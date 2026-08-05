import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import archiver from 'archiver';

import { IcmsService } from '../icms/icms.service';
import { parseCteXml } from '../cte/cte-xml.parser';
import { gerarDacte } from '../cte/dacte/dacte.generator';
import { SpedXmlService, XmlAchado } from './sped-xml.service';
import { lerSped, NotaSped, CteSped, EmpresaSped } from './sped.parser';
import { classificarNota, PASTAS, PASTA_CTE, PASTA_XML, ROTULO_PASTA } from './sped-cfop';

export interface SpedOpcoes {
    /** Código da empresa no ERP correspondente ao CNPJ do arquivo (matriz = 1). */
    empresa: number;
    /** Gera o DANFE das notas de entrada, em pastas por natureza da operação. */
    danfe: boolean;
    /** Gera o DACTE dos CT-e de entrada, numa pasta única. */
    dacte: boolean;
    /** Exporta os XMLs (NF-e e CT-e juntos) numa pasta única. */
    xml: boolean;
    /** Não consulta o ERP: o que não estiver no Postgres fica sem documento. */
    somentePostgres: boolean;
}

export interface LinhaPasta {
    pasta: string;
    rotulo: string;
    quantidade: number;
    valor: number;
}

export interface Pendencia {
    chave: string;
    tipo: string;
    numero: string;
    emitente: string;
    motivo: string;
}

export interface SpedResumo {
    empresa: EmpresaSped | null;
    totalNotas: number;
    totalCtes: number;
    mistas: number;
    porPasta: LinhaPasta[];
    comXml: number;
    semXml: number;
    pdfsGerados: number;
    pdfsComErro: number;
    xmlsExportados: number;
    fontes: Record<string, number>;
    pendencias: Pendencia[];
}

export interface SpedJob {
    id: string;
    nomeSped: string;
    criadoEm: Date;
    status: 'processando' | 'concluido' | 'falhou';
    etapa: string;
    feito: number;
    total: number;
    resumo: SpedResumo | null;
    erro: string | null;
    /** Caminho do .zip no disco temporário; some quando o job expira. */
    arquivo: string | null;
    nomeArquivo: string;
}

/** Um job vive 1h depois de terminar — tempo de sobra para baixar o pacote. */
const TTL_MS = 60 * 60 * 1000;

/**
 * Fechamento do SPED Fiscal: a partir do arquivo que vai para o Fisco, monta o
 * pacote que a contabilidade arquiva — DANFE das entradas separado por natureza
 * da operação, DACTE dos CT-e e os XMLs.
 *
 * Roda como JOB e não como download síncrono: são centenas de documentos e a
 * busca no ERP passa de um minuto. O cliente cria o job, acompanha o progresso e
 * baixa o .zip no fim.
 *
 * O .zip é escrito em disco temporário enquanto é montado, nunca acumulado em
 * memória: um mês típico passa de 500 documentos.
 */
@Injectable()
export class SpedService implements OnModuleDestroy {
    private readonly logger = new Logger(SpedService.name);
    private readonly jobs = new Map<string, SpedJob>();

    constructor(
        private readonly xmlService: SpedXmlService,
        private readonly icms: IcmsService,
    ) { }

    // ------------------------------------------------------------------
    // Prévia — só o arquivo, sem tocar em Postgres nem ERP
    // ------------------------------------------------------------------

    /**
     * Lê o arquivo e devolve a classificação, sem buscar um único XML. É barato
     * (milissegundos) e serve para conferir o enquadramento antes de disparar a
     * geração, que é a parte cara.
     */
    analisar(conteudo: Buffer) {
        const { empresa, notas, ctes } = lerSped(conteudo);
        const classificadas = notas.map((n) => ({ nota: n, ...classificarNota(n.cfops, n.codSituacao) }));

        return {
            empresa,
            totalNotas: notas.length,
            totalCtes: ctes.length,
            mistas: classificadas.filter((c) => c.mista).length,
            porPasta: this.agrupar(classificadas, ctes),
        };
    }

    private agrupar(
        classificadas: { nota: NotaSped; pasta: string }[],
        ctes: CteSped[],
    ): LinhaPasta[] {
        const linhas = new Map<string, LinhaPasta>();
        const garante = (pasta: string) => {
            if (!linhas.has(pasta)) {
                linhas.set(pasta, { pasta, rotulo: ROTULO_PASTA[pasta] || pasta, quantidade: 0, valor: 0 });
            }
            return linhas.get(pasta)!;
        };

        for (const p of Object.values(PASTAS)) garante(p);
        for (const c of classificadas) {
            const linha = garante(c.pasta);
            linha.quantidade++;
            linha.valor += c.nota.valorDoc;
        }
        if (ctes.length) {
            const linha = garante(PASTA_CTE);
            linha.quantidade = ctes.length;
            linha.valor = ctes.reduce((s, c) => s + c.valorDoc, 0);
        }
        return [...linhas.values()];
    }

    // ------------------------------------------------------------------
    // Job
    // ------------------------------------------------------------------

    criarJob(conteudo: Buffer, nomeSped: string, opcoes: SpedOpcoes): SpedJob {
        const id = randomUUID();
        const base = (nomeSped || 'sped').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
        const job: SpedJob = {
            id,
            nomeSped,
            criadoEm: new Date(),
            status: 'processando',
            etapa: 'Lendo o arquivo do SPED',
            feito: 0,
            total: 0,
            resumo: null,
            erro: null,
            arquivo: null,
            nomeArquivo: `${base}.zip`,
        };
        this.jobs.set(id, job);

        // Solta o processamento: a resposta do POST devolve o id na hora.
        void this.processar(job, conteudo, opcoes).catch((e: any) => {
            job.status = 'falhou';
            job.erro = e?.message ?? String(e);
            this.logger.error(`Job SPED ${id} falhou: ${job.erro}`);
        });

        return job;
    }

    status(id: string): SpedJob {
        const job = this.jobs.get(id);
        if (!job) throw new NotFoundException(`Job não encontrado: ${id}`);
        return job;
    }

    arquivoDoJob(id: string): { caminho: string; nome: string } {
        const job = this.status(id);
        if (job.status !== 'concluido' || !job.arquivo || !fs.existsSync(job.arquivo)) {
            throw new NotFoundException(`O pacote do job ${id} não está disponível.`);
        }
        return { caminho: job.arquivo, nome: job.nomeArquivo };
    }

    // ------------------------------------------------------------------
    // Processamento
    // ------------------------------------------------------------------

    private async processar(job: SpedJob, conteudo: Buffer, opcoes: SpedOpcoes) {
        const { empresa, notas, ctes } = lerSped(conteudo);
        const classificadas = notas.map((n) => ({ nota: n, ...classificarNota(n.cfops, n.codSituacao) }));

        job.total = notas.length + ctes.length;
        job.etapa = `Arquivo lido: ${notas.length} nota(s) e ${ctes.length} CT-e de entrada`;

        // ---- 1. XMLs (uma passada só, para os dois usos: PDF e exportação) ----
        const chavesNfe = notas.map((n) => n.chave);
        const chavesCte = ctes.map((c) => c.chave);
        const achados = new Map<string, XmlAchado>();

        job.etapa = 'Buscando XMLs no Postgres';
        for (const [k, v] of await this.xmlService.buscarNoPostgres(chavesNfe, chavesCte)) achados.set(k, v);

        if (!opcoes.somentePostgres) {
            const faltamNfe = chavesNfe.filter((k) => !achados.has(k));
            const faltamCte = chavesCte.filter((k) => !achados.has(k));
            if (faltamNfe.length || faltamCte.length) {
                job.etapa = 'Buscando XMLs no ERP';
                const doErp = await this.xmlService.buscarNoErp(faltamNfe, faltamCte, {
                    empresa: opcoes.empresa,
                    onProgresso: (rotulo) => {
                        job.etapa = `Buscando XMLs no ERP — ${rotulo}`;
                    },
                });
                for (const [k, v] of doErp) achados.set(k, v);
            }
        }

        const fontes: Record<string, number> = {};
        for (const a of achados.values()) fontes[a.fonte] = (fontes[a.fonte] || 0) + 1;

        // ---- 2. Pacote ----
        const caminho = path.join(os.tmpdir(), `sped-${job.id}.zip`);
        const saida = fs.createWriteStream(caminho);
        const zip = archiver('zip', { zlib: { level: 9 } });
        const fim = new Promise<void>((resolve, reject) => {
            saida.on('close', () => resolve());
            saida.on('error', reject);
            zip.on('error', reject);
        });
        zip.pipe(saida);

        const relatorio: Record<string, string>[] = [];
        const pendencias: Pendencia[] = [];
        let pdfsGerados = 0;
        let pdfsComErro = 0;
        let xmlsExportados = 0;

        job.etapa = 'Gerando documentos';

        for (const c of classificadas) {
            const n = c.nota;
            const achado = achados.get(n.chave);
            const linha: Record<string, string> = {
                tipo: 'NF-e',
                chave: n.chave,
                numero: n.numero,
                serie: n.serie,
                cod_situacao: n.codSituacao,
                data_documento: n.dataDoc,
                data_entrada: n.dataEntrada,
                emitente: n.emitenteNome,
                cnpj_emitente: n.emitenteCnpj,
                valor: this.brl(n.valorDoc),
                cfops: c.cfops.join(' '),
                cfop_predominante: c.cfopPredominante,
                cfops_mistos: c.mista ? 'SIM' : '',
                pasta: c.pasta,
                fonte_xml: achado?.fonte ?? '',
                arquivo_pdf: '',
                arquivo_xml: '',
                status: '',
            };

            if (!achado) {
                linha.status = 'SEM XML';
                pendencias.push({
                    chave: n.chave,
                    tipo: 'NF-e',
                    numero: n.numero,
                    emitente: n.emitenteNome,
                    motivo: 'XML não encontrado no Postgres nem no ERP',
                });
            } else {
                const conteudoXml = this.xmlService.xmlFinal(achado);

                if (opcoes.xml) {
                    linha.arquivo_xml = `${PASTA_XML}/${n.chave}.xml`;
                    zip.append(Buffer.from(conteudoXml, 'utf8'), { name: linha.arquivo_xml });
                    xmlsExportados++;
                }

                if (opcoes.danfe) {
                    try {
                        const pdf = await this.icms.generateDanfe(conteudoXml);
                        if (!pdf?.length) throw new Error('PDF vazio');
                        linha.arquivo_pdf = `${c.pasta}/${this.nomeArquivo(n)}.pdf`;
                        zip.append(pdf, { name: linha.arquivo_pdf });
                        pdfsGerados++;
                        linha.status = 'OK';
                    } catch (e: any) {
                        pdfsComErro++;
                        linha.status = `ERRO: ${e?.message ?? e}`;
                        pendencias.push({
                            chave: n.chave,
                            tipo: 'NF-e',
                            numero: n.numero,
                            emitente: n.emitenteNome,
                            motivo: `Falha ao gerar o DANFE: ${e?.message ?? e}`,
                        });
                    }
                } else {
                    linha.status = 'OK';
                }
            }

            relatorio.push(linha);
            job.feito++;
        }

        for (const cte of ctes) {
            const achado = achados.get(cte.chave);
            const linha: Record<string, string> = {
                tipo: 'CT-e',
                chave: cte.chave,
                numero: cte.numero,
                serie: cte.serie,
                cod_situacao: cte.codSituacao,
                data_documento: cte.dataDoc,
                data_entrada: '',
                emitente: cte.emitenteNome,
                cnpj_emitente: cte.emitenteCnpj,
                valor: this.brl(cte.valorDoc),
                cfops: '',
                cfop_predominante: '',
                cfops_mistos: '',
                pasta: PASTA_CTE,
                fonte_xml: achado?.fonte ?? '',
                arquivo_pdf: '',
                arquivo_xml: '',
                status: '',
            };

            if (!achado) {
                linha.status = 'SEM XML';
                pendencias.push({
                    chave: cte.chave,
                    tipo: 'CT-e',
                    numero: cte.numero,
                    emitente: cte.emitenteNome,
                    motivo: 'XML não encontrado no Postgres nem no ERP',
                });
            } else {
                const conteudoXml = this.xmlService.xmlFinal(achado);

                if (opcoes.xml) {
                    linha.arquivo_xml = `${PASTA_XML}/${cte.chave}.xml`;
                    zip.append(Buffer.from(conteudoXml, 'utf8'), { name: linha.arquivo_xml });
                    xmlsExportados++;
                }

                if (opcoes.dacte) {
                    try {
                        const pdf = await gerarDacte(parseCteXml(conteudoXml));
                        if (!pdf?.length) throw new Error('PDF vazio');
                        linha.arquivo_pdf = `${PASTA_CTE}/${this.nomeArquivoCte(cte)}.pdf`;
                        zip.append(pdf, { name: linha.arquivo_pdf });
                        pdfsGerados++;
                        linha.status = 'OK';
                    } catch (e: any) {
                        pdfsComErro++;
                        linha.status = `ERRO: ${e?.message ?? e}`;
                        pendencias.push({
                            chave: cte.chave,
                            tipo: 'CT-e',
                            numero: cte.numero,
                            emitente: cte.emitenteNome,
                            motivo: `Falha ao gerar o DACTE: ${e?.message ?? e}`,
                        });
                    }
                } else {
                    linha.status = 'OK';
                }
            }

            relatorio.push(linha);
            job.feito++;
        }

        job.etapa = 'Fechando o pacote';
        zip.append(Buffer.from(this.csv(relatorio), 'utf8'), { name: 'relatorio.csv' });
        await zip.finalize();
        await fim;

        job.arquivo = caminho;
        job.status = 'concluido';
        job.etapa = 'Concluído';
        job.resumo = {
            empresa,
            totalNotas: notas.length,
            totalCtes: ctes.length,
            mistas: classificadas.filter((c) => c.mista).length,
            porPasta: this.agrupar(classificadas, ctes),
            comXml: achados.size,
            semXml: notas.length + ctes.length - achados.size,
            pdfsGerados,
            pdfsComErro,
            xmlsExportados,
            fontes,
            pendencias,
        };

        this.logger.log(
            `Job SPED ${job.id}: ${pdfsGerados} PDF(s), ${xmlsExportados} XML(s), ` +
            `${job.resumo.semXml} sem XML — ${path.basename(caminho)}`,
        );

        setTimeout(() => this.descartar(job.id), TTL_MS).unref();
    }

    // ------------------------------------------------------------------
    // Auxiliares
    // ------------------------------------------------------------------

    /** `AAAA-MM-DD_NNNNNNNNN_EMITENTE_CHAVE`: ordena por data dentro da pasta. */
    private nomeArquivo(n: NotaSped): string {
        return [
            n.dataDoc || n.dataEntrada || 'sem-data',
            String(n.numero || '').replace(/\D/g, '').padStart(9, '0'),
            this.slug(n.emitenteNome) || 'SEM-EMITENTE',
            n.chave,
        ].join('_');
    }

    private nomeArquivoCte(c: CteSped): string {
        return [
            c.dataDoc || 'sem-data',
            `CTe${String(c.numero || '').replace(/\D/g, '').padStart(9, '0')}-${c.serie || '0'}`,
            this.slug(c.emitenteNome) || 'SEM-EMITENTE',
            c.chave,
        ].join('_');
    }

    private slug(s: string, max = 30): string {
        return String(s || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toUpperCase()
            .slice(0, max);
    }

    private brl(v: number): string {
        return Number(v || 0).toFixed(2).replace('.', ',');
    }

    /** `;` como separador e BOM UTF-8: abre direto no Excel em português. */
    private csv(linhas: Record<string, string>[]): string {
        if (!linhas.length) return '﻿';
        const colunas = Object.keys(linhas[0]);
        const campo = (v: unknown) => {
            const s = String(v ?? '');
            return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const corpo = linhas.map((l) => colunas.map((c) => campo(l[c])).join(';'));
        return '﻿' + [colunas.join(';'), ...corpo].join('\r\n');
    }

    private descartar(id: string) {
        const job = this.jobs.get(id);
        if (job?.arquivo) fs.promises.unlink(job.arquivo).catch(() => undefined);
        this.jobs.delete(id);
    }

    onModuleDestroy() {
        for (const id of [...this.jobs.keys()]) this.descartar(id);
    }
}
