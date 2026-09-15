import { readFileSync } from 'fs';
import * as https from 'https';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';
import { GnreConfig, NS_GNRE } from './gnre-builder';

/**
 * Cliente do webservice GNRE com autenticação mTLS pelo certificado A1.
 *
 * A GNRE 2.00 NÃO exige assinatura XML: a autenticação é o certificado na
 * conexão. O servidor negocia TLS 1.3 e pede o certificado em post-handshake
 * auth, que o Node ignora (vira "198 — use seu Certificado Digital"); por isso
 * TLS 1.2 fixo, onde o certificado é pedido no próprio handshake.
 *
 * www.gnre.pe.gov.br manda só o certificado folha (sem o intermediário
 * Sectigo): a cadeia é validada com o CA bundle próprio em assets/.
 *
 * Operações (SOAP 1.2): recepção "processar" e resultado "consultar".
 */

const NS_RECEP = 'http://www.gnre.pe.gov.br/webservice/GnreLoteRecepcao';
const NS_RESULT = 'http://www.gnre.pe.gov.br/webservice/GnreResultadoLote';
const NS_SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';

const SITUACAO_GUIA: Record<string, string> = {
    '0': 'Processada com sucesso',
    '1': 'Invalidada pelo Portal',
    '2': 'Invalidada pela UF',
    '3': 'Erro de comunicação',
};

export function situacaoGuiaTexto(cod: string | null | undefined): string {
    return (cod != null && SITUACAO_GUIA[cod]) || cod || '';
}

export interface RespostaGnre {
    httpStatus: number;
    situacao: string | null;
    codigo: string | null;
    descricao: string | null;
    numeroRecibo: string | null;
    raw: string;
    situacaoGuia: string | null;
    linhaDigitavel: string | null;
    codigoBarras: string | null;
    /** [codigo, descricao, campo] */
    motivos: string[][];
}

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
});

let caBundle: Buffer | undefined;
function ca(): Buffer | undefined {
    if (!caBundle) {
        try {
            caBundle = readFileSync(join(__dirname, 'assets', 'gnre_cabundle.pem'));
        } catch {
            caBundle = undefined;
        }
    }
    return caBundle;
}

function textOf(v: any): string | null {
    if (v == null) return null;
    if (Array.isArray(v)) return v.length ? textOf(v[0]) : null;
    if (typeof v === 'object') return v['#text'] != null ? String(v['#text']) : null;
    return String(v);
}

/** Primeiro nó com este local-name (busca em largura por nível). */
function findFirst(obj: any, name: string): string | null {
    if (obj == null || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
        for (const it of obj) {
            const r = findFirst(it, name);
            if (r != null) return r;
        }
        return null;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (k === name) {
            const t = textOf(v);
            if (t != null) return t;
        }
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
            const r = findFirst(v, name);
            if (r != null) return r;
        }
    }
    return null;
}

function findAllNodes(obj: any, name: string, out: any[] = []): any[] {
    if (obj == null || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) {
        for (const it of obj) findAllNodes(it, name, out);
        return out;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (k === name) out.push(...(Array.isArray(v) ? v : [v]));
        if (v && typeof v === 'object') findAllNodes(v, name, out);
    }
    return out;
}

/** A SEFAZ às vezes manda texto DUPLO-escapado ("servi&#xE7;o"); o parser só decodifica uma vez. */
function decodeEntities(s: string | null): string | null {
    if (s == null) return s;
    return String(s)
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function envelope(nsWs: string, corpoXml: string, versao: string): string {
    return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<soap:Envelope xmlns:soap="${NS_SOAP12}" xmlns:ws="${nsWs}">` +
        `<soap:Header><ws:gnreCabecMsg><ws:versaoDados>${versao}</ws:versaoDados></ws:gnreCabecMsg></soap:Header>` +
        `<soap:Body><ws:gnreDadosMsg>${corpoXml}</ws:gnreDadosMsg></soap:Body>` +
        '</soap:Envelope>'
    );
}

export function parseResposta(status: number, raw: string): RespostaGnre {
    const resp: RespostaGnre = {
        httpStatus: status,
        situacao: null,
        codigo: null,
        descricao: null,
        numeroRecibo: null,
        raw,
        situacaoGuia: null,
        linhaDigitavel: null,
        codigoBarras: null,
        motivos: [],
    };
    try {
        const doc = parser.parse(raw);
        resp.codigo = findFirst(doc, 'codigo');
        resp.descricao = decodeEntities(findFirst(doc, 'descricao') || findFirst(doc, 'motivo'));
        resp.numeroRecibo = findFirst(doc, 'numeroRecibo') || findFirst(doc, 'numero') || findFirst(doc, 'recibo');
        resp.situacao = decodeEntities(findFirst(doc, 'situacaoRecepcao') || findFirst(doc, 'situacao') || resp.descricao);
        resp.situacaoGuia = findFirst(doc, 'situacaoGuia');
        resp.linhaDigitavel = findFirst(doc, 'linhaDigitavel');
        resp.codigoBarras = findFirst(doc, 'codigoBarras');
        for (const m of findAllNodes(doc, 'motivo')) {
            if (m && typeof m === 'object') {
                resp.motivos.push([
                    findFirst(m, 'codigo') || '',
                    decodeEntities(findFirst(m, 'descricao') || '') || '',
                    findFirst(m, 'campo') || '',
                ]);
            }
        }
    } catch {
        /* retorno não-XML: fica o raw */
    }
    return resp;
}

export class GnreClient {
    private readonly agent: https.Agent;

    constructor(
        private readonly cfg: GnreConfig,
        cert: { pfx: Buffer; passphrase: string },
    ) {
        this.agent = new https.Agent({
            pfx: cert.pfx,
            passphrase: cert.passphrase,
            ca: ca(),
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.2',
            keepAlive: false,
        });
    }

    private post(url: string, nsWs: string, operacao: string, corpoXml: string): Promise<RespostaGnre> {
        const env = Buffer.from(envelope(nsWs, corpoXml, this.cfg.gnre.versaoDados), 'utf8');
        const u = new URL(url);
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    method: 'POST',
                    hostname: u.hostname,
                    port: u.port || 443,
                    path: u.pathname + u.search,
                    agent: this.agent,
                    headers: {
                        'Content-Type': `application/soap+xml;charset=UTF-8;action="${nsWs}/${operacao}"`,
                        'Content-Length': env.length,
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve(parseResposta(res.statusCode || 0, Buffer.concat(chunks).toString('utf8'))));
                },
            );
            req.on('error', reject);
            req.setTimeout(this.cfg.gnre.timeoutSeg * 1000, () => req.destroy(new Error('timeout ao chamar a GNRE')));
            req.end(env);
        });
    }

    /** "processar" — envia o lote (recepção). */
    enviarLote(loteXml: string) {
        return this.post(this.cfg.gnre.urlRecepcao, NS_RECEP, 'processar', loteXml);
    }

    /** "consultar" — <ambiente> ANTES de <numeroRecibo> e SEM atributo versao (senão 149/501). */
    consultarResultado(numeroRecibo: string) {
        const ambiente = this.cfg.gnre.ambiente.toLowerCase().startsWith('homolog') ? '2' : '1';
        const cons =
            `<TConsLote_GNRE xmlns="${NS_GNRE}"><ambiente>${ambiente}</ambiente>` +
            `<numeroRecibo>${String(numeroRecibo).replace(/\D/g, '')}</numeroRecibo></TConsLote_GNRE>`;
        return this.post(this.cfg.gnre.urlResultado, NS_RESULT, 'consultar', cons);
    }
}
