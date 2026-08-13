import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CteRastreioClient, SswTrackingEvento } from './cte-rastreio.client';

/** Evento da timeline devolvido pela API (/cte/rastreio/:chave). */
export interface RastreioEventoDto {
  dataHora: string | null;
  codigoSsw: string | null;
  ocorrencia: string | null;
  descricao: string | null;
  cidade: string | null;
  filial: string | null;
  tipo: string | null;
  nomeRecebedor: string | null;
  entrega: boolean;
}

/** Situação de transporte derivada (NF/Pedido). */
export type SituacaoTransporte = 'ENTREGUE' | 'EM_TRANSITO' | 'SEM_RASTREIO' | 'PENDENTE';

/** Rastreio resolvido a partir da chave de uma NF transportada (tela da NF / Pedido). */
export interface RastreioPorNfeDto {
  chaveNfe: string;
  vinculado: boolean; // existe CT-e transportando esta NF?
  cteChave: string | null;
  numeroNf: string | null;
  transportadora: string | null;
  transportadoraCnpj: string | null;
  modalidadeFrete: string | null; // REMETENTE | DESTINATÁRIO | ...
  freteNossaConta: boolean; // somos o tomador (frete por nossa conta)
  valorFrete: number | null; // valor da prestação (a pagar quando freteNossaConta)
  nfLancada: boolean; // NF já lançada no ERP (status_erp=LANCADA)
  situacao: SituacaoTransporte; // Entregue (lançada) > Em Trânsito > Sem rastreio > Pendente
  rastreio: RastreioDto | null;
}

/** Resposta do rastreio de um CT-e (cabeçalho + timeline). */
export interface RastreioDto {
  chave: string;
  statusFiscal: string | null; // PENDENTE | LANCADA (espelho do ERP)
  status: string | null; // EM_TRANSITO | ENTREGUE | null (movimentação SSW)
  cobertura: string | null; // COBERTO | SEM_RASTREIO | null
  dominio: string | null;
  previsao: string | null;
  entregueEm: string | null;
  recebedor: string | null;
  ultimaConsulta: string | null;
  eventos: RastreioEventoDto[];
}

// Janela de polling: só rastreamos CT-es emitidos nos últimos N dias.
const JANELA_DIAS = Number(process.env.SSW_TRACKING_JANELA_DIAS) || 45;
// Máximo de CT-es consultados por disparo do cron (politez com a API pública).
const MAX_POR_RODADA = Number(process.env.SSW_TRACKING_MAX_POR_RODADA) || 150;
// Concorrência de chamadas simultâneas ao SSW.
const CONCORRENCIA = Number(process.env.SSW_TRACKING_CONCORRENCIA) || 5;
// Após N consultas sem documento localizado, marca o CT-e como SEM_RASTREIO.
// As tentativas contam NO MÁXIMO UMA POR DIA (não uma por rodada): a transportadora
// registra a NF no SSW dias depois da emissão, e contar por rodada queimava as 6
// tentativas em ~3h de cron — CT-es entregues ficavam "sem rastreio" para sempre.
const TENT_CTE_SEM_RASTREIO = Number(process.env.SSW_TRACKING_TENT_CTE) || 6;
// Após N falhas acumuladas, marca a transportadora (CNPJ-raiz) como fora do SSW.
const TENT_TRANSP_SEM_SSW = Number(process.env.SSW_TRACKING_TENT_TRANSP) || 8;
// Transportadora marcada fora do SSW volta a ser SONDADA após N dias (uma consulta
// de prova por rodada): sem isso a lista negra era permanente e transportadoras que
// entram no SSW (ou entraram errado na lista) nunca voltavam a rastrear.
const SONDA_TRANSP_DIAS = Number(process.env.SSW_TRACKING_SONDA_TRANSP_DIAS) || 7;

@Injectable()
export class CteRastreioService {
  private readonly logger = new Logger(CteRastreioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CteRastreioClient,
  ) {}

  // =====================================================================
  // LEITURA — timeline para a tela de detalhe
  // =====================================================================

  async getRastreio(chave: string): Promise<RastreioDto | null> {
    const key = String(chave || '').trim();
    if (!key) return null;

    const cte = await this.prisma.cteDocumento.findUnique({
      where: { chave_acesso: key },
      select: {
        chave_acesso: true,
        status: true,
        dados_json: true,
        rastreio_status: true,
        rastreio_cobertura: true,
        rastreio_dominio: true,
        rastreio_previsao: true,
        rastreio_entregue_em: true,
        rastreio_recebedor: true,
        rastreio_ult_consulta: true,
      },
    });
    if (!cte) return null;

    const eventos = await this.prisma.cteRastreioEvento.findMany({
      where: { chave_acesso: key },
      orderBy: { data_hora: 'desc' },
    });

    // Previsão de entrega: prioriza o que o SSW gravou; senão, a estimativa do próprio CT-e.
    const prevDoc = parseSswDate((cte.dados_json as any)?.prevEntrega);
    const previsao = cte.rastreio_previsao || prevDoc;

    return {
      chave: key,
      statusFiscal: cte.status,
      status: cte.rastreio_status,
      cobertura: cte.rastreio_cobertura,
      dominio: cte.rastreio_dominio,
      previsao: previsao ? previsao.toISOString() : null,
      entregueEm: cte.rastreio_entregue_em ? cte.rastreio_entregue_em.toISOString() : null,
      recebedor: cte.rastreio_recebedor,
      ultimaConsulta: cte.rastreio_ult_consulta ? cte.rastreio_ult_consulta.toISOString() : null,
      eventos: eventos.map((e) => ({
        dataHora: e.data_hora ? e.data_hora.toISOString() : null,
        codigoSsw: e.codigo_ssw,
        ocorrencia: e.ocorrencia,
        descricao: e.descricao,
        cidade: e.cidade,
        filial: e.filial,
        tipo: e.tipo,
        nomeRecebedor: e.nome_recebedor,
        entrega: this.ehEntrega(e),
      })),
    };
  }

  /**
   * Resolve o rastreio a partir da chave de uma NF transportada (tela da NF e do Pedido).
   * Acha o CT-e cujo documentosNFe contém a chave, deriva transportadora/frete e a
   * situação de transporte (Entregue quando a NF está lançada; senão Em Trânsito quando
   * há CT-e coberto com movimento; senão Sem rastreio / Pendente).
   */
  async getRastreioPorNfe(chaveNfe: string): Promise<RastreioPorNfeDto> {
    const chave = String(chaveNfe || '').replace(/\D/g, '');
    const base: RastreioPorNfeDto = {
      chaveNfe: chave,
      vinculado: false,
      cteChave: null,
      numeroNf: chave.length >= 34 ? chave.substring(25, 34).replace(/^0+/, '') || null : null,
      transportadora: null,
      transportadoraCnpj: null,
      modalidadeFrete: null,
      freteNossaConta: false,
      valorFrete: null,
      nfLancada: false,
      situacao: 'PENDENTE',
      rastreio: null,
    };
    if (chave.length !== 44) return base;

    // NF lançada no ERP? (status_erp=LANCADA → mercadoria recebida → Entregue)
    const nfe = await this.prisma.nfeConciliacao
      .findUnique({ where: { chave_nfe: chave }, select: { status_erp: true } })
      .catch(() => null);
    base.nfLancada = nfe?.status_erp === 'LANCADA';

    // CT-e que transporta esta NF (prefere o que tem rastreio / mais recente).
    const cte = await this.prisma.cteDocumento.findFirst({
      where: { dados_json: { path: ['documentosNFe'], array_contains: chave } },
      orderBy: [{ rastreio_status: 'desc' }, { data_emissao: 'desc' }],
      select: {
        chave_acesso: true,
        emitente_nome: true,
        emitente_cnpj: true,
        modalidade_pagador: true,
        tomador_nos: true,
        valor_total: true,
        rastreio_status: true,
        rastreio_cobertura: true,
      },
    });

    if (cte) {
      base.vinculado = true;
      base.cteChave = cte.chave_acesso;
      base.transportadora = cte.emitente_nome;
      base.transportadoraCnpj = cte.emitente_cnpj;
      base.modalidadeFrete = labelModalidade(cte.modalidade_pagador);
      base.freteNossaConta = !!cte.tomador_nos;
      base.valorFrete = cte.valor_total != null ? Number(cte.valor_total) : null;
      base.rastreio = await this.getRastreio(cte.chave_acesso);
    }

    // Situação (Lançada=Entregue sobrepõe; senão Em Trânsito enquanto há movimento coberto).
    const emMovimento =
      cte?.rastreio_cobertura === 'COBERTO' &&
      (cte?.rastreio_status === 'EM_TRANSITO' || cte?.rastreio_status === 'ENTREGUE');
    if (base.nfLancada) base.situacao = 'ENTREGUE';
    else if (emMovimento) base.situacao = 'EM_TRANSITO';
    else if (cte?.rastreio_cobertura === 'SEM_RASTREIO') base.situacao = 'SEM_RASTREIO';
    else base.situacao = 'PENDENTE';

    return base;
  }

  // =====================================================================
  // SINCRONIZAÇÃO — polling do SSW (cron e botão manual)
  // =====================================================================

  async sincronizar(): Promise<{
    ok: true;
    consultados: number;
    emTransito: number;
    entregues: number;
    semRastreio: number;
    erros: number;
  }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - JANELA_DIAS);

    // Meia-noite local — âncora do "no máximo uma tentativa por dia" e da
    // re-tentativa diária de SEM_RASTREIO.
    const inicioHoje = new Date();
    inicioHoje.setHours(0, 0, 0, 0);

    // Candidatos: PENDENTE (LANCADA já chegou → não gasta API), dentro da janela,
    // ainda não entregue. Os nunca-consultados (rastreio_ult_consulta = null) vêm
    // primeiro. SEM_RASTREIO NÃO é mais definitivo: enquanto o CT-e está na janela,
    // ele volta à fila UMA vez por dia — a transportadora pode registrar o documento
    // no SSW dias depois da emissão.
    const candidatos = await this.prisma.cteDocumento.findMany({
      where: {
        status: 'PENDENTE',
        data_emissao: { gte: cutoff },
        AND: [
          { OR: [{ rastreio_status: null }, { rastreio_status: 'EM_TRANSITO' }] },
          {
            OR: [
              { rastreio_cobertura: null },
              { rastreio_cobertura: 'COBERTO' },
              { rastreio_cobertura: 'SEM_RASTREIO', rastreio_ult_consulta: { lt: inicioHoje } },
            ],
          },
        ],
      },
      select: {
        chave_acesso: true,
        emitente_cnpj: true,
        emitente_nome: true,
        dados_json: true,
        rastreio_tentativas: true,
        rastreio_ult_consulta: true,
        rastreio_cobertura: true,
      },
      orderBy: [{ rastreio_ult_consulta: { sort: 'asc', nulls: 'first' } }],
      take: MAX_POR_RODADA,
    });

    if (!candidatos.length) {
      return { ok: true, consultados: 0, emTransito: 0, entregues: 0, semRastreio: 0, erros: 0 };
    }

    // Cobertura conhecida por transportadora (CNPJ-raiz).
    const coberturas = await this.prisma.cteTransportadoraCobertura.findMany();
    const covMap = new Map(coberturas.map((c) => [c.cnpj_raiz, c]));

    let emTransito = 0;
    let entregues = 0;
    let semRastreio = 0;
    let erros = 0;
    let consultados = 0;

    // Uma SONDA por transportadora por rodada: revalida a lista negra sem
    // multiplicar chamadas quando vários CT-es dela caem na mesma rodada.
    const sondadas = new Set<string>();

    for (const lote of chunk(candidatos, CONCORRENCIA)) {
      await Promise.all(
        lote.map(async (cte) => {
          const raiz = raizCnpj(cte.emitente_cnpj);
          const cov = raiz ? covMap.get(raiz) : undefined;

          // Transportadora sabidamente fora do SSW → marca sem chamar a API,
          // EXCETO quando a verificação venceu (SONDA_TRANSP_DIAS): aí um CT-e
          // segue como sonda e, se o SSW responder, a cobertura vira `true` e a
          // transportadora inteira volta a rastrear.
          if (cov && cov.coberta === false) {
            const verificadaEm = cov.ultima_verificacao
              ? new Date(cov.ultima_verificacao).getTime()
              : 0;
            const vencida = Date.now() - verificadaEm > SONDA_TRANSP_DIAS * 86_400_000;
            if (!vencida || sondadas.has(raiz!)) {
              await this.marcarSemRastreio(cte.chave_acesso);
              semRastreio++;
              return;
            }
            sondadas.add(raiz!);
          }

          const chaveNfe = primeiraChaveNfe(cte.dados_json);
          if (!chaveNfe) {
            // Sem NF-e transportada não há como rastrear; apenas registra a tentativa.
            await this.tocarConsulta(cte.chave_acesso);
            return;
          }

          const resp = await this.client.rastrearPorChaveNfe(chaveNfe);
          consultados++;

          if (resp.success && resp.tracking.length) {
            const r = await this.aplicarSucesso(cte.chave_acesso, resp.tracking);
            if (r === 'ENTREGUE') entregues++;
            else emTransito++;
            const dominio = resp.tracking.find((t) => t.dominio)?.dominio || null;
            await this.registrarCoberturaTransportadora(raiz, cte.emitente_nome, true, dominio, covMap);
          } else if (resp.success) {
            // Respondeu sem eventos — o documento EXISTE no SSW, só não se moveu.
            // Se o CT-e estava marcado SEM_RASTREIO (re-tentativa), a marca cai:
            // ele volta à fila normal e as tentativas zeram.
            if (cte.rastreio_cobertura === 'SEM_RASTREIO') {
              await this.prisma.cteDocumento
                .update({
                  where: { chave_acesso: cte.chave_acesso },
                  data: {
                    rastreio_cobertura: null,
                    rastreio_tentativas: 0,
                    rastreio_ult_consulta: new Date(),
                  },
                })
                .catch(() => undefined);
            } else {
              await this.tocarConsulta(cte.chave_acesso);
            }
          } else if (/localizado|inválida|nenhum/i.test(resp.message || '')) {
            // Documento não encontrado no SSW: conta tentativa — NO MÁXIMO UMA POR
            // DIA. A primeira falha do dia conta (a última consulta é de ontem ou
            // nunca houve); as rodadas seguintes do mesmo dia só tocam a consulta.
            // O mesmo vale para as falhas da TRANSPORTADORA: sem o teto diário, a
            // lista negra fechava em 8 rodadas (~4h) de um único CT-e recém-emitido.
            const contaHoje = !cte.rastreio_ult_consulta || cte.rastreio_ult_consulta < inicioHoje;
            const novasTent = (cte.rastreio_tentativas || 0) + (contaHoje ? 1 : 0);
            if (contaHoje && novasTent >= TENT_CTE_SEM_RASTREIO) {
              await this.marcarSemRastreio(cte.chave_acesso);
              semRastreio++;
            } else {
              await this.prisma.cteDocumento.update({
                where: { chave_acesso: cte.chave_acesso },
                data: { rastreio_tentativas: novasTent, rastreio_ult_consulta: new Date() },
              });
            }
            if (contaHoje) {
              await this.registrarCoberturaTransportadora(raiz, cte.emitente_nome, false, null, covMap);
            }
          } else {
            // Erro de comunicação: não penaliza cobertura, só toca a consulta.
            erros++;
            await this.tocarConsulta(cte.chave_acesso);
          }
        }),
      );
    }

    this.logger.log(
      `Rastreio SSW: ${consultados} consultados, ${emTransito} em trânsito, ${entregues} entregues, ${semRastreio} sem rastreio, ${erros} erros.`,
    );
    return { ok: true, consultados, emTransito, entregues, semRastreio, erros };
  }

  // =====================================================================
  // Persistência de eventos / status
  // =====================================================================

  /** Grava os eventos (dedupe) e atualiza o status do CT-e. Retorna o status final. */
  private async aplicarSucesso(
    chave: string,
    tracking: SswTrackingEvento[],
  ): Promise<'EM_TRANSITO' | 'ENTREGUE'> {
    const eventos = tracking
      .map((t) => ({ ...t, _dt: parseSswDate(t.data_hora || t.data_hora_efetiva) }))
      .filter((t) => t._dt) as Array<SswTrackingEvento & { _dt: Date }>;

    for (const ev of eventos) {
      await this.prisma.cteRastreioEvento
        .upsert({
          where: {
            uq_cte_evento: {
              chave_acesso: chave,
              data_hora: ev._dt,
              codigo_ssw: ev.codigo_ssw || '',
            },
          },
          create: {
            chave_acesso: chave,
            data_hora: ev._dt,
            codigo_ssw: ev.codigo_ssw || '',
            ocorrencia: ev.ocorrencia || null,
            descricao: ev.descricao || null,
            cidade: ev.cidade || null,
            filial: ev.filial || null,
            tipo: ev.tipo || null,
            nome_recebedor: ev.nome_recebedor || null,
            dominio: ev.dominio || null,
          },
          update: {
            ocorrencia: ev.ocorrencia || null,
            descricao: ev.descricao || null,
            nome_recebedor: ev.nome_recebedor || null,
          },
        })
        .catch(() => undefined);
    }

    const entrega = eventos.find((e) => this.ehEntrega(e));
    const ultimo = eventos.slice().sort((a, b) => b._dt.getTime() - a._dt.getTime())[0];
    const dominio = eventos.find((e) => e.dominio)?.dominio || null;

    const status: 'EM_TRANSITO' | 'ENTREGUE' = entrega ? 'ENTREGUE' : 'EM_TRANSITO';

    await this.prisma.cteDocumento.update({
      where: { chave_acesso: chave },
      data: {
        rastreio_status: status,
        rastreio_cobertura: 'COBERTO',
        rastreio_dominio: dominio || undefined,
        rastreio_ult_evento: ultimo?.ocorrencia || ultimo?.descricao || undefined,
        rastreio_entregue_em: entrega ? entrega._dt : undefined,
        rastreio_recebedor: entrega?.nome_recebedor || undefined,
        rastreio_tentativas: 0,
        rastreio_ult_consulta: new Date(),
      },
    });

    return status;
  }

  private async marcarSemRastreio(chave: string) {
    await this.prisma.cteDocumento
      .update({
        where: { chave_acesso: chave },
        data: { rastreio_cobertura: 'SEM_RASTREIO', rastreio_ult_consulta: new Date() },
      })
      .catch(() => undefined);
  }

  private async tocarConsulta(chave: string) {
    await this.prisma.cteDocumento
      .update({ where: { chave_acesso: chave }, data: { rastreio_ult_consulta: new Date() } })
      .catch(() => undefined);
  }

  /** Atualiza/insere a cobertura por transportadora (CNPJ-raiz) e o mapa em memória. */
  private async registrarCoberturaTransportadora(
    raiz: string | null,
    nome: string | null | undefined,
    sucesso: boolean,
    dominio: string | null,
    covMap: Map<string, any>,
  ) {
    if (!raiz) return;
    const atual = covMap.get(raiz);

    if (sucesso) {
      const data = {
        nome: nome || atual?.nome || null,
        coberta: true,
        dominio: dominio || atual?.dominio || null,
        tentativas_sem_sucesso: 0,
        ultima_verificacao: new Date(),
      };
      const novo = await this.prisma.cteTransportadoraCobertura
        .upsert({ where: { cnpj_raiz: raiz }, create: { cnpj_raiz: raiz, ...data }, update: data })
        .catch(() => null);
      if (novo) covMap.set(raiz, novo);
      return;
    }

    // Falha: acumula tentativas; só marca coberta=false quando ainda é desconhecida
    // (nunca rebaixa uma transportadora já confirmada como SSW).
    const novasTent = (atual?.tentativas_sem_sucesso || 0) + 1;
    const cobertaNova = atual?.coberta === true ? true : novasTent >= TENT_TRANSP_SEM_SSW ? false : null;
    const data = {
      nome: nome || atual?.nome || null,
      coberta: cobertaNova,
      tentativas_sem_sucesso: novasTent,
      ultima_verificacao: new Date(),
    };
    const novo = await this.prisma.cteTransportadoraCobertura
      .upsert({ where: { cnpj_raiz: raiz }, create: { cnpj_raiz: raiz, ...data }, update: data })
      .catch(() => null);
    if (novo) covMap.set(raiz, novo);
  }

  /** Heurística de "entrega realizada" a partir de uma ocorrência do SSW. */
  private ehEntrega(ev: {
    codigo_ssw?: string | null;
    ocorrencia?: string | null;
    descricao?: string | null;
    nome_recebedor?: string | null;
  }): boolean {
    const cod = String(ev.codigo_ssw || '').replace(/\D/g, '');
    if (cod === '1') return true; // SSW: ocorrência 1 = mercadoria entregue
    if (String(ev.nome_recebedor || '').trim()) return true;
    const txt = `${ev.ocorrencia || ''} ${ev.descricao || ''}`.toUpperCase();
    return /MERCADORIA ENTREGUE|ENTREGA REALIZADA|COMPROVANTE DE ENTREGA/.test(txt);
  }
}

/**
 * Normaliza o papel do tomador/modalidade do frete para um rótulo limpo.
 * Tolera mojibake do XML (ex.: "DESTINAT�RIO") casando pelo prefixo.
 */
function labelModalidade(raw?: string | null): string | null {
  const s = String(raw || '').toUpperCase();
  if (!s) return null;
  if (s.startsWith('REMET')) return 'Remetente';
  if (s.startsWith('DESTINAT')) return 'Destinatário';
  if (s.startsWith('EXPED')) return 'Expedidor';
  if (s.startsWith('RECEB')) return 'Recebedor';
  if (s.startsWith('OUTRO')) return 'Outros';
  return raw || null;
}

/** CNPJ-raiz (8 primeiros dígitos) ou null. */
function raizCnpj(cnpj?: string | null): string | null {
  const d = String(cnpj || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(0, 8) : null;
}

/** Primeira chave de NF-e transportada (dados_json.documentosNFe[0]). */
function primeiraChaveNfe(dadosJson: any): string | null {
  const docs = dadosJson && typeof dadosJson === 'object' ? (dadosJson as any).documentosNFe : null;
  if (Array.isArray(docs)) {
    for (const d of docs) {
      const chave = String(d || '').replace(/\D/g, '');
      if (chave.length === 44) return chave;
    }
  }
  return null;
}

/** Converte a data do SSW ("2026-06-25T15:07:13" ou "2026-06-25 15:07:13") em Date. */
function parseSswDate(value?: string | null): Date | null {
  const s = String(value || '').trim();
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Divide um array em lotes de tamanho `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
