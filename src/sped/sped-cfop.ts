/**
 * Classificação das operações de ENTRADA por CFOP — é daqui que sai a pasta de
 * cada DANFE no pacote. Para mudar o enquadramento de um CFOP, edite as listas:
 * este é o único lugar que decide.
 */

// Uso e consumo — interno e interestadual caem na MESMA pasta.
// Inclui a transferência de material de uso/consumo: aqui vale o DESTINO da
// mercadoria, não o fato de ser transferência.
// Combustível e lubrificante entram inteiros: a empresa não revende combustível,
// é abastecimento da frota própria. Por isso 1651/1652/1653/1658, que no CFOP são
// "para industrialização/comercialização", também são consumo.
const USO_CONSUMO = new Set([
    '1407', '2407', // compra p/ uso ou consumo, mercadoria sujeita a ST
    '1556', '2556', // compra de material p/ uso ou consumo
    '1557', '2557', // transferência de material p/ uso ou consumo
    '1651', '2651', // compra de combustível/lubrificante p/ industrialização
    '1652', '2652', // compra de combustível/lubrificante p/ comercialização
    '1653', '2653', // compra de combustível/lubrificante p/ consumidor final
    '1656', '2656', // compra de combustível/lubrificante p/ uso ou consumo
    '1658', '2658', // transferência de combustível/lubrificante p/ comercialização
    '1659', '2659', // transferência de combustível/lubrificante p/ consumo
]);

// Transferência entre estabelecimentos da empresa (depósito, filial). Não é
// compra: interno e interestadual caem na MESMA pasta, igual ao uso e consumo.
const TRANSFERENCIA = new Set([
    '1151', '2151', // transferência p/ industrialização
    '1152', '2152', // transferência de mercadoria de terceiros p/ comercialização
    '1153', '2153', // transferência de energia elétrica p/ distribuição
    '1154', '2154', // transferência p/ utilização na prestação de serviço
    '1408', '2408', // transferência p/ industrialização, com ST
    '1409', '2409', // transferência p/ comercialização, com ST
    '1552', '2552', // transferência de bem do ativo imobilizado
]);

// Compra para comercialização — a pasta depende do 1º dígito (1 interno, 2 interestadual).
const COMPRA_COMERCIALIZACAO = new Set([
    '1102', '2102', // compra p/ comercialização
    '1113', '2113', // compra p/ comercialização, mercadoria recebida antes em consignação
    '1117', '2117', // compra p/ comercialização originada de encomenda p/ entrega futura
    '1118', '2118', // compra pelo adquirente originário, entrega pelo vendedor remetente
    '1120', '2120', // compra p/ comercialização, entrega futura
    '1121', '2121', // compra p/ comercialização, entrega ao destinatário pelo vendedor remetente
    '1403', '2403', // compra p/ comercialização em operação com ST
]);

// Devolução de clientes (nosso cliente devolvendo uma venda nossa).
const DEVOLUCAO_CLIENTE = new Set([
    '1201', '2201', // devolução de venda de produção do estabelecimento
    '1202', '2202', // devolução de venda de mercadoria de terceiros
    '1203', '2203', // devolução de venda de produção, destinada à ZFM/ALC
    '1204', '2204', // devolução de venda de mercadoria de terceiros, destinada à ZFM/ALC
    '1410', '2410', // devolução de venda de produção, com ST
    '1411', '2411', // devolução de venda de mercadoria de terceiros, com ST
    '1412', '2412', // devolução de venda destinada à ZFM/ALC, com ST
    '1413', '2413', // devolução de venda de mercadoria de terceiros p/ ZFM/ALC, com ST
]);

export const PASTAS = {
    // Documentos cancelados/denegados/inutilizados (COD_SIT 02, 03, 04, 05): não
    // têm CFOP nem valores no SPED, então saem de todas as pastas de operação.
    CANCELADAS: '00-canceladas-denegadas',
    USO_CONSUMO: '01-uso-e-consumo',
    COMPRA_INTERNA: '02-compra-comercializacao-interna',
    COMPRA_INTERESTADUAL: '03-compra-comercializacao-interestadual',
    DEVOLUCAO_CLIENTE: '04-devolucao-de-clientes',
    TRANSFERENCIA: '05-transferencias',
    OUTRAS: '06-outras-operacoes',
} as const;

export type Pasta = (typeof PASTAS)[keyof typeof PASTAS];

/** Pasta única dos DACTEs — o CT-e não é segmentado por natureza de operação. */
export const PASTA_CTE = '07-conhecimentos-de-transporte';

/** Pasta única dos XMLs de entrada (NF-e e CT-e juntos). */
export const PASTA_XML = 'xml-entradas';

/** Rótulo legível de cada pasta, para a tela e o relatório. */
export const ROTULO_PASTA: Record<string, string> = {
    [PASTAS.CANCELADAS]: 'Canceladas / denegadas',
    [PASTAS.USO_CONSUMO]: 'Uso e consumo',
    [PASTAS.COMPRA_INTERNA]: 'Compra p/ comercialização — interna',
    [PASTAS.COMPRA_INTERESTADUAL]: 'Compra p/ comercialização — interestadual',
    [PASTAS.DEVOLUCAO_CLIENTE]: 'Devolução de clientes',
    [PASTAS.TRANSFERENCIA]: 'Transferências',
    [PASTAS.OUTRAS]: 'Outras operações',
    [PASTA_CTE]: 'Conhecimentos de transporte (CT-e)',
};

/** Pasta de um único CFOP. */
export function pastaDoCfop(cfop: string): string {
    const c = String(cfop || '').replace(/\D/g, '');
    if (DEVOLUCAO_CLIENTE.has(c)) return PASTAS.DEVOLUCAO_CLIENTE;
    if (USO_CONSUMO.has(c)) return PASTAS.USO_CONSUMO;
    if (TRANSFERENCIA.has(c)) return PASTAS.TRANSFERENCIA;
    if (COMPRA_COMERCIALIZACAO.has(c)) {
        return c.startsWith('1') ? PASTAS.COMPRA_INTERNA : PASTAS.COMPRA_INTERESTADUAL;
    }
    return PASTAS.OUTRAS;
}

const SITUACOES_CANCELADAS = new Set(['02', '03', '04', '05']);

export interface Classificacao {
    pasta: string;
    cfopPredominante: string;
    /** CFOPs de naturezas diferentes na mesma nota — sinalizado no relatório. */
    mista: boolean;
    cfops: string[];
}

/**
 * Classifica uma nota. `cfops` é CFOP -> valor da operação.
 *
 * Nota com CFOPs de naturezas diferentes vai para a pasta do CFOP de MAIOR valor
 * e volta com `mista: true` — o arquivo precisa ficar em algum lugar, mas quem
 * confere tem que saber que a escolha foi por critério de valor.
 */
export function classificarNota(cfops: Map<string, number>, codSituacao: string): Classificacao {
    if (SITUACOES_CANCELADAS.has(String(codSituacao || '').padStart(2, '0'))) {
        return { pasta: PASTAS.CANCELADAS, cfopPredominante: '', mista: false, cfops: [] };
    }
    const entradas = [...cfops.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!entradas.length) {
        return { pasta: PASTAS.OUTRAS, cfopPredominante: '', mista: false, cfops: [] };
    }
    const pastas = new Set(entradas.map(([c]) => pastaDoCfop(c)));
    return {
        pasta: pastaDoCfop(entradas[0][0]),
        cfopPredominante: entradas[0][0],
        mista: pastas.size > 1,
        cfops: entradas.map(([c]) => c),
    };
}
