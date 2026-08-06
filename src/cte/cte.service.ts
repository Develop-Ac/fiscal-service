import { Injectable, Logger } from '@nestjs/common';
import * as zlib from 'zlib';
import { randomUUID } from 'crypto';
import { OpenQueryService } from '../shared/database/openquery/openquery.service';
import { ErpApiService } from '../shared/erp-api/erp-api.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseCteXml } from './cte-xml.parser';
import { gerarDacte } from './dacte/dacte.generator';
import { CteData, CteListItem } from './cte.types';

type CargaJob = {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  totalEncontradas: number;
  processadas: number;
  inseridas: number;
  ignoradas: number;
  progresso: number;
  logs: string[];
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
};

// Data-base da carga inicial / janela padrão da listagem.
const INICIO_PADRAO = '2026-01-01';

// Raiz do CNPJ da nossa empresa (C. M. SIQUEIRA E CIA LTDA — AC ACESSÓRIOS): matriz
// 07.351.198/0001-05 e filial /0002-88 compartilham a mesma raiz (8 primeiros dígitos).
const NOSSO_CNPJ_RAIZ = '07351198';

/**
 * Classifica o frete pela posição da nossa empresa no CT-e:
 *  - destinatário = nós  → COMPRA (recebemos a mercadoria);
 *  - remetente   = nós   → VENDA  (despachamos a mercadoria);
 *  - caso contrário      → OUTRO.
 */
function classificarFrete(remetenteCnpj?: string | null, destinatarioCnpj?: string | null): 'COMPRA' | 'VENDA' | 'OUTRO' {
  const raiz = (c?: string | null) => String(c || '').replace(/\D/g, '').slice(0, 8);
  if (raiz(destinatarioCnpj) === NOSSO_CNPJ_RAIZ) return 'COMPRA';
  if (raiz(remetenteCnpj) === NOSSO_CNPJ_RAIZ) return 'VENDA';
  return 'OUTRO';
}

@Injectable()
export class CteService {
  private readonly logger = new Logger(CteService.name);
  private readonly cargaJobs = new Map<string, CargaJob>();

  constructor(
    private readonly openQuery: OpenQueryService,
    private readonly erpApi: ErpApiService,
    private readonly prisma: PrismaService,
  ) {}

  // =====================================================================
  // LISTAGEM / DETALHE (servidos do Postgres)
  // =====================================================================

  async listCtes(params: {
    status?: string;
    tipoFrete?: string;
    somosTomador?: string;
    numero?: string;
    emitente?: string;
    cnpj?: string;
    dataInicio?: string;
    dataFim?: string;
    page?: string | number;
    pageSize?: string | number;
  }): Promise<{ items: CteListItem[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 20));

    const where: any = {};

    const status = String(params.status || '').toUpperCase();
    if (status === 'PENDENTE' || status === 'LANCADA') {
      where.status = status;
    } else if (status === 'EM_TRANSITO' || status === 'ENTREGUE') {
      // Situação de transporte (rastreio SSW). "Lançada" sobrepõe, então excluímos LANCADA.
      where.rastreio_status = status;
      where.status = { not: 'LANCADA' };
    }

    const tipoFrete = String(params.tipoFrete || '').toUpperCase();
    if (tipoFrete === 'COMPRA' || tipoFrete === 'VENDA' || tipoFrete === 'OUTRO') {
      where.tipo_frete = tipoFrete;
    }

    const somosTomador = String(params.somosTomador || '').trim();
    if (somosTomador === '1' || somosTomador.toLowerCase() === 'true') {
      where.tomador_nos = true;
    }

    const numero = String(params.numero || '').trim();
    if (numero) {
      where.OR = [
        { numero: { contains: numero } },
        { chave_acesso: { contains: numero } },
      ];
    }

    const emitente = String(params.emitente || '').trim();
    if (emitente) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { emitente_nome: { contains: emitente, mode: 'insensitive' } },
            { remetente_nome: { contains: emitente, mode: 'insensitive' } },
          ],
        },
      ];
    }

    const cnpj = String(params.cnpj || '').replace(/\D/g, '');
    if (cnpj) {
      where.emitente_cnpj = { contains: cnpj };
    }

    if (params.dataInicio || params.dataFim) {
      where.data_emissao = {};
      if (params.dataInicio) where.data_emissao.gte = new Date(`${params.dataInicio}T00:00:00`);
      if (params.dataFim) where.data_emissao.lte = new Date(`${params.dataFim}T23:59:59.999`);
    }

    const [total, rows] = await Promise.all([
      this.prisma.cteDocumento.count({ where }),
      this.prisma.cteDocumento.findMany({
        where,
        orderBy: { data_emissao: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const items: CteListItem[] = rows.map((r) => ({
      chave: r.chave_acesso,
      numero: r.numero || '',
      serie: r.serie || '',
      emitente_nome: r.emitente_nome || '',
      emitente_cnpj: r.emitente_cnpj || '',
      remetente_nome: r.remetente_nome || '',
      destinatario_nome: r.destinatario_nome || '',
      origem: r.origem || '',
      destino: r.destino || '',
      cfop: r.cfop || '',
      valor: Number(r.valor_total || 0),
      data_emissao: r.data_emissao ? r.data_emissao.toISOString() : '',
      dt_entrada: r.dt_entrada ? r.dt_entrada.toISOString() : null,
      status: (r.status as 'PENDENTE' | 'LANCADA') || 'PENDENTE',
      tipoFrete: (r.tipo_frete as 'COMPRA' | 'VENDA' | 'OUTRO') || 'OUTRO',
      tomadorNome: r.tomador_nome || '',
      tomadorCnpj: r.tomador_cnpj || '',
      modalidadePagador: r.modalidade_pagador || '',
      tomadorNos: !!r.tomador_nos,
      rastreioStatus: (r.rastreio_status as 'EM_TRANSITO' | 'ENTREGUE' | null) || null,
      rastreioCobertura: (r.rastreio_cobertura as 'COBERTO' | 'SEM_RASTREIO' | null) || null,
    }));

    return { items, total, page, pageSize };
  }

  async getCteByKey(chave: string): Promise<CteData | null> {
    const key = String(chave || '').trim();
    if (!key) return null;

    const local = await this.prisma.cteDocumento.findUnique({ where: { chave_acesso: key } });
    if (!local) return null;

    // dados_json já tem o CteData parseado; se faltar, parseia o XML na hora.
    if (local.dados_json && typeof local.dados_json === 'object') {
      return local.dados_json as unknown as CteData;
    }

    const xml = await this.decodeXml(local.xml_completo);
    if (xml) return parseCteXml(xml);
    return null;
  }

  /** XML decodificado do CT-e (Postgres → fallback ERP CTE_ENTRADA_XML). */
  async getCteXml(chave: string): Promise<string | null> {
    const key = String(chave || '').trim();
    if (!key) return null;

    const local = await this.prisma.cteDocumento.findUnique({
      where: { chave_acesso: key },
      select: { xml_completo: true },
    });
    const fromLocal = await this.decodeXml(local?.xml_completo || '');
    if (fromLocal && fromLocal.startsWith('<')) return fromLocal;

    // fallback: busca direto no ERP
    const rows = await this.fetchCteEntradaXmlByKeys([key]);
    if (rows.length) {
      const xml = await this.normalizeBlobXml(rows[0].XML_COMPLETO);
      if (xml) return xml;
    }
    return null;
  }

  async generateDacteByKey(chave: string): Promise<Buffer | null> {
    const xml = await this.getCteXml(chave);
    if (!xml) return null;
    const data = parseCteXml(xml);
    return gerarDacte(data);
  }

  // =====================================================================
  // SINCRONIZAÇÃO INCREMENTAL (botão "Atualizar")
  // =====================================================================

  async sincronizar(): Promise<{ ok: true; pendentes: number; preenchidas: number; lancadas: number }> {
    // 1) Pendentes do ERP (CTE_DISTRIBUICAO, IMPORTADA='N') desde a data-base.
    const pendentes = await this.fetchCteDistribuicaoPendentes(INICIO_PADRAO);
    const pendIndex = new Map<string, any>();
    for (const p of pendentes) {
      const c = String(p.CHAVE_CTE || '').trim();
      if (c) pendIndex.set(c, p);
    }
    const chavesPendErp = Array.from(pendIndex.keys());

    // Quais já estão completas (dados_json) ou já LANCADA no Postgres — não reprocessa
    // (evita rebuscar XML à toa e não rebaixa LANCADA → PENDENTE).
    const existentes = await this.prisma.cteDocumento.findMany({
      where: { chave_acesso: { in: chavesPendErp } },
      select: { chave_acesso: true, dados_json: true, status: true },
    });
    const jaResolvida = new Set(
      existentes
        .filter((e) => e.status === 'LANCADA' || (e.dados_json && typeof e.dados_json === 'object'))
        .map((e) => e.chave_acesso),
    );

    // 2) Para as pendentes ainda SEM dados, busca o XML no CTE_ENTRADA_XML e preenche tudo.
    //    Se o XML ainda não chegou, grava o básico (e tenta de novo no próximo sync).
    let pendCount = 0;
    let preenchidas = 0;
    for (const lote of chunk(chavesPendErp, 100)) {
      const faltando = lote.filter((c) => !jaResolvida.has(c));
      const xmlRows = faltando.length ? await this.fetchCteEntradaXmlByKeys(faltando) : [];
      const xmlByChave = new Map<string, any>();
      for (const r of xmlRows) xmlByChave.set(String(r.CHAVE_CTE || '').trim(), r.XML_COMPLETO);

      for (const chave of lote) {
        pendCount++;
        if (jaResolvida.has(chave)) continue; // já completa/lançada
        const xml = await this.normalizeBlobXml(xmlByChave.get(chave));
        if (xml && xml.startsWith('<')) {
          await this.upsertComXml(chave, xml, 'PENDENTE', null);
          preenchidas++;
        } else {
          await this.upsertPendenteBasico(pendIndex.get(chave) || { CHAVE_CTE: chave });
        }
      }
    }

    // 3) Reconciliação: docs locais PENDENTE que já estão na NF_ENTRADA viram LANCADA.
    const locaisPendentes = await this.prisma.cteDocumento.findMany({
      where: { status: 'PENDENTE' },
      select: { chave_acesso: true },
    });
    const chavesPend = locaisPendentes.map((l) => l.chave_acesso);
    let lancadasCount = 0;
    for (const lote of chunk(chavesPend, 100)) {
      const datas = await this.fetchNfEntradaDatesByKeys(lote);
      for (const [chave, dt] of datas.entries()) {
        await this.marcarLancada(chave, dt);
        lancadasCount++;
      }
    }

    return { ok: true, pendentes: pendCount, preenchidas, lancadas: lancadasCount };
  }

  // =====================================================================
  // CARGA INICIAL (job com progresso) — lançadas + pendentes desde jan/2026
  // =====================================================================

  startCargaInicialJob(): { jobId: string } {
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    this.cargaJobs.set(jobId, {
      jobId,
      status: 'running',
      totalEncontradas: 0,
      processadas: 0,
      inseridas: 0,
      ignoradas: 0,
      progresso: 0,
      logs: [`[${startedAt}] Iniciando carga inicial de CT-es...`],
      startedAt,
    });

    this.runCargaInicial(jobId).catch((e) => {
      this.logger.error('Erro na carga inicial de CT-es', e instanceof Error ? e.stack : String(e));
    });

    return { jobId };
  }

  getCargaInicialJob(jobId: string): CargaJob | null {
    return this.cargaJobs.get(jobId) ?? null;
  }

  private appendLog(jobId: string, message: string) {
    const job = this.cargaJobs.get(jobId);
    if (!job) return;
    job.logs.push(`[${new Date().toISOString()}] ${message}`);
    if (job.logs.length > 300) job.logs = job.logs.slice(-300);
    this.cargaJobs.set(jobId, job);
  }

  private async runCargaInicial(jobId: string) {
    const job = this.cargaJobs.get(jobId);
    if (!job) return;
    try {
      // -------- A) PENDENTES (CTE_DISTRIBUICAO) --------
      this.appendLog(jobId, 'Consultando pendentes na CTE_DISTRIBUICAO...');
      const pendentes = await this.fetchCteDistribuicaoPendentes(INICIO_PADRAO);
      this.appendLog(jobId, `Pendentes encontradas: ${pendentes.length}`);

      // -------- B) LANÇADAS (CTE_ENTRADA_XML ∩ NF_ENTRADA) --------
      this.appendLog(jobId, 'Consultando chaves de CT-e no CTE_ENTRADA_XML...');
      const xmlKeys = await this.fetchCteEntradaXmlKeys(INICIO_PADRAO);
      this.appendLog(jobId, `Chaves no CTE_ENTRADA_XML (>= ${INICIO_PADRAO}): ${xmlKeys.length}`);

      // confirma lançamento via NF_ENTRADA (IN-list, em lotes) — scan amplo quebra o OLE DB.
      const lancadasMap = new Map<string, Date | null>();
      for (const lote of chunk(xmlKeys, 100)) {
        const datas = await this.fetchNfEntradaDatesByKeys(lote);
        for (const [chave, dt] of datas.entries()) lancadasMap.set(chave, dt);
      }
      this.appendLog(jobId, `Lançadas confirmadas na NF_ENTRADA: ${lancadasMap.size}`);

      // Universo a processar (chaves únicas)
      const universo = new Set<string>([
        ...pendentes.map((p) => String(p.CHAVE_CTE || '').trim()).filter(Boolean),
        ...Array.from(lancadasMap.keys()),
      ]);
      job.totalEncontradas = universo.size;
      this.cargaJobs.set(jobId, job);
      this.appendLog(jobId, `Total de CT-es a processar: ${universo.size}`);

      // índice rápido dos dados de pendentes (emitente/valor/data sem XML)
      const pendIndex = new Map<string, any>();
      for (const p of pendentes) pendIndex.set(String(p.CHAVE_CTE || '').trim(), p);

      const chaves = Array.from(universo);
      let processadas = 0;
      let inseridas = 0;
      let ignoradas = 0;

      for (const lote of chunk(chaves, 100)) {
        // busca XMLs do lote de uma vez
        const xmlRows = await this.fetchCteEntradaXmlByKeys(lote);
        const xmlByChave = new Map<string, any>();
        for (const r of xmlRows) xmlByChave.set(String(r.CHAVE_CTE || '').trim(), r.XML_COMPLETO);

        for (const chave of lote) {
          try {
            const dtEntrada = lancadasMap.has(chave) ? lancadasMap.get(chave) ?? null : null;
            const status = lancadasMap.has(chave) ? 'LANCADA' : 'PENDENTE';
            const xml = await this.normalizeBlobXml(xmlByChave.get(chave));

            if (xml && xml.startsWith('<')) {
              await this.upsertComXml(chave, xml, status, dtEntrada);
            } else {
              // sem XML: grava o básico vindo da distribuição
              const p = pendIndex.get(chave);
              await this.upsertPendenteBasico(p || { CHAVE_CTE: chave }, status, dtEntrada);
            }
            inseridas++;
          } catch (e) {
            ignoradas++;
          }
          processadas++;
        }

        job.processadas = processadas;
        job.inseridas = inseridas;
        job.ignoradas = ignoradas;
        job.progresso = universo.size === 0 ? 100 : Math.round((processadas / universo.size) * 100);
        this.cargaJobs.set(jobId, job);
      }

      job.status = 'completed';
      job.progresso = 100;
      job.completedAt = new Date().toISOString();
      this.cargaJobs.set(jobId, job);
      this.appendLog(jobId, `Concluído. Processadas: ${processadas}, inseridas/atualizadas: ${inseridas}, ignoradas: ${ignoradas}.`);
    } catch (e) {
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.errorMessage = e instanceof Error ? e.message : String(e);
      this.cargaJobs.set(jobId, job);
      this.appendLog(jobId, `Falha: ${job.errorMessage}`);
    }
  }

  // =====================================================================
  // UPSERTS no Postgres
  // =====================================================================

  private async upsertComXml(chave: string, xml: string, status: string, dtEntrada: Date | null) {
    const data = parseCteXml(xml);
    const xmlCompactado = this.encodeXml(xml);
    const origem = data.origemMunicipio && data.origemUf ? `${data.origemMunicipio}/${data.origemUf}` : null;
    const destino = data.destinoMunicipio && data.destinoUf ? `${data.destinoMunicipio}/${data.destinoUf}` : null;
    const dataEmissao = data.dataEmissao ? new Date(data.dataEmissao) : null;

    const tipoFrete = classificarFrete(data.remetente.cnpjCpf, data.destinatario.cnpjCpf);
    const raiz = (c?: string | null) => String(c || '').replace(/\D/g, '').slice(0, 8);
    const tomadorNos = !!data.tomadorParte && raiz(data.tomadorParte.cnpjCpf) === NOSSO_CNPJ_RAIZ;
    // Dados do tomador (responsável pelo pagamento do frete) + modalidade = papel
    // (REMETENTE/DESTINATÁRIO/EXPEDIDOR/RECEBEDOR/OUTROS). A tela mostra a modalidade
    // quando não somos nós, e "Por nossa conta" quando somos.
    const tomadorNome = data.tomadorParte?.nome || '';
    const tomadorCnpj = data.tomadorParte?.cnpjCpf || '';
    const modalidadePagador = data.tomador || '';

    const base = {
      numero: data.numero || null,
      serie: data.serie || null,
      cfop: data.cfop || null,
      emitente_nome: data.emitente.nome || null,
      emitente_cnpj: data.emitente.cnpjCpf || null,
      remetente_nome: data.remetente.nome || null,
      destinatario_nome: data.destinatario.nome || null,
      origem,
      destino,
      valor_total: data.valorTotalPrestacao || 0,
      data_emissao: dataEmissao && !Number.isNaN(dataEmissao.getTime()) ? dataEmissao : null,
      status,
      dt_entrada: dtEntrada,
      tipo_frete: tipoFrete,
      tomador_nome: tomadorNome || null,
      tomador_cnpj: tomadorCnpj || null,
      modalidade_pagador: modalidadePagador || null,
      tomador_nos: tomadorNos,
      xml_completo: xmlCompactado,
      dados_json: data as any,
    };

    await this.prisma.cteDocumento.upsert({
      where: { chave_acesso: chave },
      create: { chave_acesso: chave, ...base },
      update: { ...base, updated_at: new Date() },
    });
  }

  /** Grava o básico da distribuição (sem XML) ou cria um stub pela chave. */
  private async upsertPendenteBasico(row: any, status = 'PENDENTE', dtEntrada: Date | null = null) {
    const chave = String(row?.CHAVE_CTE || '').trim();
    if (!chave) return;
    const dataEmissao = row?.DATA_EMISSAO ? new Date(row.DATA_EMISSAO) : null;

    const create = {
      chave_acesso: chave,
      numero: chave.length >= 34 ? chave.substring(25, 34).replace(/^0+/, '') : null,
      serie: chave.length >= 25 ? chave.substring(22, 25).replace(/^0+/, '') : null,
      emitente_nome: row?.NOME_EMITENTE || null,
      emitente_cnpj: row?.CPF_CNPJ_EMITENTE || null,
      valor_total: this.parseDecimal(row?.VALOR),
      data_emissao: dataEmissao && !Number.isNaN(dataEmissao.getTime()) ? dataEmissao : null,
      status,
      dt_entrada: dtEntrada,
      xml_completo: '',
    };

    await this.prisma.cteDocumento.upsert({
      where: { chave_acesso: chave },
      create,
      // não rebaixa LANCADA → PENDENTE nem apaga XML já existente
      update: {
        ...(status === 'LANCADA' ? { status: 'LANCADA', dt_entrada: dtEntrada } : {}),
        emitente_nome: create.emitente_nome ?? undefined,
        emitente_cnpj: create.emitente_cnpj ?? undefined,
        ...(create.valor_total ? { valor_total: create.valor_total } : {}),
        updated_at: new Date(),
      },
    });
  }

  private async marcarLancada(chave: string, dt: Date | null) {
    await this.prisma.cteDocumento.update({
      where: { chave_acesso: chave },
      data: { status: 'LANCADA', dt_entrada: dt, updated_at: new Date() },
    }).catch(() => undefined);
  }

  // =====================================================================
  // QUERIES NO ERP (OPENQUERY / Firebird) — colunas reais confirmadas
  // =====================================================================

  private oq(firebirdSql: string): string {
    const fb = firebirdSql.replace(/'/g, "''");
    return `SELECT * FROM OPENQUERY(CONSULTA, '${fb}')`;
  }

  /** Pendentes: CTE_DISTRIBUICAO (IMPORTADA='N') desde `inicio` (YYYY-MM-DD). */
  async fetchCteDistribuicaoPendentes(inicio: string): Promise<any[]> {
    const fbDate = this.toFirebirdDate(inicio);
    const sql = `
      SELECT D.EMPRESA, D.CHAVE_CTE, D.CPF_CNPJ_EMITENTE, D.NOME_EMITENTE,
             D.DATA_EMISSAO, D.TIPO_OPERACAO, D.VALOR, D.SITUACAO_CTE, D.PROTOCOLO
      FROM CTE_DISTRIBUICAO D
      WHERE D.EMPRESA = 1
        AND D.IMPORTADA = 'N'
        AND D.DATA_EMISSAO >= '${fbDate}'
      ORDER BY D.DATA_EMISSAO DESC`;
    try {
      return await this.openQuery.query<any>(this.oq(sql), {}, { timeout: 300000, allowZeroRows: true });
    } catch (e) {
      this.logger.error('Erro ao buscar CTE_DISTRIBUICAO', e instanceof Error ? e.stack : String(e));
      return [];
    }
  }

  /** Todas as chaves do CTE_ENTRADA_XML cujo ano (posições 3-4 da chave) >= ano de `inicio`. */
  async fetchCteEntradaXmlKeys(inicio: string): Promise<string[]> {
    const anoLimite = inicio.substring(2, 4); // '26' p/ 2026
    const sql = `
      SELECT X.CHAVE_CTE
      FROM CTE_ENTRADA_XML X
      WHERE X.EMPRESA = 1
        AND SUBSTRING(X.CHAVE_CTE FROM 3 FOR 2) >= '${anoLimite}'`;
    try {
      const rows = await this.openQuery.query<any>(this.oq(sql), {}, { timeout: 300000, allowZeroRows: true });
      return rows.map((r) => String(r.CHAVE_CTE || '').trim()).filter(Boolean);
    } catch (e) {
      this.logger.error('Erro ao buscar chaves CTE_ENTRADA_XML', e instanceof Error ? e.stack : String(e));
      return [];
    }
  }

  /** XMLs do CTE_ENTRADA_XML para um lote de chaves. */
  async fetchCteEntradaXmlByKeys(keys: string[]): Promise<any[]> {
    if (!keys.length) return [];
    const inList = keys.map((k) => `'${String(k).replace(/'/g, "''")}'`).join(',');
    const sql = `
      SELECT X.CHAVE_CTE, X.XML_COMPLETO
      FROM CTE_ENTRADA_XML X
      WHERE X.EMPRESA = 1
        AND X.CHAVE_CTE IN (${inList})`;
    try {
      return await this.openQuery.query<any>(this.oq(sql), {}, { timeout: 300000, allowZeroRows: true });
    } catch (e) {
      this.logger.error('Erro ao buscar XMLs CTE_ENTRADA_XML', e instanceof Error ? e.stack : String(e));
      return [];
    }
  }

  /**
   * Confirma na NF_ENTRADA quais chaves de CT-e foram lançadas (STATUS=1) e
   * devolve a DT_ENTRADA. ⚠️ Só por IN-list — scan amplo por MODELO_NOTA quebra o OLE DB.
   */
  async fetchNfEntradaDatesByKeys(keys: string[]): Promise<Map<string, Date | null>> {
    if (!keys.length) return new Map();
    return this.erpApi.comFallback(
      () => this.fetchNfEntradaDatesByKeysViaApi(keys),
      () => this.fetchNfEntradaDatesByKeysViaOpenQuery(keys),
    );
  }

  /**
   * O CT-e lançado vira nota de entrada modelo 57: a confirmação sai da mesma
   * rota usada para NF-e, que já filtra STATUS = 1 e fatia a lista de chaves.
   */
  private async fetchNfEntradaDatesByKeysViaApi(keys: string[]): Promise<Map<string, Date | null>> {
    const result = new Map<string, Date | null>();
    for (let i = 0; i < keys.length; i += ErpApiService.LOTE_CHAVES) {
      const lote = keys.slice(i, i + ErpApiService.LOTE_CHAVES);
      for (const row of await this.erpApi.nfEntradaPorChaves(lote)) {
        const chave = String(row.CHAVE_NFE || '').trim();
        if (!chave) continue;
        const dt = row.DT_ENTRADA ? new Date(row.DT_ENTRADA) : null;
        result.set(chave, dt && !Number.isNaN(dt.getTime()) ? dt : null);
      }
    }
    return result;
  }

  private async fetchNfEntradaDatesByKeysViaOpenQuery(keys: string[]): Promise<Map<string, Date | null>> {
    const result = new Map<string, Date | null>();
    if (!keys.length) return result;
    const inList = keys.map((k) => `'${String(k).replace(/'/g, "''")}'`).join(',');
    const sql = `
      SELECT E.CHAVE_NFE, E.DT_ENTRADA
      FROM NF_ENTRADA E
      WHERE E.EMPRESA = 1
        AND E.STATUS = 1
        AND E.CHAVE_NFE IN (${inList})`;
    try {
      const rows = await this.openQuery.query<any>(this.oq(sql), {}, { timeout: 300000, allowZeroRows: true });
      for (const row of rows) {
        const chave = String(row.CHAVE_NFE || '').trim();
        if (!chave) continue;
        const dt = row.DT_ENTRADA ? new Date(row.DT_ENTRADA) : null;
        result.set(chave, dt && !Number.isNaN(dt.getTime()) ? dt : null);
      }
    } catch (e) {
      this.logger.error('Erro ao confirmar NF_ENTRADA (CT-e)', e instanceof Error ? e.stack : String(e));
    }
    return result;
  }

  // =====================================================================
  // Utilitários de XML / datas (mesmo encode da NF-e: gzip+base64)
  // =====================================================================

  private async decodeXml(content: any): Promise<string> {
    const c = String(content || '').trim();
    if (!c) return '';
    if (c.startsWith('<')) return c;
    try {
      return zlib.gunzipSync(Buffer.from(c, 'base64')).toString('utf-8');
    } catch {
      return c;
    }
  }

  private encodeXml(xml: string): string {
    const content = String(xml || '').trim();
    if (!content || !content.startsWith('<')) return content;
    return zlib.gzipSync(Buffer.from(content, 'utf-8')).toString('base64');
  }

  private async normalizeBlobXml(content: any): Promise<string> {
    if (!content) return '';
    if (Buffer.isBuffer(content)) {
      const asText = content.toString('utf-8').trim();
      return asText ? this.decodeXml(asText) : '';
    }
    const asString = String(content).trim();
    return asString ? this.decodeXml(asString) : '';
  }

  private toFirebirdDate(value: string): string {
    const d = new Date(`${value}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '01.01.2026';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${d.getFullYear()}`;
  }

  private parseDecimal(value: unknown): number {
    const raw = String(value ?? '').trim().replace(',', '.');
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }
}

/** Divide um array em lotes de tamanho `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
