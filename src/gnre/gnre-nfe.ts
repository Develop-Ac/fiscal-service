import { XMLParser } from 'fast-xml-parser';

/**
 * Parser da NF-e de saída (modelo 55) e detecção dos cenários de GNRE.
 *
 * Extrai só o necessário para montar a guia: emitente (substituto/remetente =
 * quem paga), destinatário, identificação da operação e os valores de ICMS-ST
 * e DIFAL. Valores monetários ficam como STRING ("13.65"); a aritmética
 * (principal + FECP) é feita em centavos inteiros.
 */

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
});

export interface Contribuinte {
    cnpj: string | null;
    cpf: string | null;
    ie: string | null;
    nome: string | null;
    indIeDest: string | null;
    uf: string | null;
    codMunicipio: string | null;
    municipio: string | null;
    cep: string | null;
    fone: string | null;
    endereco: string | null;
}

export interface Nota {
    chave: string;
    numero: string;
    serie: string;
    modelo: string;
    emissaoIso: string;
    emissaoData: string;
    idDest: string;
    indFinal: string;
    finNfe: string;
    natOp: string;
    emitente: Contribuinte;
    destinatario: Contribuinte;
    vSt: string;
    vFcpSt: string;
    vIcmsUfDest: string;
    vFcpUfDest: string;
    csts: string[];
    interestadual: boolean;
    destinoContribuinte: boolean;
    temIcmsSt: boolean;
    temDifal: boolean;
}

/** "13.65" -> 1365 centavos. */
export function centavos(txt: string | null | undefined): number {
    if (!txt) return 0;
    const n = Number(String(txt).replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 1365 -> "13.65". */
export function fmtCentavos(c: number): string {
    const sinal = c < 0 ? '-' : '';
    const abs = Math.abs(c);
    return `${sinal}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function txt(v: any): string {
    if (v == null) return '';
    if (typeof v === 'object') return v['#text'] != null ? String(v['#text']) : '';
    return String(v);
}

function endereco(ender: any): string | null {
    if (!ender) return null;
    const partes = [txt(ender.xLgr), txt(ender.nro), txt(ender.xBairro)].filter(Boolean);
    return partes.length ? partes.join(', ') : null;
}

function contribuinte(node: any, ender: any): Contribuinte {
    node = node || {};
    return {
        cnpj: txt(node.CNPJ) || null,
        cpf: txt(node.CPF) || null,
        ie: txt(node.IE) || null,
        nome: txt(node.xNome) || null,
        indIeDest: txt(node.indIEDest) || null,
        uf: ender ? txt(ender.UF) || null : null,
        codMunicipio: ender ? txt(ender.cMun) || null : null,
        municipio: ender ? txt(ender.xMun) || null : null,
        cep: ender ? txt(ender.CEP) || null : null,
        fone: ender ? txt(ender.fone) || null : null,
        endereco: endereco(ender),
    };
}

const asArray = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function parseNfe(xmlText: string): Nota {
    if (!xmlText) throw new Error('XML vazio');
    let texto = xmlText;
    const ini = texto.indexOf('<NFe');
    if (ini > 0) texto = texto.slice(ini);

    const doc = parser.parse(texto);
    const nfe = doc.NFe || doc.nfeProc?.NFe || doc;
    const inf = nfe.infNFe || doc.infNFe;
    if (!inf) throw new Error('infNFe não encontrado no XML');

    const ide = inf.ide || {};
    const emit = inf.emit || {};
    const dest = inf.dest || {};
    const tot = inf.total?.ICMSTot || {};
    const dh = txt(ide.dhEmi) || txt(ide.dEmi) || '';

    const cstSet = new Set<string>();
    for (const det of asArray(inf.det)) {
        const icms = det?.imposto?.ICMS;
        const grp = icms && typeof icms === 'object' ? (Object.values(icms)[0] as any) : null; // ICMS00, ICMS10...
        const cst = grp && typeof grp === 'object' ? txt(grp.CST) || txt(grp.CSOSN) : '';
        if (cst) cstSet.add(cst);
    }

    const vSt = txt(tot.vST) || '0';
    const vFcpSt = txt(tot.vFCPST) || '0';
    const vIcmsUfDest = txt(tot.vICMSUFDest) || '0';
    const vFcpUfDest = txt(tot.vFCPUFDest) || '0';
    const destinatario = contribuinte(dest, dest.enderDest);
    const idDest = txt(ide.idDest);

    return {
        chave: String(inf['@_Id'] || '').replace('NFe', ''),
        numero: txt(ide.nNF),
        serie: txt(ide.serie),
        modelo: txt(ide.mod),
        emissaoIso: dh,
        emissaoData: dh.length >= 10 ? dh.slice(0, 10) : '',
        idDest,
        indFinal: txt(ide.indFinal),
        finNfe: txt(ide.finNFe),
        natOp: txt(ide.natOp),
        emitente: contribuinte(emit, emit.enderEmit),
        destinatario,
        vSt,
        vFcpSt,
        vIcmsUfDest,
        vFcpUfDest,
        csts: [...cstSet],
        interestadual: idDest === '2',
        destinoContribuinte: destinatario.indIeDest === '1',
        temIcmsSt: centavos(vSt) > 0,
        temDifal: centavos(vIcmsUfDest) > 0 || centavos(vFcpUfDest) > 0,
    };
}
