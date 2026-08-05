import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import archiver from 'archiver';

import { PrismaService } from '../prisma/prisma.service';
import { IcmsService } from '../icms/icms.service';
import { parseCteXml } from '../cte/cte-xml.parser';
import { gerarDacte } from '../cte/dacte/dacte.generator';
import { extrairNacional } from '../nfse/danfse/nfse-nacional.extract';
import { gerarDanfse } from '../nfse/danfse/danfse-pdf';
import { SpedXmlService, XmlAchado } from './sped-xml.service';
import { lerSped, NotaSped, CteSped, EmpresaSped } from './sped.parser';
import {
    classificarNota,
    PASTAS,
    PASTA_CTE,
    PASTA_NFSE,
    PASTA_XML_CTE,
    PASTA_XML_NFE,
    PASTA_XML_NFSE,
    ROTULO_PASTA,
} from './sped-cfop';

/**
 * Cada opção é independente e grava na sua própria pasta. Marcar só "XML das
 * NF-e" tem que produzir um pacote com essa pasta e mais nada.
 */
export interface SpedOpcoes {
    /** Código da empresa no ERP correspondente ao CNPJ do arquivo (matriz = 1). */
    empresa: number;
    /** DANFE das notas de entrada, em pastas por natureza da operação. */
    danfe: boolean;
    /** DACTE dos CT-e de entrada. */
    dacte: boolean;
    /** DANFSe das NFS-e da competência do arquivo. */
    danfse: boolean;
    /** XML das NF-e de entrada. */
    xmlNfe: boolean;
    /** XML dos CT-e de entrada. */
    xmlCte: boolean;
    /** XML das NFS-e da competência do arquivo. */
    xmlNfse: boolean;
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

export interface SpedPrevia {
    empresa: EmpresaSped | null;
    totalNotas: number;
    totalCtes: number;
    totalNfse: number;
    mistas: number;
    porPasta: LinhaPasta[];
}

export interface SpedResumo extends SpedPrevia {
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

/** NFS-e da competência, vinda da distribuição do ADN (com_nfse_documento). */
interface NfseDoSped {
    chave: string;
    numero: string;
    serie: string;
    papel: string;
    situacao: string;
    prestador: string;
    valor: number;
    data: string;
    xml: string;
}

/** Um job vive 1h depois de terminar — tempo de sobra para baixar o pacote. */
const TTL_MS = 60 * 60 * 1000;

/**
 * Fechamento do SPED Fiscal: a partir do arquivo que vai para o Fisco, monta o
 * pacote que a contabilidade arquiva.
 *
 * O arquivo do SPED cobre NF-e (C100) e CT-e (D100). A NFS-e **não está nele** —
 * é imposto municipal e não entra no SPED Fiscal. Ela entra aqui pela competência
 * declarada no registro 0000, buscada no acervo que a distribuição do ADN já
 * mantém; o arquivo serve só para dizer de que mês estamos falando.
 *
 * Roda como JOB e não como download síncrono: são centenas de documentos e a
 * busca no ERP passa de um minuto. O .zip é escrito em disco temporário enquanto
 * é montado, nunca acumulado em memória.
 */
@Injectable()
export class SpedService implements OnModuleDestroy {
    private readonly logger = new Logger(SpedService.name);
    private readonly jobs = new Map<string, SpedJob>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly xmlService: SpedXmlService,
        private readonly icms: IcmsService,
    ) { }

    // ------------------------------------------------------------------
    // Prévia
    // ------------------------------------------------------------------

    /**
     * Lê o arquivo e devolve a classificação, sem buscar um único XML. O único
     * toque no banco é contar as NFS-e da competência — que não vêm do arquivo.
     */
    async analisar(conteudo: Buffer): Promise<SpedPrevia> {
        const { empresa, notas, ctes } = lerSped(conteudo);
        const classificadas = notas.map((n) => ({ nota: n, ...classificarNota(n.cfops, n.codSituacao) }));
        const totalNfse = await this.contarNfse(empresa);

        return {
            empresa,
            totalNotas: notas.length,
            totalCtes: ctes.length,
            totalNfse,
            mistas: classificadas.filter((c) => c.mista).length,
            porPasta: this.agrupar(classificadas, ctes, [], undefined, totalNfse),
        };
    }

    /**
     * Linhas "documentos por pasta".
     *
     * `pdfs` diz quais famílias de PDF foram realmente geradas: no RESULTADO a
     * tabela tem que mostrar o que está dentro do .zip, não a classificação de
     * documentos cujo PDF ninguém pediu. Na PRÉVIA, tudo entra — ali o objetivo
     * é justamente ver o enquadramento antes de escolher.
     */
    private agrupar(
        classificadas: { nota: NotaSped; pasta: string }[],
        ctes: CteSped[],
        nfse: NfseDoSped[],
        opcoes?: { danfe: boolean; dacte: boolean; danfse: boolean },
        totalNfse = nfse.length,
    ): LinhaPasta[] {
        const linhas = new Map<string, LinhaPasta>();
        const garante = (pasta: string) => {
            if (!linhas.has(pasta)) {
                linhas.set(pasta, { pasta, rotulo: ROTULO_PASTA[pasta] || pasta, quantidade: 0, valor: 0 });
            }
            return linhas.get(pasta)!;
        };

        for (const p of Object.values(PASTAS)) garante(p);
        if (!opcoes || opcoes.danfe) {
            for (const c of classificadas) {
                const linha = garante(c.pasta);
                linha.quantidade++;
                linha.valor += c.nota.valorDoc;
            }
        }

        const cte = garante(PASTA_CTE);
        if (!opcoes || opcoes.dacte) {
            cte.quantidade = ctes.length;
            cte.valor = ctes.reduce((s, c) => s + c.valorDoc, 0);
        }

        const serv = garante(PASTA_NFSE);
        if (!opcoes || opcoes.danfse) {
            serv.quantidade = totalNfse;
            serv.valor = nfse.reduce((s, n) => s + n.valor, 0);
        }

        return [...linhas.values()];
    }

    // ------------------------------------------------------------------
    // NFS-e da competência
    // ------------------------------------------------------------------

    /**
     * Janela da competência do arquivo. A NFS-e é registrada pela competência
     * (o mês a que o serviço pertence); quando ela não vem preenchida, caímos
     * para a data de emissão, que é o que sobra.
     */
    private janela(empresa: EmpresaSped | null) {
        if (!empresa?.dtInicio || !empresa?.dtFim) return null;
        const ini = new Date(`${empresa.dtInicio}T00:00:00.000Z`);
        const fim = new Date(`${empresa.dtFim}T23:59:59.999Z`);
        if (Number.isNaN(ini.getTime()) || Number.isNaN(fim.getTime())) return null;
        return {
            OR: [
                { competencia: { gte: ini, lte: fim } },
                { competencia: null, data_emissao: { gte: ini, lte: fim } },
            ],
        };
    }

    private async contarNfse(empresa: EmpresaSped | null): Promise<number> {
        const where = this.janela(empresa);
        if (!where) return 0;
        return this.prisma.nfseDocumento.count({ where });
    }

    private async buscarNfse(empresa: EmpresaSped | null): Promise<NfseDoSped[]> {
        const where = this.janela(empresa);
        if (!where) return [];
        const rows = await this.prisma.nfseDocumento.findMany({
            where,
            select: {
                chave_acesso: true,
                numero: true,
                serie: true,
                papel: true,
                situacao: true,
                nome_prestador: true,
                valor: true,
                data_emissao: true,
                competencia: true,
                xml: true,
            },
            orderBy: [{ data_emissao: 'asc' }, { numero: 'asc' }],
        });

        return rows.map((r) => ({
            chave: r.chave_acesso,
            numero: r.numero ?? '',
            serie: r.serie ?? '',
            papel: r.papel ?? '',
            situacao: r.situacao,
            prestador: r.nome_prestador ?? '',
            valor: r.valor ?? 0,
            data: (r.data_emissao ?? r.competencia)?.toISOString().slice(0, 10) ?? '',
            xml: r.xml ?? '',
        }));
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

        // Só busca o que alguma opção marcada vai usar.
        const querNfe = opcoes.danfe || opcoes.xmlNfe;
        const querCte = opcoes.dacte || opcoes.xmlCte;
        const querNfse = opcoes.danfse || opcoes.xmlNfse;

        const listaNotas = querNfe ? classificadas : [];
        const listaCtes = querCte ? ctes : [];

        let listaNfse: NfseDoSped[] = [];
        if (querNfse) {
            job.etapa = 'Buscando as NFS-e da competência';
            listaNfse = await this.buscarNfse(empresa);
        }

        job.total = listaNotas.length + listaCtes.length + listaNfse.length;
        job.etapa =
            `Arquivo lido: ${notas.length} NF-e e ${ctes.length} CT-e de entrada` +
            (querNfse ? `, ${listaNfse.length} NFS-e na competência` : '');

        // ---- 1. XMLs das NF-e/CT-e (uma passada só, serve ao PDF e à exportação) ----
        const chavesNfe = listaNotas.map((c) => c.nota.chave);
        const chavesCte = listaCtes.map((c) => c.chave);
        const achados = new Map<string, XmlAchado>();

        if (chavesNfe.length || chavesCte.length) {
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
        }

        const fontes: Record<string, number> = {};
        for (const a of achados.values()) fontes[a.fonte] = (fontes[a.fonte] || 0) + 1;
        if (listaNfse.length) fontes['intranet:com_nfse_documento'] = listaNfse.filter((n) => n.xml).length;

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

        const semDocumento = (p: Pendencia) => pendencias.push(p);

        job.etapa = 'Gerando documentos';

        // ---- 2.1 NF-e ----
        for (const c of listaNotas) {
            const n = c.nota;
            const achado = achados.get(n.chave);
            const linha = this.linhaRelatorio({
                tipo: 'NF-e',
                chave: n.chave,
                numero: n.numero,
                serie: n.serie,
                situacao: n.codSituacao,
                data: n.dataDoc,
                dataEntrada: n.dataEntrada,
                parte: n.emitenteNome,
                cnpj: n.emitenteCnpj,
                valor: n.valorDoc,
                cfops: c.cfops.join(' '),
                cfopPredominante: c.cfopPredominante,
                mistos: c.mista ? 'SIM' : '',
                pasta: c.pasta,
                fonte: achado?.fonte ?? '',
            });

            if (!achado) {
                linha.status = 'SEM XML';
                semDocumento({
                    chave: n.chave,
                    tipo: 'NF-e',
                    numero: n.numero,
                    emitente: n.emitenteNome,
                    motivo: 'XML não encontrado no Postgres nem no ERP',
                });
            } else {
                const xml = this.xmlService.xmlFinal(achado);

                if (opcoes.xmlNfe) {
                    linha.arquivo_xml = `${PASTA_XML_NFE}/${n.chave}.xml`;
                    zip.append(Buffer.from(xml, 'utf8'), { name: linha.arquivo_xml });
                    xmlsExportados++;
                }

                if (opcoes.danfe) {
                    try {
                        const pdf = await this.icms.generateDanfe(xml);
                        if (!pdf?.length) throw new Error('PDF vazio');
                        linha.arquivo_pdf = `${c.pasta}/${this.nomeNota(n)}.pdf`;
                        zip.append(pdf, { name: linha.arquivo_pdf });
                        pdfsGerados++;
                        linha.status = 'OK';
                    } catch (e: any) {
                        pdfsComErro++;
                        linha.status = `ERRO: ${e?.message ?? e}`;
                        semDocumento({
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

        // ---- 2.2 CT-e ----
        for (const cte of listaCtes) {
            const achado = achados.get(cte.chave);
            const linha = this.linhaRelatorio({
                tipo: 'CT-e',
                chave: cte.chave,
                numero: cte.numero,
                serie: cte.serie,
                situacao: cte.codSituacao,
                data: cte.dataDoc,
                parte: cte.emitenteNome,
                cnpj: cte.emitenteCnpj,
                valor: cte.valorDoc,
                pasta: PASTA_CTE,
                fonte: achado?.fonte ?? '',
            });

            if (!achado) {
                linha.status = 'SEM XML';
                semDocumento({
                    chave: cte.chave,
                    tipo: 'CT-e',
                    numero: cte.numero,
                    emitente: cte.emitenteNome,
                    motivo: 'XML não encontrado no Postgres nem no ERP',
                });
            } else {
                const xml = this.xmlService.xmlFinal(achado);

                if (opcoes.xmlCte) {
                    linha.arquivo_xml = `${PASTA_XML_CTE}/${cte.chave}.xml`;
                    zip.append(Buffer.from(xml, 'utf8'), { name: linha.arquivo_xml });
                    xmlsExportados++;
                }

                if (opcoes.dacte) {
                    try {
                        const pdf = await gerarDacte(parseCteXml(xml));
                        if (!pdf?.length) throw new Error('PDF vazio');
                        linha.arquivo_pdf = `${PASTA_CTE}/${this.nomeCte(cte)}.pdf`;
                        zip.append(pdf, { name: linha.arquivo_pdf });
                        pdfsGerados++;
                        linha.status = 'OK';
                    } catch (e: any) {
                        pdfsComErro++;
                        linha.status = `ERRO: ${e?.message ?? e}`;
                        semDocumento({
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

        // ---- 2.3 NFS-e ----
        for (const nf of listaNfse) {
            const linha = this.linhaRelatorio({
                tipo: `NFS-e ${this.rotuloPapel(nf.papel)}`,
                chave: nf.chave,
                numero: nf.numero,
                serie: nf.serie,
                situacao: nf.situacao,
                data: nf.data,
                parte: nf.prestador,
                valor: nf.valor,
                pasta: PASTA_NFSE,
                fonte: nf.xml ? 'intranet:com_nfse_documento' : '',
            });

            if (!nf.xml) {
                linha.status = 'SEM XML';
                semDocumento({
                    chave: nf.chave,
                    tipo: 'NFS-e',
                    numero: nf.numero,
                    emitente: nf.prestador,
                    motivo: 'A distribuição registrou a nota sem o XML',
                });
            } else {
                if (opcoes.xmlNfse) {
                    linha.arquivo_xml = `${PASTA_XML_NFSE}/${nf.chave}.xml`;
                    zip.append(Buffer.from(nf.xml, 'utf8'), { name: linha.arquivo_xml });
                    xmlsExportados++;
                }

                if (opcoes.danfse) {
                    try {
                        const dados = await extrairNacional(nf.xml, nf.situacao === 'CANCELADA');
                        const pdf = await gerarDanfse(dados);
                        if (!pdf?.length) throw new Error('PDF vazio');
                        linha.arquivo_pdf = `${PASTA_NFSE}/${this.nomeNfse(nf)}.pdf`;
                        zip.append(pdf, { name: linha.arquivo_pdf });
                        pdfsGerados++;
                        linha.status = 'OK';
                    } catch (e: any) {
                        pdfsComErro++;
                        linha.status = `ERRO: ${e?.message ?? e}`;
                        semDocumento({
                            chave: nf.chave,
                            tipo: 'NFS-e',
                            numero: nf.numero,
                            emitente: nf.prestador,
                            motivo: `Falha ao gerar o DANFSe: ${e?.message ?? e}`,
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

        const comXml = achados.size + listaNfse.filter((n) => n.xml).length;
        job.arquivo = caminho;
        job.status = 'concluido';
        job.etapa = 'Concluído';
        job.resumo = {
            empresa,
            totalNotas: listaNotas.length,
            totalCtes: listaCtes.length,
            totalNfse: listaNfse.length,
            mistas: listaNotas.filter((c) => c.mista).length,
            porPasta: this.agrupar(listaNotas, listaCtes, listaNfse, {
                danfe: opcoes.danfe,
                dacte: opcoes.dacte,
                danfse: opcoes.danfse,
            }),
            comXml,
            semXml: job.total - comXml,
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

    /** Colunas fixas do relatório — a ordem das chaves é a ordem do CSV. */
    private linhaRelatorio(d: {
        tipo: string;
        chave: string;
        numero: string;
        serie: string;
        situacao: string;
        data: string;
        dataEntrada?: string;
        parte: string;
        cnpj?: string;
        valor: number;
        cfops?: string;
        cfopPredominante?: string;
        mistos?: string;
        pasta: string;
        fonte: string;
    }): Record<string, string> {
        return {
            tipo: d.tipo,
            chave: d.chave,
            numero: d.numero,
            serie: d.serie,
            situacao: d.situacao,
            data_documento: d.data,
            data_entrada: d.dataEntrada ?? '',
            emitente_prestador: d.parte,
            cnpj: d.cnpj ?? '',
            valor: this.brl(d.valor),
            cfops: d.cfops ?? '',
            cfop_predominante: d.cfopPredominante ?? '',
            cfops_mistos: d.mistos ?? '',
            pasta: d.pasta,
            fonte_xml: d.fonte,
            arquivo_pdf: '',
            arquivo_xml: '',
            status: '',
        };
    }

    private rotuloPapel(papel: string): string {
        if (papel === 'PRESTADOR') return 'PRESTADA';
        if (papel === 'TOMADOR') return 'TOMADA';
        return papel || 'SEM-PAPEL';
    }

    /** `AAAA-MM-DD_NNNNNNNNN_EMITENTE_CHAVE`: ordena por data dentro da pasta. */
    private nomeNota(n: NotaSped): string {
        return [
            n.dataDoc || n.dataEntrada || 'sem-data',
            String(n.numero || '').replace(/\D/g, '').padStart(9, '0'),
            this.slug(n.emitenteNome) || 'SEM-EMITENTE',
            n.chave,
        ].join('_');
    }

    private nomeCte(c: CteSped): string {
        return [
            c.dataDoc || 'sem-data',
            `CTe${String(c.numero || '').replace(/\D/g, '').padStart(9, '0')}-${c.serie || '0'}`,
            this.slug(c.emitenteNome) || 'SEM-EMITENTE',
            c.chave,
        ].join('_');
    }

    /**
     * A NFS-e leva PRESTADA/TOMADA no nome. Prestada e tomada vão para lugares
     * diferentes na contabilidade, mas dividir a pasta faria a opção "NFS-e"
     * gerar duas — e o pedido é uma pasta por opção.
     */
    private nomeNfse(n: NfseDoSped): string {
        return [
            n.data || 'sem-data',
            `NFSe${String(n.numero || '').replace(/\D/g, '').padStart(9, '0')}`,
            this.rotuloPapel(n.papel),
            this.slug(n.prestador) || 'SEM-PRESTADOR',
            n.chave,
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
