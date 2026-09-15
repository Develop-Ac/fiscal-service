import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { minioClient } from '../shared/minio/minio-client';

export interface EscDocumentoRow {
    id: number;
    tipo: string;
    tipo_label: string;
    data_documento: string;
    descricao: string | null;
    nome_arquivo: string | null;
    tamanho_bytes: number | null;
    nf_numero: string | null;
    chave_nfe: string | null;
    fornecedor_nome: string | null;
    fornecedor_cnpj: string | null;
    criado_em: string;
}

export interface ListFilters {
    from?: string;
    to?: string;
    tipo?: string;
    q?: string;
    page: number;
    pageSize: number;
}

/** Rótulos amigáveis dos tipos gravados pelo escaner-fiscal-app. */
const TIPO_LABELS: Record<string, string> = {
    'nao-fiscal': 'Não fiscal',
    'recibo': 'Recibo',
    'cupom-fiscal': 'Cupom fiscal',
    'comprovante-outros': 'Comprovante/Outros',
    'conta-consumo': 'Conta de consumo',
    'guia-icms-st': 'Guia ICMS-ST',
    'guia-gnre': 'Guia GNRE (venda)',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A tabela esc_documento é compartilhada por dois apps de scan: o Movimento Fiscal
 * (scanfiscal) e o SAC (scansac, tipos ni / ni-garantia / nota-devolucao...). O que
 * separa os dois acervos é a coluna minio_bucket, gravada por linha. Esta tela é só
 * do fiscal, então toda consulta restringe ao bucket fiscal — o nome segue o default
 * do escaner-fiscal-app (MINIO_BUCKET de lá) e pode ser sobreposto por env.
 */
export const BUCKET_FISCAL = (process.env.ESCANER_BUCKET_FISCAL || 'movimento-fiscal').trim();

/** Descrição vira sufixo do nome: sem acento, só [a-z0-9-], no máximo este tanto. */
const DESCRICAO_MAX = 40;

/** "Conta de luz — Energisa" -> "conta-de-luz-energisa" (cortado em DESCRICAO_MAX). */
export function slugDescricao(descricao: string | null | undefined): string {
    const s = String(descricao ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (s.length <= DESCRICAO_MAX) return s;
    // corta no último hífen antes do limite (não deixa palavra pela metade, se der)
    const cut = s.slice(0, DESCRICAO_MAX);
    const h = cut.lastIndexOf('-');
    return (h >= DESCRICAO_MAX / 2 ? cut.slice(0, h) : cut).replace(/-+$/, '');
}

export interface EntradaZip {
    tipo: string;
    nomeArquivo: string;
    dataDocumento?: string | null;
    descricao?: string | null;
    nfNumero?: string | null;
    fornecedorNome?: string | null;
}

/**
 * Nome de cada PDF dentro do zip. O `nome_arquivo` gravado pelo app é só
 * data + tipo (+ NF + nº de páginas), então documentos do mesmo dia e tipo saem
 * com o MESMO nome e sobrescrevem um ao outro ao extrair. Regra:
 *   - guia de ICMS-ST com nota: `guia-icms-st-<NF>-<fornecedor>_<data>[_Np]` — o
 *     fiscal localiza a guia pela nota/fornecedor, não pela data;
 *   - demais: `<nome_arquivo>[_<descricao-slug>]` (slug limitado a DESCRICAO_MAX);
 *   - o que ainda colidir dentro da mesma pasta (tipo/) ganha `_01`, `_02`... —
 *     na prática, os sem descrição do mesmo dia saem numerados.
 * Devolve na mesma ordem das entradas.
 */
export function nomesNoZip(entries: EntradaZip[]): string[] {
    const bases = entries.map((e) => {
        const base = e.nomeArquivo.replace(/\.pdf$/i, '');
        const slug = slugDescricao(e.descricao);
        const nf = String(e.nfNumero ?? '').replace(/\D/g, '');
        let nome: string;
        if (e.tipo === 'guia-icms-st' && nf) {
            const forn = slugDescricao(e.fornecedorNome);
            const paginas = (base.match(/_(\d+p)$/) ?? [])[1];
            nome =
                `guia-icms-st-${nf}` +
                (forn ? `-${forn}` : '') +
                (e.dataDocumento ? `_${e.dataDocumento}` : '') +
                (paginas ? `_${paginas}` : '') +
                (slug ? `_${slug}` : '');
        } else {
            nome = slug ? `${base}_${slug}` : base;
        }
        return `${e.tipo}/${nome}`;
    });
    const total = new Map<string, number>();
    for (const b of bases) total.set(b, (total.get(b) ?? 0) + 1);
    const seq = new Map<string, number>();
    return bases.map((b) => {
        const n = total.get(b) ?? 1;
        if (n === 1) return `${b}.pdf`;
        const i = (seq.get(b) ?? 0) + 1;
        seq.set(b, i);
        const width = Math.max(2, String(n).length);
        return `${b}_${String(i).padStart(width, '0')}.pdf`;
    });
}

/**
 * Documentos do Movimento Fiscal (escaner-fiscal-app): leitura de esc_documento
 * + download/export dos PDFs no MinIO (bucket movimento-fiscal, gravado por linha).
 * Somente leitura — o arquivo fiscal não se apaga por aqui.
 */
@Injectable()
export class EscanerService {
    private readonly logger = new Logger(EscanerService.name);
    private readonly minioBucket = process.env.MINIO_BUCKET || 'documentos';

    constructor(private readonly prisma: PrismaService) {}

    async listDocumentos(filters: ListFilters) {
        const where: string[] = [];
        const params: unknown[] = [];
        const add = (sql: string, value: unknown) => {
            params.push(value);
            where.push(sql.replace('?', `$${params.length}`));
        };

        add('minio_bucket = ?', BUCKET_FISCAL);
        if (filters.from && ISO_DATE.test(filters.from)) add('data_documento >= ?::date', filters.from);
        if (filters.to && ISO_DATE.test(filters.to)) add('data_documento <= ?::date', filters.to);
        if (filters.tipo) add('tipo = ?', filters.tipo);
        if (filters.q) {
            params.push(`%${filters.q}%`);
            const p = `$${params.length}`;
            where.push(
                `(descricao ILIKE ${p} OR nome_arquivo ILIKE ${p} OR nf_numero ILIKE ${p} OR fornecedor_nome ILIKE ${p} OR fornecedor_cnpj ILIKE ${p})`,
            );
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const offset = (filters.page - 1) * filters.pageSize;

        try {
            const countRows = await this.prisma.$queryRawUnsafe<{ total: bigint }[]>(
                `SELECT COUNT(*)::bigint AS total FROM esc_documento ${whereSql}`,
                ...params,
            );
            const total = Number(countRows[0]?.total ?? 0);

            const rows = await this.prisma.$queryRawUnsafe<any[]>(
                `
                SELECT
                    id, tipo,
                    -- DATE direto vira meia-noite local e o fuso empurra o dia p/ trás
                    to_char(data_documento, 'YYYY-MM-DD') AS data_documento,
                    descricao, nome_arquivo, tamanho_bytes,
                    nf_numero, chave_nfe, fornecedor_nome, fornecedor_cnpj,
                    to_char(criado_em, 'YYYY-MM-DD"T"HH24:MI:SS') AS criado_em
                FROM esc_documento
                ${whereSql}
                ORDER BY data_documento DESC, criado_em DESC
                LIMIT ${filters.pageSize} OFFSET ${offset}
                `,
                ...params,
            );

            const documentos: EscDocumentoRow[] = rows.map((r) => ({
                id: Number(r.id),
                tipo: String(r.tipo ?? ''),
                tipo_label: TIPO_LABELS[String(r.tipo ?? '')] ?? String(r.tipo ?? ''),
                data_documento: String(r.data_documento ?? ''),
                descricao: r.descricao ?? null,
                nome_arquivo: r.nome_arquivo ?? null,
                tamanho_bytes: r.tamanho_bytes == null ? null : Number(r.tamanho_bytes),
                nf_numero: r.nf_numero ?? null,
                chave_nfe: r.chave_nfe ?? null,
                fornecedor_nome: r.fornecedor_nome ?? null,
                fornecedor_cnpj: r.fornecedor_cnpj ?? null,
                criado_em: String(r.criado_em ?? ''),
            }));

            return { total, page: filters.page, pageSize: filters.pageSize, documentos };
        } catch (error) {
            if (this.semTabelaDoScan(error)) {
                return { total: 0, page: filters.page, pageSize: filters.pageSize, documentos: [] };
            }
            throw error;
        }
    }

    /** Tipos existentes no arquivo (para o filtro da tela). */
    async listTipos() {
        try {
            const rows = await this.prisma.$queryRawUnsafe<{ tipo: string; total: bigint }[]>(
                `SELECT tipo, COUNT(*)::bigint AS total FROM esc_documento WHERE minio_bucket = $1 GROUP BY tipo ORDER BY tipo`,
                BUCKET_FISCAL,
            );
            return rows.map((r) => ({
                tipo: r.tipo,
                label: TIPO_LABELS[r.tipo] ?? r.tipo,
                total: Number(r.total),
            }));
        } catch (error) {
            if (this.semTabelaDoScan(error)) return [];
            throw error;
        }
    }

    /** Stream do PDF de um documento. */
    async downloadDocumento(id: number) {
        const idNum = Number(id);
        if (!Number.isInteger(idNum) || idNum <= 0) return null;

        let rows: any[] = [];
        try {
            rows = await this.prisma.$queryRawUnsafe<any[]>(
                `SELECT minio_bucket, minio_key, nome_arquivo FROM esc_documento WHERE id = $1 AND minio_bucket = $2`,
                idNum,
                BUCKET_FISCAL,
            );
        } catch (error) {
            if (this.semTabelaDoScan(error)) return null;
            throw error;
        }

        const doc = rows[0];
        if (!doc?.minio_key) return null;

        const stream = await minioClient().getObject(doc.minio_bucket || this.minioBucket, doc.minio_key);
        const fileName = String(doc.nome_arquivo || `documento-${idNum}.pdf`);
        return { stream, fileName };
    }

    /** Documentos do período para o export em lote (zip). */
    async listParaExport(filters: { from?: string; to?: string; tipo?: string }) {
        const where: string[] = [];
        const params: unknown[] = [];
        const add = (sql: string, value: unknown) => {
            params.push(value);
            where.push(sql.replace('?', `$${params.length}`));
        };
        add('minio_bucket = ?', BUCKET_FISCAL);
        if (filters.from && ISO_DATE.test(filters.from)) add('data_documento >= ?::date', filters.from);
        if (filters.to && ISO_DATE.test(filters.to)) add('data_documento <= ?::date', filters.to);
        if (filters.tipo) add('tipo = ?', filters.tipo);
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        try {
            const rows = await this.prisma.$queryRawUnsafe<any[]>(
                `
                SELECT id, tipo, to_char(data_documento, 'YYYY-MM-DD') AS data_documento,
                       minio_bucket, minio_key, nome_arquivo, descricao, nf_numero, fornecedor_nome
                FROM esc_documento
                ${whereSql}
                ORDER BY data_documento, id
                `,
                ...params,
            );
            const entries = rows.map((r) => ({
                id: Number(r.id),
                tipo: String(r.tipo ?? ''),
                dataDocumento: String(r.data_documento ?? ''),
                bucket: String(r.minio_bucket || this.minioBucket),
                key: String(r.minio_key ?? ''),
                nomeArquivo: String(r.nome_arquivo || `documento-${r.id}.pdf`),
                descricao: r.descricao == null ? '' : String(r.descricao),
                nfNumero: r.nf_numero == null ? '' : String(r.nf_numero),
                fornecedorNome: r.fornecedor_nome == null ? '' : String(r.fornecedor_nome),
            }));
            const nomes = nomesNoZip(entries);
            return entries.map((e, i) => ({ ...e, nomeNoZip: nomes[i] }));
        } catch (error) {
            if (this.semTabelaDoScan(error)) return [];
            throw error;
        }
    }

    getObjectStream(bucket: string, key: string) {
        return minioClient().getObject(bucket, key);
    }

    /** Instalações sem o DDL do scan aplicado: devolve vazio em vez de 500. */
    private semTabelaDoScan(error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        const ausente = /esc_documento/i.test(msg) && /(does not exist|não existe|nao existe|42P01)/i.test(msg);
        if (ausente) {
            this.logger.warn(`esc_documento indisponível — documentos do scan não listados (${msg}).`);
        }
        return ausente;
    }
}
