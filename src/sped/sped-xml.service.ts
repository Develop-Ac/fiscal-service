import { Injectable, Logger } from '@nestjs/common';
import * as zlib from 'zlib';
import { PrismaService } from '../prisma/prisma.service';
import { OpenQueryService } from '../shared/database/openquery/openquery.service';

export interface XmlAchado {
    xml: string;
    /** NF_SAIDA guarda documento e protocolo separados; juntamos no envelope. */
    protocolo: string | null;
    fonte: string;
}

/**
 * Busca do XML por chave de acesso, para os documentos que estão no SPED.
 *
 * O arquivo do SPED só guarda a chave — o XML tem que vir de outro lugar. A busca
 * é em cascata e para na primeira fonte que responder:
 *
 *   NF-e   1. Postgres  com_nfe_conciliacao   2. ERP NF_ENTRADA_XML   3. ERP NF_SAIDA
 *   CT-e   1. Postgres  com_cte_documento     2. ERP CTE_ENTRADA_XML
 *
 * `NF_SAIDA` entra na lista porque nota DE ENTRADA emitida pela própria empresa
 * (devolução de cliente não contribuinte) só existe lá. O Postgres sozinho cobre
 * pouco mais da metade das entradas: a `com_nfe_conciliacao` é alimentada pelo
 * fluxo de conciliação de ST/DIFAL e não recebe transferência nem devolução.
 */
@Injectable()
export class SpedXmlService {
    private readonly logger = new Logger(SpedXmlService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly openQuery: OpenQueryService,
    ) { }

    /**
     * XML pode vir em texto puro ou gzip+base64.
     *
     * Dois detalhes que custam caro se forem ignorados: o ERP devolve o blob em
     * chunks e o base64 chega COM QUEBRAS DE LINHA no meio (sem tirar o
     * whitespace o buffer sai errado); e alguns registros vêm com o encode
     * aplicado DUAS vezes, daí o laço em vez de uma passada só.
     *
     * Devolve '' quando o resultado não é XML: melhor não exportar do que gravar
     * um arquivo com base64 dentro achando que é nota fiscal.
     */
    decodificarXml(valor: unknown): string {
        if (valor == null) return '';
        let t = (Buffer.isBuffer(valor) ? valor.toString('utf8') : String(valor)).trim();
        for (let volta = 0; volta < 4; volta++) {
            if (!t) return '';
            if (t.startsWith('<')) return t;
            try {
                t = zlib.gunzipSync(Buffer.from(t.replace(/\s+/g, ''), 'base64')).toString('utf8').trim();
            } catch {
                return '';
            }
        }
        return '';
    }

    /** Junta documento e protocolo num envelope nfeProc/cteProc. */
    montarProc(xmlDoc: string, xmlProt: string): string {
        const doc = xmlDoc.replace(/<\?xml[^>]*\?>/i, '').trim();
        const prot = xmlProt.replace(/<\?xml[^>]*\?>/i, '').trim();
        const eCte = /<CTe[\s>]/i.test(doc);
        const tag = eCte ? 'cteProc' : 'nfeProc';
        const ns = eCte ? 'http://www.portalfiscal.inf.br/cte' : 'http://www.portalfiscal.inf.br/nfe';
        const versao = (/versao="([\d.]+)"/i.exec(doc) || [, '4.00'])[1];
        return (
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<${tag} xmlns="${ns}" versao="${versao}">${doc}${prot}</${tag}>`
        );
    }

    /** Documento pronto para gravar: com protocolo embutido quando houver. */
    xmlFinal(achado: XmlAchado): string {
        if (achado.protocolo && !/<nfeProc|<cteProc/i.test(achado.xml)) {
            return this.montarProc(achado.xml, achado.protocolo);
        }
        return achado.xml;
    }

    /** Postgres da intranet — as duas tabelas de espelho. */
    async buscarNoPostgres(chavesNfe: string[], chavesCte: string[]): Promise<Map<string, XmlAchado>> {
        const achados = new Map<string, XmlAchado>();

        if (chavesNfe.length) {
            const rows = await this.prisma.nfeConciliacao.findMany({
                where: { chave_nfe: { in: chavesNfe } },
                select: { chave_nfe: true, xml_completo: true },
            });
            for (const r of rows) {
                const xml = this.decodificarXml(r.xml_completo);
                if (xml) achados.set(r.chave_nfe, { xml, protocolo: null, fonte: 'postgres:com_nfe_conciliacao' });
            }
        }

        if (chavesCte.length) {
            const rows = await this.prisma.cteDocumento.findMany({
                where: { chave_acesso: { in: chavesCte } },
                select: { chave_acesso: true, xml_completo: true },
            });
            for (const r of rows) {
                const xml = this.decodificarXml(r.xml_completo);
                if (xml) achados.set(r.chave_acesso, { xml, protocolo: null, fonte: 'postgres:com_cte_documento' });
            }
        }

        return achados;
    }

    /**
     * ERP (Firebird, alcançado pelo linked server CONSULTA no SQL Server do BI).
     *
     * A IN-list vai em lotes pequenos: o provider OLE DB derruba a consulta quando
     * a lista fica grande. Lote que falha não derruba a exportação — as chaves
     * daquele lote apenas continuam pendentes e aparecem como "sem XML".
     */
    async buscarNoErp(
        chavesNfe: string[],
        chavesCte: string[],
        opcoes: { empresa: number; tamanhoLote?: number; onProgresso?: (rotulo: string) => void },
    ): Promise<Map<string, XmlAchado>> {
        const achados = new Map<string, XmlAchado>();
        const lote = Math.max(1, Number(opcoes.tamanhoLote || 40));
        const empresa = Number(opcoes.empresa || 1);

        const consultas = [
            {
                fonte: 'erp:NF_ENTRADA_XML',
                chaves: chavesNfe,
                sql: (lista: string) =>
                    `SELECT X.CHAVE_NFE, X.XML_COMPLETO FROM NF_ENTRADA_XML X ` +
                    `WHERE X.EMPRESA = ${empresa} AND X.CHAVE_NFE IN (${lista})`,
                chave: (r: any) => r.CHAVE_NFE,
                xml: (r: any) => this.decodificarXml(r.XML_COMPLETO),
                protocolo: () => null as string | null,
            },
            {
                fonte: 'erp:NF_SAIDA',
                chaves: chavesNfe,
                sql: (lista: string) =>
                    `SELECT S.CHAVE_NFE, S.XML_NFE, S.XML_PROTOCOLO_NFE FROM NF_SAIDA S ` +
                    `WHERE S.EMPRESA = ${empresa} AND S.CHAVE_NFE IN (${lista})`,
                chave: (r: any) => r.CHAVE_NFE,
                xml: (r: any) => this.decodificarXml(r.XML_NFE),
                protocolo: (r: any) => this.decodificarXml(r.XML_PROTOCOLO_NFE) || null,
            },
            {
                fonte: 'erp:CTE_ENTRADA_XML',
                chaves: chavesCte,
                sql: (lista: string) =>
                    `SELECT X.CHAVE_CTE, X.XML_COMPLETO FROM CTE_ENTRADA_XML X ` +
                    `WHERE X.EMPRESA = ${empresa} AND X.CHAVE_CTE IN (${lista})`,
                chave: (r: any) => r.CHAVE_CTE,
                xml: (r: any) => this.decodificarXml(r.XML_COMPLETO),
                protocolo: () => null as string | null,
            },
        ];

        for (const consulta of consultas) {
            const pendentes = consulta.chaves.filter((k) => !achados.has(k));
            if (!pendentes.length) continue;

            for (let i = 0; i < pendentes.length; i += lote) {
                const grupo = pendentes.slice(i, i + lote);
                const lista = grupo.map((k) => `'${k.replace(/\D/g, '')}'`).join(',');
                opcoes.onProgresso?.(`${consulta.fonte} (lote ${Math.floor(i / lote) + 1})`);

                let rows: any[] = [];
                try {
                    rows = await this.openQuery.query<any>(this.oq(consulta.sql(lista)), {}, { allowZeroRows: true });
                } catch (e: any) {
                    this.logger.warn(`${consulta.fonte}: lote de ${grupo.length} falhou — ${e?.message ?? e}`);
                    continue;
                }

                for (const r of rows) {
                    const chave = String(consulta.chave(r) || '').trim();
                    const xml = consulta.xml(r);
                    if (chave && xml && !achados.has(chave)) {
                        achados.set(chave, { xml, protocolo: consulta.protocolo(r), fonte: consulta.fonte });
                    }
                }
            }
        }

        return achados;
    }

    private oq(sqlFirebird: string): string {
        return `SELECT * FROM OPENQUERY(CONSULTA, '${sqlFirebird.replace(/'/g, "''")}')`;
    }
}
