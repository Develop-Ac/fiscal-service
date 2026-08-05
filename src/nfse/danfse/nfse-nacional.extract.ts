import { parseStringPromise } from 'xml2js';
import { municipio } from './municipios';

/**
 * Leitura do XML de NFS-e no PADRÃO NACIONAL (SEFIN Nacional / ADN):
 *
 *   <NFSe versao="1.01" xmlns="http://www.sped.fazenda.gov.br/nfse">
 *     <infNFSe Id="NFS<chave 50 dígitos>"> … <DPS><infDPS> … </infDPS></DPS>
 *
 * Devolve o objeto que o layout do DANFSe v2.0 consome. É deliberadamente
 * separado do `detalhar()` do NfseDistService: aquele alimenta a TELA (campos
 * crus, para inspeção) e este alimenta o DOCUMENTO (rótulos oficiais, valores já
 * formatados). Misturar os dois faria a tela mudar sempre que o layout mudasse.
 */

// Tabelas do leiaute da NFS-e nacional (NT 008/2026). Código não mapeado é
// exibido cru — documento fiscal não pode exibir descrição errada.
const TRIB_ISSQN: Record<number, string> = {
    1: 'Operação tributável',
    2: 'Exportação de serviço',
    3: 'Não incidência',
    4: 'Imunidade',
};
const RET_ISSQN: Record<number, string> = {
    1: 'Não Retido',
    2: 'Retido pelo Tomador',
    3: 'Retido pelo Intermediário',
};
const OPT_SIMPLES: Record<number, string> = {
    1: 'Não optante',
    2: 'Optante - MEI',
    3: 'Optante - ME/EPP',
};
const REG_AP_SN: Record<number, string> = {
    1: 'Regime de apuração dos tributos federais e municipal pelo SN',
    2: 'Regime de apuração dos tributos federais e municipal pelo SN, exceto ISSQN por fora',
    3: 'Regime de apuração com ISSQN fixo',
};
const REG_ESP_TRIB: Record<number, string> = {
    0: 'Nenhum',
    1: 'Ato Cooperado',
    2: 'Estimativa',
    3: 'Microempresa Municipal',
    4: 'Notário ou Registrador',
    5: 'Profissional Autônomo',
    6: 'Sociedade de Profissionais',
};

/** Valor exibível: número, texto numérico ou vazio quando o XML não traz. */
export type Valor = string | number | '';

export interface DanfseParte {
    cnpj: string;
    im: string;
    telefone: string;
    nome: string;
    email: string;
    fantasia?: string;
    endereco: string;
    municipio: string;
    cep: string;
    optanteSimples?: string;
}

export interface DanfseDados {
    municipioEmissor: string;
    regimeApuracaoSN: string;
    complementares: string;

    ambiente: 'producao' | 'homologacao';
    cancelada: boolean;
    chaveAcesso: string;
    numeroNfse: string;
    competencia: string;
    dataEmissao: string;
    numeroDps: string;
    serieDps: string;
    dataDps: string;

    prestador: DanfseParte;
    tomador: DanfseParte;

    servico: {
        codTribNacional: string;
        codTribMunicipal: string;
        localPrestacao: string;
        descricao: string;
    };
    issqn: {
        tributacao: string;
        municipioIncidencia: string;
        regimeEspecial: string;
        valorServico: Valor;
        descontoIncond: Valor;
        bc: Valor;
        aliquota: Valor;
        retido: boolean;
        apurado: Valor;
        retencaoTxt: string;
    };
    federal: { irrf: Valor; inss: Valor; csll: Valor; pis: Valor; cofins: Valor };
    ibscbs: { base: Valor; aliqIbs: Valor; valorIbs: Valor; aliqCbs: Valor; valorCbs: Valor };
    total: {
        valorServico: Valor;
        descontoIncond: Valor;
        issqnRetido: Valor;
        retencoes: Valor;
        liquido: Valor;
        liquidoComTributos: Valor;
    };
    tributos: { federais: Valor; estaduais: Valor; municipais: Valor };
    nbs: string;
}

// ---------------------------------------------------------------- helpers
const first = (v: any) => (Array.isArray(v) ? v[0] : v);
/** Texto de um nó do xml2js, que pode ser string, objeto com `_` ou ausente. */
const t = (v: any): string => {
    const x = first(v);
    if (x == null) return '';
    if (typeof x === 'object') return x._ != null ? String(x._) : '';
    return String(x);
};
const num = (v: any): number => Number(String(t(v)).replace(',', '.')) || 0;

const codDesc = (mapa: Record<number, string>, v: string): string => {
    if (v == null || v === '') return '';
    const n = Number(v);
    return mapa[n] ? `${n} - ${mapa[n]}` : String(v);
};

const cep = (v: string): string => {
    const d = String(v || '').replace(/\D/g, '');
    return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : '';
};

const fone = (v: string): string => {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d ? String(v) : '';
};

const documento = (v: string): string => {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
    if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
    return d ? String(v) : '';
};

const fmtData = (iso: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};
const fmtDataHora = (iso: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : fmtData(iso);
};

/** "Rua X, 100, Sala 2 - Centro" a partir de um bloco de endereço nacional. */
const endereco = (e: any): string => {
    if (!e) return '';
    const via = [t(e.xLgr), t(e.nro)].filter(Boolean).join(', ');
    return [[via, t(e.xCpl)].filter(Boolean).join(', '), t(e.xBairro)].filter(Boolean).join(' - ');
};

// ---------------------------------------------------------------- extração
export async function extrairNacional(xmlTexto: string, cancelada = false): Promise<DanfseDados> {
    const raiz: any = await parseStringPromise(xmlTexto, {
        explicitArray: false,
        ignoreAttrs: false,
        tagNameProcessors: [(name: string) => name.replace(/^.*:/, '')],
    });

    const nfse = raiz?.NFSe || raiz?.nfse || raiz || {};
    const inf = nfse.infNFSe || nfse.InfNFSe || {};
    const dps = inf.DPS || {};
    const infDps = dps.infDPS || dps || {};

    // Id = "NFS" + os 50 dígitos da chave de acesso
    const chave = String(inf?.$?.Id || '').replace(/^NFS/i, '').replace(/\D/g, '');

    const emit = inf.emit || {};
    const endEmit = emit.enderNac || {};
    const prest = infDps.prest || {};
    const regTrib = prest.regTrib || {};
    const toma = infDps.toma || {};
    const endToma = toma.end || {};
    const endTomaNac = endToma.endNac || {};
    const serv = infDps.serv || {};
    const cServ = serv.cServ || {};
    const valDps = infDps.valores || {};
    const trib = valDps.trib || {};
    const tribMun = trib.tribMun || {};
    const tribFed = trib.tribFed || {};
    const totTrib = trib.totTrib || {};
    const valNfse = inf.valores || {};
    const ibscbs = inf.IBSCBS || {};

    const vServ = num((valDps.vServPrest || {}).vServ);
    const vDesc = num(valDps.vDescCondIncond?.vDescIncond ?? valDps.vDescCondIncond);
    const vIssqn = num(valNfse.vISSQN);
    const retido = t(tribMun.tpRetISSQN) === '2' || t(tribMun.tpRetISSQN) === '3';

    // IBS/CBS (reforma tributária) — só nas notas já no novo regime
    const totC = ibscbs.totCIBS || {};
    const valIb = ibscbs.valores || {};
    const vIbs = num((totC.gIBS || {}).vIBSTot);
    const vCbs = num((totC.gCBS || {}).vCBS);
    const aliqIbs = num((valIb.uf || {}).pIBSUF) + num((valIb.mun || {}).pIBSMun);

    // Totais aproximados (Lei 12.741/2012) — o XML traz em R$ ou em %
    const pTot = totTrib.pTotTrib || {};
    const vTot = totTrib.vTotTrib || {};
    const aproximado = (emReais: any, emPercentual: any): Valor => {
        if (emReais != null) return num(emReais);
        const p = num(emPercentual);
        return p ? (vServ * p) / 100 : '';
    };

    const ufEmit = t(endEmit.UF);
    const munEmit = t(inf.xLocEmi) || municipio(t(endEmit.cMun));
    const vLiq = num(valNfse.vLiq);

    const complementares = [t((serv.infoCompl || {}).xInfComp), t(inf.xOutInf)].filter(Boolean).join('\n');

    return {
        municipioEmissor: ufEmit ? `${munEmit}/${ufEmit}` : munEmit,
        regimeApuracaoSN: codDesc(REG_AP_SN, t(regTrib.regApTribSN)),
        complementares,

        ambiente: t(infDps.tpAmb) === '2' ? 'homologacao' : 'producao',
        cancelada,
        chaveAcesso: chave,
        numeroNfse: t(inf.nNFSe),
        competencia: fmtData(t(infDps.dCompet)),
        dataEmissao: fmtDataHora(t(inf.dhProc)),
        numeroDps: t(infDps.nDPS),
        serieDps: t(infDps.serie),
        dataDps: fmtDataHora(t(infDps.dhEmi)),

        prestador: {
            cnpj: documento(t(emit.CNPJ) || t(emit.CPF)),
            im: t(emit.IM),
            telefone: fone(t(emit.fone)),
            nome: t(emit.xNome),
            email: t(emit.email),
            fantasia: t(emit.xFant),
            endereco: endereco(endEmit),
            municipio: municipio(t(endEmit.cMun), ufEmit ? `${munEmit}/${ufEmit}` : munEmit),
            cep: cep(t(endEmit.CEP)),
            optanteSimples: codDesc(OPT_SIMPLES, t(regTrib.opSimpNac)),
        },
        tomador: {
            cnpj: documento(t(toma.CNPJ) || t(toma.CPF)),
            im: t(toma.IM),
            telefone: fone(t(toma.fone)),
            nome: t(toma.xNome),
            email: t(toma.email),
            endereco: endereco(endToma),
            municipio: municipio(t(endTomaNac.cMun)),
            cep: cep(t(endTomaNac.CEP)),
        },

        servico: {
            codTribNacional: [t(cServ.cTribNac), t(inf.xTribNac)].filter(Boolean).join(' - '),
            codTribMunicipal: [t(cServ.cTribMun), t(inf.xTribMun)].filter(Boolean).join(' - '),
            localPrestacao: t(inf.xLocPrestacao) || municipio(t((serv.locPrest || {}).cLocPrestacao)),
            descricao: t(cServ.xDescServ),
        },
        issqn: {
            tributacao: codDesc(TRIB_ISSQN, t(tribMun.tribISSQN)),
            municipioIncidencia: t(inf.xLocIncid) || municipio(t(inf.cLocIncid)),
            regimeEspecial: codDesc(REG_ESP_TRIB, t(regTrib.regEspTrib)) || 'Nenhum',
            valorServico: vServ,
            descontoIncond: vDesc || '',
            bc: t(valNfse.vBC),
            aliquota: t(valNfse.pAliqAplic),
            retido,
            apurado: t(valNfse.vISSQN),
            retencaoTxt: codDesc(RET_ISSQN, t(tribMun.tpRetISSQN)),
        },
        federal: {
            irrf: t(tribFed.vRetIRRF),
            inss: t(tribFed.vRetCP),
            csll: t(tribFed.vRetCSLL),
            pis: t((tribFed.piscofins || {}).vPis),
            cofins: t((tribFed.piscofins || {}).vCofins),
        },
        ibscbs: {
            base: t(valIb.vBC),
            aliqIbs: aliqIbs || '',
            valorIbs: vIbs || '',
            aliqCbs: t((valIb.fed || {}).pCBS),
            valorCbs: vCbs || '',
        },
        total: {
            valorServico: vServ,
            descontoIncond: vDesc || '',
            issqnRetido: retido ? vIssqn : '',
            retencoes: num(valNfse.vTotalRet),
            liquido: vLiq,
            liquidoComTributos: Math.round((vLiq + vIbs + vCbs) * 100) / 100,
        },
        tributos: {
            federais: aproximado(vTot.vTotTribFed, pTot.pTotTribFed),
            estaduais: aproximado(vTot.vTotTribEst, pTot.pTotTribEst),
            municipais: aproximado(vTot.vTotTribMun, pTot.pTotTribMun),
        },
        nbs: [t(cServ.cNBS), t(inf.xNBS)].filter(Boolean).join(' - '),
    };
}
