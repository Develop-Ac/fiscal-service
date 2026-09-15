import { centavos, fmtCentavos, Nota, Contribuinte } from './gnre-nfe';

/**
 * Montagem do lote GNRE (leiaute 2.00).
 *
 * Cenários:
 *   - ICMS-ST por operação -> receita 100099, principal = vST (+ FECP-ST)
 *   - DIFAL (EC 87/2015)    -> receita 100102, principal = vICMSUFDest (+ FECP)
 *
 * O emitente da guia é sempre o REMETENTE/substituto (quem vende e recolhe); o
 * favorecido é a UF de destino. Sem validação XSD (exigiria lib nativa): as
 * checagens de campo ficam em `validarLote` e a SEFAZ valida na consulta.
 *
 * Regras de campo confirmadas por rejeição em produção:
 *   - município = 5 dígitos (IBGE sem a UF): 104 cvc-pattern-valid;
 *   - documentoOrigem da 100102 no PA = tipo 10 com o NÚMERO da nota (302/217);
 *   - dataVencimento não pode ser passada (263); dataPagamento obrigatória (225).
 */

export interface GnreConfig {
    gnre: {
        ambiente: string;
        ufFavorecida: string;
        urlRecepcao: string;
        urlResultado: string;
        versaoDados: string;
        timeoutSeg: number;
    };
    regras: {
        receitaIcmsSt: string;
        receitaDifal: string;
        tipoDocOrigem: string;
        docOrigemUsar: 'numero' | 'chave';
        incluirMunicipio: boolean;
        vencimentoModo: 'hoje' | 'emissao';
        vencimentoDias: number;
        periodoReferencia: string;
    };
}

export const NS_GNRE = 'http://www.gnre.pe.gov.br';
export const TIPO_ICMS_ST = 'icms_st';
export const TIPO_DIFAL = 'difal';
export type TipoGuia = typeof TIPO_ICMS_ST | typeof TIPO_DIFAL;

const VALOR_PRINCIPAL_ICMS = '11';
const VALOR_PRINCIPAL_FECP = '12';

export const ROTULOS: Record<TipoGuia, string> = {
    [TIPO_ICMS_ST]: 'ICMS-ST por operação (100099)',
    [TIPO_DIFAL]: 'DIFAL EC 87/2015 (100102)',
};

export interface InfoGuia {
    tipo: TipoGuia;
    descricao: string;
    receita: string;
    valorPrincipal: string;
    valorFecp: string;
    valorTotal: string;
    vencimento: string;
}

const soDigitos = (s: string | null | undefined) => (s || '').replace(/\D/g, '');
const texto = (s: string | null | undefined, limite = 60) => (s || '').trim().slice(0, limite);
const esc = (s: unknown) =>
    String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** IBGE 7 díg (UF+município) -> 5 díg do município. */
export function municipio5(cod: string | null | undefined): string | null {
    const d = soDigitos(cod);
    if (d.length === 7) return d.slice(2);
    return d || null;
}

/** Hoje no fuso de Cuiabá (o servidor roda em UTC; às 21h daqui já seria amanhã). */
export function hojeIso(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cuiaba' }).format(new Date());
}

function addDias(iso: string, dias: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + Number(dias || 0)));
    return dt.toISOString().slice(0, 10);
}

/** Vencimento AAAA-MM-DD, nunca no passado. */
export function calcularVencimento(nota: Nota, regras: GnreConfig['regras']): string {
    const hoje = hojeIso();
    const base = regras.vencimentoModo === 'emissao' && nota.emissaoData ? nota.emissaoData : hoje;
    const venc = addDias(base, regras.vencimentoDias);
    return venc < hoje ? hoje : venc;
}

function el(tag: string, inner?: string | null, attrs?: Record<string, string>): string {
    const a = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
    if (inner == null || inner === '') return `<${tag}${a}/>`;
    return `<${tag}${a}>${inner}</${tag}>`;
}

function identificacao(c: Contribuinte, incluirIe: boolean): string {
    let s = '';
    if (c.cnpj) s += el('CNPJ', esc(soDigitos(c.cnpj)));
    else if (c.cpf) s += el('CPF', esc(soDigitos(c.cpf)));
    if (incluirIe && soDigitos(c.ie)) s += el('IE', esc(soDigitos(c.ie)));
    return el('identificacao', s);
}

function emitenteXml(emit: Contribuinte, regras: GnreConfig['regras']): string {
    let s = identificacao(emit, false);
    if (emit.nome) s += el('razaoSocial', esc(texto(emit.nome)));
    if (emit.endereco) s += el('endereco', esc(texto(emit.endereco)));
    if (regras.incluirMunicipio && emit.codMunicipio) s += el('municipio', esc(municipio5(emit.codMunicipio)));
    if (emit.uf) s += el('uf', esc(emit.uf));
    const cep = soDigitos(emit.cep);
    if (cep.length === 8) s += el('cep', esc(cep));
    const fone = soDigitos(emit.fone);
    if (fone.length >= 6 && fone.length <= 11) s += el('telefone', esc(fone));
    return el('contribuinteEmitente', s);
}

function destinatarioXml(dest: Contribuinte, regras: GnreConfig['regras'], contribuinte: boolean): string {
    let s = identificacao(dest, contribuinte);
    if (dest.nome) s += el('razaoSocial', esc(texto(dest.nome)));
    if (regras.incluirMunicipio && dest.codMunicipio) s += el('municipio', esc(municipio5(dest.codMunicipio)));
    return el('contribuinteDestinatario', s);
}

function valores(nota: Nota, tipo: TipoGuia) {
    return tipo === TIPO_ICMS_ST
        ? { principalC: centavos(nota.vSt), fecpC: centavos(nota.vFcpSt) }
        : { principalC: centavos(nota.vIcmsUfDest), fecpC: centavos(nota.vFcpUfDest) };
}

function guia(nota: Nota, cfg: GnreConfig, tipo: TipoGuia): { xml: string; info: InfoGuia } {
    const r = cfg.regras;
    if (tipo !== TIPO_ICMS_ST && tipo !== TIPO_DIFAL) throw new Error(`tipo de guia desconhecido: ${tipo}`);
    const st = tipo === TIPO_ICMS_ST;
    const receita = st ? r.receitaIcmsSt : r.receitaDifal;
    const { principalC, fecpC } = valores(nota, tipo);
    const vencimento = calcularVencimento(nota, r);
    const totalC = principalC + fecpC;

    let item = el('receita', esc(receita));
    const docValor = r.docOrigemUsar === 'numero' ? nota.numero : nota.chave;
    item += el('documentoOrigem', esc(docValor), { tipo: r.tipoDocOrigem });
    if (nota.emissaoData) {
        const [ano, mes] = nota.emissaoData.split('-');
        item += el('referencia', el('periodo', esc(r.periodoReferencia)) + el('mes', esc(mes)) + el('ano', esc(ano)));
    }
    item += el('dataVencimento', esc(vencimento));
    item += el('valor', esc(fmtCentavos(principalC)), { tipo: VALOR_PRINCIPAL_ICMS });
    if (fecpC > 0) item += el('valor', esc(fmtCentavos(fecpC)), { tipo: VALOR_PRINCIPAL_FECP });
    // No DIFAL o destinatário é consumidor final: IE não entra.
    item += destinatarioXml(nota.destinatario, r, st);

    let g = el('ufFavorecida', esc(cfg.gnre.ufFavorecida));
    g += el('tipoGnre', '0');
    g += emitenteXml(nota.emitente, r);
    g += el('itensGNRE', el('item', item));
    g += el('valorGNRE', esc(fmtCentavos(totalC)));
    g += el('dataPagamento', esc(vencimento));

    return {
        xml: `<TDadosGNRE versao="2.00">${g}</TDadosGNRE>`,
        info: {
            tipo,
            descricao: st ? 'ICMS-ST por operação' : 'DIFAL (EC 87/2015)',
            receita,
            valorPrincipal: fmtCentavos(principalC),
            valorFecp: fmtCentavos(fecpC),
            valorTotal: fmtCentavos(totalC),
            vencimento,
        },
    };
}

/** TLote_GNRE com uma ou mais guias. */
export function montarLote(nota: Nota, cfg: GnreConfig, tipos: TipoGuia[]): { xml: string; infos: InfoGuia[] } {
    if (!tipos?.length) throw new Error('nenhum tipo de guia selecionado');
    const partes = tipos.map((t) => guia(nota, cfg, t));
    const xml = `<TLote_GNRE xmlns="${NS_GNRE}" versao="2.00">${el('guias', partes.map((p) => p.xml).join(''))}</TLote_GNRE>`;
    return { xml, infos: partes.map((p) => p.info) };
}

/** Guias que a nota permite gerar, detectadas pelo XML. */
export function guiasDisponiveis(nota: Nota): TipoGuia[] {
    const tipos: TipoGuia[] = [];
    if (nota.interestadual && nota.temIcmsSt) tipos.push(TIPO_ICMS_ST);
    if (nota.interestadual && nota.temDifal) tipos.push(TIPO_DIFAL);
    return tipos;
}

/** Validação de campo (no lugar do XSD). Lista vazia = ok. */
export function validarLote(nota: Nota, cfg: GnreConfig, tipos: TipoGuia[]): string[] {
    const erros: string[] = [];
    const r = cfg.regras;
    if (cfg.gnre.ufFavorecida?.length !== 2) erros.push('UF favorecida deve ter 2 letras.');
    const emit = nota.emitente;
    if (!soDigitos(emit.cnpj) && !soDigitos(emit.cpf)) erros.push('Emitente sem CNPJ/CPF no XML da NF-e.');
    if (r.incluirMunicipio && emit.codMunicipio && municipio5(emit.codMunicipio)?.length !== 5) {
        erros.push(`Município do emitente inválido (${emit.codMunicipio}).`);
    }
    for (const tipo of tipos) {
        const receita = tipo === TIPO_ICMS_ST ? r.receitaIcmsSt : r.receitaDifal;
        if (!/^\d{6}$/.test(receita || '')) erros.push(`Receita ${receita} deve ter 6 dígitos.`);
        const { principalC, fecpC } = valores(nota, tipo);
        if (principalC + fecpC <= 0) erros.push(`${ROTULOS[tipo] ?? tipo}: valor total zerado.`);
        const docValor = r.docOrigemUsar === 'numero' ? nota.numero : nota.chave;
        if (!docValor) erros.push(`${ROTULOS[tipo] ?? tipo}: documento de origem vazio.`);
    }
    return erros;
}
