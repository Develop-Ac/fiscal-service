import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { OpenQueryService } from '../shared/database/openquery/openquery.service';
import { minioClient } from '../shared/minio/minio-client';
import { decifrar } from '../nfse/nfse-crypto.util';
import { BUCKET_FISCAL } from '../escaner/escaner.service';
import { Nota, parseNfe } from './gnre-nfe';
import {
    GnreConfig,
    guiasDisponiveis,
    hojeIso,
    InfoGuia,
    montarLote,
    ROTULOS,
    TIPO_DIFAL,
    TIPO_ICMS_ST,
    TipoGuia,
    validarLote,
} from './gnre-builder';
import { GnreClient, RespostaGnre, situacaoGuiaTexto } from './gnre-client';
import { gerarPdfGuia, parseGuias } from './gnre-pdf';

/**
 * GNRE de venda (ICMS-ST por operação e DIFAL) da NF-e de saída ao PA.
 *
 * Fluxo: consulta a NF no ERP (NF_SAIDA.XML_NFE) → detecta as guias cabíveis →
 * monta o lote 2.00 → transmite em produção (mTLS com o certificado A1 vinculado
 * na tela de NFS-e) → consulta o resultado → gera o PDF da guia, grava no MinIO
 * e registra no arquivo fiscal (esc_documento, tipo `guia-gnre`), onde aparece
 * em /fiscal/arquivos junto dos documentos escaneados.
 *
 * Histórico em com_gnre_guia (uma linha por guia transmitida, com o XML de
 * resultado — o PDF é sempre reproduzível a partir dele).
 */

const LINKED_SERVER = 'CONSULTA';
const TIPO_ARQUIVO = 'guia-gnre';
const RECEITA_TIPO: Record<string, TipoGuia> = { '100099': TIPO_ICMS_ST, '100102': TIPO_DIFAL };

const env = (k: string, d: string) => (process.env[k] ?? '').trim() || d;

export function configGnre(): GnreConfig {
    return {
        gnre: {
            ambiente: env('GNRE_AMBIENTE', 'producao'),
            ufFavorecida: env('GNRE_UF_FAVORECIDA', 'PA'),
            urlRecepcao: env('GNRE_URL_RECEPCAO', 'https://www.gnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao'),
            urlResultado: env('GNRE_URL_RESULTADO', 'https://www.gnre.pe.gov.br/gnreWS/services/GnreResultadoLote'),
            versaoDados: '2.00',
            timeoutSeg: Number(env('GNRE_TIMEOUT_SEG', '60')) || 60,
        },
        regras: {
            receitaIcmsSt: env('GNRE_RECEITA_ICMS_ST', '100099'),
            receitaDifal: env('GNRE_RECEITA_DIFAL', '100102'),
            tipoDocOrigem: env('GNRE_TIPO_DOC_ORIGEM', '10'),
            docOrigemUsar: env('GNRE_DOC_ORIGEM_USAR', 'numero') === 'chave' ? 'chave' : 'numero',
            incluirMunicipio: env('GNRE_INCLUIR_MUNICIPIO', '1') === '1',
            vencimentoModo: env('GNRE_VENCIMENTO_MODO', 'hoje') === 'emissao' ? 'emissao' : 'hoje',
            vencimentoDias: Number(env('GNRE_VENCIMENTO_DIAS', '0')) || 0,
            periodoReferencia: '0',
        },
    };
}

/** Empresa emitente padrão e raiz do CNPJ do certificado (status da tela). */
const EMPRESA_PADRAO = Number(env('GNRE_EMPRESA_PADRAO', '1')) || 1;
const CNPJ_RAIZ_PADRAO = env('GNRE_CNPJ_RAIZ', '07351198');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RegistroErp {
    numero: number;
    serie: string;
    empresa: number;
    nfs: number;
    chave: string;
    emissao: string;
    valorSt: number;
    totalNota: number;
}

export interface GuiaRow {
    id: number;
    criado_em: string;
    numero_nf: string;
    serie: string | null;
    empresa: number | null;
    chave_nfe: string | null;
    tipo: string | null;
    receita: string | null;
    uf: string | null;
    valor_total: string | null;
    vencimento: string | null;
    recibo: string | null;
    situacao_guia: string | null;
    situacao_desc: string | null;
    linha_digitavel: string | null;
    codigo_barras: string | null;
    motivos: string[][];
    resultado_xml: string | null;
    minio_bucket: string | null;
    minio_key: string | null;
    esc_documento_id: number | null;
    usuario: string | null;
}

@Injectable()
export class GnreService {
    private readonly logger = new Logger(GnreService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly openQuery: OpenQueryService,
    ) {}

    // ------------------------------------------------------------------ status
    async status() {
        const cfg = configGnre();
        const cert = await this.certificadoDaRaiz(CNPJ_RAIZ_PADRAO).catch(() => null);
        return {
            ambiente: cfg.gnre.ambiente,
            ufFavorecida: cfg.gnre.ufFavorecida,
            empresaPadrao: EMPRESA_PADRAO,
            certificado: cert
                ? { vinculado: true, cnpj: cert.cnpj, nome: cert.nome, validadeAte: cert.validade_ate }
                : { vinculado: false },
        };
    }

    // --------------------------------------------------------------------- ERP
    /** NF-e modelo 55 não cancelada. O número se repete entre NF-e e NFC-e (65): filtra pela chave. */
    private async buscarNotas(numero: number, empresa: number): Promise<RegistroErp[]> {
        const fb =
            'SELECT NOTA_FISCAL, SERIE, EMPRESA, NFS, CHAVE_NFE, DT_EMISSAO, VALOR_ICMS_SUBST, TOTAL_NOTA FROM NF_SAIDA ' +
            `WHERE NOTA_FISCAL=${numero} AND EMPRESA=${empresa} ` +
            "AND DT_CANCELAMENTO IS NULL AND CHAVE_NFE IS NOT NULL AND SUBSTRING(CHAVE_NFE FROM 21 FOR 2)='55'";
        const rows = await this.openQuery.query<any>(this.oq(fb));
        return rows.map((r) => ({
            numero: parseInt(r.NOTA_FISCAL, 10),
            serie: String(r.SERIE),
            empresa: parseInt(r.EMPRESA, 10),
            nfs: r.NFS != null ? parseInt(r.NFS, 10) : 0,
            chave: String(r.CHAVE_NFE),
            emissao: String(r.DT_EMISSAO),
            valorSt: Number(r.VALOR_ICMS_SUBST || 0),
            totalNota: Number(r.TOTAL_NOTA || 0),
        }));
    }

    /**
     * XML_NFE em pedaços: o driver ODBC do linked server não devolve o BLOB
     * inteiro nem aceita CAST/LIKE nele, mas SUBSTRING devolve texto. Avança pelo
     * tamanho REAL recebido (o driver fatia em respostas curtas).
     */
    private async carregarXml(reg: RegistroErp, chunk = 2000): Promise<string> {
        const partes: string[] = [];
        let pos = 1;
        for (let i = 0; i < 2000; i += 1) {
            const fb =
                `SELECT FIRST 1 SUBSTRING(XML_NFE FROM ${pos} FOR ${chunk}) AS PEDACO FROM NF_SAIDA ` +
                `WHERE NOTA_FISCAL=${reg.numero} AND SERIE='${reg.serie.replace(/'/g, "''")}' ` +
                `AND EMPRESA=${reg.empresa} AND SUBSTRING(CHAVE_NFE FROM 21 FOR 2)='55'`;
            const rows = await this.openQuery.query<any>(this.oq(fb));
            const s = rows[0]?.PEDACO ? String(rows[0].PEDACO) : '';
            if (!s) break;
            partes.push(s);
            pos += s.length;
        }
        return partes.join('');
    }

    /** OPENQUERY dobra as aspas simples UMA vez (dobrar duas quebra com "token unknown"). */
    private oq(fbSql: string) {
        return `SELECT * FROM OPENQUERY([${LINKED_SERVER}], '${fbSql.replace(/'/g, "''")}')`;
    }

    private async carregarNota(numero: string | number, empresa?: string | number) {
        const num = parseInt(String(numero), 10);
        if (!Number.isFinite(num) || num <= 0) throw new BadRequestException('Informe um número de NF válido.');
        const emp = empresa != null && String(empresa) !== '' ? parseInt(String(empresa), 10) : EMPRESA_PADRAO;
        if (!Number.isFinite(emp) || emp <= 0) throw new BadRequestException('Empresa inválida.');
        const regs = await this.buscarNotas(num, emp);
        if (!regs.length) throw new NotFoundException(`Nenhuma NF-e modelo 55 número ${num} (empresa ${emp}) encontrada.`);
        if (regs.length > 1) {
            const series = [...new Set(regs.map((r) => r.serie))].sort().join(', ');
            throw new BadRequestException(`Há mais de uma série para o número ${num}: ${series}. Ajuste no ERP.`);
        }
        const registro = regs[0];
        const xml = await this.carregarXml(registro);
        if (!xml) throw new BadRequestException(`NF ${num} sem XML armazenado no ERP.`);
        return { registro, nota: parseNfe(xml) };
    }

    // ------------------------------------------------------ consultar / gerar
    async consultarNf(numero: string, empresa?: string) {
        const { registro, nota } = await this.carregarNota(numero, empresa);
        const d = nota.destinatario;
        const e = nota.emitente;
        return {
            registro,
            nota: {
                numero: nota.numero,
                serie: nota.serie,
                chave: nota.chave,
                emissaoData: nota.emissaoData,
                destUf: d.uf,
                emitNome: e.nome,
                vSt: nota.vSt,
                vFcpSt: nota.vFcpSt,
                vIcmsUfDest: nota.vIcmsUfDest,
                vFcpUfDest: nota.vFcpUfDest,
            },
            resumo: [
                ['NF', `${nota.numero}  série ${nota.serie}  mod ${nota.modelo}`],
                ['Emissão', nota.emissaoData],
                ['Natureza', nota.natOp],
                ['idDest', `${nota.idDest} (2 = interestadual)`],
                ['indFinal / indIEDest', `${nota.indFinal} / ${d.indIeDest || '-'}`],
                ['Emitente (recolhe)', `${e.nome || ''} — CNPJ ${e.cnpj || ''} IE ${e.ie || ''} ${e.uf || ''}`],
                ['Destinatário', `${d.nome || ''} — ${d.cnpj ? `CNPJ ${d.cnpj}` : `CPF ${d.cpf || ''}`} — ${d.municipio || ''}/${d.uf || ''}`],
                ['ICMS-ST (vST)', `R$ ${nota.vSt}`],
                ['FCP-ST', `R$ ${nota.vFcpSt}`],
                ['DIFAL destino', `R$ ${nota.vIcmsUfDest}`],
                ['FCP DIFAL', `R$ ${nota.vFcpUfDest}`],
            ],
            tiposDisponiveis: guiasDisponiveis(nota).map((t) => ({ tipo: t, rotulo: ROTULOS[t] })),
            // O servidor da GNRE devolve o MESMO recibo para lote igual: avisar antes de repetir.
            guiasAnteriores: await this.listarGuias({ nfExata: String(nota.numero), empresa: registro.empresa }),
        };
    }

    private tiposValidos(tipos: unknown): TipoGuia[] {
        const lista = (Array.isArray(tipos) ? tipos : []).filter((t): t is TipoGuia => t === TIPO_ICMS_ST || t === TIPO_DIFAL);
        if (!lista.length) throw new BadRequestException('Selecione ao menos uma guia.');
        return [...new Set(lista)];
    }

    async gerar(numero: string, empresa: string | undefined, tipos: unknown) {
        const tps = this.tiposValidos(tipos);
        const { nota } = await this.carregarNota(numero, empresa);
        const cfg = configGnre();
        const { xml, infos } = montarLote(nota, cfg, tps);
        return { xml, xmlBonito: prettyXml(xml), infos, erros: validarLote(nota, cfg, tps) };
    }

    // ------------------------------------------------------------- transmitir
    async transmitir(numero: string, empresa: string | undefined, tipos: unknown, usuario?: string) {
        const tps = this.tiposValidos(tipos);
        const { registro, nota } = await this.carregarNota(numero, empresa);
        const cfg = configGnre();
        const { xml, infos } = montarLote(nota, cfg, tps);
        const erros = validarLote(nota, cfg, tps);
        if (erros.length) throw new BadRequestException('XML inválido:\n' + erros.join('\n'));

        const cli = await this.cliente(cfg, nota.emitente.cnpj);
        this.logger.log(`Transmitindo GNRE da NF ${nota.numero} (${tps.join('+')}) por ${usuario || '?'}.`);
        const env = await cli.enviarLote(xml);
        let resultado: RespostaGnre | null = null;
        if (env.codigo === '100' && env.numeroRecibo) {
            await sleep(3000);
            resultado = await this.consultarComRetentativa(cli, env.numeroRecibo);
        }
        await this.registrarTransmissao(env, resultado, infos, nota, registro, cfg, usuario);

        const saida: any = {
            env: { codigo: env.codigo, descricao: env.descricao, situacao: env.situacao, recibo: env.numeroRecibo },
            resultado: null,
            guiaId: null,
        };
        if (env.codigo !== '100') {
            saida.mensagem = `Lote não recebido (código ${env.codigo}${env.descricao ? ` — ${env.descricao}` : ''}).`;
            return saida;
        }
        if (!resultado) {
            saida.mensagem = `Lote recebido (recibo ${env.numeroRecibo}). O resultado ainda não retornou; reconsulte depois em Guias emitidas.`;
            return saida;
        }
        saida.resultado = {
            situacaoGuia: resultado.situacaoGuia,
            situacaoTexto: situacaoGuiaTexto(resultado.situacaoGuia),
            linhaDigitavel: resultado.linhaDigitavel,
            motivos: resultado.motivos,
        };
        if (resultado.situacaoGuia !== '0') {
            saida.mensagem = 'Guia rejeitada — veja os motivos.';
            return saida;
        }
        const [row] = await this.listarGuias({ recibo: env.numeroRecibo! });
        saida.guiaId = row?.id ?? null;
        try {
            if (row) await this.arquivar(row);
            saida.mensagem = 'Guia gerada com sucesso. PDF salvo no arquivo fiscal.';
        } catch (e) {
            saida.mensagem = `Guia gerada, mas falhou ao salvar o PDF: ${msg(e)}. Use "PDF" em Guias emitidas para tentar de novo.`;
        }
        return saida;
    }

    private async consultarComRetentativa(cli: GnreClient, recibo: string): Promise<RespostaGnre | null> {
        let r: RespostaGnre | null = null;
        for (let i = 0; i < 5; i += 1) {
            try {
                r = await cli.consultarResultado(recibo);
                if (r.codigo !== '501') break; // 501 = ainda processando
            } catch {
                /* tenta de novo */
            }
            await sleep(4000);
        }
        return r;
    }

    /** Certificado vinculado (tela de NFS-e) cuja raiz de CNPJ é a do emitente da nota. */
    private async certificadoDaRaiz(cnpj: string | null | undefined) {
        const raiz = (cnpj || '').replace(/\D/g, '').slice(0, 8);
        if (raiz.length !== 8) return null;
        const certs = await this.prisma.nfseCertificado.findMany({ where: { ativo: true }, orderBy: { atualizado_em: 'desc' } });
        return certs.find((c) => c.cnpj.replace(/\D/g, '').startsWith(raiz)) ?? null;
    }

    private async cliente(cfg: GnreConfig, cnpjEmitente: string | null) {
        const cert = await this.certificadoDaRaiz(cnpjEmitente);
        if (!cert) {
            throw new BadRequestException(
                `Nenhum certificado A1 do CNPJ ${cnpjEmitente || '?'} vinculado. Vincule em Fiscal → Notas de Serviço → Certificado.`,
            );
        }
        return new GnreClient(cfg, { pfx: Buffer.from(cert.arquivo), passphrase: decifrar(cert.senha) });
    }

    // --------------------------------------------------------------- histórico
    private async inserirGuia(g: {
        numeroNf: string; serie?: string; empresa?: number; chave?: string; tipo?: string; receita?: string;
        uf?: string; valorTotal?: string; vencimento?: string; recibo?: string | null; situacaoGuia?: string | null;
        situacaoDesc?: string; linhaDigitavel?: string | null; codigoBarras?: string | null; motivos?: string[][];
        resultadoXml?: string; usuario?: string;
    }) {
        await this.prisma.$executeRawUnsafe(
            `INSERT INTO com_gnre_guia (numero_nf, serie, empresa, chave_nfe, tipo, receita, uf, valor_total, vencimento,
                recibo, situacao_guia, situacao_desc, linha_digitavel, codigo_barras, motivos, resultado_xml, usuario)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::date,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
            String(g.numeroNf ?? ''),
            g.serie || null,
            g.empresa ?? null,
            g.chave || null,
            g.tipo || null,
            g.receita || null,
            g.uf || null,
            g.valorTotal || null,
            g.vencimento || null,
            g.recibo || null,
            g.situacaoGuia || null,
            g.situacaoDesc || null,
            g.linhaDigitavel || null,
            g.codigoBarras || null,
            JSON.stringify(g.motivos || []),
            g.resultadoXml || null,
            g.usuario || null,
        );
    }

    private async registrarTransmissao(
        env: RespostaGnre, resultado: RespostaGnre | null, infos: InfoGuia[], nota: Nota,
        registro: RegistroErp, cfg: GnreConfig, usuario?: string,
    ) {
        const base = { numeroNf: nota.numero, serie: nota.serie, empresa: registro.empresa, chave: nota.chave, recibo: env.numeroRecibo, usuario };
        let guias: ReturnType<typeof parseGuias> = [];
        try {
            guias = resultado ? parseGuias(resultado.raw) : [];
        } catch {
            guias = [];
        }
        if (guias.length) {
            for (const g of guias) {
                await this.inserirGuia({
                    ...base, tipo: RECEITA_TIPO[g.receita] || '', receita: g.receita, uf: g.ufFavorecida,
                    valorTotal: g.valorTotal, vencimento: g.dataVencimento, situacaoGuia: g.situacaoGuia,
                    situacaoDesc: situacaoGuiaTexto(g.situacaoGuia), linhaDigitavel: g.linhaDigitavel,
                    codigoBarras: g.codigoBarras, motivos: resultado!.motivos, resultadoXml: resultado!.raw,
                });
            }
            return;
        }
        for (const info of infos) {
            await this.inserirGuia({
                ...base, tipo: info.tipo, receita: info.receita, uf: cfg.gnre.ufFavorecida, valorTotal: info.valorTotal,
                vencimento: info.vencimento, situacaoGuia: null,
                situacaoDesc: env.codigo === '100' ? 'Aguardando processamento' : `Lote não recebido (${env.codigo})`,
                motivos: resultado?.motivos ?? env.motivos, resultadoXml: resultado?.raw ?? env.raw,
            });
        }
    }

    async listarGuias(f: { nf?: string; nfExata?: string; recibo?: string; empresa?: number; id?: number } = {}): Promise<GuiaRow[]> {
        const where: string[] = [];
        const params: unknown[] = [];
        const add = (sql: string, v: unknown) => {
            params.push(v);
            where.push(sql.replace('?', `$${params.length}`));
        };
        if (f.id) add('id = ?', f.id);
        if (f.nf) add('numero_nf LIKE ?', `%${f.nf.replace(/\D/g, '')}%`);
        if (f.nfExata) add('numero_nf = ?', f.nfExata);
        if (f.recibo) add('recibo = ?', f.recibo);
        if (f.empresa) add('empresa = ?', f.empresa);
        const rows = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT id, to_char(criado_em AT TIME ZONE 'America/Cuiaba', 'YYYY-MM-DD HH24:MI:SS') AS criado_em,
                    numero_nf, serie, empresa, chave_nfe, tipo, receita, uf, valor_total::text AS valor_total,
                    to_char(vencimento, 'YYYY-MM-DD') AS vencimento, recibo, situacao_guia, situacao_desc,
                    linha_digitavel, codigo_barras, motivos, resultado_xml, minio_bucket, minio_key,
                    esc_documento_id, usuario
             FROM com_gnre_guia ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY id DESC LIMIT 500`,
            ...params,
        );
        return rows.map((r) => ({
            ...r,
            id: Number(r.id),
            empresa: r.empresa == null ? null : Number(r.empresa),
            esc_documento_id: r.esc_documento_id == null ? null : Number(r.esc_documento_id),
            motivos: Array.isArray(r.motivos) ? r.motivos : [],
        }));
    }

    /** Lista para a tela (sem o XML de resultado). */
    async listarParaTela(nf?: string) {
        const rows = await this.listarGuias({ nf: nf || undefined });
        return rows.map(({ resultado_xml, ...r }) => ({
            ...r,
            situacao_texto: r.situacao_guia ? situacaoGuiaTexto(r.situacao_guia) : r.situacao_desc,
            tem_barras: !!r.codigo_barras,
            tem_pdf: !!r.minio_key,
        }));
    }

    private async obterGuia(id: number) {
        if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('id inválido');
        const [g] = await this.listarGuias({ id });
        if (!g) throw new NotFoundException('Guia não encontrada.');
        return g;
    }

    async reconsultar(id: number) {
        const g = await this.obterGuia(id);
        if (!g.recibo) throw new BadRequestException('Registro sem número de recibo.');
        const cfg = configGnre();
        const cli = await this.cliente(cfg, g.chave_nfe ? g.chave_nfe.slice(6, 20) : CNPJ_RAIZ_PADRAO);
        const r = await this.consultarComRetentativa(cli, g.recibo);
        if (!r) throw new BadRequestException('Sem resposta do servidor da GNRE.');
        let gs: ReturnType<typeof parseGuias> = [];
        try {
            gs = parseGuias(r.raw);
        } catch {
            gs = [];
        }
        const gg = gs.find((x) => x.receita === g.receita) || gs[0] || null;
        await this.prisma.$executeRawUnsafe(
            `UPDATE com_gnre_guia SET situacao_guia=$1, situacao_desc=$2, linha_digitavel=$3, codigo_barras=$4,
                motivos=$5::jsonb, resultado_xml=$6, atualizado_em=now() WHERE id=$7`,
            gg?.situacaoGuia || null,
            r.descricao || null,
            gg?.linhaDigitavel || null,
            gg?.codigoBarras || null,
            JSON.stringify(r.motivos),
            r.raw,
            id,
        );
        let mensagem = situacaoGuiaTexto(gg?.situacaoGuia) || r.descricao || `código ${r.codigo}`;
        if (gg?.situacaoGuia === '0' && !g.minio_key) {
            try {
                await this.arquivar(await this.obterGuia(id));
                mensagem += ' — PDF salvo no arquivo fiscal.';
            } catch (e) {
                mensagem += ` — falhou ao salvar o PDF: ${msg(e)}`;
            }
        }
        return { situacaoGuia: gg?.situacaoGuia ?? '', situacaoTexto: situacaoGuiaTexto(gg?.situacaoGuia), mensagem };
    }

    /** Guia já transmitida (por fora ou em outra máquina), adicionada pelo número do recibo. */
    async importarRecibo(recibo: string, usuario?: string) {
        const rec = String(recibo || '').replace(/\D/g, '');
        if (!rec) throw new BadRequestException('Informe o número do recibo.');
        const cfg = configGnre();
        const cli = await this.cliente(cfg, CNPJ_RAIZ_PADRAO);
        const r = await this.consultarComRetentativa(cli, rec);
        if (!r) throw new BadRequestException('Sem resposta do servidor da GNRE.');
        let gs: ReturnType<typeof parseGuias> = [];
        try {
            gs = parseGuias(r.raw);
        } catch {
            gs = [];
        }
        if (!gs.length) throw new BadRequestException(`Recibo consultado (código ${r.codigo}), mas sem guia no retorno. ${r.descricao || ''}`);
        for (const g of gs) {
            await this.inserirGuia({
                numeroNf: g.docOrigem, empresa: EMPRESA_PADRAO, tipo: RECEITA_TIPO[g.receita] || '', receita: g.receita,
                uf: g.ufFavorecida, valorTotal: g.valorTotal, vencimento: g.dataVencimento, recibo: rec,
                situacaoGuia: g.situacaoGuia, situacaoDesc: situacaoGuiaTexto(g.situacaoGuia),
                linhaDigitavel: g.linhaDigitavel, codigoBarras: g.codigoBarras, motivos: r.motivos, resultadoXml: r.raw, usuario,
            });
        }
        const [row] = await this.listarGuias({ recibo: rec });
        if (row?.codigo_barras) await this.arquivar(row).catch((e) => this.logger.warn(`PDF do recibo ${rec}: ${msg(e)}`));
        return { importadas: gs.length };
    }

    // ----------------------------------------------------- PDF / arquivo fiscal
    /**
     * Gera o PDF do recibo, grava no MinIO (bucket do arquivo fiscal) e registra
     * em esc_documento — assim a guia aparece em /fiscal/arquivos e no export
     * em lote. Um PDF por recibo (o lote pode ter ST + DIFAL): todas as linhas do
     * recibo apontam para o mesmo objeto. Idempotente pelo client_id.
     */
    private async arquivar(g: GuiaRow) {
        if (!g.resultado_xml || !g.codigo_barras || !g.recibo) {
            throw new BadRequestException('Guia sem código de barras (não processada). Use "Reconsultar".');
        }
        const pdf = await gerarPdfGuia(g.resultado_xml, g.chave_nfe);
        const data = g.vencimento || hojeIso();
        const [ano, mes] = data.split('-');
        const nome = `gnre_nf${g.numero_nf}_${g.recibo}.pdf`;
        const key = `${ano}/${mes}/${TIPO_ARQUIVO}/${nome}`;
        await minioClient().putObject(BUCKET_FISCAL, key, pdf, pdf.length, { 'Content-Type': 'application/pdf' });

        const guias = parseGuias(g.resultado_xml);
        const tipos = [...new Set(guias.map((x) => (RECEITA_TIPO[x.receita] === TIPO_DIFAL ? 'DIFAL' : 'ICMS-ST')))].join(' + ');
        const dest = guias[0]?.dest.razao;
        const descricao = [`GNRE ${tipos} ${g.uf || ''}`.trim(), `recibo ${g.recibo}`, dest].filter(Boolean).join(' · ').slice(0, 200);

        const [doc] = await this.prisma.$queryRawUnsafe<{ id: bigint }[]>(
            `INSERT INTO esc_documento (tipo, data_documento, descricao, minio_bucket, minio_key, nome_arquivo,
                tamanho_bytes, client_id, nf_numero, chave_nfe)
             VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (client_id) DO UPDATE SET minio_key = EXCLUDED.minio_key, tamanho_bytes = EXCLUDED.tamanho_bytes,
                descricao = EXCLUDED.descricao
             RETURNING id`,
            TIPO_ARQUIVO, data, descricao, BUCKET_FISCAL, key, nome, pdf.length, `gnre-${g.recibo}`,
            g.numero_nf, g.chave_nfe,
        );
        await this.prisma.$executeRawUnsafe(
            `UPDATE com_gnre_guia SET minio_bucket=$1, minio_key=$2, esc_documento_id=$3, atualizado_em=now() WHERE recibo=$4`,
            BUCKET_FISCAL, key, Number(doc.id), g.recibo,
        );
        return { bucket: BUCKET_FISCAL, key, pdf };
    }

    /** PDF da guia: do MinIO; se ainda não foi arquivado, gera e arquiva agora. */
    async pdf(id: number): Promise<{ stream: Readable; fileName: string }> {
        const g = await this.obterGuia(id);
        const fileName = `gnre_nf${g.numero_nf}_${g.recibo}.pdf`;
        if (g.minio_key) {
            try {
                return { stream: await minioClient().getObject(g.minio_bucket || BUCKET_FISCAL, g.minio_key), fileName };
            } catch (e) {
                this.logger.warn(`PDF da guia ${id} sumiu do MinIO (${msg(e)}); gerando de novo.`);
            }
        }
        const { pdf } = await this.arquivar(g);
        return { stream: Readable.from(pdf), fileName };
    }

    /** Arquiva os PDFs das guias processadas que ainda não estão no MinIO (ex.: histórico importado do app). */
    async arquivarPendentes() {
        const rows = await this.prisma.$queryRawUnsafe<{ id: bigint }[]>(
            `SELECT DISTINCT ON (recibo) id FROM com_gnre_guia
             WHERE minio_key IS NULL AND situacao_guia = '0' AND codigo_barras IS NOT NULL AND recibo IS NOT NULL
             ORDER BY recibo, id DESC`,
        );
        const falhas: string[] = [];
        for (const r of rows) {
            try {
                await this.arquivar(await this.obterGuia(Number(r.id)));
            } catch (e) {
                falhas.push(`guia ${r.id}: ${msg(e)}`);
            }
        }
        return { total: rows.length, arquivadas: rows.length - falhas.length, falhas };
    }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Pretty-print simples para a pré-visualização do lote. */
function prettyXml(xml: string): string {
    let out = '';
    let pad = 0;
    xml.replace(/>\s*</g, '><').split(/(?=<)/).forEach((node) => {
        if (/^<\/\w/.test(node)) pad -= 1;
        out += '  '.repeat(Math.max(pad, 0)) + node + '\n';
        if (/^<\w[^>]*[^/]>$/.test(node) && !/^<.*<\/.*>$/.test(node)) pad += 1;
    });
    return out.trim();
}
