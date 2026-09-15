import { readFileSync } from 'fs';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';

// pdfkit não traz types no projeto; mesmo padrão do dacte.generator.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

/**
 * PDF da guia GNRE no layout oficial: DUAS vias por página (1ª Banco / 2ª
 * Contribuinte) com linha tracejada, coluna fiscal à direita e código de barras
 * Interleaved 2of5 desenhado à mão.
 *
 * O webservice NÃO devolve PDF — só os dados (linha digitável, código de barras
 * de 44 díg e os campos). Por isso o PDF é sempre reproduzível a partir do XML
 * de resultado guardado no histórico.
 */

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
});

const RECEITAS: Record<string, string> = {
    '100099': 'ICMS Substituição Tributária por Operação',
    '100102': 'ICMS Diferencial de Alíquota - Partilha (EC 87/2015)',
    '100129': 'ICMS Fundo Estadual de Combate à Pobreza (FECP)',
    '100110': 'ICMS Antecipação',
    '100013': 'ICMS Substituição Tributária por Apuração',
};

// valor por tipo: 11/12 principal/fecp, 31/32 multa, 41/42 juros, 51/52 atualização
const VALOR_MAP: Record<string, string> = {
    '11': 'principal', '12': 'fecp', '31': 'multa', '32': 'multa',
    '41': 'juros', '42': 'juros', '51': 'atualizacao', '52': 'atualizacao',
};

export interface GuiaRetorno {
    situacaoGuia: string;
    ufFavorecida: string;
    receita: string;
    emit: { cnpj: string; cpf: string; ie: string; razao: string; endereco: string; municipio: string; uf: string; cep: string; telefone: string };
    dest: { cnpj: string; cpf: string; ie: string; razao: string; municipio: string };
    docOrigem: string;
    periodo: string;
    mes: string;
    ano: string;
    parcela: string;
    convenio: string;
    valorPrincipal: string;
    valorFecp: string;
    atualizacao: string;
    juros: string;
    multa: string;
    valorTotal: string;
    dataVencimento: string;
    dataPagamento: string;
    dataLimite: string;
    nossoNumero: string;
    linhaDigitavel: string;
    codigoBarras: string;
    informacoes: string[];
}

const asArray = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const textoNo = (v: any): string =>
    v && typeof v === 'object' ? (v['#text'] != null ? String(v['#text']).trim() : '') : String(v ?? '').trim();
const t = (node: any, name: string) => (node ? textoNo(node[name]) : '');

/** Guias do XML de resultado (com ou sem código de barras). */
export function parseGuias(rawXml: string): GuiaRetorno[] {
    const doc = parser.parse(rawXml);
    const nos: any[] = [];
    (function walk(o: any) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        for (const [k, v] of Object.entries(o)) {
            if (k === 'guia') nos.push(...asArray(v));
            if (v && typeof v === 'object') walk(v);
        }
    })(doc);

    return nos.map((g) => {
        const emit = g.contribuinteEmitente || {};
        const item = asArray(g.itensGNRE?.item)[0] || {};
        const dest = item.contribuinteDestinatario || {};
        const ref = item.referencia || {};

        const vals: Record<string, string> = { principal: '', fecp: '', multa: '', juros: '', atualizacao: '' };
        for (const v of asArray(item.valor)) {
            const tipo = v && typeof v === 'object' ? v['@_tipo'] : '';
            vals[VALOR_MAP[String(Number(tipo))] || 'principal'] = textoNo(v);
        }

        const ident = (node: any) => {
            const i = node?.identificacao || {};
            return { cnpj: t(i, 'CNPJ'), cpf: t(i, 'CPF'), ie: t(i, 'IE') };
        };

        const informacoes: string[] = [];
        (function collect(o: any) {
            if (o == null) return;
            if (typeof o === 'string') {
                if (o.trim()) informacoes.push(o.trim());
                return;
            }
            if (Array.isArray(o)) return o.forEach(collect);
            if (typeof o === 'object') {
                if (o['#text']) informacoes.push(String(o['#text']).trim());
                Object.values(o).forEach(collect);
            }
        })(g.informacoesComplementares);

        return {
            situacaoGuia: t(g, 'situacaoGuia'),
            ufFavorecida: t(g, 'ufFavorecida'),
            receita: t(item, 'receita'),
            emit: {
                ...ident(emit),
                razao: t(emit, 'razaoSocial'),
                endereco: t(emit, 'endereco'),
                municipio: t(emit, 'municipio'),
                uf: t(emit, 'uf'),
                cep: t(emit, 'cep'),
                telefone: t(emit, 'telefone'),
            },
            dest: { ...ident(dest), razao: t(dest, 'razaoSocial'), municipio: t(dest, 'municipio') },
            docOrigem: textoNo(item.documentoOrigem),
            periodo: t(ref, 'periodo'),
            mes: t(ref, 'mes'),
            ano: t(ref, 'ano'),
            parcela: t(ref, 'parcela'),
            convenio: t(item, 'convenio'),
            valorPrincipal: vals.principal,
            valorFecp: vals.fecp,
            atualizacao: vals.atualizacao,
            juros: vals.juros,
            multa: vals.multa,
            valorTotal: t(g, 'valorGNRE'),
            dataVencimento: t(item, 'dataVencimento'),
            dataPagamento: t(g, 'dataPagamento'),
            dataLimite: t(g, 'dataLimitePagamento'),
            nossoNumero: t(g, 'nossoNumero'),
            linhaDigitavel: t(g, 'linhaDigitavel'),
            codigoBarras: t(g, 'codigoBarras'),
            informacoes,
        };
    });
}

// ------------------------------------------------------------------ formatação
function fData(d: string) {
    if (d && d.length === 10 && d[4] === '-') {
        const [a, m, dia] = d.split('-');
        return `${dia}/${m}/${a}`;
    }
    return d || '';
}
function fMoney(s: string) {
    const v = Number(s || 0);
    if (!Number.isFinite(v)) return `R$ ${s}`;
    const [intp, dec] = v.toFixed(2).split('.');
    return `R$ ${intp.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}
export function linhaFormatada(linha: string) {
    if (linha && linha.length === 48) {
        const blocos: string[] = [];
        for (let i = 0; i < 48; i += 12) blocos.push(linha.slice(i, i + 12));
        return blocos.map((b) => `${b.slice(0, 11)} ${b[11]}`).join('  ');
    }
    return linha || '';
}

// ------------------------------------------------- Interleaved 2 of 5 à mão
const I25: Record<string, string> = {
    0: 'NNWWN', 1: 'WNNNW', 2: 'NWNNW', 3: 'WWNNN', 4: 'NNWNW',
    5: 'WNWNN', 6: 'NWWNN', 7: 'NNNWW', 8: 'WNNWN', 9: 'NWNWN',
};

function desenharBarras(doc: any, code: string, x: number, y: number, width: number, height: number) {
    if (!(code && /^\d+$/.test(code) && code.length % 2 === 0)) return;
    const els: [boolean, boolean][] = [[true, false], [false, false], [true, false], [false, false]]; // start
    for (let i = 0; i + 1 < code.length; i += 2) {
        const a = I25[code[i]];
        const b = I25[code[i + 1]];
        for (let k = 0; k < 5; k += 1) {
            els.push([true, a[k] === 'W']);
            els.push([false, b[k] === 'W']);
        }
    }
    els.push([true, true], [false, false], [true, false]); // stop
    const wide = 2.4;
    const narrow = width / els.reduce((s, [, w]) => s + (w ? wide : 1), 0);
    let cx = x;
    for (const [bar, w] of els) {
        const bw = (w ? wide : 1) * narrow;
        if (bar) doc.rect(cx, y, bw, height).fill('black');
        cx += bw;
    }
}

// --------------------------------- desenho (origem topo-esquerda, y p/ baixo)
const mm = 2.834645669;
const X0 = 8 * mm;
const TOTAL_W = 194 * mm;
const MC_W = 140 * mm; // coluna principal
const RC_W = TOTAL_W - MC_W; // coluna fiscal (direita)
const RC_X = X0 + MC_W;
const AUTH_W = 5 * mm;
const FLD_W = RC_W - AUTH_W;

function cell(
    doc: any, x: number, y: number, w: number, h: number, label: string, value: string,
    opts: { size?: number; bold?: boolean; right?: boolean } = {},
) {
    const { size = 8, bold = false, right = false } = opts;
    doc.lineWidth(0.5).rect(x, y, w, h).stroke('#000');
    if (label) {
        doc.font('Helvetica').fontSize(5).fillColor('#4d4d4d')
            .text(label, x + 1 * mm, y + 1 * mm, { lineBreak: false, width: w - 2 * mm });
    }
    if (value) {
        let sz = size;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
        while (sz > 5 && doc.fontSize(sz).widthOfString(String(value)) > w - 2.6 * mm) sz -= 0.5;
        doc.fontSize(sz).fillColor('black')
            .text(String(value), x + 1.2 * mm, y + h - sz - 1.5, { lineBreak: false, width: w - 2.4 * mm, align: right ? 'right' : 'left' });
    }
    doc.fillColor('black');
}

function secao(doc: any, x: number, y: number, w: number, texto: string, h = 4.5 * mm) {
    doc.rect(x, y, w, h).fillAndStroke('#d9d9d9', '#000');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(6.5)
        .text(texto, x, y + 1.2 * mm, { width: w, align: 'center', lineBreak: false });
    doc.fillColor('black');
}

function drawVia(doc: any, g: GuiaRetorno, yTop: number, viaLabel: string, chave: string | null, logo: Buffer | null) {
    const rec = g.receita;
    const y = yTop;
    const topH = 9 * mm;
    doc.lineWidth(0.5).rect(X0, y, MC_W, topH).stroke('#000');
    if (logo) {
        try {
            doc.image(logo, X0 + 1.5 * mm, y + 1.5 * mm, { height: topH - 3 * mm });
        } catch {
            /* logo é enfeite */
        }
    }
    doc.font('Helvetica-Bold').fontSize(8.2).fillColor('#000')
        .text('Guia Nacional de Recolhimento de Tributos Estaduais - GNRE', X0 + 16 * mm, y + 3 * mm, { width: MC_W - 18 * mm, align: 'center', lineBreak: false });
    cell(doc, RC_X, y, FLD_W / 2, topH, 'UF Favorecida', g.ufFavorecida, { bold: true });
    cell(doc, RC_X + FLD_W / 2, y, FLD_W / 2, topH, 'Código da Receita', rec, { bold: true });

    // coluna fiscal (direita)
    let ry = y + topH;
    const rh = 8.6 * mm;
    const linhas: [string, string | null, boolean][] = [
        ['Nº de Controle', g.nossoNumero, false],
        ['Data de Vencimento', fData(g.dataVencimento), false],
        ['Nº Documento de Origem', g.docOrigem, false],
        ['__periodo__', null, false],
        ['Valor Principal', fMoney(g.valorPrincipal), true],
        ['Atualização Monetária', fMoney(g.atualizacao), true],
        ['Juros', fMoney(g.juros), true],
        ['Multa', fMoney(g.multa), true],
        ['Total a Recolher', fMoney(g.valorTotal), true],
    ];
    for (const [label, valor, right] of linhas) {
        if (label === '__periodo__') {
            cell(doc, RC_X, ry, FLD_W * 0.62, rh, 'Período de Referência', g.ano ? `${g.mes}/${g.ano}` : '');
            cell(doc, RC_X + FLD_W * 0.62, ry, FLD_W * 0.38, rh, 'Parcela', g.parcela);
        } else {
            cell(doc, RC_X, ry, FLD_W, rh, label, valor || '', { bold: label === 'Total a Recolher', right });
        }
        ry += rh;
    }
    const boxBottom = ry;
    const authH = boxBottom - (y + topH);
    doc.rect(RC_X + FLD_W, y + topH, AUTH_W, authH).stroke('#000');
    doc.save();
    doc.rotate(-90, { origin: [RC_X + FLD_W + AUTH_W / 2, y + topH + authH / 2] });
    doc.font('Helvetica').fontSize(6).fillColor('#4d4d4d')
        .text('A u t e n t i c a ç ã o', RC_X + FLD_W + AUTH_W / 2 - authH / 2, y + topH + authH / 2 - 3, { width: authH, align: 'center', lineBreak: false });
    doc.restore();
    doc.fillColor('black');

    // coluna principal
    let my = y + topH;
    secao(doc, X0, my, MC_W, 'Dados do Contribuinte Emitente');
    my += 4.5 * mm;
    cell(doc, X0, my, MC_W * 0.7, 8 * mm, 'Razão Social:', g.emit.razao);
    cell(doc, X0 + MC_W * 0.7, my, MC_W * 0.3, 8 * mm, 'CNPJ/CPF/Insc.Est.:', g.emit.cnpj || g.emit.cpf || '', { bold: true, right: true });
    my += 8 * mm;
    cell(doc, X0, my, MC_W, 7 * mm, 'Endereço:', g.emit.endereco);
    my += 7 * mm;
    cell(doc, X0, my, MC_W * 0.55, 7 * mm, 'Município:', g.emit.municipio);
    cell(doc, X0 + MC_W * 0.55, my, MC_W * 0.2, 7 * mm, 'UF:', g.emit.uf);
    cell(doc, X0 + MC_W * 0.75, my, MC_W * 0.25, 7 * mm, 'Telefone:', g.emit.telefone);
    my += 7 * mm;
    cell(doc, X0, my, MC_W, 6.5 * mm, 'CEP:', g.emit.cep);
    my += 6.5 * mm;

    secao(doc, X0, my, MC_W, 'Dados do Destinatário');
    my += 4.5 * mm;
    cell(doc, X0, my, MC_W * 0.6, 7.5 * mm, 'CPF/CNPJ/Insc.Est.:', g.dest.cnpj || g.dest.cpf || '');
    cell(doc, X0 + MC_W * 0.6, my, MC_W * 0.4, 7.5 * mm, 'Município:', g.dest.municipio);
    my += 7.5 * mm;

    secao(doc, X0, my, MC_W, 'Reservado à Fiscalização');
    my += 4.5 * mm;
    cell(doc, X0, my, MC_W * 0.55, 7 * mm, 'Convênio/Protocolo:', g.convenio);
    cell(doc, X0 + MC_W * 0.55, my, MC_W * 0.45, 7 * mm, 'Produto:', '');
    my += 7 * mm;

    // informações complementares (inclui a chave da NF-e)
    const infoLines = [...g.informacoes];
    if (!infoLines.some((i) => /ICMS|TRIBUTO/i.test(i)) && RECEITAS[rec]) infoLines.unshift(`Tributo: ${rec} - ${RECEITAS[rec]}`);
    if (chave && !infoLines.some((i) => /chave/i.test(i))) infoLines.push(`Chave: ${chave}`);
    const infoH = 6 * mm + 3.2 * mm * Math.max(1, infoLines.length);
    cell(doc, X0, my, MC_W, infoH, 'Informações Complementares:', '');
    doc.font('Helvetica').fontSize(7).fillColor('#000');
    let ty = my + 5.2 * mm;
    for (const linha of infoLines) {
        doc.text(linha.slice(0, 120), X0 + 1.5 * mm, ty, { lineBreak: false, width: MC_W - 3 * mm });
        ty += 3.2 * mm;
    }
    my += infoH;

    cell(doc, X0, my, MC_W, 5.5 * mm, '', `Documento Válido para pagamento até   ${fData(g.dataLimite || g.dataVencimento)}`, { bold: true });
    my += 5.5 * mm;

    // linha digitável + código de barras (largura total)
    const barTop = Math.max(my, boxBottom) + 2 * mm;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
        .text(linhaFormatada(g.linhaDigitavel), X0, barTop, { lineBreak: false, width: TOTAL_W });
    desenharBarras(doc, g.codigoBarras, X0, barTop + 5 * mm, TOTAL_W, 13 * mm);
    doc.font('Helvetica').fontSize(6.5).fillColor('#000')
        .text(viaLabel, X0, barTop + 18 * mm + 1.5 * mm, { width: TOTAL_W, align: 'right', lineBreak: false });
    doc.fillColor('black');
    return barTop + 23 * mm; // y após a via
}

let logoCache: Buffer | null | undefined;
function logo(): Buffer | null {
    if (logoCache === undefined) {
        try {
            logoCache = readFileSync(join(__dirname, 'assets', 'logo.png'));
        } catch {
            logoCache = null;
        }
    }
    return logoCache;
}

/** PDF (Buffer) com as duas vias de cada guia processada do retorno. */
export function gerarPdfGuia(rawXml: string, chave: string | null): Promise<Buffer> {
    const guias = parseGuias(rawXml).filter((g) => g.codigoBarras);
    if (!guias.length) return Promise.reject(new Error('Nenhuma guia com código de barras no retorno (guia não processada).'));

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'GNRE', Author: 'AC Acessórios' } });
        const pedacos: Buffer[] = [];
        doc.on('data', (c: Buffer) => pedacos.push(c));
        doc.on('end', () => resolve(Buffer.concat(pedacos)));
        doc.on('error', reject);
        guias.forEach((g, idx) => {
            if (idx > 0) doc.addPage();
            const y = drawVia(doc, g, 10 * mm, '1ª via - Banco', chave, logo());
            doc.save().lineWidth(0.5).dash(3, { space: 2 })
                .moveTo(X0, y + 1 * mm).lineTo(X0 + TOTAL_W, y + 1 * mm).stroke('#000').undash().restore();
            drawVia(doc, g, y + 4 * mm, '2ª via - Contribuinte', chave, logo());
        });
        doc.end();
    });
}
