/**
 * Leitura das respostas do grupo de guias no WhatsApp (docs/automacao-icms-st.md, 2.3).
 * Funções puras, sem Nest: `node scripts/check-st-fluxo-parse.mjs` exercita todas.
 */
export type Classificacao = 'ST' | 'DIFAL' | 'TRIBUTADA';
export type Comando = 'AJUSTADO' | 'AUTORIZAR' | 'MANUAL' | 'CLASSIFICAR';

const RE_AJUSTADO = /ajustad[oa]/i;
const RE_AUTORIZAR = /pode\s+enviar/i;
const RE_MANUAL = /^\s*manual\b/i;
// "3 st", "7: difal", "9 - tributada", "todos st"; separadas por linha, ";" ou ","
const RE_CLASSIF = /(^|[\n;,·])\s*(\d+|todos)\s*[:\-–]?\s*(st|revenda|difal|consumo|uso|tributad\w*)\b/gi;

export function comando(body: string): Comando | null {
    if (RE_AJUSTADO.test(body)) return 'AJUSTADO';
    if (RE_AUTORIZAR.test(body)) return 'AUTORIZAR';
    if (RE_MANUAL.test(body)) return 'MANUAL';
    RE_CLASSIF.lastIndex = 0;
    return RE_CLASSIF.test(body) ? 'CLASSIFICAR' : null;
}

/** "pode enviar 25/09" → "2026-09-25"; ano ausente = `anoBase`; "25/09/26" aceito. */
export function parseVencimento(body: string, anoBase = new Date().getFullYear()): string | null {
    const m = body.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!m) return null;
    const d = Number(m[1]), mes = Number(m[2]);
    let ano = m[3] ? Number(m[3]) : anoBase;
    if (ano < 100) ano += 2000;
    if (d < 1 || d > 31 || mes < 1 || mes > 12) return null;
    return `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Linhas "3 st", "7 difal", "9 tributada", "todos st" → {"3":"ST",...}; só itens pendentes contam. */
export function parseClassificacao(body: string, pendentes: number[]): Record<string, Classificacao> {
    const out: Record<string, Classificacao> = {};
    const re = new RegExp(RE_CLASSIF.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
        const alvo = m[2].toLowerCase();
        const p = m[3].toLowerCase();
        const imposto: Classificacao = p === 'st' || p === 'revenda' ? 'ST' : p === 'difal' || p === 'consumo' || p === 'uso' ? 'DIFAL' : 'TRIBUTADA';
        if (alvo === 'todos') for (const n of pendentes) out[String(n)] = imposto;
        else if (pendentes.includes(Number(alvo))) out[alvo] = imposto;
    }
    return out;
}
