/**
 * Leitura do arquivo do SPED Fiscal — blocos 0, C e D.
 *
 * O arquivo é a única fonte aqui: é ele que vai para o Fisco, então o que ele
 * declara é o que a contabilidade precisa arquivar. Nenhum dado é buscado em
 * outro lugar nesta etapa (o XML vem depois, em `sped-xml.service`).
 *
 * Encoding: o gerador do ERP grava em latin1. Ler como utf8 corrompe acentos e,
 * pior, muda o comprimento dos campos.
 */

/** Nota fiscal de ENTRADA (C100 com IND_OPER = 0). */
export interface NotaSped {
    chave: string;
    modelo: string;
    /** COD_SIT: 00 regular, 02/03/04/05 cancelada/denegada/inutilizada. */
    codSituacao: string;
    serie: string;
    numero: string;
    dataDoc: string;
    dataEntrada: string;
    valorDoc: number;
    emitenteNome: string;
    emitenteCnpj: string;
    /** CFOP -> valor da operação (C190.VL_OPR, ou C170 quando o C190 falta). */
    cfops: Map<string, number>;
}

/** CT-e de entrada (D100 com COD_MOD = 57). */
export interface CteSped {
    chave: string;
    codSituacao: string;
    serie: string;
    numero: string;
    dataDoc: string;
    valorDoc: number;
    emitenteNome: string;
    emitenteCnpj: string;
}

export interface EmpresaSped {
    nome: string;
    cnpj: string;
    uf: string;
    ie: string;
    /** DT_INI e DT_FIN do 0000, em AAAA-MM-DD. Delimitam o mês do fechamento. */
    dtInicio: string;
    dtFim: string;
}

export interface SpedLido {
    empresa: EmpresaSped | null;
    notas: NotaSped[];
    ctes: CteSped[];
}

function num(v: unknown): number {
    const x = Number(String(v ?? '').replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(x) ? x : 0;
}

/** DDMMAAAA -> AAAA-MM-DD (o SPED só usa esse formato de data). */
function dataIso(ddmmaaaa: unknown): string {
    const d = String(ddmmaaaa ?? '').replace(/\D/g, '');
    return d.length === 8 ? `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}` : '';
}

/**
 * Lê o conteúdo de um arquivo do SPED Fiscal.
 *
 * Os CFOPs de cada nota vêm do C190 (analítico, que traz o valor da operação por
 * CFOP); quando o C190 falta, caímos para o C170 (itens) somando o valor do item.
 * Sem essa segunda fonte, nota sem analítico ficaria sem classificação.
 */
export function lerSped(conteudo: Buffer | string): SpedLido {
    const texto = Buffer.isBuffer(conteudo) ? conteudo.toString('latin1') : conteudo;
    const linhas = texto.split(/\r?\n/);

    const participantes = new Map<string, { nome: string; cnpj: string; cpf: string }>();
    const notas: NotaSped[] = [];
    const ctes: CteSped[] = [];
    let empresa: EmpresaSped | null = null;

    // Nota de entrada aberta (C100/D100) — os registros filhos pertencem a ela.
    let notaAtual: NotaSped | null = null;
    let itensCfop = new Map<string, number>();
    let dentroDeC100 = false;
    // COD_PART do D100 aberto, resolvido no fim junto com o dos C100.
    const codPartPorNota = new Map<NotaSped | CteSped, string>();

    for (const linha of linhas) {
        if (!linha.startsWith('|')) continue;
        const f = linha.split('|');
        const reg = f[1];

        if (reg === '0000') {
            // |0000|LAYOUT|COD_VER|COD_FIN|DT_INI|DT_FIN|NOME|CNPJ|CPF|UF|IE|…
            empresa = {
                nome: f[6],
                cnpj: f[7],
                uf: f[9],
                ie: f[10],
                dtInicio: dataIso(f[4]),
                dtFim: dataIso(f[5]),
            };
        } else if (reg === '0150') {
            participantes.set(f[2], { nome: f[3], cnpj: f[5], cpf: f[6] });
        } else if (reg === 'C100') {
            // fecha a nota anterior antes de abrir a próxima
            if (notaAtual && notaAtual.cfops.size === 0 && itensCfop.size) notaAtual.cfops = itensCfop;
            itensCfop = new Map();
            dentroDeC100 = true;

            if (f[2] === '0') {
                notaAtual = {
                    modelo: f[5],
                    codSituacao: f[6],
                    serie: f[7],
                    numero: f[8],
                    chave: (f[9] || '').replace(/\D/g, ''),
                    dataDoc: dataIso(f[10]),
                    dataEntrada: dataIso(f[11]),
                    valorDoc: num(f[12]),
                    emitenteNome: '',
                    emitenteCnpj: '',
                    cfops: new Map<string, number>(),
                };
                codPartPorNota.set(notaAtual, f[4]);
                notas.push(notaAtual);
            } else {
                notaAtual = null; // C100 de saída: ignora os filhos até o próximo C100
            }
        } else if (reg === 'C190' && notaAtual) {
            const cfop = String(f[3] || '').replace(/\D/g, '');
            if (cfop) notaAtual.cfops.set(cfop, (notaAtual.cfops.get(cfop) || 0) + num(f[5]));
        } else if (reg === 'C170' && notaAtual) {
            const cfop = String(f[12] || '').replace(/\D/g, '');
            if (cfop) itensCfop.set(cfop, (itensCfop.get(cfop) || 0) + num(f[8]));
        } else if (reg === 'D100' && f[5] === '57' && f[2] === '0') {
            const chave = String(f[10] || '').replace(/\D/g, '');
            if (chave.length === 44) {
                const cte: CteSped = {
                    chave,
                    codSituacao: f[6],
                    serie: f[7],
                    numero: f[9],
                    dataDoc: dataIso(f[11]),
                    valorDoc: num(f[15]),
                    emitenteNome: '',
                    emitenteCnpj: '',
                };
                codPartPorNota.set(cte, f[4]);
                ctes.push(cte);
            }
        } else if (reg && reg[0] !== 'C' && dentroDeC100) {
            // saiu do bloco C: a última nota também precisa do fallback do C170
            if (notaAtual && notaAtual.cfops.size === 0 && itensCfop.size) notaAtual.cfops = itensCfop;
            itensCfop = new Map();
            dentroDeC100 = false;
            notaAtual = null;
        }
    }
    if (notaAtual && notaAtual.cfops.size === 0 && itensCfop.size) notaAtual.cfops = itensCfop;

    for (const [doc, codPart] of codPartPorNota) {
        const p = participantes.get(codPart);
        doc.emitenteNome = p?.nome || codPart;
        doc.emitenteCnpj = (p?.cnpj || p?.cpf || '').replace(/\D/g, '');
    }

    // O mesmo documento pode aparecer em mais de um registro (nota com mais de
    // um C100, por exemplo); o arquivo de saída teria arquivos duplicados.
    return {
        empresa,
        notas: dedup(notas.filter((n) => n.chave.length === 44)),
        ctes: dedup(ctes),
    };
}

function dedup<T extends { chave: string }>(docs: T[]): T[] {
    const vistos = new Set<string>();
    return docs.filter((d) => !vistos.has(d.chave) && vistos.add(d.chave));
}
