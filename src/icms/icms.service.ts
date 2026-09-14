import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OpenQueryService } from '../shared/database/openquery/openquery.service';
import { ErpApiService } from '../shared/erp-api/erp-api.service';
import { PrismaService } from '../prisma/prisma.service';
import { SimplesNacionalService } from './simples-nacional.service';
import * as xml2js from 'xml2js';
import * as zlib from 'zlib'; // for gzip
import { randomUUID } from 'crypto';
import { CSV_DATA_CLEAN } from './constants/mva-data';
import { MONOFASICO_NCM_LIST } from './constants/monofasico-ncm';
import { CFOP_INTERESTADUAIS_TRIBUTADOS } from './constants/cfop-tributados';
import { FiscalConferenceRequestDto, FiscalConferenceItemDto } from './dto/fiscal-conference.dto';
// @ts-ignore
import { gerarPDF } from '@alexssmusica/node-pdf-nfe';
import archiver from 'archiver';
import { Writable } from 'stream';
import * as Minio from 'minio';

/** Lançamento da NF no ERP: cabeçalho de NF_ENTRADA + itens de NFE_ITENS. */
type LancamentoErp = { header: any; itens: any[] };

type GuiaPdfExtractedData = {
    numeroDocumento: string | null;
    dataVencimento: Date | null;
    valor: number | null;
    feCte: string | null;
    numeroNfExtraido: string | null;
    feCteConfere: boolean | null;
    aviso: string | null;
    textoExtraido: string;
};

@Injectable()
export class IcmsService {
    private readonly logger = new Logger(IcmsService.name);
    private readonly minioBucket = process.env.MINIO_BUCKET || 'documentos';
    private readonly minioRegion = process.env.MINIO_REGION || 'us-east-1';
    private minioClient: Minio.Client | null = null;
    private refData: any[] = [];
    private readonly monofasicoNcmSet = new Set<string>(MONOFASICO_NCM_LIST.map((ncm) => this.cleanDigits(ncm)));
    private readonly launchedSyncJobs = new Map<string, {
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
    }>();
    private readonly xmlNormalizationJobs = new Map<string, {
        jobId: string;
        status: 'running' | 'completed' | 'failed';
        total: number;
        processadas: number;
        normalizadas: number;
        ignoradas: number;
        erros: number;
        progresso: number;
        logs: string[];
        startedAt: string;
        completedAt?: string;
        errorMessage?: string;
    }>();

    constructor(
        private readonly openQuery: OpenQueryService,
        private readonly erpApi: ErpApiService,
        private readonly prisma: PrismaService,
        private readonly simplesNacional: SimplesNacionalService,
    ) {
        this.parseReferenceData();
    }

    // --- REFERENCE DATA PARSING ---
    private parseReferenceData() {
        // CSV parsing logic ported
        const lines = CSV_DATA_CLEAN.split('\n').filter(l => l.trim() !== '');
        const headers = lines[0].split(';'); // Assuming first line is header: Item;CEST;NCM_SH;MVA;Descricao

        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(';');
            if (parts.length < 4) continue;

            const row: any = {};
            // Mapping basic columns
            row['Item'] = parseFloat(parts[0]);
            row['CEST'] = parts[1];
            row['NCM_SH'] = parts[2];
            row['MVA'] = parseFloat(parts[3]);
            row['Descricao'] = parts[4];

            // Clean NCM
            row['NCM_CLEAN'] = row['NCM_SH'].replace(/\./g, '').trim();
            this.refData.push(row);
        }
        this.logger.log(`Loaded ${this.refData.length} reference MVA items.`);
    }

    // --- ETL / SYNC ---
    async syncInvoices(start?: string, end?: string) {
        try {
            const { startDate, endDate } = this.getDateRangeOrDefault(start, end);

            // 1. Fetch from ERP (OpenQuery)
            const erpInvoices = await this.fetchErpInvoices(start, end);
            this.logger.log(`Fetched ${erpInvoices.length} invoices from ERP`, 'Sync');
            const erpKeys = new Set<string>();

            // 2. Upsert ERP items to Local DB
            const upsertTasks: Array<() => Promise<void>> = [];
            for (const inv of erpInvoices) {
                erpKeys.add(inv.CHAVE_NFE);
                upsertTasks.push(async () => {
                    const normalizedXmlCompleto = await this.normalizeBlobXml(inv.XML_COMPLETO);
                    const normalizedXmlResumo = await this.normalizeBlobXml(inv.XML_RESUMO);
                    const xmlParaPersistir = normalizedXmlCompleto || normalizedXmlResumo || '';
                    const xmlParaPersistirCompactado = this.encodeXml(xmlParaPersistir);
                    const valorTotal = this.extractValorTotalFromXml(xmlParaPersistir);

                    await this.prisma.nfeConciliacao.upsert({
                        where: { chave_nfe: inv.CHAVE_NFE },
                        create: {
                            chave_nfe: inv.CHAVE_NFE,
                            emitente: inv.NOME_EMITENTE || 'Desconhecido',
                            cnpj_emitente: inv.CPF_CNPJ_EMITENTE,
                            data_emissao: new Date(inv.DATA_EMISSAO),
                            valor_total: valorTotal,
                            xml_completo: xmlParaPersistirCompactado,
                            status_erp: 'PENDENTE',
                            tipo_operacao: inv.TIPO_OPERACAO,
                            tipo_operacao_desc: inv.TIPO_OPERACAO_DESC
                        },
                        update: {
                            status_erp: 'PENDENTE',
                            ...(normalizedXmlCompleto ? { xml_completo: this.encodeXml(normalizedXmlCompleto) } : {}),
                            updated_at: new Date()
                        }
                    });

                    // Só quando o XML COMPLETO chega (resumo não traz itens/MVA),
                    // avalia a regra de MVA e dispara o alerta de WhatsApp (n8n).
                    // Idempotente e tolerante a falha: nunca quebra o sync.
                    if (normalizedXmlCompleto) {
                        await this.maybeAlertMva(inv.CHAVE_NFE, normalizedXmlCompleto);
                    }
                });
            }

            const upsertBatchSize = 20;
            for (let i = 0; i < upsertTasks.length; i += upsertBatchSize) {
                const chunk = upsertTasks.slice(i, i + upsertBatchSize);
                await Promise.all(chunk.map(task => task()));
            }

            // 3. Detect Missing Items (saíram da tabela temporária NFE_DISTRIBUICAO)
            // Sair da temporária NÃO significa lançada: precisamos confirmar na NF_ENTRADA.
            // - Está na NF_ENTRADA  -> LANCADA (e grava DT_ENTRADA no Postgres)
            // - Não está na NF_ENTRADA -> EXCLUIDA
            // Só roda quando a consulta ao ERP retornou chaves; assim uma falha/retorno
            // vazio do ERP não marca notas pendentes como EXCLUIDA indevidamente.
            if (erpKeys.size > 0) {
                const missing = await this.prisma.nfeConciliacao.findMany({
                    where: {
                        status_erp: 'PENDENTE',
                        data_emissao: {
                            gte: startDate,
                            lte: endDate,
                        },
                        chave_nfe: { notIn: Array.from(erpKeys) },
                    },
                    select: { chave_nfe: true },
                });
                const missingKeys = missing.map((m) => m.chave_nfe);

                if (missingKeys.length > 0) {
                    // Confirma o lançamento real na NF_ENTRADA e obtém a DT_ENTRADA.
                    const entradaDates = await this.fetchNfEntradaDatesByKeys(missingKeys);

                    const lancadas = missingKeys
                        .filter((chave) => entradaDates.has(chave))
                        .map((chave) => ({ chave, dt_entrada: entradaDates.get(chave) ?? null }));
                    const excluidas = missingKeys.filter((chave) => !entradaDates.has(chave));

                    // LANCADA: atualização individual pois cada nota tem sua própria DT_ENTRADA.
                    const updateBatchSize = 20;
                    for (let i = 0; i < lancadas.length; i += updateBatchSize) {
                        const chunk = lancadas.slice(i, i + updateBatchSize);
                        await Promise.all(
                            chunk.map((l) =>
                                this.prisma.nfeConciliacao.update({
                                    where: { chave_nfe: l.chave },
                                    data: {
                                        status_erp: 'LANCADA',
                                        dt_entrada: l.dt_entrada,
                                        updated_at: new Date(),
                                    },
                                }),
                            ),
                        );
                    }

                    // Auditoria fiscal do lançamento recém-confirmado (LANCADA).
                    // Idempotente (só alerta 1x) e tolerante a falha: nunca quebra o sync.
                    for (const l of lancadas) {
                        await this.auditarLancamentoFiscal(l.chave);
                    }

                    // EXCLUIDA: saiu da temporária e não foi encontrada na NF_ENTRADA.
                    if (excluidas.length > 0) {
                        await this.prisma.nfeConciliacao.updateMany({
                            where: { chave_nfe: { in: excluidas } },
                            data: { status_erp: 'EXCLUIDA' },
                        });
                    }

                    // Avisa o compras-service que essas NF viraram LANCADA, para
                    // marcar os pedidos vinculados como 'Entregue' + data_recebimento.
                    // Falha de rede NÃO pode quebrar o sync (try/catch).
                    if (lancadas.length > 0) {
                        const base = process.env.COMPRAS_SERVICE_URL;
                        if (!base) {
                            this.logger.warn(
                                'COMPRAS_SERVICE_URL não configurada: pulando notificação de NF lançada ao compras-service.',
                                'Sync',
                            );
                        } else {
                            try {
                                await fetch(`${base}/compras/vinculacao-nfe/nf-lancada`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        lancadas: lancadas.map((l) => ({
                                            chave_nfe: l.chave,
                                            dt_entrada: l.dt_entrada,
                                        })),
                                    }),
                                });
                            } catch (e) {
                                this.logger.error(
                                    'Falha ao notificar compras-service de NF lançada',
                                    e instanceof Error ? e.stack : String(e),
                                    'Sync',
                                );
                            }
                        }
                    }
                }
            }

            // 4. Return Merged List
            const allLocal = await this.prisma.nfeConciliacao.findMany({
                where: {
                    data_emissao: {
                        gte: startDate,
                        lte: endDate,
                    }
                },
                orderBy: { data_emissao: 'desc' }
                ,
                take: 1200
            });

            // Situação de transporte por NF (CT-e em trânsito coberto) — uma query batch.
            const emMovimentoPorChave = await this.fetchEmMovimentoPorNfe(
                allLocal.map((l) => l.chave_nfe),
            );

            return await Promise.all(allLocal.map(async (local) => {
                const normalizedXml = await this.normalizeBlobXml(local.xml_completo);
                const xmlResolved = normalizedXml || local.xml_completo;
                const valorTotal = Number(local.valor_total || 0) > 0
                    ? Number(local.valor_total || 0)
                    : this.extractValorTotalFromXml(xmlResolved);

                return {
                    CHAVE_NFE: local.chave_nfe,
                    NOME_EMITENTE: local.emitente,
                    CPF_CNPJ_EMITENTE: local.cnpj_emitente,
                    DATA_EMISSAO: local.data_emissao,
                    DT_ENTRADA: local.dt_entrada,
                    VALOR_TOTAL: valorTotal,
                    STATUS_ERP: local.status_erp,
                    TIPO_OPERACAO: local.tipo_operacao,
                    TIPO_OPERACAO_DESC: local.tipo_operacao_desc,
                    XML_COMPLETO: local.xml_completo,
                    XML_TIPO: this.detectXmlType(xmlResolved),
                    TIPO_IMPOSTO: local.tipo_imposto,
                    // Situação de transporte: Entregue (lançada) > Em Trânsito (CT-e coberto em
                    // movimento) > null. O badge ERP (PENDENTE/LANCADA) segue independente.
                    RASTREIO_SITUACAO:
                        local.status_erp === 'LANCADA'
                            ? 'ENTREGUE'
                            : emMovimentoPorChave.get(local.chave_nfe)
                                ? 'EM_TRANSITO'
                                : null,
                };
            }));
        } catch (error) {
            this.logger.error('Error in syncInvoices', error, 'Sync');
            throw error;
        }
    }

    /**
     * Para um lote de chaves de NF, devolve quais têm um CT-e em trânsito coberto pelo SSW
     * (rastreio_cobertura='COBERTO' e rastreio_status não nulo). Uma única query.
     */
    private async fetchEmMovimentoPorNfe(chavesNfe: string[]): Promise<Map<string, boolean>> {
        const result = new Map<string, boolean>();
        const chaves = [...new Set((chavesNfe || []).map((c) => String(c || '').replace(/\D/g, '')).filter((c) => c.length === 44))];
        if (!chaves.length) return result;
        const inList = chaves.map((c) => `'${c}'`).join(',');
        try {
            const rows = await this.prisma.$queryRawUnsafe<Array<{ chave_nfe: string; em_movimento: boolean }>>(
                `SELECT j.chave AS chave_nfe,
                        bool_or(c.rastreio_cobertura = 'COBERTO' AND c.rastreio_status IS NOT NULL) AS em_movimento
                 FROM com_cte_documento c,
                      jsonb_array_elements_text(c.dados_json -> 'documentosNFe') AS j(chave)
                 WHERE j.chave IN (${inList})
                 GROUP BY j.chave`,
            );
            for (const r of rows) result.set(r.chave_nfe, !!r.em_movimento);
        } catch (e) {
            this.logger.error('Erro ao resolver situação de transporte das NFs', e instanceof Error ? e.stack : String(e), 'Rastreio');
        }
        return result;
    }

    private getDateRangeOrDefault(start?: string, end?: string) {
        const safeEnd = end ? new Date(`${end}T23:59:59.999`) : new Date();
        const parsedEnd = Number.isNaN(safeEnd.getTime()) ? new Date() : safeEnd;

        const safeStart = start
            ? new Date(`${start}T00:00:00`)
            : new Date(parsedEnd.getTime() - (90 * 24 * 60 * 60 * 1000));
        const parsedStart = Number.isNaN(safeStart.getTime())
            ? new Date(parsedEnd.getTime() - (90 * 24 * 60 * 60 * 1000))
            : safeStart;

        return {
            startDate: parsedStart,
            endDate: parsedEnd,
        };
    }

    async syncLaunchedInvoicesFromEntradaXml() {
        return this.runLaunchedInvoicesSync();
    }

    async getInvoiceByKey(chaveNfe: string) {
        const key = String(chaveNfe || '').trim();
        if (!key) return null;

        const local = await this.prisma.nfeConciliacao.findUnique({
            where: { chave_nfe: key }
        });

        if (!local) return null;

        const normalizedXml = await this.normalizeBlobXml(local.xml_completo);
        const xmlResolved = normalizedXml || local.xml_completo;
        const valorTotal = Number(local.valor_total || 0) > 0
            ? Number(local.valor_total || 0)
            : this.extractValorTotalFromXml(xmlResolved);

        return {
            EMPRESA: 1,
            CHAVE_NFE: local.chave_nfe,
            NOME_EMITENTE: local.emitente,
            CPF_CNPJ_EMITENTE: local.cnpj_emitente,
            DATA_EMISSAO: local.data_emissao,
            DT_ENTRADA: local.dt_entrada,
            VALOR_TOTAL: valorTotal,
            STATUS_ERP: local.status_erp,
            TIPO_OPERACAO: local.tipo_operacao,
            TIPO_OPERACAO_DESC: local.tipo_operacao_desc,
            XML_COMPLETO: xmlResolved,
            XML_TIPO: this.detectXmlType(xmlResolved),
            TIPO_IMPOSTO: local.tipo_imposto,
        };
    }

    /**
     * Importa notas a partir de XMLs enviados pelo usuário (upload manual na tela).
     * Persiste cada uma em NfeConciliacao com status_erp='UPLOAD' para que apareçam
     * na listagem "Banco de Dados" e possam ser abertas/calculadas no detalhe.
     *
     * Idempotente: se a chave já existir, apenas atualiza o XML — NUNCA sobrescreve
     * um status_erp real do ERP (PENDENTE/LANCADA/EXCLUIDA) com 'UPLOAD'.
     * Retorna as notas no mesmo formato de getInvoiceByKey/syncInvoices.
     */
    async importXmlInvoices(xmls: string[]) {
        const parser = new xml2js.Parser({ explicitArray: false });
        const out: any[] = [];

        for (const raw of Array.isArray(xmls) ? xmls : []) {
            const xmlStr = await this.decodeXml(raw);
            if (!xmlStr) continue;

            let parsed: any;
            try {
                parsed = await parser.parseStringPromise(xmlStr);
            } catch (e) {
                this.logger.warn(`XML importado inválido, ignorado: ${e instanceof Error ? e.message : String(e)}`, 'Import');
                continue;
            }

            const nfe = parsed.nfeProc ? parsed.nfeProc.NFe : parsed.NFe;
            if (!nfe?.infNFe?.['$']?.Id) continue;

            const infNfe = nfe.infNFe;
            const chave = String(infNfe['$']['Id']).replace('NFe', '').replace(/\D/g, '');
            if (chave.length !== 44) continue;

            const emit = infNfe.emit || {};
            const ide = infNfe.ide || {};
            const valorTotal = this.extractValorTotalFromXml(xmlStr);
            const compressedXml = this.encodeXml(xmlStr);
            const tpNF = parseInt(ide.tpNF || 0);
            const dataEmissao = new Date(ide.dhEmi || ide.dEmi || Date.now());

            try {
                const record = await this.prisma.nfeConciliacao.upsert({
                    where: { chave_nfe: chave },
                    create: {
                        chave_nfe: chave,
                        emitente: emit.xNome || 'Desconhecido',
                        cnpj_emitente: emit.CNPJ || emit.CPF || '',
                        data_emissao: dataEmissao,
                        valor_total: valorTotal,
                        xml_completo: compressedXml,
                        status_erp: 'UPLOAD',
                        tipo_operacao: tpNF,
                        tipo_operacao_desc: tpNF === 0 ? 'ENTRADA' : 'SAÍDA',
                    },
                    // Não mexe em status_erp: preserva status real do ERP se a nota já existir.
                    update: {
                        xml_completo: compressedXml,
                        updated_at: new Date(),
                    },
                });

                out.push({
                    CHAVE_NFE: record.chave_nfe,
                    NOME_EMITENTE: record.emitente,
                    CPF_CNPJ_EMITENTE: record.cnpj_emitente,
                    DATA_EMISSAO: record.data_emissao,
                    DT_ENTRADA: record.dt_entrada,
                    VALOR_TOTAL: Number(record.valor_total || 0),
                    STATUS_ERP: record.status_erp,
                    TIPO_OPERACAO: record.tipo_operacao,
                    TIPO_OPERACAO_DESC: record.tipo_operacao_desc,
                    XML_COMPLETO: xmlStr,
                    XML_TIPO: this.detectXmlType(xmlStr),
                    TIPO_IMPOSTO: record.tipo_imposto,
                });
            } catch (e) {
                this.logger.error(`Falha ao importar NF ${chave}`, e instanceof Error ? e.stack : String(e), 'Import');
            }
        }

        return out;
    }

    private detectXmlType(xml: string | null | undefined): 'COMPLETO' | 'RESUMO' | 'SEM_XML' {
        const raw = String(xml || '').trim();
        if (!raw) return 'SEM_XML';

        const content = raw.toLowerCase();
        const hasItems = content.includes('<det') && content.includes('<prod');
        if (hasItems) return 'COMPLETO';

        return 'RESUMO';
    }

    async startLaunchedInvoicesSyncJob() {
        const jobId = randomUUID();
        const startedAt = new Date().toISOString();

        this.launchedSyncJobs.set(jobId, {
            jobId,
            status: 'running',
            totalEncontradas: 0,
            processadas: 0,
            inseridas: 0,
            ignoradas: 0,
            progresso: 0,
            logs: [`[${startedAt}] Iniciando busca de NFs lançadas...`],
            startedAt,
        });

        this.runLaunchedInvoicesSync(jobId).catch((error) => {
            this.logger.error('Error running launched invoices sync job', error, 'Sync');
        });

        return { jobId };
    }

    getLaunchedInvoicesSyncJob(jobId: string) {
        return this.launchedSyncJobs.get(jobId) ?? null;
    }

    async startXmlNormalizationJob(batchSize = 500) {
        const safeBatchSize = Number.isFinite(batchSize) ? Math.min(Math.max(Math.floor(batchSize), 100), 2000) : 500;
        const jobId = randomUUID();
        const startedAt = new Date().toISOString();

        this.xmlNormalizationJobs.set(jobId, {
            jobId,
            status: 'running',
            total: 0,
            processadas: 0,
            normalizadas: 0,
            ignoradas: 0,
            erros: 0,
            progresso: 0,
            logs: [`[${startedAt}] Iniciando normalização global de XMLs (batch=${safeBatchSize})...`],
            startedAt,
        });

        this.runXmlNormalization(jobId, safeBatchSize).catch((error) => {
            this.logger.error('Error running XML normalization job', error, 'NormalizeXml');
        });

        return { jobId, batchSize: safeBatchSize };
    }

    getXmlNormalizationJob(jobId: string) {
        return this.xmlNormalizationJobs.get(jobId) ?? null;
    }

    private appendXmlNormalizationLog(jobId: string, message: string) {
        const job = this.xmlNormalizationJobs.get(jobId);
        if (!job) return;

        job.logs.push(`[${new Date().toISOString()}] ${message}`);
        if (job.logs.length > 300) {
            job.logs = job.logs.slice(-300);
        }
        this.xmlNormalizationJobs.set(jobId, job);
    }

    private async runXmlNormalization(jobId: string, batchSize: number) {
        try {
            const total = await this.prisma.nfeConciliacao.count();
            const initialJob = this.xmlNormalizationJobs.get(jobId);
            if (!initialJob) return;

            initialJob.total = total;
            this.xmlNormalizationJobs.set(jobId, initialJob);
            this.appendXmlNormalizationLog(jobId, `Total de notas para verificar: ${total}`);

            let cursor: string | undefined;
            let processadas = 0;
            let normalizadas = 0;
            let ignoradas = 0;
            let erros = 0;

            while (true) {
                const rows = await this.prisma.nfeConciliacao.findMany({
                    select: { chave_nfe: true, xml_completo: true },
                    orderBy: { chave_nfe: 'asc' },
                    take: batchSize,
                    ...(cursor ? { cursor: { chave_nfe: cursor }, skip: 1 } : {}),
                });

                if (!rows.length) break;

                for (const row of rows) {
                    const raw = String(row.xml_completo || '').trim();

                    try {
                        if (!raw) {
                            ignoradas++;
                            processadas++;
                            continue;
                        }

                        if (raw.startsWith('<')) {
                            const compressed = this.encodeXml(raw);
                            await this.prisma.nfeConciliacao.update({
                                where: { chave_nfe: row.chave_nfe },
                                data: { xml_completo: compressed },
                            });
                            normalizadas++;
                        } else {
                            const decoded = await this.decodeXml(raw);
                            if (decoded && decoded.trim().startsWith('<')) {
                                // Já compactado/decodificável para XML: mantemos como está.
                                ignoradas++;
                            } else {
                                // Conteúdo inválido ou inesperado, não alteramos automaticamente.
                                ignoradas++;
                                erros++;
                            }
                        }
                    } catch {
                        erros++;
                    }

                    processadas++;
                }

                cursor = rows[rows.length - 1].chave_nfe;

                const job = this.xmlNormalizationJobs.get(jobId);
                if (!job) return;

                job.processadas = processadas;
                job.normalizadas = normalizadas;
                job.ignoradas = ignoradas;
                job.erros = erros;
                job.progresso = total === 0 ? 100 : Math.round((processadas / total) * 100);
                this.xmlNormalizationJobs.set(jobId, job);

                this.appendXmlNormalizationLog(
                    jobId,
                    `Lote concluído. Processadas ${processadas}/${total} | normalizadas ${normalizadas} | ignoradas ${ignoradas} | erros ${erros}`,
                );
            }

            const job = this.xmlNormalizationJobs.get(jobId);
            if (!job) return;

            job.status = 'completed';
            job.processadas = processadas;
            job.normalizadas = normalizadas;
            job.ignoradas = ignoradas;
            job.erros = erros;
            job.progresso = 100;
            job.completedAt = new Date().toISOString();
            this.xmlNormalizationJobs.set(jobId, job);

            this.appendXmlNormalizationLog(
                jobId,
                `Concluído. Normalizadas: ${normalizadas}. Ignoradas: ${ignoradas}. Erros: ${erros}.`,
            );
        } catch (error) {
            const job = this.xmlNormalizationJobs.get(jobId);
            if (job) {
                job.status = 'failed';
                job.completedAt = new Date().toISOString();
                job.errorMessage = error instanceof Error ? error.message : String(error);
                this.xmlNormalizationJobs.set(jobId, job);
            }
            this.appendXmlNormalizationLog(jobId, `Falha na normalização: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    private appendJobLog(jobId: string | undefined, message: string) {
        if (!jobId) return;
        const job = this.launchedSyncJobs.get(jobId);
        if (!job) return;

        job.logs.push(`[${new Date().toISOString()}] ${message}`);
        if (job.logs.length > 200) {
            job.logs = job.logs.slice(-200);
        }
        this.launchedSyncJobs.set(jobId, job);
    }

    private async runLaunchedInvoicesSync(jobId?: string) {
        try {
            this.appendJobLog(jobId, 'Consultando chaves na NF_ENTRADA_XML (empresa=1)...');
            const allEntradaKeys = await this.fetchEntradaXmlKeys();

            this.appendJobLog(jobId, `Total de chaves encontradas na NF_ENTRADA_XML: ${allEntradaKeys.length}`);

            const existingLocal = await this.prisma.nfeConciliacao.findMany({
                select: { chave_nfe: true }
            });
            const existingLocalSet = new Set(existingLocal.map(i => i.chave_nfe));
            const keysToImport = allEntradaKeys.filter(k => !existingLocalSet.has(k));

            this.appendJobLog(jobId, `Chaves novas para importar: ${keysToImport.length}`);

            let inserted = 0;
            let skipped = 0;

            if (jobId) {
                const job = this.launchedSyncJobs.get(jobId);
                if (job) {
                    job.totalEncontradas = allEntradaKeys.length;
                    job.progresso = keysToImport.length === 0 ? 100 : 0;
                    this.launchedSyncJobs.set(jobId, job);
                }
            }

            const batchSize = 100;
            let processadas = 0;

            for (let offset = 0; offset < keysToImport.length; offset += batchSize) {
                const batchKeys = keysToImport.slice(offset, offset + batchSize);
                this.appendJobLog(jobId, `Carregando lote ${Math.floor(offset / batchSize) + 1} com ${batchKeys.length} chaves...`);

                const batchInvoices = await this.fetchEntradaXmlInvoicesByKeys(batchKeys);

                for (const inv of batchInvoices) {
                    const chave = String(inv.CHAVE_NFE || '').trim();
                    if (!chave) {
                        skipped++;
                        processadas++;
                        continue;
                    }

                    const normalizedXml = await this.normalizeBlobXml(inv.XML_COMPLETO) || await this.normalizeBlobXml(inv.XML_RESUMO);
                    const parsed = this.extractInvoiceMetadataFromXml(normalizedXml, chave);
                    const parsedXmlCompactado = this.encodeXml(parsed.xmlCompleto);

                    try {
                        await this.prisma.nfeConciliacao.create({
                            data: {
                                chave_nfe: chave,
                                emitente: parsed.emitente,
                                cnpj_emitente: parsed.cnpjEmitente,
                                data_emissao: parsed.dataEmissao,
                                valor_total: parsed.valorTotal,
                                xml_completo: parsedXmlCompactado,
                                status_erp: 'LANCADA',
                                tipo_operacao: parsed.tipoOperacao,
                                tipo_operacao_desc: parsed.tipoOperacaoDesc,
                            }
                        });
                        inserted++;
                    } catch {
                        // Se outra execução inserir no meio do caminho, tratamos como ignorada
                        skipped++;
                    }

                    processadas++;

                    if (jobId) {
                        const job = this.launchedSyncJobs.get(jobId);
                        if (job) {
                            job.processadas = processadas;
                            job.inseridas = inserted;
                            job.ignoradas = skipped;
                            job.progresso = keysToImport.length === 0
                                ? 100
                                : Math.round((processadas / keysToImport.length) * 100);
                            this.launchedSyncJobs.set(jobId, job);
                        }
                    }
                }

                if (jobId) {
                    this.appendJobLog(jobId, `Lote concluído. Processadas ${processadas}/${keysToImport.length} (inseridas: ${inserted}, ignoradas: ${skipped})`);
                }
            }

            if (jobId) {
                const job = this.launchedSyncJobs.get(jobId);
                if (job) {
                    job.status = 'completed';
                    job.processadas = keysToImport.length;
                    job.inseridas = inserted;
                    job.ignoradas = skipped;
                    job.progresso = 100;
                    job.completedAt = new Date().toISOString();
                    this.launchedSyncJobs.set(jobId, job);
                }
                this.appendJobLog(jobId, `Concluído. Inseridas: ${inserted}. Ignoradas: ${skipped}.`);
            }

            return {
                totalEncontradas: allEntradaKeys.length,
                inseridas: inserted,
                ignoradas: skipped,
            };
        } catch (error) {
            this.logger.error('Error syncing launched invoices from NF_ENTRADA_XML', error, 'Sync');

            if (jobId) {
                const job = this.launchedSyncJobs.get(jobId);
                if (job) {
                    job.status = 'failed';
                    job.completedAt = new Date().toISOString();
                    job.errorMessage = error instanceof Error ? error.message : String(error);
                    this.launchedSyncJobs.set(jobId, job);
                }
                this.appendJobLog(jobId, `Falha na sincronização: ${error instanceof Error ? error.message : String(error)}`);
            }

            throw error;
        }
    }


    /* Renamed original fetchInvoices to fetchErpInvoices */
    async fetchErpInvoices(start?: string, end?: string) {
        return this.erpApi.comFallback(
            () => this.fetchErpInvoicesViaApi(start, end),
            () => this.fetchErpInvoicesViaOpenQuery(start, end),
        );
    }

    /**
     * Pendentes pela erp-firebird-api: a lista vem sem o XML e o conteúdo é
     * buscado depois, só para as notas que já têm XML no ERP.
     *
     * A consulta precisa de período fechado. O caminho por OPENQUERY, sem
     * data informada, varre tudo desde 01/2025 — é justamente o tipo de
     * varredura sem recorte que segura a conexão do ERP.
     */
    private async fetchErpInvoicesViaApi(start?: string, end?: string) {
        const { startDate, endDate } = this.getDateRangeOrDefault(start, end);
        const iso = (d: Date) => d.toISOString().slice(0, 10);

        const pendentes = await this.erpApi.nfeDistribuicaoPendentes(iso(startDate), iso(endDate));
        if (!pendentes.length) return [];

        // Só busca XML de quem já tem: no fluxo do ERP a nota chega antes do
        // XML, e pedir o BLOB de uma chave sem XML custa a ida sem trazer nada.
        const comXml = pendentes
            .filter((linha) => Number(linha.TEM_XML) === 1)
            .map((linha) => String(linha.CHAVE_NFE || '').trim())
            .filter(Boolean);

        const xmlPorChave = new Map<string, { XML_RESUMO: any; XML_COMPLETO: any }>();
        for (let i = 0; i < comXml.length; i += ErpApiService.LOTE_CHAVES) {
            const lote = comXml.slice(i, i + ErpApiService.LOTE_CHAVES);
            for (const linha of await this.erpApi.xmlPorChaves(lote)) {
                xmlPorChave.set(String(linha.CHAVE_NFE || '').trim(), {
                    XML_RESUMO: linha.XML_RESUMO,
                    XML_COMPLETO: linha.XML_COMPLETO,
                });
            }
        }

        return pendentes.map((linha) => {
            const chave = String(linha.CHAVE_NFE || '').trim();
            const xml = xmlPorChave.get(chave);
            return {
                ...linha,
                CHAVE_NFE: chave,
                EMPRESA: 1,
                // O catálogo devolve o rótulo sem acento; o restante do serviço
                // grava e exibe a forma acentuada.
                TIPO_OPERACAO_DESC:
                    Number(linha.TIPO_OPERACAO) === 0
                        ? 'ENTRADA PRÓPRIA'
                        : Number(linha.TIPO_OPERACAO) === 1
                            ? 'SAÍDA'
                            : 'OUTROS',
                XML_RESUMO: xml?.XML_RESUMO ?? null,
                XML_COMPLETO: xml?.XML_COMPLETO ?? null,
            };
        });
    }

    private async fetchErpInvoicesViaOpenQuery(start?: string, end?: string) {
        // ... (Original OpenQuery Logic) ...
        const startFilter = this.toFirebirdDateOrNull(start);
        const endFilter = this.toFirebirdDateOrNull(end);
        const dateClause = startFilter && endFilter
            ? ` AND NFD.DATA_EMISSAO BETWEEN '${startFilter}' AND '${endFilter}'`
            : ` AND NFD.DATA_EMISSAO > '01.01.2025'`;

        const sql = `
      SELECT 
          NFD.EMPRESA,
          NFD.CHAVE_NFE,
          SUBSTRING(NFD.CHAVE_NFE FROM 26 FOR 9) AS NUMERO,
          NFD.CPF_CNPJ_EMITENTE,
          NFD.NOME_EMITENTE,
          NFD.RG_IE_EMITENTE,
          NFD.DATA_EMISSAO,
          NFD.TIPO_OPERACAO,
          CASE 
              WHEN NFD.TIPO_OPERACAO = 0 THEN 'ENTRADA PRÓPRIA'
              WHEN NFD.TIPO_OPERACAO = 1 THEN 'SAÍDA'
              ELSE 'OUTROS'
          END AS TIPO_OPERACAO_DESC,
          X.XML_RESUMO,
          X.XML_COMPLETO
      FROM NFE_DISTRIBUICAO NFD
      LEFT JOIN NF_ENTRADA_XML X
             ON X.EMPRESA    = NFD.EMPRESA
            AND X.CHAVE_NFE = NFD.CHAVE_NFE
      WHERE NFD.IMPORTADA    = 'N'
        AND NFD.EMPRESA      = 1
                ${dateClause}
        order by NFD.DATA_EMISSAO desc
    `;

        // Escape single quotes for MSSQL string literal
        const firebirdSql = sql.replace(/'/g, "''");
        // Wrap in OPENQUERY
        const tsql = `SELECT * FROM OPENQUERY(CONSULTA, '${firebirdSql}')`;

        try {
            const rows = await this.openQuery.query<any>(tsql, {});
            return rows;
        } catch (e) {
            this.logger.error("Error fetching ERP invoices", e);
            return [];
        }
    }

    async fetchEntradaXmlKeys() {
        // Ordena ASC no banco e inverte aqui. O índice (EMPRESA, CHAVE_NFE) é
        // ascendente — como quase todos os do ERP — e o Firebird não o percorre
        // ao contrário: com DESC ele ordena o conjunto inteiro antes de devolver.
        // A consulta traz TODAS as chaves, então inverter no consumidor devolve
        // exatamente a mesma lista (não há FIRST/limite decidindo quais linhas voltam).
        const sql = `
      SELECT
          X.CHAVE_NFE
      FROM NF_ENTRADA_XML X
      WHERE X.EMPRESA = 1
      ORDER BY X.CHAVE_NFE
    `;

        const firebirdSql = sql.replace(/'/g, "''");
        const tsql = `SELECT * FROM OPENQUERY(CONSULTA, '${firebirdSql}')`;

        const rows = await this.openQuery.query<any>(tsql, {}, { timeout: 300000, allowZeroRows: true });
        return rows
            .map(r => String(r.CHAVE_NFE || '').trim())
            .filter(Boolean)
            .reverse();
    }

    /**
     * Confirma, na tabela NF_ENTRADA do ERP, quais das chaves informadas foram
     * efetivamente lançadas e retorna a DT_ENTRADA de cada uma.
     * Retorna um Map<CHAVE_NFE, DT_ENTRADA | null>; chaves AUSENTES no Map
     * significam que a nota não está na NF_ENTRADA (ou seja, foi excluída).
     */
    async fetchNfEntradaDatesByKeys(keys: string[]): Promise<Map<string, Date | null>> {
        if (!keys.length) return new Map();
        return this.erpApi.comFallback(
            () => this.fetchNfEntradaDatesByKeysViaApi(keys),
            () => this.fetchNfEntradaDatesByKeysViaOpenQuery(keys),
        );
    }

    private async fetchNfEntradaDatesByKeysViaApi(keys: string[]): Promise<Map<string, Date | null>> {
        const result = new Map<string, Date | null>();
        // O lote é menor que o do OPENQUERY: a rota limita a lista de chaves,
        // e o filtro de STATUS = 1 (lançada) já vem aplicado do outro lado.
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

        const batchSize = 100;
        for (let offset = 0; offset < keys.length; offset += batchSize) {
            const batchKeys = keys.slice(offset, offset + batchSize);
            const inList = batchKeys
                .map((k) => `'${String(k).replace(/'/g, "''")}'`)
                .join(',');

            // STATUS=1 = Concluída. Cancelada (2) não conta como lançada — assim o
            // sync marca como EXCLUIDA quem teve o lançamento cancelado.
            const sql = `
      SELECT
          E.CHAVE_NFE,
          E.DT_ENTRADA
      FROM NF_ENTRADA E
      WHERE E.EMPRESA = 1
        AND E.STATUS = 1
        AND E.CHAVE_NFE IN (${inList})
    `;

            const firebirdSql = sql.replace(/'/g, "''");
            const tsql = `SELECT * FROM OPENQUERY(CONSULTA, '${firebirdSql}')`;

            const rows = await this.openQuery.query<any>(tsql, {}, { timeout: 300000, allowZeroRows: true });
            for (const row of rows) {
                const chave = String(row.CHAVE_NFE || '').trim();
                if (!chave) continue;
                const dt = row.DT_ENTRADA ? new Date(row.DT_ENTRADA) : null;
                result.set(chave, dt && !Number.isNaN(dt.getTime()) ? dt : null);
            }
        }

        return result;
    }

    async fetchEntradaXmlInvoicesByKeys(keys: string[]) {
        if (!keys.length) return [];
        return this.erpApi.comFallback(
            () => this.fetchEntradaXmlInvoicesByKeysViaApi(keys),
            () => this.fetchEntradaXmlInvoicesByKeysViaOpenQuery(keys),
        );
    }

    private async fetchEntradaXmlInvoicesByKeysViaApi(keys: string[]) {
        const linhas: any[] = [];
        // O XML é BLOB e a rota limita o lote de propósito: o custo é por nota,
        // não pela consulta.
        for (let i = 0; i < keys.length; i += ErpApiService.LOTE_CHAVES) {
            const lote = keys.slice(i, i + ErpApiService.LOTE_CHAVES);
            linhas.push(...(await this.erpApi.xmlPorChaves(lote)).map((l) => ({ ...l, EMPRESA: 1 })));
        }
        return linhas;
    }

    private async fetchEntradaXmlInvoicesByKeysViaOpenQuery(keys: string[]) {
        if (!keys.length) return [];

        const inList = keys
            .map((k) => `'${String(k).replace(/'/g, "''")}'`)
            .join(',');

        const sql = `
      SELECT
          X.EMPRESA,
          X.CHAVE_NFE,
          X.XML_RESUMO,
          X.XML_COMPLETO
      FROM NF_ENTRADA_XML X
      WHERE X.EMPRESA = 1
        AND X.CHAVE_NFE IN (${inList})
      ORDER BY X.CHAVE_NFE
    `;

        const firebirdSql = sql.replace(/'/g, "''");
        const tsql = `SELECT * FROM OPENQUERY(CONSULTA, '${firebirdSql}')`;

        const rows = await this.openQuery.query<any>(tsql, {}, { timeout: 300000, allowZeroRows: true });
        return rows.reverse();
    }

    // --- XML UTILS ---
    async decodeXml(content: string): Promise<string> {
        if (!content) return "";
        content = content.trim();
        if (content.startsWith('<')) return content;

        try {
            const buffer = Buffer.from(content, 'base64');
            return zlib.gunzipSync(buffer).toString('utf-8');
        } catch (e) {
            return content; // Fallback
        }
    }

    private encodeXml(xml: string): string {
        const content = String(xml || '').trim();
        if (!content) return '';
        if (!content.startsWith('<')) return content;

        const gz = zlib.gzipSync(Buffer.from(content, 'utf-8'));
        return gz.toString('base64');
    }

    private async normalizeBlobXml(content: any): Promise<string> {
        if (!content) return '';

        // mssql pode devolver BLOB como Buffer
        if (Buffer.isBuffer(content)) {
            const asText = content.toString('utf-8').trim();
            if (!asText) return '';
            return this.decodeXml(asText);
        }

        const asString = String(content).trim();
        if (!asString) return '';
        return this.decodeXml(asString);
    }

    private toFirebirdDateOrNull(value?: string): string | null {
        if (!value) return null;
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return null;
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return `${dd}.${mm}.${yyyy}`;
    }

    private parseDecimal(value: unknown) {
        const raw = String(value ?? '').trim();
        if (!raw) return 0;

        let normalized = raw;
        if (normalized.includes(',') && normalized.includes('.')) {
            normalized = normalized.replace(/\./g, '').replace(',', '.');
        } else if (normalized.includes(',')) {
            normalized = normalized.replace(',', '.');
        }

        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private parsePtBrMoney(value: string | null | undefined) {
        const raw = String(value || '').trim();
        if (!raw) return null;

        let normalized = raw;
        if (normalized.includes(',') && normalized.includes('.')) {
            normalized = normalized.replace(/\./g, '').replace(',', '.');
        } else if (normalized.includes(',')) {
            normalized = normalized.replace(',', '.');
        }

        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private parsePtBrDate(value: string | null | undefined) {
        const raw = String(value || '').trim();
        const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!match) return null;

        const [, dd, mm, yyyy] = match;
        const date = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    private extractLineField(text: string, fieldNumber: string, fieldNamePattern: string) {
        const regex = new RegExp(`${fieldNumber}\\s*-\\s*${fieldNamePattern}[\\s:.-]*([^\\n\\r]+)`, 'i');
        const match = text.match(regex);
        return match?.[1]?.trim() || null;
    }

    private extractGuiaDataFromPdfText(text: string, chaveNfe: string): GuiaPdfExtractedData {
        const compactText = String(text || '').replace(/\r/g, '');

        const numeroDocumento = this.extractLineField(compactText, '23', 'INF\\.?\\s*COMPLEMENTARES');
        const dataVencimentoRaw = this.extractLineField(compactText, '22', 'DATA\\s*VENCTO\\.?');
        const valorRaw = this.extractLineField(compactText, '31', 'VALOR');
        const info32 = this.extractLineField(compactText, '32', 'INFORMA[ÇC][ÕO]ES\\s*PREVISTAS\\s*EM\\s*INSTRU[ÇC][ÕO]ES');

        const textForFeCte = info32 || compactText;
        const normalizedTextForFeCte = textForFeCte.replace(/\s+/g, ' ');
        const numeroNfChave = String(chaveNfe || '').substring(25, 34).replace(/^0+/, '');

        const normalizeDigits = (value: string | null | undefined) =>
            String(value || '').replace(/\D/g, '').replace(/^0+/, '');

        const captureContextAfterMarker = (source: string) => {
            const marker = source.match(/NFE?\s*OU\s*CTE\s*[:\-]?/i);
            if (!marker || marker.index == null) return '';

            const start = marker.index + marker[0].length;
            const tail = source.slice(start);
            const endBySenhor = tail.search(/Senhor\s+Contribuinte/i);
            const endByNaoReceber = tail.search(/N[ÃA]O\s+RECEBER/i);

            const candidates = [endBySenhor, endByNaoReceber].filter((idx) => idx >= 0);
            const end = candidates.length > 0 ? Math.min(...candidates) : Math.min(tail.length, 260);
            return tail.slice(0, end);
        };

        const selectBestToken = (tokenList: string[]) => {
            if (tokenList.length === 0) return null;

            const exactByChave = tokenList.find((token) => normalizeDigits(token) === numeroNfChave);
            if (exactByChave) return exactByChave;

            const plausible = tokenList.find((token) => {
                const len = normalizeDigits(token).length;
                return len >= 6 && len <= 10;
            });
            return plausible || tokenList[0];
        };

        const markerContext = captureContextAfterMarker(compactText) || captureContextAfterMarker(normalizedTextForFeCte);
        const markerContextTokens = (markerContext.match(/\d[\d\s.-]{4,25}/g) || [])
            .map((token) => token.replace(/\D/g, ''))
            .filter((token) => token.length > 0);

        const markerToken = selectBestToken(markerContextTokens);

        // Prefer the number that appears right after the explicit "NFE ou CTE:" marker.
        const feCteByMarker = normalizedTextForFeCte.match(/NFE?\s*OU\s*CTE\s*[:\-]?\s*(\d{1,20})\b/i)
            || textForFeCte.match(/NFE?\s*OU\s*CTE\s*[:\-]?\s*(\d{1,20})\b/i);

        // Fallbacks for layout variations.
        const feCteFallback = normalizedTextForFeCte.match(/\b(?:NFE?|CTE|FE)\s*[:\-]?\s*(\d{1,20})\b/i)
            || textForFeCte.match(/\b(?:NFE?|CTE|FE)\s*[:\-]?\s*(\d{1,20})\b/i);

        const feCteRaw = markerToken || feCteByMarker?.[1] || feCteFallback?.[1] || null;

        const dataVencimento = this.parsePtBrDate(dataVencimentoRaw);
        const valor = this.parsePtBrMoney(valorRaw);

        const numeroNfExtraido = feCteRaw ? normalizeDigits(feCteRaw) : null;

        let feCteConfere: boolean | null = null;
        let aviso: string | null = null;

        if (numeroNfExtraido) {
            feCteConfere = numeroNfExtraido === numeroNfChave;
            if (!feCteConfere) {
                aviso = `Aviso: FE/CTE (${numeroNfExtraido}) diferente do número da NF (${numeroNfChave}).`;
            }
        }

        return {
            numeroDocumento,
            dataVencimento,
            valor,
            feCte: feCteRaw,
            numeroNfExtraido,
            feCteConfere,
            aviso,
            textoExtraido: compactText,
        };
    }

    private getMinioClient() {
        if (this.minioClient) return this.minioClient;

        const rawEndpoint = String(process.env.MINIO_ENDPOINT || '').trim();
        const accessKey = process.env.MINIO_ACCESS_KEY;
        const secretKey = process.env.MINIO_SECRET_KEY;

        if (!rawEndpoint || !accessKey || !secretKey) {
            throw new Error('Configuração MinIO incompleta: MINIO_ENDPOINT, MINIO_ACCESS_KEY e MINIO_SECRET_KEY são obrigatórios.');
        }

        let endPoint = rawEndpoint;
        let port = Number(process.env.MINIO_PORT || 9000);
        let useSSL = String(process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true';

        // Accept both raw host (s3.local) and full URL (https://s3.local:9000/).
        if (rawEndpoint.includes('://')) {
            try {
                const parsed = new URL(rawEndpoint);
                endPoint = parsed.hostname;
                if (parsed.port) {
                    const parsedPort = Number(parsed.port);
                    if (Number.isFinite(parsedPort) && parsedPort > 0) {
                        port = parsedPort;
                    }
                } else if (!process.env.MINIO_PORT) {
                    port = parsed.protocol === 'https:' ? 443 : 80;
                }

                if (!process.env.MINIO_USE_SSL) {
                    useSSL = parsed.protocol === 'https:';
                }
            } catch {
                throw new Error(`MINIO_ENDPOINT inválido: ${rawEndpoint}`);
            }
        } else {
            endPoint = rawEndpoint.replace(/^https?:\/\//i, '').replace(/\/$/, '');
        }

        this.minioClient = new Minio.Client({
            endPoint,
            port,
            useSSL,
            accessKey,
            secretKey,
        });

        return this.minioClient;
    }

    private async ensureMinioBucket() {
        const client = this.getMinioClient();
        const exists = await client.bucketExists(this.minioBucket);
        if (!exists) {
            await client.makeBucket(this.minioBucket, this.minioRegion);
        }
    }

    private normalizeUploadedFileName(fileName: string | null | undefined) {
        const raw = String(fileName || '').trim();
        if (!raw) return 'guia.pdf';

        let normalized = raw;

        // Common mojibake repair (UTF-8 bytes interpreted as Latin-1), e.g. "NÂº".
        if (/[ÃÂ]/.test(normalized)) {
            try {
                const repaired = Buffer.from(normalized, 'latin1').toString('utf8');
                if (repaired && !repaired.includes('�')) {
                    normalized = repaired;
                }
            } catch {
                // Keep original when conversion fails.
            }
        }

        normalized = normalized
            .replace(/[\u0000-\u001F\u007F]/g, '')
            .replace(/[\\/]+/g, '_')
            .trim();

        return normalized || 'guia.pdf';
    }

    private async uploadGuiaPdfToMinio(chaveNfe: string, file: { buffer: Buffer; originalname: string; mimetype: string }) {
        await this.ensureMinioBucket();
        const client = this.getMinioClient();

        const normalizedOriginalName = this.normalizeUploadedFileName(file.originalname);
        const safeFileName = String(normalizedOriginalName || 'guia.pdf').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const objectPath = `notas/${chaveNfe}/${Date.now()}-${safeFileName}`;

        await client.putObject(
            this.minioBucket,
            objectPath,
            file.buffer,
            file.buffer.length,
            { 'Content-Type': file.mimetype || 'application/pdf' },
        );

        return { bucket: this.minioBucket, objectPath };
    }

    private extractTagValue(xml: string, tagName: string) {
        if (!xml) return '';
        const match = xml.match(new RegExp(`<(?:\\w+:)?${tagName}>([^<]+)<\\/(?:\\w+:)?${tagName}>`, 'i'));
        return match?.[1]?.trim() || '';
    }

    private extractValorTotalFromXml(xml: string) {
        const rawVnf = this.extractTagValue(xml, 'vNF');
        return this.parseDecimal(rawVnf);
    }

    private extractInvoiceMetadataFromXml(xml: string, fallbackChave: string) {
        const emitente = xml.match(/<xNome>([\s\S]*?)<\/xNome>/)?.[1]?.trim() || 'Desconhecido';
        const cnpjEmitente = xml.match(/<CNPJ>(\d+)<\/CNPJ>/)?.[1]
            || xml.match(/<CPF>(\d+)<\/CPF>/)?.[1]
            || null;

        const dhEmi = xml.match(/<dhEmi>([^<]+)<\/dhEmi>/)?.[1];
        const dEmi = xml.match(/<dEmi>([^<]+)<\/dEmi>/)?.[1];
        const dataEmissao = new Date(dhEmi || dEmi || Date.now());
        const safeDataEmissao = Number.isNaN(dataEmissao.getTime()) ? new Date() : dataEmissao;

        const valorTotal = this.extractValorTotalFromXml(xml);

        const tpNf = parseInt(xml.match(/<tpNF>(\d)<\/tpNF>/)?.[1] || '0', 10);
        const tipoOperacao = Number.isNaN(tpNf) ? 0 : tpNf;
        const tipoOperacaoDesc = tipoOperacao === 0 ? 'ENTRADA PRÓPRIA' : 'SAÍDA';

        // Se XML vier vazio/invalido, preserva a chave como fallback de rastreabilidade
        const finalXml = xml && xml.includes('<') ? xml : `<chave>${fallbackChave}</chave>`;

        return {
            emitente,
            cnpjEmitente,
            dataEmissao: safeDataEmissao,
            valorTotal,
            tipoOperacao,
            tipoOperacaoDesc,
            xmlCompleto: finalXml,
        };
    }

    private async isInterstateInvoice(row: any): Promise<boolean> {
        // 51 is MT.
        const xml = await this.decodeXml(row.XML_COMPLETO);
        if (!xml) return false;

        // Regex check for ID
        const match = xml.match(/infNFe\s+Id="NFe(\d{44})"/);
        if (match) {
            const uf = match[1].substring(0, 2);
            return uf !== '51';
        }
        // Fallback: check DB chave if available
        if (row.CHAVE_NFE && row.CHAVE_NFE.length === 44) {
            return row.CHAVE_NFE.substring(0, 2) !== '51';
        }
        return false;
    }

    // --- CALCULATION LOGIC ---

    private cleanNcm(ncm: string) {
        return ncm ? ncm.replace(/\./g, '').trim() : '';
    }

    private findMvaInRef(ncmProduto: string) {
        const ncmLimpo = this.cleanNcm(ncmProduto);

        // 1. Exact Match
        let match = this.refData.find(r => r.NCM_CLEAN === ncmLimpo);
        if (match) return { mva: match.MVA, item: match.Item, matchType: 'Exato' };

        // 2. 6 digits
        if (ncmLimpo.length >= 6) {
            match = this.refData.find(r => r.NCM_CLEAN === ncmLimpo.substring(0, 6));
            if (match) return { mva: match.MVA, item: match.Item, matchType: 'Raiz 6' };
        }

        // 3. 4 digits
        if (ncmLimpo.length >= 4) {
            match = this.refData.find(r => r.NCM_CLEAN === ncmLimpo.substring(0, 4));
            if (match) return { mva: match.MVA, item: match.Item, matchType: 'Raiz 4' };
        }

        return { mva: null, item: null, matchType: 'Não Encontrado' };
    }

    /**
     * Alíquota interestadual com MT como destino (Res. Senado 22/89 e 13/2012):
     * 4% p/ mercadoria importada (orig 1, 2, 3 ou 8); 7% quando a origem é
     * Sul/Sudeste exceto ES; 12% nas demais. Usada quando a NF não destaca
     * pICMS (fornecedor do Simples Nacional).
     */
    private aliquotaInterestadualPorUf(ufOrigem: string, origProduto: string): number {
        if (['1', '2', '3', '8'].includes(origProduto)) return 0.04;
        const sulSudesteExcetoEs = new Set(['SP', 'RJ', 'MG', 'PR', 'SC', 'RS']);
        return sulSudesteExcetoEs.has(ufOrigem) ? 0.07 : 0.12;
    }

    // Extracts items from XML and calculates ST for each
    async calculateStForInvoice(xmlContent: string, icmsInternoRate = 17.0) {
        const xmlStr = await this.decodeXml(xmlContent);
        if (!xmlStr) return [];

        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xmlStr);

        const nfe = result.nfeProc ? result.nfeProc.NFe : result.NFe;
        if (!nfe) return [];

        const infNfe = nfe.infNFe;
        const chave = infNfe['$']['Id'].replace('NFe', '');
        const emit = infNfe.emit;
        const ide = infNfe.ide;
        const total = infNfe.total.ICMSTot;
        const det = Array.isArray(infNfe.det) ? infNfe.det : [infNfe.det];

        // --- UPSERT INTO NfeConciliacao ---
        // This ensures that even XML-uploaded notes exist in the DB for status tracking
        try {
            const compressedXml = this.encodeXml(xmlStr);
            await this.prisma.nfeConciliacao.upsert({
                where: { chave_nfe: chave },
                create: {
                    chave_nfe: chave,
                    emitente: emit.xNome || 'Desconhecido',
                    cnpj_emitente: emit.CNPJ || emit.CPF,
                    data_emissao: new Date(ide.dhEmi || ide.dEmi),
                    valor_total: this.parseDecimal(total.vNF || 0),
                    xml_completo: compressedXml,
                    status_erp: 'UPLOAD', // Mark as upload to distinguish
                    tipo_operacao: parseInt(ide.tpNF || 0),
                    tipo_operacao_desc: parseInt(ide.tpNF) === 0 ? 'ENTRADA' : 'SAÍDA'
                },
                update: {
                    // Update XML if it changed or to ensure it's there
                    xml_completo: compressedXml,
                    updated_at: new Date()
                }
            });
        } catch (e) {
            this.logger.error(`Error upserting NFe ${chave} during calculation`, e);
        }

        const results = [];

        // Tolerância (R$) para decidir se PRECISA de guia: diferenças de ST dentro
        // de ±tolerância são tratadas como OK (sem guia). Default R$ 10,00.
        const tolGuia = Number(process.env.GUIA_TOLERANCIA_BRL) > 0 ? Number(process.env.GUIA_TOLERANCIA_BRL) : 10;

        // --- Regime tributário do fornecedor (decide a fórmula do DIFAL) ---
        // 1º: ReceitaWS (consulta online, sem persistência); 2º: CRT do próprio XML.
        // CRT 1 (Simples) e 4 (MEI) = optante; CRT 2 (Simples acima do sublimite,
        // destaca ICMS) e 3 (regime normal) = não optante p/ efeito de DIFAL.
        const emitUf = String(emit?.enderEmit?.UF || '').toUpperCase();
        const crtEmit = String(emit?.CRT || '').trim();
        const regime = await this.simplesNacional.consultarOptante(emit.CNPJ || '');
        let optanteSimples: boolean | null = regime.optanteSimples;
        let regimeFonte: string = regime.fonte;
        if (optanteSimples === null && crtEmit) {
            optanteSimples = crtEmit === '1' || crtEmit === '4';
            regimeFonte = 'crt';
        }

        for (const item of det) {
            const prod = item.prod;
            const imposto = item.imposto;

            const ncm = prod.NCM;
            const { mva, item: itemRef, matchType } = this.findMvaInRef(ncm);

            // Values
            const vProd = parseFloat(prod.vProd || 0);
            const vFrete = parseFloat(prod.vFrete || 0);
            const vSeg = parseFloat(prod.vSeg || 0);
            const vDesc = parseFloat(prod.vDesc || 0);
            const vOutro = parseFloat(prod.vOutro || 0);

            // IPI
            let vIpi = 0;
            if (imposto.IPI && imposto.IPI.IPITrib) {
                vIpi = parseFloat(imposto.IPI.IPITrib.vIPI || 0);
            }

            // ICMS Details
            let vIcmsProprio = 0;
            let vStDestacado = 0;
            let pMvaNota = 0;
            let pIcmsOrigem = 0;
            let cstNota = '';
            let icmsTag = '';
            let origProduto = '';

            const icmsKeys = Object.keys(imposto.ICMS || {});
            for (const key of icmsKeys) {
                const vals = imposto.ICMS[key];
                icmsTag = key;
                vIcmsProprio = parseFloat(vals.vICMS || 0);
                vStDestacado = parseFloat(vals.vICMSST || 0);
                pMvaNota = parseFloat(vals.pMVAST || 0);
                if (vals.pICMS) pIcmsOrigem = parseFloat(vals.pICMS);
                cstNota = String(vals.CST || vals.CSOSN || '');
                if (vals.orig !== undefined) origProduto = String(vals.orig);
            }

            // Logic for Credit Origin
            // Rule:
            // 1. If pICMS > 0 and <= 7% -> Use it.
            // 2. If pICMS > 7% -> Cap at 7%.
            // 3. If pICMS is 0 or missing -> Default to 7%.

            let taxaOrigem = 0.07; // Default covering 0, missing, or > 7%

            if (pIcmsOrigem > 0.00 && pIcmsOrigem <= 7.0) {
                taxaOrigem = pIcmsOrigem / 100.0;
            }

            const baseCreditoOrigem = vProd + vFrete + vSeg + vOutro - vDesc;
            const vCreditoOrigem = baseCreditoOrigem * taxaOrigem;

            let vStCalculado = 0;
            let diffSt = 0;
            let status = "";

            let effectiveMatchType = matchType;
            let effectiveMva = mva;
            let isDefaultMva = false;

            if (effectiveMva === null) {
                // FALLBACK MVA: 50.39%
                // Used when product is NOT found in reference list
                effectiveMva = 0.5039;
                isDefaultMva = true;
                // Keep matchType as 'Não Encontrado' to trigger selection screen
            }

            const baseSoma = vProd + vIpi + vFrete + vSeg + vOutro - vDesc;
            const baseCalcStRef = baseSoma * (1 + effectiveMva);
            const debitoSt = baseCalcStRef * (icmsInternoRate / 100.0);
            const vStCalculadoRaw = Math.max(0, debitoSt - vCreditoOrigem);
            vStCalculado = parseFloat(vStCalculadoRaw.toFixed(2));

            diffSt = vStCalculado - vStDestacado;

            // CFOP tributado: zera cálculo quando operação não está na lista de tributados
            const cfopItem = String(prod.CFOP || '').trim();
            const semTributacaoItem = cfopItem !== '' && !CFOP_INTERESTADUAIS_TRIBUTADOS.has(cfopItem);

            if (semTributacaoItem) {
                vStCalculado = 0;
                diffSt = 0;
                status = "Sem Tributação";
            } else if (!isDefaultMva) {
                if (diffSt > tolGuia) status = "Guia Complementar";
                else if (diffSt < -tolGuia) status = "Pago a Maior";
                else status = "OK";
            } else {
                if (diffSt > tolGuia) status = "Guia Compl. (Padrão 50%)";
                else if (diffSt < -tolGuia) status = "Pago Maior (Padrão 50%)";
                else status = "OK (Padrão 50%)";
            }

            // Desmembra a diferença em dois valores positivos e explícitos, para
            // exibição tanto no cálculo quanto na listagem:
            //  - valorGuiaComplementar: quanto ainda falta pagar (ST calculada > destacada)
            //  - valorPagoAMais: quanto foi pago a mais (ST destacada > calculada)
            // Usa o diffSt final (já zerado em "Sem Tributação"), então ambos ficam 0 nesse caso.
            const valorGuiaComplementar = parseFloat(Math.max(0, diffSt).toFixed(2));
            const valorPagoAMais = parseFloat(Math.max(0, -diffSt).toFixed(2));

            // ============================================
            // CALCULO DO DIFAL
            // ============================================
            // Regra independente do MVA. A fórmula depende do regime do fornecedor:
            //
            //  Não optante do Simples (NF com ICMS destacado):
            //    DIFAL = [(V oper − ICMS origem) / (1 − alíq. interna)] × alíq. interna − (V oper × alíq. interestadual)
            //
            //  Optante do Simples — ou qualquer operação sem destaque/crédito de ICMS:
            //    Crédito = (V oper / (1 − alíq. interestadual)) × alíq. interestadual
            //    DIFAL   = (V oper / (1 − alíq. interna)) × alíq. interna − Crédito
            const aliquotaInternaDecimal = icmsInternoRate / 100.0;
            // NF sem pICMS (Simples não destaca): deriva a interestadual da UF de origem + origem da mercadoria
            const aliquotaInterestadualDIFAL = pIcmsOrigem > 0
                ? pIcmsOrigem / 100.0
                : this.aliquotaInterestadualPorUf(emitUf, origProduto);
            let vlDifalCalculado = 0;
            let vlCreditoDifal = 0;
            let formulaDifal: 'COM_DESTAQUE' | 'SEM_DESTAQUE_SIMPLES';

            if (optanteSimples !== true && vIcmsProprio > 0) {
                // Fornecedor do regime normal, com destaque de ICMS na origem
                formulaDifal = 'COM_DESTAQUE';
                const baseDifal = (baseSoma - vIcmsProprio) / (1 - aliquotaInternaDecimal);
                vlCreditoDifal = baseSoma * aliquotaInterestadualDIFAL;
                vlDifalCalculado = Math.max(0, (baseDifal * aliquotaInternaDecimal) - vlCreditoDifal);
            } else {
                // Optante do Simples Nacional (ou NF sem crédito de ICMS destacado):
                // crédito presumido "por dentro" pela alíquota interestadual
                formulaDifal = 'SEM_DESTAQUE_SIMPLES';
                vlCreditoDifal = (baseSoma / (1 - aliquotaInterestadualDIFAL)) * aliquotaInterestadualDIFAL;
                const debitoInterno = (baseSoma / (1 - aliquotaInternaDecimal)) * aliquotaInternaDecimal;
                vlDifalCalculado = Math.max(0, debitoInterno - vlCreditoDifal);
            }

            vlDifalCalculado = parseFloat(vlDifalCalculado.toFixed(2));

            results.push({
                chaveNfe: chave,
                emitente: emit.xNome,
                item: parseFloat(item['$'].nItem),
                codProd: prod.cProd,
                produto: prod.xProd,
                unidadeFornecedor: String(prod.uCom || ''),
                ncmNota: ncm,
                cfop: prod.CFOP,
                cstNota,
                icmsTag,
                possuiIcmsSt: vStDestacado > 0 || cstNota.endsWith('10') || cstNota.endsWith('60'),
                semTributacao: semTributacaoItem,
                refTabela: itemRef,
                matchType: effectiveMatchType,
                mvaNota: pMvaNota,
                mvaRef: effectiveMva * 100,
                vlProduto: vProd,
                vlIcmsProprio: vIcmsProprio,
                creditoOrigem: vCreditoOrigem,
                stDestacado: vStDestacado,
                stCalculado: vStCalculado,
                vlDifal: vlDifalCalculado, // NOVO CAMPO
                // Transparência do DIFAL por regime do fornecedor
                optanteSimples,
                regimeFonte, // receitaws | crt | indefinido
                formulaDifal, // COM_DESTAQUE | SEM_DESTAQUE_SIMPLES
                vlCreditoDifal: parseFloat(vlCreditoDifal.toFixed(2)),
                aliqInterestadualDifal: aliquotaInterestadualDIFAL * 100,
                diferenca: diffSt,
                valorGuiaComplementar, // > 0 quando ainda falta pagar ST
                valorPagoAMais,        // > 0 quando a ST destacada na NF ficou acima da calculada
                status: status
            });
        }
        return results;
    }
    // --- PERSISTENCE ---

    async previewFiscalConference(dto: FiscalConferenceRequestDto) {
        return this.runFiscalConference(dto, false);
    }

    async persistFiscalConference(dto: FiscalConferenceRequestDto) {
        return this.runFiscalConference(dto, true);
    }

    private async runFiscalConference(dto: FiscalConferenceRequestDto, persist: boolean) {
        const notas = Array.isArray(dto?.notas) ? dto.notas : [];
        const result = [];

        for (const nota of notas) {
            const chaveNfe = String(nota?.chaveNfe || '').trim();
            if (!chaveNfe) continue;

            const nfe = await this.prisma.nfeConciliacao.findUnique({
                where: { chave_nfe: chaveNfe },
                select: { cnpj_emitente: true },
            });

            const emitenteCnpj = this.cleanDigits(nfe?.cnpj_emitente || '');
            const isCompraDentroEstado = this.isWithinMtByChave(chaveNfe);

            const itensOut = [];
            const warnings: string[] = [];
            let hasComercializacao = false;
            let hasUsoConsumo = false;
            let hasSemTributacao = false;

            for (const item of Array.isArray(nota?.itens) ? nota.itens : []) {
                const analyzed = await this.analyzeFiscalItem({
                    chaveNfe,
                    emitenteCnpj,
                    isCompraDentroEstado,
                    item,
                });

                hasComercializacao = hasComercializacao || analyzed.destinacaoMercadoria === 'COMERCIALIZACAO';
                hasUsoConsumo = hasUsoConsumo || analyzed.destinacaoMercadoria === 'USO_CONSUMO';
                hasSemTributacao = hasSemTributacao || Boolean(analyzed.semTributacao);

                if (persist) {
                    try {
                        await this.saveFiscalConferenceItem(chaveNfe, analyzed);
                    } catch (error) {
                        warnings.push(`Falha ao persistir item ${analyzed.item}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }

                itensOut.push(analyzed);
            }

            if (persist) {
                try {
                    await this.saveFiscalConferenceSummary(chaveNfe, hasComercializacao, hasUsoConsumo);
                } catch (error) {
                    warnings.push(`Falha ao atualizar resumo da nota: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            result.push({
                chaveNfe,
                flagsNota: {
                    compraComercializacao: hasComercializacao,
                    usoConsumo: hasUsoConsumo,
                    semTributacao: hasSemTributacao,
                },
                itens: itensOut,
                warnings,
            });
        }

        return { notas: result };
    }

    private async analyzeFiscalItem(input: {
        chaveNfe: string;
        emitenteCnpj: string;
        isCompraDentroEstado: boolean;
        item: FiscalConferenceItemDto;
    }) {
        const { emitenteCnpj, isCompraDentroEstado, item } = input;
        // Valor marcado na tela de cálculo. NÃO decide mais revenda x uso/consumo
        // (isso passou a ser pelo SUBTIPO do cadastro, ver abaixo); fica só como
        // fallback de persistência, pois a coluna destinacao_mercadoria é NOT NULL.
        const destinacaoTela = item.destinacaoMercadoria;
        const codProdFornecedorRaw = String(item.codProdFornecedor || '').trim();
        const codProdFornecedor = codProdFornecedorRaw || String(item.item || '');
        const normalizedNcm = this.cleanDigits(item.ncmNota || '');
        const normalizedCstNota = this.cleanDigits(item.cstNota || '');
        const possuiIcmsSt = Boolean(item.possuiIcmsSt || item.impostoEscolhido === 'ST');
        const possuiDifal = Boolean(item.possuiDifal || item.impostoEscolhido === 'DIFAL');

        const cfopNota = String(item.cfop || '').trim();
        const semTributacao = cfopNota !== '' && !CFOP_INTERESTADUAIS_TRIBUTADOS.has(cfopNota);

        const divergencias: string[] = [];
        const conformidades: string[] = [];

        const supplier = emitenteCnpj
            ? await this.findSupplierByCpfCnpj(emitenteCnpj)
            : null;

        if (!supplier) {
            divergencias.push('Fornecedor da nota não encontrado na Stage_Fornecedores pelo CPF/CNPJ do emitente.');
        }

        const codigoInternoManual = String(item.codigoInternoManual || '').trim();
        let vinculo: any = null;
        let produtoInterno: any = null;

        if (codigoInternoManual) {
            // Relacionamento manual: ignora busca de vínculo e usa o código interno diretamente
            produtoInterno = await this.findInternalProduct(codigoInternoManual);
            if (produtoInterno) {
                conformidades.push(`Relacionamento manual com código interno ${codigoInternoManual} localizado na Stage_Produtos.`);
            } else {
                divergencias.push(`Código interno ${codigoInternoManual} informado manualmente não foi encontrado na Stage_Produtos.`);
            }
        } else {
            if (supplier?.FOR_CODIGO && codProdFornecedor) {
                vinculo = await this.findSupplierProductLink(
                    supplier.FOR_CODIGO,
                    codProdFornecedor,
                    item.produto,
                    item.unidadeFornecedor,
                );
                if (!vinculo) {
                    divergencias.push('Produto do fornecedor não foi relacionado ao nosso código interno no Sistema Celta. Por Favor Verifique!');
                } else {
                    conformidades.push('Relacionamento do produto do fornecedor com o código interno localizado no Sistema Celta.');
                }
            }

            produtoInterno = vinculo?.PRO_CODIGO
                ? await this.findInternalProduct(vinculo.PRO_CODIGO)
                : null;

            if (vinculo?.PRO_CODIGO && !produtoInterno) {
                divergencias.push('PRO_CODIGO vinculado não encontrado na Stage_Produtos.');
            }
        }

        if (produtoInterno) {
            // Situação Tributária: COM CEST -> ST0-X. SEM CEST não força TR0-X
            // (pode ser ST pela regra do 999 / uso automotivo).
            const stCodigo = String(produtoInterno.ST_CODIGO || '').trim().toUpperCase();
            const temCest = !!String(produtoInterno.CEST ?? '').trim();
            if (temCest && stCodigo !== 'ST0-X') {
                divergencias.push(`Situação Tributária inválida: produto com CEST exige ST_CODIGO=ST0-X e encontrado ${stCodigo || 'vazio'}.`);
            } else if (temCest) {
                conformidades.push('Situação Tributária correta: ST0-X (com CEST).');
            }
        }

        // Destinação (revenda x uso/consumo) definida pelo SUBTIPO do cadastro,
        // e não pelo que foi marcado na tela de cálculo. A tela continua mandando
        // apenas no imposto (ST x tributada), via item.impostoEscolhido.
        //   SUBTIPO 00 -> comercialização   |   SUBTIPO 07 -> uso e consumo
        const subtipoCadastro = this.digitsOnly(produtoInterno?.SUBTIPO);
        const destinacaoMercadoria: 'COMERCIALIZACAO' | 'USO_CONSUMO' | null =
            subtipoCadastro === '00' ? 'COMERCIALIZACAO' : subtipoCadastro === '07' ? 'USO_CONSUMO' : null;
        if (!destinacaoMercadoria) {
            divergencias.push(
                produtoInterno
                    ? `Não foi possível definir a destinação pelo SUBTIPO do cadastro (esperado 00=comercialização ou 07=uso e consumo, encontrado ${String(produtoInterno.SUBTIPO || '').trim() || 'vazio'}). Corrija o cadastro do produto.`
                    : 'Não foi possível definir a destinação pelo SUBTIPO: produto interno não localizado no cadastro.',
            );
        }

        const isMonofasico = this.isMonofasicoNcm(normalizedNcm);
        const pisEsperado = isMonofasico ? '04' : 'P01';
        const cofinsEsperado = isMonofasico ? '04' : 'C01';

        if (destinacaoMercadoria === 'COMERCIALIZACAO') {
            if (isCompraDentroEstado && item.impostoEscolhido === 'ST') {
                const cstEndsWithValid = normalizedCstNota.endsWith('10') || normalizedCstNota.endsWith('60');
                if (!cstEndsWithValid) {
                    divergencias.push('Compra interna para comercialização com ST exige CST da nota final 10 ou 60.');
                }
            }

            if (produtoInterno) {
                // SUBTIPO já garante COMERCIALIZACAO aqui (destinação derivada dele).
                const pis = String(produtoInterno.PIS_CODIGO || '').trim().toUpperCase();
                const cofins = String(produtoInterno.COFINS_CODIGO || '').trim().toUpperCase();

                if (pis !== pisEsperado.toUpperCase()) {
                    divergencias.push(`Código do Pis inválido: esperado ${pisEsperado} e encontrado ${pis || 'vazio'}.`);
                } else {
                    conformidades.push(`Código do Pis correto: ${pisEsperado}.`);
                }
                if (cofins !== cofinsEsperado.toUpperCase()) {
                    divergencias.push(`Código do Cofins inválido: esperado ${cofinsEsperado} e encontrado ${cofins || 'vazio'}.`);
                } else {
                    conformidades.push(`Código do Cofins correto: ${cofinsEsperado}.`);
                }
            }
        }

        if (destinacaoMercadoria === 'USO_CONSUMO' && produtoInterno) {
            const comercializavel = String(produtoInterno.COMERCIALIZAVEL || '').trim().toUpperCase();
            const pis = String(produtoInterno.PIS_CODIGO || '').trim().toUpperCase();
            const cofins = String(produtoInterno.COFINS_CODIGO || '').trim().toUpperCase();
            const subgrp = String(produtoInterno.SUBGRP_CODIGO || '').trim();

            if (comercializavel !== 'N') {
                divergencias.push(`COMERCIALIZAVEL inválido para uso e consumo: esperado N e encontrado ${comercializavel || 'vazio'}.`);
            }
            if (pis !== 'P99') {
                divergencias.push(`Código do Pis inválido para uso e consumo: esperado P99 e encontrado ${pis || 'vazio'}.`);
            } else {
                conformidades.push('Código do Pis correto para uso e consumo: P99.');
            }
            if (cofins !== 'C99') {
                divergencias.push(`Código do Cofins inválido para uso e consumo: esperado C99 e encontrado ${cofins || 'vazio'}.`);
            } else {
                conformidades.push('Código do Cofins correto para uso e consumo: C99.');
            }
            if (subgrp !== '274') {
                divergencias.push(`SUBGRP_CODIGO inválido para uso e consumo: esperado 274 e encontrado ${subgrp || 'vazio'}.`);
            }
            // SUBTIPO já garante USO_CONSUMO aqui (destinação derivada dele).
        }

        return {
            item: item.item,
            codProdFornecedor,
            codigoProduto: String(produtoInterno?.PRO_CODIGO || vinculo?.PRO_CODIGO || codigoInternoManual || ''),
            codigoInternoManual: codigoInternoManual || null,
            impostoEscolhido: item.impostoEscolhido,
            destinacaoMercadoria: destinacaoMercadoria ?? destinacaoTela,
            possuiIcmsSt,
            possuiDifal,
            semTributacao,
            ncmNota: item.ncmNota || null,
            cstNota: item.cstNota || null,
            fornecedor: supplier
                ? {
                    forCodigo: String(supplier.FOR_CODIGO || ''),
                    forNome: String(supplier.FOR_NOME || ''),
                }
                : null,
            produtoVinculado: vinculo
                ? {
                    proCodigo: String(vinculo.PRO_CODIGO || ''),
                    descFornecedor: String(vinculo.DESC_PROD_FORNECEDOR || ''),
                }
                : null,
            produtoInterno: produtoInterno
                ? {
                    proCodigo: String(produtoInterno.PRO_CODIGO || ''),
                    descricao: String(produtoInterno.PRO_DESCRICAO || ''),
                    stCodigo: String(produtoInterno.ST_CODIGO || ''),
                    pisCodigo: String(produtoInterno.PIS_CODIGO || ''),
                    cofinsCodigo: String(produtoInterno.COFINS_CODIGO || ''),
                    subtipo: String(produtoInterno.SUBTIPO || ''),
                    comercializavel: String(produtoInterno.COMERCIALIZAVEL || ''),
                    subgrpCodigo: String(produtoInterno.SUBGRP_CODIGO || ''),
                }
                : null,
            monofasico: isMonofasico,
            esperadoPis: pisEsperado,
            esperadoCofins: cofinsEsperado,
            conformidades,
            divergencias,
            statusConferencia: divergencias.length > 0 ? 'DIVERGENTE' : 'OK',
        };
    }

    private async saveFiscalConferenceItem(chaveNfe: string, analyzed: any) {
        await this.prisma.$executeRawUnsafe(
            `
            INSERT INTO com_nfe_conciliacao_item (
                chave_nfe,
                n_item,
                cod_prod_fornecedor,
                for_codigo,
                pro_codigo,
                destinacao_mercadoria,
                imposto_escolhido,
                possui_icms_st,
                possui_difal,
                sem_tributacao,
                ncm_xml,
                cst_nota,
                divergencias_json,
                status_conferencia,
                created_at,
                updated_at
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,NOW(),NOW()
            )
            ON CONFLICT (chave_nfe, n_item)
            DO UPDATE SET
                cod_prod_fornecedor = EXCLUDED.cod_prod_fornecedor,
                for_codigo = EXCLUDED.for_codigo,
                pro_codigo = EXCLUDED.pro_codigo,
                destinacao_mercadoria = EXCLUDED.destinacao_mercadoria,
                imposto_escolhido = EXCLUDED.imposto_escolhido,
                possui_icms_st = EXCLUDED.possui_icms_st,
                possui_difal = EXCLUDED.possui_difal,
                sem_tributacao = EXCLUDED.sem_tributacao,
                ncm_xml = EXCLUDED.ncm_xml,
                cst_nota = EXCLUDED.cst_nota,
                divergencias_json = EXCLUDED.divergencias_json,
                status_conferencia = EXCLUDED.status_conferencia,
                updated_at = NOW()
            `,
            chaveNfe,
            analyzed.item,
            analyzed.codProdFornecedor,
            analyzed.fornecedor?.forCodigo || null,
            analyzed.produtoInterno?.proCodigo || analyzed.produtoVinculado?.proCodigo || null,
            analyzed.destinacaoMercadoria,
            analyzed.impostoEscolhido,
            Boolean(analyzed.possuiIcmsSt),
            Boolean(analyzed.possuiDifal),
            Boolean(analyzed.semTributacao),
            analyzed.ncmNota,
            analyzed.cstNota,
            JSON.stringify(analyzed.divergencias || []),
            analyzed.statusConferencia,
        );
    }

    private async saveFiscalConferenceSummary(chaveNfe: string, compraComercializacao: boolean, usoConsumo: boolean) {
        await this.prisma.$executeRawUnsafe(
            `
            UPDATE com_nfe_conciliacao
            SET
                compra_comercializacao = $2,
                uso_consumo = $3,
                updated_at = NOW()
            WHERE chave_nfe = $1
            `,
            chaveNfe,
            compraComercializacao,
            usoConsumo,
        );
    }

    async findSupplierByCpfCnpj(cpfCnpj: string) {
        const normalized = this.cleanDigits(cpfCnpj);
        if (!normalized) return null;

        const rows = await this.openQuery.query<any>(
            `
            SELECT TOP 1
                FOR_CODIGO,
                FOR_NOME,
                CPF_CNPJ
            FROM [BI].[dbo].[Stage_Fornecedores]
            WHERE REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(CPF_CNPJ, ''), '.', ''), '/', ''), '-', ''), ' ', '') = @cpfCnpj
            ORDER BY FOR_CODIGO
            `,
            { cpfCnpj: normalized },
            { allowZeroRows: true },
        );

        return rows[0] ?? null;
    }

    async findSupplierProductLink(
        forCodigo: string,
        codProdFornecedor: string,
        descProdFornecedor?: string,
        unidadeFornecedor?: string,
    ) {
        const normalizedCode = String(codProdFornecedor || '').trim();
        const noLeadingZeros = normalizedCode.replace(/^0+/, '');
        const normalizedDesc = String(descProdFornecedor || '').trim();
        const normalizedUnit = String(unidadeFornecedor || '').trim();

        const escapedForCodigo = String(forCodigo || '').replace(/'/g, "''");
        const escapedCode = normalizedCode.replace(/'/g, "''");
        const escapedCodeNoZero = (noLeadingZeros || normalizedCode).replace(/'/g, "''");
        const escapedDesc = normalizedDesc.replace(/'/g, "''");
        const escapedUnit = normalizedUnit.replace(/'/g, "''");

        const usePkCompleteFilter = Boolean(normalizedDesc && normalizedUnit);
        const useDescriptionFilter = Boolean(normalizedDesc);

        const firebirdSqlByPk = `
            SELECT
                EMPRESA,
                FOR_CODIGO,
                COD_PROD_FORNECEDOR,
                UM_FORNECEDOR,
                DESC_PROD_FORNECEDOR,
                PRO_CODIGO,
                CST_CSOSN_NOTA,
                CFOP_NOTA
            FROM PRODUTOS_FORNECEDOR_NFE
            WHERE EMPRESA = 1
              AND FOR_CODIGO = '${escapedForCodigo}'
              AND (
                  TRIM(COALESCE(COD_PROD_FORNECEDOR, '')) = '${escapedCode}'
                  OR TRIM(COALESCE(COD_PROD_FORNECEDOR, '')) = '${escapedCodeNoZero}'
              )
              AND TRIM(COALESCE(UM_FORNECEDOR, '')) = '${escapedUnit}'
              AND TRIM(COALESCE(DESC_PROD_FORNECEDOR, '')) = '${escapedDesc}'
        `.replace(/\s+/g, ' ').trim().replace(/'/g, "''");

        const firebirdSqlByCode = `
            SELECT
                EMPRESA,
                FOR_CODIGO,
                COD_PROD_FORNECEDOR,
                UM_FORNECEDOR,
                PRO_CODIGO,
                DESC_PROD_FORNECEDOR,
                CST_CSOSN_NOTA,
                CFOP_NOTA
            FROM PRODUTOS_FORNECEDOR_NFE
            WHERE EMPRESA = 1
              AND FOR_CODIGO = '${escapedForCodigo}'
              AND (
                  TRIM(COALESCE(COD_PROD_FORNECEDOR, '')) = '${escapedCode}'
                  OR TRIM(COALESCE(COD_PROD_FORNECEDOR, '')) = '${escapedCodeNoZero}'
              )
                            ${useDescriptionFilter ? `AND UPPER(TRIM(COALESCE(DESC_PROD_FORNECEDOR, ''))) = UPPER('${escapedDesc}')` : ''}
        `.replace(/\s+/g, ' ').trim().replace(/'/g, "''");

        const tsqlPk = `
            SELECT TOP 1
                EMPRESA,
                FOR_CODIGO,
                COD_PROD_FORNECEDOR,
                UM_FORNECEDOR,
                PRO_CODIGO,
                DESC_PROD_FORNECEDOR,
                CST_CSOSN_NOTA,
                CFOP_NOTA
            FROM OPENQUERY(CONSULTA, '${firebirdSqlByPk}')
            ORDER BY EMPRESA, PRO_CODIGO
        `;

        const tsqlCode = `
            SELECT TOP 1
                EMPRESA,
                FOR_CODIGO,
                COD_PROD_FORNECEDOR,
                UM_FORNECEDOR,
                PRO_CODIGO,
                DESC_PROD_FORNECEDOR,
                CST_CSOSN_NOTA,
                CFOP_NOTA
            FROM OPENQUERY(CONSULTA, '${firebirdSqlByCode}')
            ORDER BY EMPRESA, PRO_CODIGO
        `;

        let rows: any[] = [];
        if (usePkCompleteFilter) {
            rows = await this.openQuery.query<any>(
                tsqlPk,
                {},
                { allowZeroRows: true },
            );
        }

        if (!rows.length) {
            rows = await this.openQuery.query<any>(
                tsqlCode,
                {},
                { allowZeroRows: true },
            );
        }

        return rows[0] ?? null;
    }

    /**
     * Cadastro do produto. Por padrão consulta o Stage (rápido) com fallback no
     * ERP. Com `direto=true` (reconferência), consulta direto a PRODUTOS do ERP
     * via linked server CONSULTA — sem esperar o ETL (~1 min) — e usa o Stage só
     * como fallback.
     */
    async findInternalProduct(proCodigo: string, direto = false) {
        if (direto) {
            return (await this.findInternalProductErp(proCodigo)) ?? (await this.findInternalProductStage(proCodigo));
        }
        return (await this.findInternalProductStage(proCodigo)) ?? (await this.findInternalProductErp(proCodigo));
    }

    private async findInternalProductStage(proCodigo: string) {
        const rows = await this.openQuery.query<any>(
            `
            SELECT TOP 1
                PRO_CODIGO,
                PRO_DESCRICAO,
                ST_CODIGO,
                SUBTIPO,
                PIS_CODIGO,
                COFINS_CODIGO,
                COMERCIALIZAVEL,
                SUBGRP_CODIGO,
                CEST
            FROM [BI].[dbo].[Stage_Produtos]
            WHERE PRO_CODIGO = @proCodigo
            `,
            { proCodigo },
            { allowZeroRows: true },
        );
        return rows[0] ?? null;
    }

    /**
     * Fallback do cadastro do produto direto na PRODUTOS (empresa 1) do ERP.
     *
     * A conferência pergunta item a item. Pela API, as chamadas unitárias que
     * chegam juntas são agrupadas num único SELECT com IN do outro lado —
     * continua sendo uma requisição por item, mas deixa de ser uma ida ao
     * Firebird por item, que é o que esgota o pool.
     */
    private async findInternalProductErp(proCodigo: string) {
        const code = this.digitsOnly(proCodigo);
        if (!code) return null;
        return this.erpApi.comFallback(
            () => this.erpApi.produtoFiscalUnico(Number(code)),
            () => this.findInternalProductErpViaOpenQuery(code),
        );
    }

    private async findInternalProductErpViaOpenQuery(code: string) {
        const firebirdSql = `
      SELECT FIRST 1
          PRO_CODIGO, PRO_DESCRICAO, ST_CODIGO, SUBTIPO,
          PIS_CODIGO, COFINS_CODIGO, COMERCIALIZAVEL, SUBGRP_CODIGO, CEST
      FROM PRODUTOS
      WHERE EMPRESA = 1 AND PRO_CODIGO = ${code}
    `;
        try {
            const rows = await this.openQuery.query<any>(
                `SELECT * FROM OPENQUERY(CONSULTA, '${firebirdSql.replace(/'/g, "''")}')`,
                {},
                { timeout: 120000, allowZeroRows: true },
            );
            return rows[0] ?? null;
        } catch (e) {
            this.logger.error(
                `Falha no fallback de produto ${code} no banco mãe (PRODUTOS)`,
                e instanceof Error ? e.stack : String(e),
                'Auditoria',
            );
            return null;
        }
    }

    private isMonofasicoNcm(ncm: string) {
        const ncmClean = this.cleanDigits(ncm);
        if (!ncmClean) return false;

        if (this.monofasicoNcmSet.has(ncmClean)) return true;
        if (ncmClean.length >= 6 && this.monofasicoNcmSet.has(ncmClean.slice(0, 6))) return true;
        if (ncmClean.length >= 4 && this.monofasicoNcmSet.has(ncmClean.slice(0, 4))) return true;
        return false;
    }

    private cleanDigits(value: string) {
        return String(value || '').replace(/\D/g, '');
    }

    private normalizeComparisonText(value: string) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
    }

    private parseDivergenciasJson(raw: unknown): string[] {
        if (Array.isArray(raw)) return raw.map((item) => String(item || '')).filter(Boolean);

        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return parsed.map((item) => String(item || '')).filter(Boolean);
                }
            } catch {
                return raw ? [raw] : [];
            }
            return raw ? [raw] : [];
        }

        return [];
    }

    private isOnlyNoRelationshipStatus(divergencias: string[]) {
        if (!divergencias.length) return false;

        return divergencias.every((item) => {
            const normalized = this.normalizeComparisonText(item);
            return normalized.includes('nao foi relacionado ao nosso codigo interno')
                || normalized.includes('nao vinculado na stage_produtos_fornecedor_nfe');
        });
    }

    private getConferenceStatusFromRows(rows: Array<{ status_conferencia?: string | null; divergencias_json?: unknown }>) {
        if (!rows.length) return 'PENDENTE';

        let hasError = false;
        let hasNoRelationship = false;
        let hasOk = false;

        for (const row of rows) {
            const status = String(row?.status_conferencia || '').trim().toUpperCase();
            if (status === 'OK') {
                hasOk = true;
                continue;
            }

            const divergencias = this.parseDivergenciasJson(row?.divergencias_json);
            if (this.isOnlyNoRelationshipStatus(divergencias)) {
                hasNoRelationship = true;
            } else {
                hasError = true;
            }
        }

        if (hasError) return 'ERRO';
        if (hasNoRelationship) return 'SEM_RELACIONAMENTO';
        if (hasOk) return 'OK';
        return 'PENDENTE';
    }

    private isWithinMtByChave(chaveNfe: string) {
        const chave = String(chaveNfe || '').trim();
        return chave.slice(0, 2) === '51';
    }

    // Limiar de MVA a partir do qual a NF interestadual é sinalizada para a
    // Conferência Fiscal. 50,39% é o MVA-padrão (fallback) usado nos cálculos.
    private static readonly MVA_LIMIAR = 50.39;

    /**
     * Avalia a regra de MVA para uma NF que acabou de receber XML COMPLETO e,
     * se cabível, dispara o webhook do n8n (que envia o WhatsApp via WAHA).
     *
     * Regra: NF de FORA do estado (chave não inicia com 51) em que ALGUM item
     * tenha pMVAST destacado > 50,39%.
     *
     * Idempotência: usa as colunas mva_verificado_em / mva_alerta_enviado_em.
     * O alerta só é marcado como enviado em resposta 2xx do n8n — assim uma
     * falha de rede é reprocessada no próximo ciclo do sync. Nunca lança.
     */
    private async maybeAlertMva(chaveNfe: string, xmlCompleto: string): Promise<void> {
        try {
            const row = await this.prisma.nfeConciliacao.findUnique({
                where: { chave_nfe: chaveNfe },
                select: { mva_alerta_enviado_em: true },
            });
            // Já alertado: nada a fazer.
            if (row?.mva_alerta_enviado_em) return;

            // Dentro de MT (intraestadual): não se aplica. Marca como verificado
            // para não reprocessar a cada minuto.
            if (this.isWithinMtByChave(chaveNfe)) {
                await this.prisma.nfeConciliacao.update({
                    where: { chave_nfe: chaveNfe },
                    data: { mva_verificado_em: new Date() },
                });
                return;
            }

            const parsed = await this.extractMvaFromXml(xmlCompleto);
            if (!parsed) return; // XML não-completo/ilegível: tenta de novo depois.

            const itensAcima = parsed.itens.filter(
                (i) => i.pMvaSt > IcmsService.MVA_LIMIAR,
            );
            const maiorMva = parsed.itens.reduce((m, i) => Math.max(m, i.pMvaSt), 0);

            // Verificado: guarda o maior MVA da nota para auditoria.
            await this.prisma.nfeConciliacao.update({
                where: { chave_nfe: chaveNfe },
                data: { mva_verificado_em: new Date(), mva_maior: maiorMva },
            });

            if (itensAcima.length === 0) return; // Nada acima do limiar.

            const webhook = process.env.N8N_MVA_WEBHOOK_URL;
            if (!webhook) {
                this.logger.warn(
                    'N8N_MVA_WEBHOOK_URL não configurada: pulando alerta de MVA.',
                    'MVA',
                );
                return;
            }

            const payload = {
                chaveNfe,
                numeroNf: parsed.numeroNf,
                emitente: parsed.emitente,
                cnpjEmitente: parsed.cnpjEmitente,
                ufEmitente: parsed.ufEmitente,
                dataEmissao: parsed.dataEmissao,
                valorTotal: parsed.valorTotal,
                mvaPadrao: IcmsService.MVA_LIMIAR,
                maiorMva,
                qtdItensAcima: itensAcima.length,
                itensAcima,
            };

            const resp = await fetch(webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (resp.ok) {
                await this.prisma.nfeConciliacao.update({
                    where: { chave_nfe: chaveNfe },
                    data: { mva_alerta_enviado_em: new Date() },
                });
                this.logger.log(
                    `Alerta de MVA enviado para ${chaveNfe} (${itensAcima.length} item(s), maior ${maiorMva}%).`,
                    'MVA',
                );
            } else {
                this.logger.error(
                    `n8n recusou alerta de MVA ${chaveNfe}: HTTP ${resp.status}. Será reprocessado.`,
                    undefined,
                    'MVA',
                );
            }
        } catch (e) {
            // Nunca pode quebrar o sync.
            this.logger.error(
                `Falha ao avaliar/enviar alerta de MVA para ${chaveNfe}`,
                e instanceof Error ? e.stack : String(e),
                'MVA',
            );
        }
    }

    /**
     * Extrai cabeçalho + pMVAST por item de um XML de NFe completo.
     * Reaproveita o mesmo padrão de parsing de calculateStForInvoice().
     * Retorna null se o XML não tiver itens (resumo) ou for ilegível.
     */
    private async extractMvaFromXml(xmlContent: string): Promise<{
        numeroNf: string | null;
        emitente: string | null;
        cnpjEmitente: string | null;
        ufEmitente: string | null;
        dataEmissao: string | null;
        valorTotal: number;
        itens: Array<{
            nItem: number;
            cProd: string | null;
            descricao: string | null;
            ncm: string | null;
            cfop: string | null;
            pMvaSt: number;
        }>;
    } | null> {
        const xmlStr = await this.decodeXml(xmlContent);
        if (!xmlStr) return null;

        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xmlStr);

        const nfe = result.nfeProc ? result.nfeProc.NFe : result.NFe;
        if (!nfe || !nfe.infNFe) return null;

        const infNfe = nfe.infNFe;
        if (!infNfe.det) return null; // Sem itens => resumo.

        const emit = infNfe.emit || {};
        const ide = infNfe.ide || {};
        const icmsTot = infNfe.total?.ICMSTot || {};
        const det = Array.isArray(infNfe.det) ? infNfe.det : [infNfe.det];

        const itens = det.map((item: any, idx: number) => {
            const prod = item.prod || {};
            const imposto = item.imposto || {};
            let pMvaSt = 0;
            for (const key of Object.keys(imposto.ICMS || {})) {
                const vals = imposto.ICMS[key] || {};
                if (vals.pMVAST != null) {
                    pMvaSt = parseFloat(vals.pMVAST) || 0;
                }
            }
            const nItem = parseInt(item['$']?.nItem ?? '', 10);
            return {
                nItem: Number.isFinite(nItem) ? nItem : idx + 1,
                cProd: prod.cProd ?? null,
                descricao: prod.xProd ?? null,
                ncm: prod.NCM ?? null,
                cfop: prod.CFOP ?? null,
                pMvaSt,
            };
        });

        return {
            numeroNf: ide.nNF ?? null,
            emitente: emit.xNome ?? null,
            cnpjEmitente: emit.CNPJ ?? emit.CPF ?? null,
            ufEmitente: emit.enderEmit?.UF ?? null,
            dataEmissao: ide.dhEmi ?? ide.dEmi ?? null,
            valorTotal: parseFloat(icmsTot.vNF || 0) || 0,
            itens,
        };
    }

    // =====================================================================
    // AUDITORIA FISCAL DO LANÇAMENTO (gatilho: NF vira LANCADA)
    // =====================================================================

    digitsOnly(v: any): string {
        return String(v ?? '').replace(/\D/g, '');
    }

    /** CFOP de ENTRADA esperado conforme imposto × destinação × (intra/inter). */
    private cfopEntradaEsperado(imposto: string, destinacao: string, intra: boolean): string | null {
        const p = intra ? '1' : '2';
        const I = String(imposto || '').toUpperCase();
        const D = String(destinacao || '').toUpperCase();
        if (I === 'ST' && D === 'COMERCIALIZACAO') return p + '403';
        if (I === 'ST' && D === 'USO_CONSUMO') return p + '407';
        if (I === 'TRIBUTADA' && D === 'COMERCIALIZACAO') return p + '102';
        if (D === 'USO_CONSUMO' && (I === 'TRIBUTADA' || I === 'DIFAL')) return p + '556';
        if (I === 'DIFAL') return p + '556';
        return null;
    }

    /** Final (2 dígitos) do CST esperado na ENTRADA. */
    private cstFinalEsperado(imposto: string, destinacao: string): string | null {
        const I = String(imposto || '').toUpperCase();
        const D = String(destinacao || '').toUpperCase();
        // Na ENTRADA, mercadoria com ST chega com o imposto já retido pelo
        // fornecedor (substituto) → CST final 60, seja revenda ou uso/consumo.
        // (O final 10 é de saída, quando o substituto cobra o ST na venda.)
        if (I === 'ST') return '60';
        if (I === 'TRIBUTADA' && D === 'COMERCIALIZACAO') return '00';
        if (D === 'USO_CONSUMO' && (I === 'TRIBUTADA' || I === 'DIFAL')) return '90';
        if (I === 'DIFAL') return '90';
        return null;
    }

    /** Origem esperada do CST: fornecedor importou direto, mas adquirimos no
     *  mercado interno → converte 1→2 e 6→7. Demais origens permanecem. */
    private origemEsperada(origemNota: string): string {
        if (origemNota === '1') return '2';
        if (origemNota === '6') return '7';
        return origemNota;
    }

    /** Sem conferência na tela: deduz imposto/destinação pelo CFOP lançado. */
    private classificacaoPorCfop(cfopDigits: string): { imposto: string; destinacao: string } | null {
        const suf = cfopDigits.slice(1); // remove o 1º dígito (1/2/3)
        if (suf === '102') return { imposto: 'TRIBUTADA', destinacao: 'COMERCIALIZACAO' };
        if (suf === '403') return { imposto: 'ST', destinacao: 'COMERCIALIZACAO' };
        if (suf === '407') return { imposto: 'ST', destinacao: 'USO_CONSUMO' };
        if (suf === '556') return { imposto: 'TRIBUTADA', destinacao: 'USO_CONSUMO' };
        // Devolução / transferência / retorno / combustível / outras (destinação = comercialização)
        if (suf === '411') return { imposto: 'ST', destinacao: 'COMERCIALIZACAO' };
        if (suf === '202') return { imposto: 'TRIBUTADA', destinacao: 'COMERCIALIZACAO' };
        if (suf === '653') return { imposto: 'ST', destinacao: 'COMERCIALIZACAO' };
        if (suf === '152') return { imposto: 'TRIBUTADA', destinacao: 'COMERCIALIZACAO' };
        if (suf === '916') return { imposto: 'TRIBUTADA', destinacao: 'COMERCIALIZACAO' };
        if (suf === '949') return { imposto: 'ST', destinacao: 'COMERCIALIZACAO' };
        return null;
    }

    /** Notas DENTRO do estado: a destinação vem do OPF_CODIGO da NF_ENTRADA.
     *  1 ou 40 = compra (comercialização); 10 = uso/consumo. */
    private destinacaoPorOpf(opfCodigo: any): 'COMERCIALIZACAO' | 'USO_CONSUMO' | null {
        const code = this.digitsOnly(opfCodigo);
        if (code === '1' || code === '40') return 'COMERCIALIZACAO';
        if (code === '10') return 'USO_CONSUMO';
        return null;
    }

    /**
     * PIS/COFINS esperados conforme o SUBTIPO do cadastro e se é monofásico:
     *   - SUBTIPO 07 ou 08            -> P70 / C70
     *   - monofásico (e não 07/08)    -> 04 / 04
     *   - demais (não mono, não 07/08)-> P01 / C01
     */
    private pisCofinsEsperado(cadastroSubtipo: any, monofasico: boolean): { pis: string; cofins: string } {
        const sub = this.digitsOnly(cadastroSubtipo);
        if (sub === '07' || sub === '08') return { pis: 'P70', cofins: 'C70' };
        if (monofasico) return { pis: '04', cofins: '04' };
        return { pis: 'P01', cofins: 'C01' };
    }

    // ---- Regras fiscais configuráveis (com cache) ----

    private fiscalRulesCache: { regras: any[]; opf: Map<string, string>; origem: Map<string, string>; cfops: any[] } | null = null;
    private fiscalRulesCacheAt = 0;
    private static readonly FISCAL_RULES_TTL_MS = 60_000;

    private invalidateFiscalRules() {
        this.fiscalRulesCache = null;
    }

    private async getFiscalRules() {
        // Cache em memória com TTL curto: invalida na hora ao salvar (modal) e,
        // se as regras mudarem direto no banco, se atualiza sozinho em até 60s.
        if (this.fiscalRulesCache && Date.now() - this.fiscalRulesCacheAt < IcmsService.FISCAL_RULES_TTL_MS) {
            return this.fiscalRulesCache;
        }
        try {
            const regras = await this.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM com_fiscal_regra WHERE ativo = true`);
            const opfRows = await this.prisma.$queryRawUnsafe<any[]>(`SELECT opf_codigo, destinacao FROM com_fiscal_opf_destinacao WHERE ativo = true`);
            const origemRows = await this.prisma.$queryRawUnsafe<any[]>(`SELECT origem_de, origem_para FROM com_fiscal_origem_cst WHERE ativo = true`);
            let cfops: any[] = [];
            try {
                cfops = await this.prisma.$queryRawUnsafe<any[]>(
                    `SELECT cfop_fornecedor, destinacao, tem_cest, cfop_entrada, cst_final FROM com_fiscal_cfop WHERE ativo = true`,
                );
            } catch { cfops = []; } // tabela ainda não criada
            this.fiscalRulesCache = {
                regras: regras ?? [],
                opf: new Map((opfRows ?? []).map((r) => [this.digitsOnly(r.opf_codigo), String(r.destinacao)])),
                origem: new Map((origemRows ?? []).map((r) => [String(r.origem_de), String(r.origem_para)])),
                cfops: cfops ?? [],
            };
        } catch {
            // Tabelas ainda não criadas → usa os defaults embutidos no código.
            this.fiscalRulesCache = { regras: [], opf: new Map(), origem: new Map(), cfops: [] };
        }
        this.fiscalRulesCacheAt = Date.now();
        return this.fiscalRulesCache;
    }

    /**
     * CFOP de entrada + CST final esperados a partir do CFOP do fornecedor,
     * destinação e se o produto é ST em MT (tem CEST). Match por especificidade
     * (destinação/tem_cest exatos têm prioridade sobre QUALQUER). null = sem regra.
     */
    private cfopRegraEsperada(
        rules: { cfops: any[] },
        cfopFornecedor: string,
        destinacao: string | null,
        temCest: boolean,
    ): { cfopEntrada: string; cstFinal: string | null } | null {
        if (!cfopFornecedor) return null;
        const dest = String(destinacao || '').toUpperCase();
        const cest = temCest ? 'SIM' : 'NAO';
        let best: any = null;
        let bestScore = -1;
        for (const r of rules.cfops ?? []) {
            if (this.digitsOnly(r.cfop_fornecedor) !== cfopFornecedor) continue;
            const rd = String(r.destinacao || 'QUALQUER').toUpperCase();
            const rc = String(r.tem_cest || 'QUALQUER').toUpperCase();
            if (rd !== 'QUALQUER' && rd !== dest) continue;
            if (rc !== 'QUALQUER' && rc !== cest) continue;
            const score = (rd !== 'QUALQUER' ? 2 : 0) + (rc !== 'QUALQUER' ? 1 : 0);
            if (score > bestScore) { bestScore = score; best = r; }
        }
        if (!best) return null;
        return {
            cfopEntrada: this.digitsOnly(best.cfop_entrada),
            cstFinal: best.cst_final ? this.digitsOnly(best.cst_final).slice(-2) : null,
        };
    }

    /** Valores esperados (defaults embutidos), usados quando a tabela está vazia. */
    private regraEsperadaDefault(imposto: string, destinacao: string, monofasico: boolean) {
        const I = String(imposto).toUpperCase();
        const D = String(destinacao).toUpperCase();
        const pisCom = monofasico ? '04' : 'P01';
        const cofinsCom = monofasico ? '04' : 'C01';
        if (I === 'ST' && D === 'COMERCIALIZACAO') return { cfopSufixo: '403', cstFinal: '60', stCodigo: 'ST0-X', pis: pisCom, cofins: cofinsCom, subtipo: '00', comercializavel: null as string | null, subgrp: null as string | null };
        if (I === 'ST' && D === 'USO_CONSUMO') return { cfopSufixo: '407', cstFinal: '60', stCodigo: 'ST0-X', pis: 'P99', cofins: 'C99', subtipo: '07', comercializavel: 'N' as string | null, subgrp: '274' as string | null };
        if (I === 'TRIBUTADA' && D === 'COMERCIALIZACAO') return { cfopSufixo: '102', cstFinal: '00', stCodigo: 'TR0-X', pis: pisCom, cofins: cofinsCom, subtipo: '00', comercializavel: null as string | null, subgrp: null as string | null };
        if (D === 'USO_CONSUMO') return { cfopSufixo: '556', cstFinal: '90', stCodigo: 'TR0-X', pis: 'P99', cofins: 'C99', subtipo: '07', comercializavel: 'N' as string | null, subgrp: '274' as string | null };
        return { cfopSufixo: null as string | null, cstFinal: null as string | null, stCodigo: null as string | null, pis: null as string | null, cofins: null as string | null, subtipo: null as string | null, comercializavel: null as string | null, subgrp: null as string | null };
    }

    /** Valores esperados para um item, a partir das regras (com fallback ao default). */
    private regraEsperada(rules: { regras: any[] }, imposto: string, destinacao: string, monofasico: boolean) {
        // DIFAL ≡ Tributada uso/consumo.
        const ehDifal = String(imposto).toUpperCase() === 'DIFAL';
        const I = ehDifal ? 'TRIBUTADA' : String(imposto).toUpperCase();
        const D = ehDifal ? 'USO_CONSUMO' : String(destinacao).toUpperCase();
        const row = (rules.regras ?? []).find(
            (r) =>
                String(r.imposto).toUpperCase() === I &&
                String(r.destinacao).toUpperCase() === D &&
                (r.monofasico === null || r.monofasico === undefined || Boolean(r.monofasico) === monofasico),
        );
        if (row) {
            return {
                cfopSufixo: row.cfop_sufixo ?? null,
                cstFinal: row.cst_final ?? null,
                stCodigo: row.st_codigo ?? null,
                pis: row.pis_codigo ?? null,
                cofins: row.cofins_codigo ?? null,
                subtipo: row.subtipo ?? null,
                comercializavel: row.comercializavel ?? null,
                subgrp: row.subgrp_codigo ?? null,
            };
        }
        return this.regraEsperadaDefault(I, D, monofasico);
    }

    /** Retorna todas as regras configuráveis (para a tela de edição). */
    async getFiscalRegras() {
        // id::int evita "Do not know how to serialize a BigInt" (bigserial -> BigInt).
        const regras = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT id::int AS id, imposto, destinacao, monofasico, cfop_sufixo, cst_final,
                    st_codigo, pis_codigo, cofins_codigo, subtipo, comercializavel, subgrp_codigo,
                    ativo, descricao, updated_at
             FROM com_fiscal_regra
             ORDER BY imposto, destinacao, monofasico NULLS FIRST, id`,
        );
        const opf = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT id::int AS id, opf_codigo, destinacao, ativo FROM com_fiscal_opf_destinacao ORDER BY opf_codigo`,
        );
        const origem = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT id::int AS id, origem_de, origem_para, ativo FROM com_fiscal_origem_cst ORDER BY origem_de`,
        );
        let cfops: any[] = [];
        try {
            cfops = await this.prisma.$queryRawUnsafe<any[]>(
                `SELECT id::int AS id, cfop_fornecedor, destinacao, tem_cest, cfop_entrada, cst_final, ativo, descricao
                 FROM com_fiscal_cfop ORDER BY cfop_fornecedor, destinacao, tem_cest`,
            );
        } catch { cfops = []; }
        return { regras, opf, origem, cfops };
    }

    /** Substitui todas as regras (full replace, atômico) e invalida o cache. */
    async saveFiscalRegras(body: { regras?: any[]; opf?: any[]; origem?: any[]; cfops?: any[] }) {
        const ops: any[] = [
            this.prisma.$executeRawUnsafe(`DELETE FROM com_fiscal_regra`),
            this.prisma.$executeRawUnsafe(`DELETE FROM com_fiscal_opf_destinacao`),
            this.prisma.$executeRawUnsafe(`DELETE FROM com_fiscal_origem_cst`),
            this.prisma.$executeRawUnsafe(`DELETE FROM com_fiscal_cfop`),
        ];
        const orNull = (v: any) => (v === undefined || v === '' ? null : v);
        for (const r of body.regras ?? []) {
            ops.push(
                this.prisma.$executeRawUnsafe(
                    `INSERT INTO com_fiscal_regra
                       (imposto, destinacao, monofasico, cfop_sufixo, cst_final, st_codigo, pis_codigo, cofins_codigo, subtipo, comercializavel, subgrp_codigo, ativo, descricao)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                    String(r.imposto || '').toUpperCase(),
                    String(r.destinacao || '').toUpperCase(),
                    r.monofasico === null || r.monofasico === undefined ? null : Boolean(r.monofasico),
                    orNull(r.cfop_sufixo), orNull(r.cst_final), orNull(r.st_codigo), orNull(r.pis_codigo),
                    orNull(r.cofins_codigo), orNull(r.subtipo), orNull(r.comercializavel), orNull(r.subgrp_codigo),
                    r.ativo !== false, orNull(r.descricao),
                ),
            );
        }
        for (const o of body.opf ?? []) {
            if (!String(o.opf_codigo ?? '').trim()) continue;
            ops.push(
                this.prisma.$executeRawUnsafe(
                    `INSERT INTO com_fiscal_opf_destinacao (opf_codigo, destinacao, ativo) VALUES ($1,$2,$3)`,
                    String(o.opf_codigo).trim(), String(o.destinacao || '').toUpperCase(), o.ativo !== false,
                ),
            );
        }
        for (const o of body.origem ?? []) {
            if (!String(o.origem_de ?? '').trim()) continue;
            ops.push(
                this.prisma.$executeRawUnsafe(
                    `INSERT INTO com_fiscal_origem_cst (origem_de, origem_para, ativo) VALUES ($1,$2,$3)`,
                    String(o.origem_de).trim(), String(o.origem_para || '').trim(), o.ativo !== false,
                ),
            );
        }
        for (const c of body.cfops ?? []) {
            if (!String(c.cfop_fornecedor ?? '').trim() || !String(c.cfop_entrada ?? '').trim()) continue;
            ops.push(
                this.prisma.$executeRawUnsafe(
                    `INSERT INTO com_fiscal_cfop (cfop_fornecedor, destinacao, tem_cest, cfop_entrada, cst_final, ativo, descricao)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                    this.digitsOnly(c.cfop_fornecedor),
                    String(c.destinacao || 'QUALQUER').toUpperCase(),
                    String(c.tem_cest || 'QUALQUER').toUpperCase(),
                    this.digitsOnly(c.cfop_entrada),
                    orNull(c.cst_final ? this.digitsOnly(c.cst_final).slice(-2) : null),
                    c.ativo !== false,
                    orNull(c.descricao),
                ),
            );
        }
        await this.prisma.$transaction(ops);
        this.invalidateFiscalRules();
        return this.getFiscalRegras();
    }

    /** Cabeçalho + itens (origem/CST/ST) da nota, para a auditoria. */
    private async parseNotaParaAuditoria(xmlContent: string): Promise<{
        chave: string;
        numero: string | null;
        serie: string | null;
        modelo: string | null;
        dataEmissao: string | null;
        cnpjEmitente: string | null;
        ufEmitente: string | null;
        emitente: string | null;
        valorTotal: number;
        itens: Array<{ nItem: number; ncm: string | null; origemNota: string; cstFinalNota: string; stDestacado: number }>;
    } | null> {
        const xmlStr = await this.decodeXml(xmlContent);
        if (!xmlStr) return null;
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xmlStr);
        const nfe = result.nfeProc ? result.nfeProc.NFe : result.NFe;
        if (!nfe || !nfe.infNFe || !nfe.infNFe.det) return null;

        const infNfe = nfe.infNFe;
        const emit = infNfe.emit || {};
        const ide = infNfe.ide || {};
        const icmsTot = infNfe.total?.ICMSTot || {};
        const chave = String(infNfe['$']?.Id || '').replace('NFe', '');
        const det = Array.isArray(infNfe.det) ? infNfe.det : [infNfe.det];

        const itens = det.map((item: any, idx: number) => {
            const prod = item.prod || {};
            const imposto = item.imposto || {};
            let origem = '';
            let cstFinal = '';
            let stDestacado = 0;
            for (const key of Object.keys(imposto.ICMS || {})) {
                const vals = imposto.ICMS[key] || {};
                if (vals.orig != null) origem = String(vals.orig);
                const cst = String(vals.CST ?? vals.CSOSN ?? '');
                if (cst) cstFinal = cst.slice(-2);
                if (vals.vICMSST != null) stDestacado = parseFloat(vals.vICMSST) || 0;
            }
            const nItem = parseInt(item['$']?.nItem ?? '', 10);
            return {
                nItem: Number.isFinite(nItem) ? nItem : idx + 1,
                ncm: prod.NCM ?? null,
                origemNota: origem,
                cstFinalNota: cstFinal,
                stDestacado,
            };
        });

        return {
            chave,
            numero: ide.nNF ?? null,
            serie: ide.serie ?? null,
            modelo: ide.mod ?? null,
            dataEmissao: ide.dhEmi ?? ide.dEmi ?? null,
            cnpjEmitente: emit.CNPJ ?? emit.CPF ?? null,
            ufEmitente: emit.enderEmit?.UF ?? null,
            emitente: emit.xNome ?? null,
            valorTotal: parseFloat(icmsTot.vNF || 0) || 0,
            itens,
        };
    }

    /** Busca o lançamento real no ERP (Firebird): cabeçalho NF_ENTRADA + itens NFE_ITENS. */
    private async fetchLancamentoErp(chaveNfe: string): Promise<{
        header: any;
        itens: any[];
    } | null> {
        return this.erpApi.comFallback(
            () => this.fetchLancamentoErpViaApi(chaveNfe),
            () => this.fetchLancamentoErpViaOpenQuery(chaveNfe),
        );
    }

    /**
     * Lançamento de VÁRIAS notas de uma vez, para os laços que já sabem a lista
     * de chaves antes de começar.
     *
     * São 2 consultas ao ERP no total, em vez de 2 por nota. Chave que não vier
     * no mapa simplesmente não está lançada — quem chama trata como antes.
     *
     * Só existe pelo caminho da API; sem ela, devolve mapa vazio e o laço segue
     * nota a nota pelo OPENQUERY, exatamente como fazia.
     */
    private async fetchLancamentosErpEmLote(chaves: string[]): Promise<Map<string, LancamentoErp>> {
        const mapa = new Map<string, LancamentoErp>();
        if (!chaves.length || !this.erpApi.habilitado) return mapa;

        try {
            const cabecalhos: any[] = [];
            for (let i = 0; i < chaves.length; i += ErpApiService.LOTE_CHAVES) {
                cabecalhos.push(...(await this.erpApi.nfEntradaPorChaves(chaves.slice(i, i + ErpApiService.LOTE_CHAVES))));
            }
            if (!cabecalhos.length) return mapa;

            // Num relançamento a mesma chave tem mais de uma linha concluída;
            // vale a de maior NFE, o mesmo critério da busca individual.
            const porChave = new Map<string, any>();
            for (const h of cabecalhos) {
                const chave = String(h.CHAVE_NFE || '').trim();
                if (!chave) continue;
                const atual = porChave.get(chave);
                if (!atual || Number(h.NFE) > Number(atual.NFE)) porChave.set(chave, h);
            }

            const nfes = [...porChave.values()].map((h) => Number(h.NFE)).filter(Number.isFinite);
            const itensPorNfe = new Map<number, any[]>();
            for (const item of await this.erpApi.nfeItensEmLote(nfes)) {
                const nfe = Number(item.NFE);
                if (!itensPorNfe.has(nfe)) itensPorNfe.set(nfe, []);
                itensPorNfe.get(nfe)!.push(item);
            }

            for (const [chave, header] of porChave) {
                const itens = (itensPorNfe.get(Number(header.NFE)) ?? []).sort(
                    (a, b) => Number(a.ITEM) - Number(b.ITEM),
                );
                mapa.set(chave, { header, itens });
            }
        } catch {
            // Falha no lote não pode custar a auditoria: mapa vazio devolve o
            // laço para a busca nota a nota, que tem o seu próprio fallback.
            return new Map();
        }

        return mapa;
    }

    private async fetchLancamentoErpViaApi(chaveNfe: string) {
        const notas = await this.erpApi.nfEntradaPorChaves([chaveNfe]);
        if (!notas.length) return null;

        // Num relançamento a mesma chave tem mais de uma linha; a rota já
        // devolve só as concluídas (STATUS = 1) e a mais recente é a de maior
        // NFE — o mesmo critério do ORDER BY NFE DESC do caminho antigo.
        const header = notas.reduce((maior, atual) =>
            Number(atual.NFE) > Number(maior.NFE) ? atual : maior,
        );

        const itens = await this.erpApi.nfeItens(Number(header.NFE));
        return { header, itens };
    }

    private async fetchLancamentoErpViaOpenQuery(chaveNfe: string): Promise<{
        header: any;
        itens: any[];
    } | null> {
        const safeChave = String(chaveNfe).replace(/'/g, "''");
        // STATUS=1 = Concluída (lançamento ativo); STATUS=2 = Cancelada. Num
        // relançamento há 2 linhas (1 e 2) — pegamos a concluída mais recente.
        const headSql = `
      SELECT FIRST 1 NFE, NOTA_FISCAL, SERIE, MODELO_NOTA, FOR_CODIGO, CHAVE_NFE,
             TOTAL_NOTA, DT_EMISSAO, DT_ENTRADA, OPF_CODIGO
      FROM NF_ENTRADA
      WHERE EMPRESA = 1 AND CHAVE_NFE = '${safeChave}' AND STATUS = 1
      ORDER BY NFE DESC
    `;
        const headRows = await this.openQuery.query<any>(
            `SELECT * FROM OPENQUERY(CONSULTA, '${headSql.replace(/'/g, "''")}')`,
            {},
            { timeout: 300000, allowZeroRows: true },
        );
        const header = headRows[0];
        if (!header) return null;

        const itemSql = `
      SELECT ITEM, PRO_CODIGO, CFOP, CFOP_NOTA, CST, CST_FISCAL, ALIQ_ICMS, ST_VALOR
      FROM NFE_ITENS
      WHERE EMPRESA = 1 AND NFE = ${Number(header.NFE)}
      ORDER BY ITEM
    `;
        const itens = await this.openQuery.query<any>(
            `SELECT * FROM OPENQUERY(CONSULTA, '${itemSql.replace(/'/g, "''")}')`,
            {},
            { timeout: 300000, allowZeroRows: true },
        );
        return { header, itens };
    }

    /** Verifica se a chave voltou para a temporária NFE_DISTRIBUICAO (pendente). */
    private async existsInNfeDistribuicao(chaveNfe: string): Promise<boolean> {
        return this.erpApi.comFallback(
            () => this.erpApi.nfeDistribuicaoTemChave(chaveNfe),
            () => this.existsInNfeDistribuicaoViaOpenQuery(chaveNfe),
        );
    }

    private async existsInNfeDistribuicaoViaOpenQuery(chaveNfe: string): Promise<boolean> {
        const safe = String(chaveNfe).replace(/'/g, "''");
        const fb = `SELECT FIRST 1 CHAVE_NFE FROM NFE_DISTRIBUICAO WHERE EMPRESA = 1 AND IMPORTADA = 'N' AND CHAVE_NFE = '${safe}'`;
        try {
            const rows = await this.openQuery.query<any>(
                `SELECT * FROM OPENQUERY(CONSULTA, '${fb.replace(/'/g, "''")}')`,
                {},
                { timeout: 120000, allowZeroRows: true },
            );
            return rows.length > 0;
        } catch (e) {
            // Em dúvida (falha no ERP) NÃO marca como excluída.
            this.logger.error(`Falha ao checar NFE_DISTRIBUICAO ${chaveNfe}`, e instanceof Error ? e.stack : String(e), 'Auditoria');
            return true;
        }
    }

    /**
     * Reconcilia o status_erp no Postgres com o ERP:
     *  - está na NF_ENTRADA            -> LANCADA;
     *  - voltou para NFE_DISTRIBUICAO  -> PENDENTE;
     *  - sumiu das duas               -> EXCLUIDA (sai da auditoria).
     */
    private async reconciliarStatusEntrada(
        chaveNfe: string,
        lancamentoConhecido?: LancamentoErp | null,
    ): Promise<{ status: 'LANCADA' | 'PENDENTE' | 'EXCLUIDA'; lancamento: LancamentoErp | null }> {
        // Ausência no lote não prova que a nota saiu do ERP — pode ser que o
        // lote nem tenha rodado. Sem lançamento conhecido, confirma nota a nota.
        const erp = lancamentoConhecido ?? (await this.fetchLancamentoErp(chaveNfe));
        // Devolve o lançamento junto: quem chama audita em seguida e precisaria
        // exatamente do mesmo cabeçalho e dos mesmos itens. Buscar de novo seria
        // dobrar as idas ao ERP por nota, num laço que já roda nota a nota.
        if (erp) return { status: 'LANCADA', lancamento: erp };

        const naDistribuicao = await this.existsInNfeDistribuicao(chaveNfe);
        const status = naDistribuicao ? 'PENDENTE' : 'EXCLUIDA';
        await this.prisma.nfeConciliacao.update({
            where: { chave_nfe: chaveNfe },
            data: { status_erp: status, updated_at: new Date() },
        });
        this.logger.log(`Reconferência: NF ${chaveNfe} não está mais lançada no ERP → status ${status}.`, 'Auditoria');
        return { status, lancamento: null };
    }

    /**
     * Computa a auditoria de uma NF (read-only): cabeçalho + itens, cada
     * conferência marcada como ok/divergente, com código e descrição do produto.
     * Base única para persistir, alertar e exibir o detalhe. null = não auditável.
     */
    private async computarAuditoria(
        chaveNfe: string,
        opts: { produtoDireto?: boolean; lancamento?: LancamentoErp | null } = {},
    ): Promise<{
        nota: any;
        header: any;
        semConferencia: boolean;
        cabecalho: Array<{ campo: string; esperado: string | null; encontrado: string | null; ok: boolean; mensagem?: string }>;
        itens: Array<{ nItem: number; proCodigo: string; descricao: string | null; imposto: string | null; destinacao: string | null; checks: Array<{ campo: string; esperado: string | null; encontrado: string | null; ok: boolean; mensagem?: string }> }>;
    } | null> {
        const nfeRow: any = await this.prisma.nfeConciliacao.findUnique({
            where: { chave_nfe: chaveNfe },
            select: { xml_completo: true },
        });
        if (!nfeRow) return null;

        const xml = await this.normalizeBlobXml(nfeRow.xml_completo);
        if (this.detectXmlType(xml) !== 'COMPLETO') return null;

        const nota = await this.parseNotaParaAuditoria(xml);
        if (!nota) return null;

        // Quem já reconciliou o status acabou de buscar este mesmo lançamento.
        const erp = opts.lancamento ?? (await this.fetchLancamentoErp(chaveNfe));
        if (!erp) return null;

        const conf = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT n_item, pro_codigo, imposto_escolhido, destinacao_mercadoria
             FROM com_nfe_conciliacao_item WHERE chave_nfe = $1`,
            chaveNfe,
        );
        const confByItem = new Map<number, any>();
        for (const c of conf) confByItem.set(Number(c.n_item), c);
        const semConferencia = conf.length === 0;

        const intra = this.isWithinMtByChave(chaveNfe);
        const h = erp.header;

        // ---- Cabeçalho ----
        type Chk = { campo: string; esperado: string | null; encontrado: string | null; ok: boolean; mensagem?: string };
        const cabecalho: Chk[] = [];
        const addCab = (campo: string, esperado: any, encontrado: any, norm: (x: any) => string = (x) => String(x ?? '').trim()) => {
            const ok = norm(esperado) === norm(encontrado);
            cabecalho.push({ campo, esperado: String(esperado ?? ''), encontrado: String(encontrado ?? ''), ok, mensagem: ok ? undefined : `${campo} divergente` });
        };
        addCab('Número', nota.numero, h.NOTA_FISCAL, (x) => this.digitsOnly(x));
        addCab('Série', nota.serie, h.SERIE, (x) => this.digitsOnly(x));
        addCab('Modelo', nota.modelo, h.MODELO_NOTA, (x) => this.digitsOnly(x));
        addCab('Chave', nota.chave, h.CHAVE_NFE, (x) => this.digitsOnly(x));
        addCab('CNPJ emitente', this.digitsOnly(nota.cnpjEmitente), this.digitsOnly(h.CHAVE_NFE).slice(6, 20));
        const dEmiNota = (nota.dataEmissao || '').slice(0, 10);
        const dEmiErp = h.DT_EMISSAO ? new Date(h.DT_EMISSAO).toISOString().slice(0, 10) : '';
        const emissaoOk = !(dEmiNota && dEmiErp && dEmiNota !== dEmiErp);
        cabecalho.push({ campo: 'Emissão', esperado: dEmiNota, encontrado: dEmiErp, ok: emissaoOk, mensagem: emissaoOk ? undefined : 'Data de emissão divergente' });
        const valorOk = Math.abs((Number(h.TOTAL_NOTA) || 0) - nota.valorTotal) <= 0.01;
        cabecalho.push({ campo: 'Valor total', esperado: nota.valorTotal.toFixed(2), encontrado: Number(h.TOTAL_NOTA || 0).toFixed(2), ok: valorOk, mensagem: valorOk ? undefined : 'Valor total divergente' });

        // ---- Itens (apenas NF-e modelo 55) ----
        const itens: any[] = [];
        if (this.digitsOnly(h.MODELO_NOTA) === '55') {
            const rules = await this.getFiscalRules();
            const notaByItem = new Map<number, any>();
            for (const it of nota.itens) notaByItem.set(it.nItem, it);

            // OPF_CODIGO só DETERMINA a destinação (revenda x uso/consumo) das
            // notas intra; não entra como item de conferência.
            let destinacaoIntra: 'COMERCIALIZACAO' | 'USO_CONSUMO' | null = null;
            if (intra) {
                const destOpf = rules.opf.get(this.digitsOnly(h.OPF_CODIGO)) ?? this.destinacaoPorOpf(h.OPF_CODIGO);
                destinacaoIntra = destOpf === 'COMERCIALIZACAO' || destOpf === 'USO_CONSUMO' ? destOpf : null;
            }

            for (const ei of erp.itens) {
                const nItem = Number(ei.ITEM);
                const proCodigo = String(ei.PRO_CODIGO ?? '');
                const cfopLanc = this.digitsOnly(ei.CFOP);
                const cstFiscalLanc = this.digitsOnly(ei.CST_FISCAL).padStart(3, '0');
                const notaItem = notaByItem.get(nItem);
                const cItem = confByItem.get(nItem);
                const checks: Chk[] = [];
                const prod = proCodigo ? await this.findInternalProduct(proCodigo, !!opts.produtoDireto) : null;
                const descricao = prod?.PRO_DESCRICAO ?? null;

                let imposto: string | null = null;
                let destinacao: string | null = null;
                if (cItem) {
                    imposto = cItem.imposto_escolhido;
                    destinacao = cItem.destinacao_mercadoria;
                } else {
                    const inferido = this.classificacaoPorCfop(cfopLanc);
                    if (inferido) {
                        imposto = inferido.imposto;
                        destinacao = inferido.destinacao;
                    }
                }
                // Destinação POR ITEM, definida pelo SUBTIPO do cadastro:
                //   00 -> comercialização   |   07 -> uso e consumo
                // Antes vinha do OPF (por NOTA), o que classificava errado uma NF com
                // itens mistos (ex.: 1 revenda + 1 uso/consumo). O SUBTIPO é por item e
                // resolve isso. OPF (por nota) continua só como fallback p/ subtipos
                // fora de 00/07.
                const subItem = this.digitsOnly(prod?.SUBTIPO);
                const destSubtipo =
                    subItem === '00' ? 'COMERCIALIZACAO' : subItem === '07' ? 'USO_CONSUMO' : null;
                if (destSubtipo) destinacao = destSubtipo;
                else if (intra && destinacaoIntra) destinacao = destinacaoIntra;

                const monofasico = this.isMonofasicoNcm(this.cleanDigits(notaItem?.ncm ?? ''));
                const reg = this.regraEsperada(rules, imposto!, destinacao!, monofasico);

                // CFOP/CST esperados: 1º pelas regras por CFOP do fornecedor (norma MT,
                // considerando se o produto tem CEST); fallback na matriz imposto×destinação.
                const cfopNota = this.digitsOnly(ei.CFOP_NOTA);
                // "É ST?": a conferência da tela manda (imposto escolhido); sem ela,
                // usa o cadastro (ST_CODIGO=ST0-X) ou o CEST. O campo CEST pode estar
                // vazio mesmo em produto ST (regra do 999 / uso automotivo).
                const ehSt = cItem
                    ? String(cItem.imposto_escolhido ?? '').toUpperCase() === 'ST'
                    : (String(prod?.ST_CODIGO ?? '').toUpperCase() === 'ST0-X' || !!String(prod?.CEST ?? '').trim());
                const expCfop = this.cfopRegraEsperada(rules, cfopNota, destinacao, ehSt);
                const cfopExp = expCfop?.cfopEntrada ?? (reg.cfopSufixo ? (intra ? '1' : '2') + reg.cfopSufixo : null);
                const cstFinalExp = expCfop?.cstFinal ?? reg.cstFinal;

                if (cfopExp) {
                    checks.push({ campo: 'CFOP', esperado: cfopExp, encontrado: cfopLanc || '', ok: !cfopLanc || cfopLanc === cfopExp });
                } else if (cfopLanc) {
                    checks.push({ campo: 'CFOP', esperado: null, encontrado: cfopLanc, ok: false, mensagem: `CFOP ${cfopLanc} (fornecedor ${cfopNota || '?'}) sem regra cadastrada — verifique em Regras fiscais` });
                }
                if (cstFinalExp) {
                    const enc = cstFiscalLanc ? cstFiscalLanc.slice(-2) : '';
                    checks.push({ campo: 'CST final', esperado: cstFinalExp, encontrado: enc, ok: !enc || enc === cstFinalExp });
                }
                if (notaItem?.origemNota && cstFiscalLanc.length === 3) {
                    const origemExp = rules.origem.get(notaItem.origemNota) ?? this.origemEsperada(notaItem.origemNota);
                    const enc = cstFiscalLanc.slice(0, 1);
                    checks.push({ campo: 'CST origem', esperado: origemExp, encontrado: enc, ok: enc === origemExp });
                }
                if (proCodigo && !prod) {
                    checks.push({ campo: 'Cadastro', esperado: 'Cadastrado', encontrado: 'Não encontrado', ok: false, mensagem: `Produto ${proCodigo} não encontrado no cadastro (Stage_Produtos)` });
                } else if (prod) {
                    // PIS/COFINS vêm do SUBTIPO do cadastro (07/08->P70/C70, mono->04, senão P01/C01).
                    const pc = this.pisCofinsEsperado(prod.SUBTIPO, monofasico);
                    // Situação Tributária: COM CEST -> ST0-X (substituto). SEM CEST
                    // NÃO força TR0-X — pode ser ST pela regra do 999 (uso automotivo).
                    const stEsperado = String(prod.CEST ?? '').trim() ? 'ST0-X' : null;
                    const cad: Array<[string, any, any]> = [
                        ['Cadastro ST_CODIGO', stEsperado, prod.ST_CODIGO],
                        ['Cadastro PIS', pc.pis, prod.PIS_CODIGO],
                        ['Cadastro COFINS', pc.cofins, prod.COFINS_CODIGO],
                        ['Cadastro SUBTIPO', reg.subtipo, prod.SUBTIPO],
                        ['Cadastro COMERCIALIZAVEL', reg.comercializavel, prod.COMERCIALIZAVEL],
                        ['Cadastro SUBGRP', reg.subgrp, prod.SUBGRP_CODIGO],
                    ];
                    for (const [campo, esp, enc] of cad) {
                        if (esp == null || String(esp).trim() === '') continue;
                        const ok = String(enc ?? '').trim().toUpperCase() === String(esp).trim().toUpperCase();
                        checks.push({ campo, esperado: String(esp), encontrado: String(enc ?? '') || 'vazio', ok });
                    }
                }
                itens.push({ nItem, proCodigo, descricao, imposto, destinacao, checks });
            }
        }

        return { nota, header: h, semConferencia, cabecalho, itens };
    }

    /** Achata os checks que falharam num formato de divergência (persistência/alerta). */
    private errosFromComputado(r: { cabecalho: any[]; itens: any[] }) {
        const erros: Array<{ escopo: 'CABECALHO' | 'ITEM'; nItem?: number; proCodigo?: string; campo: string; esperado?: string; encontrado?: string; mensagem: string }> = [];
        for (const c of r.cabecalho) {
            if (!c.ok) erros.push({ escopo: 'CABECALHO', campo: c.campo, esperado: c.esperado, encontrado: c.encontrado, mensagem: c.mensagem ?? `${c.campo} divergente` });
        }
        for (const it of r.itens) {
            for (const c of it.checks) {
                if (!c.ok) erros.push({ escopo: 'ITEM', nItem: it.nItem, proCodigo: it.proCodigo, campo: c.campo, esperado: c.esperado, encontrado: c.encontrado, mensagem: c.mensagem ?? `${c.campo}: esperado ${c.esperado}, lançado ${c.encontrado}` });
            }
        }
        return erros;
    }

    /** Itens ressalvados (OK por intervenção) de uma NF. Map n_item -> motivo. */
    private async getRessalvasMap(chaveNfe: string): Promise<Map<number, string | null>> {
        const m = new Map<number, string | null>();
        try {
            const rows = await this.prisma.$queryRawUnsafe<any[]>(
                `SELECT n_item, motivo FROM com_nfe_ressalva WHERE chave_nfe = $1`,
                chaveNfe,
            );
            for (const r of rows) m.set(Number(r.n_item), r.motivo ?? null);
        } catch {
            // tabela ainda não criada
        }
        return m;
    }

    private escopoNItem(e: { escopo: string; nItem?: number }): number {
        return e.escopo === 'CABECALHO' ? 0 : (e.nItem ?? 0);
    }

    /**
     * Audita o lançamento de uma NF que virou LANCADA: persiste o resultado e,
     * havendo erro, alerta o grupo via n8n/WAHA. Nunca lança; alerta 1x por NF.
     */
    private async auditarLancamentoFiscal(
        chaveNfe: string,
        opts: { enviarAlerta?: boolean; produtoDireto?: boolean; lancamento?: LancamentoErp | null } = {},
    ): Promise<void> {
        const enviarAlerta = opts.enviarAlerta !== false;
        try {
            const nfeRow: any = await this.prisma.nfeConciliacao.findUnique({
                where: { chave_nfe: chaveNfe },
                select: { auditoria_alerta_em: true },
            });
            const r = await this.computarAuditoria(chaveNfe, {
                produtoDireto: opts.produtoDireto,
                lancamento: opts.lancamento,
            });
            if (!r) return;

            const erros = this.errosFromComputado(r);
            // Itens/cabeçalho ressalvados (OK por intervenção) não contam no status.
            const ressalvas = await this.getRessalvasMap(chaveNfe);
            const errosEfetivos = erros.filter((e) => !ressalvas.has(this.escopoNItem(e)));
            const status = errosEfetivos.length > 0 ? 'DIVERGENTE' : 'OK';

            await this.prisma.nfeConciliacao.update({
                where: { chave_nfe: chaveNfe },
                data: { auditoria_fiscal_em: new Date(), auditoria_fiscal_status: status },
            });
            await this.prisma.$executeRawUnsafe(`DELETE FROM com_nfe_auditoria_item WHERE chave_nfe = $1`, chaveNfe);
            for (const e of erros) {
                await this.prisma.$executeRawUnsafe(
                    `INSERT INTO com_nfe_auditoria_item (chave_nfe, n_item, campo, esperado, encontrado, mensagem)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (chave_nfe, n_item, campo) DO UPDATE
                       SET esperado = EXCLUDED.esperado, encontrado = EXCLUDED.encontrado, mensagem = EXCLUDED.mensagem`,
                    chaveNfe, e.nItem ?? 0, e.campo, e.esperado ?? null, e.encontrado ?? null, e.mensagem,
                );
            }

            if (enviarAlerta && errosEfetivos.length > 0 && !nfeRow?.auditoria_alerta_em) {
                const webhook = process.env.N8N_AUDITORIA_WEBHOOK_URL;
                if (!webhook) {
                    this.logger.warn('N8N_AUDITORIA_WEBHOOK_URL não configurada: pulando alerta de auditoria.', 'Auditoria');
                } else {
                    const payload = this.montarPayloadAuditoria(chaveNfe, r, status, errosEfetivos, 'automatico');
                    const resp = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    if (resp.ok) {
                        await this.prisma.nfeConciliacao.update({ where: { chave_nfe: chaveNfe }, data: { auditoria_alerta_em: new Date() } });
                        this.logger.log(`Alerta de auditoria enviado para ${chaveNfe} (${erros.length} erro(s)).`, 'Auditoria');
                    } else {
                        this.logger.error(`n8n recusou alerta de auditoria ${chaveNfe}: HTTP ${resp.status}.`, undefined, 'Auditoria');
                    }
                }
            }
        } catch (e) {
            this.logger.error(`Falha ao auditar lançamento ${chaveNfe}`, e instanceof Error ? e.stack : String(e), 'Auditoria');
        }
    }

    /** Monta o payload do alerta de auditoria (n8n/WAHA). Reusado pelo disparo
     *  automático (sync) e pelo envio manual (botão da tela de detalhe). */
    private montarPayloadAuditoria(
        chaveNfe: string,
        r: { nota: any; header: any },
        status: string,
        errosEfetivos: any[],
        origem: 'automatico' | 'manual' = 'automatico',
    ) {
        return {
            chaveNfe,
            numeroNf: r.nota.numero,
            serie: r.nota.serie,
            emitente: r.nota.emitente,
            ufEmitente: r.nota.ufEmitente,
            dtEntrada: r.header.DT_ENTRADA ? new Date(r.header.DT_ENTRADA).toISOString().slice(0, 10) : null,
            statusAuditoria: status,
            totalErros: errosEfetivos.length,
            erros: errosEfetivos,
            origem,
        };
    }

    /**
     * Envia SOB DEMANDA (botão da tela de detalhe) o alerta de auditoria da NF
     * aberta para o grupo de Conferência Fiscal no WhatsApp, via n8n/WAHA.
     * Diferente do disparo automático:
     *  - ignora a idempotência (sempre reenvia, mesmo que já alertado antes);
     *  - exige divergência efetiva (sem erros => nada a enviar);
     *  - propaga erro de configuração/HTTP para a tela dar feedback ao usuário.
     * Retorna null quando a NF não existe ou não tem XML completo p/ auditar.
     */
    async enviarAlertaAuditoria(
        chaveNfe: string,
    ): Promise<{ enviado: boolean; totalErros: number; status: 'OK' | 'DIVERGENTE'; motivo?: string } | null> {
        const r = await this.computarAuditoria(chaveNfe, { produtoDireto: true });
        if (!r) return null;

        const erros = this.errosFromComputado(r);
        const ressalvas = await this.getRessalvasMap(chaveNfe);
        const errosEfetivos = erros.filter((e) => !ressalvas.has(this.escopoNItem(e)));
        const status: 'OK' | 'DIVERGENTE' = errosEfetivos.length > 0 ? 'DIVERGENTE' : 'OK';

        if (errosEfetivos.length === 0) {
            return { enviado: false, totalErros: 0, status, motivo: 'NF sem divergências — nada a enviar.' };
        }

        const webhook = process.env.N8N_AUDITORIA_WEBHOOK_URL;
        if (!webhook) {
            throw new Error('N8N_AUDITORIA_WEBHOOK_URL não configurada no serviço.');
        }

        const payload = this.montarPayloadAuditoria(chaveNfe, r, status, errosEfetivos, 'manual');
        const resp = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            throw new Error(`n8n recusou o alerta de auditoria: HTTP ${resp.status}`);
        }

        await this.prisma.nfeConciliacao.update({
            where: { chave_nfe: chaveNfe },
            data: { auditoria_alerta_em: new Date() },
        });
        this.logger.log(
            `Alerta de auditoria (manual) enviado para ${chaveNfe} (${errosEfetivos.length} erro(s)).`,
            'Auditoria',
        );
        return { enviado: true, totalErros: errosEfetivos.length, status };
    }

    // ---- Loop fechado via WhatsApp: usuário responde "ajustado" -> reconfere ----

    /** Divergências agrupadas por PRODUTO (mesmo formato do alerta no n8n). */
    private blocosErrosDoDetalhe(detalhe: any): string {
        const fmt = (c: any) =>
            c.esperado != null || c.encontrado != null
                ? `   • ${c.campo}: Errado ${c.encontrado ?? '-'}. mudar para ${c.esperado ?? '-'}`
                : `   • ${c.mensagem || c.campo}`;
        const blocos: string[] = [];
        const cab = (detalhe?.cabecalho ?? []).filter((c: any) => !c.ok && !c.ressalvado);
        if (cab.length) blocos.push(`• CABEÇALHO\n${cab.map(fmt).join('\n')}`);
        for (const it of detalhe?.itens ?? []) {
            if (it.ressalvado) continue;
            const ck = (it.checks ?? []).filter((c: any) => !c.ok);
            if (!ck.length) continue;
            const key = it.proCodigo || `Item ${it.nItem}`;
            blocos.push(`• PRODUTO: ${key}\n${ck.map(fmt).join('\n')}`);
        }
        return blocos.join('\n\n');
    }

    /** Envia texto num grupo do WAHA (default: grupo Conferência Fiscal). Devolve o id da mensagem. */
    async wahaEnviarTexto(text: string, replyTo?: string, chatId?: string): Promise<string | null> {
        const base = process.env.WAHA_BASE_URL;
        const key = process.env.WAHA_API_KEY;
        const session = process.env.WAHA_SESSION || 'default';
        const group = chatId || process.env.WAHA_GROUP_CHAT_ID;
        if (!base || !key || !group) return null;
        const body: any = { session, chatId: group, text };
        if (replyTo) body.reply_to = replyTo;
        const resp = await fetch(`${base.replace(/\/$/, '')}/api/sendText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
            body: JSON.stringify(body),
        });
        if (!resp.ok) return null;
        // Id da mensagem enviada (o fluxo ST guarda para casar a resposta citada).
        const json: any = await resp.json().catch(() => null);
        const id = json?.id?._serialized ?? json?.id ?? json?.key?.id;
        return id ? String(id) : 'ok';
    }

    /**
     * Lê as últimas mensagens do grupo no WAHA. Tudo de SAÍDA (a intranet não
     * recebe webhook da nuvem), por isso é polling. null = WAHA não configurado
     * ou recusou a leitura. Quem roteia as respostas (ajustado, pode enviar,
     * manual, classificação de item) é StFluxoService.processarRespostasWaha().
     */
    async wahaLerMensagens(chatId?: string): Promise<any[] | null> {
        const base = process.env.WAHA_BASE_URL;
        const key = process.env.WAHA_API_KEY;
        const session = process.env.WAHA_SESSION || 'default';
        const group = chatId || process.env.WAHA_GROUP_CHAT_ID;
        if (!base || !key || !group) {
            this.logger.warn('WAHA_BASE_URL/WAHA_API_KEY/WAHA_GROUP_CHAT_ID não configurados: pulando polling de respostas.', 'Auditoria');
            return null;
        }
        const msgLimit = Number(process.env.WAHA_AJUSTADO_MSG_LIMIT) > 0 ? Number(process.env.WAHA_AJUSTADO_MSG_LIMIT) : 200;
        const url = `${base.replace(/\/$/, '')}/api/${session}/chats/${encodeURIComponent(group)}/messages?limit=${msgLimit}&downloadMedia=false`;
        const resp = await fetch(url, { headers: { 'X-Api-Key': key } });
        if (!resp.ok) {
            this.logger.error(`WAHA recusou leitura de mensagens: HTTP ${resp.status}`, undefined, 'Auditoria');
            return null;
        }
        const msgs: any[] = await resp.json();
        return Array.isArray(msgs) ? msgs : null;
    }

    /**
     * Resposta "ajustado" ao alerta de auditoria: reconfere a NF e responde no
     * grupo (✅ 100% ou ⚠️ erros restantes). Idempotente via com_nfe_ajustado_processado.
     */
    async tratarRespostaAjustado(msgId: string, chave: string): Promise<void> {
        const detalhe = await this.reconferirAuditoria(chave);
        if (!detalhe) {
            await this.wahaEnviarTexto(`⚠️ NF não encontrada na base de conciliação.\nChave: ${chave}`, msgId);
            await this.marcarAjustadoProcessado(msgId, chave, 'NAO_ENCONTRADA');
            return;
        }

        const h = detalhe.header;
        const numero = h?.numero ?? '-';
        let texto: string;
        let resultado: string;
        if (h?.naoAuditavel) {
            texto = `ℹ️ *NF ${numero}* não está mais lançada no ERP (${h?.statusErp ?? '—'}) — fora da auditoria.\n\`${chave}\``;
            resultado = 'NAO_AUDITAVEL';
        } else if ((h?.totalErros ?? 0) === 0) {
            texto =
                `🧾 *Auditoria fiscal* — ✅ *OK*\n\n` +
                `NF: *${numero}* - ${h?.emitente ?? '-'} (${h?.uf ?? '-'})\n\n` +
                `100% ajustada! Sem divergências. 👏\n\`${chave}\``;
            resultado = 'OK';
        } else {
            texto =
                `🧾 *Auditoria fiscal* — 🚫 *ERRO* 🚫\n\n` +
                `NF: *${numero}* - ${h?.emitente ?? '-'} (${h?.uf ?? '-'})\n\n` +
                `Erros (${h.totalErros}):\n\n${this.blocosErrosDoDetalhe(detalhe) || '—'}\n\n` +
                `↩️ Após ajustar no ERP, responda *ajustado* novamente.\n\`${chave}\``;
            resultado = 'DIVERGENTE';
        }

        await this.wahaEnviarTexto(texto, msgId);
        await this.marcarAjustadoProcessado(msgId, chave, resultado);
        this.logger.log(`Resposta "ajustado" tratada (NF ${numero}, ${resultado}).`, 'Auditoria');
    }

    async marcarAjustadoProcessado(msgId: string, chave: string | null, resultado: string): Promise<void> {
        await this.prisma.$executeRawUnsafe(
            `INSERT INTO com_nfe_ajustado_processado (waha_msg_id, chave_nfe, resultado)
             VALUES ($1, $2, $3) ON CONFLICT (waha_msg_id) DO NOTHING`,
            msgId, chave, resultado,
        );
    }

    // ---- Consulta da aba "Conferência Fiscal" ----

    private static readonly CUF_SIGLA: Record<string, string> = {
        '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
        '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
        '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS',
        '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
    };
    cufToSigla(cuf: string): string {
        return IcmsService.CUF_SIGLA[String(cuf ?? '')] ?? String(cuf ?? '');
    }

    /** Janela de data de entrada: default = mês corrente. */
    private resolveJanelaEntrada(dtInicio?: string, dtFim?: string): { inicio: Date; fim: Date } {
        const now = new Date();
        const inicio = dtInicio
            ? new Date(`${dtInicio}T00:00:00`)
            : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        const fim = dtFim
            ? new Date(`${dtFim}T23:59:59.999`)
            : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        return { inicio, fim };
    }

    /** Monta o WHERE + params dos filtros da aba (reuso lista/lote). */
    private buildAuditoriaFiltro(f: { q?: string; emitente?: string; escopo?: string; status?: string; dtInicio?: string; dtFim?: string }): { where: string; params: any[] } {
        const { inicio, fim } = this.resolveJanelaEntrada(f.dtInicio, f.dtFim);
        const params: any[] = [];
        const cond: string[] = [`c.status_erp = 'LANCADA'`];
        params.push(inicio); cond.push(`c.dt_entrada >= $${params.length}`);
        params.push(fim); cond.push(`c.dt_entrada <= $${params.length}`);
        if (f.q && String(f.q).trim()) {
            params.push(`%${String(f.q).trim()}%`);
            const i = params.length;
            cond.push(`(c.chave_nfe ILIKE $${i} OR substring(c.chave_nfe from 26 for 9) ILIKE $${i})`);
        }
        if (f.emitente && String(f.emitente).trim()) {
            params.push(`%${String(f.emitente).trim()}%`);
            const i = params.length;
            cond.push(`(c.emitente ILIKE $${i} OR c.cnpj_emitente ILIKE $${i} OR substring(c.chave_nfe from 7 for 14) ILIKE $${i})`);
        }
        const esc = String(f.escopo || 'TODOS').toUpperCase();
        if (esc === 'DENTRO') cond.push(`left(c.chave_nfe, 2) = '51'`);
        else if (esc === 'FORA') cond.push(`left(c.chave_nfe, 2) <> '51'`);

        const st = String(f.status || 'TODOS').toUpperCase();
        if (st === 'PENDENTE') cond.push(`c.auditoria_fiscal_status IS NULL`);
        else if (st === 'OK' || st === 'DIVERGENTE' || st === 'SEM_CONFERENCIA') {
            params.push(st);
            cond.push(`c.auditoria_fiscal_status = $${params.length}`);
        }
        return { where: cond.join(' AND '), params };
    }

    /** Reexecuta a auditoria de TODAS as NFs do período filtrado (sem WhatsApp). */
    async reconferirPeriodo(f: { q?: string; emitente?: string; escopo?: string; status?: string; dtInicio?: string; dtFim?: string }) {
        const { where, params } = this.buildAuditoriaFiltro(f);
        const chaveRows = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT c.chave_nfe FROM com_nfe_conciliacao c WHERE ${where}
             ORDER BY c.dt_entrada DESC NULLS LAST LIMIT 2000`,
            ...params,
        );
        const chaves = chaveRows.map((r) => r.chave_nfe);

        // Até 2000 notas neste laço: buscar o lançamento de uma vez tira 2 idas
        // ao ERP por nota. As que não vierem no lote são confirmadas uma a uma.
        const lancamentos = await this.fetchLancamentosErpEmLote(chaves);

        for (const chave of chaves) {
            const { status, lancamento } = await this.reconciliarStatusEntrada(chave, lancamentos.get(chave));
            if (status === 'LANCADA') {
                await this.auditarLancamentoFiscal(chave, { enviarAlerta: false, produtoDireto: true, lancamento });
            }
        }
        const sumRows = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT auditoria_fiscal_status AS s, count(*)::int AS c
             FROM com_nfe_conciliacao c WHERE ${where} GROUP BY auditoria_fiscal_status`,
            ...params,
        );
        const by = (s: string) => Number(sumRows.find((r) => r.s === s)?.c ?? 0);
        return {
            total: chaves.length,
            ok: by('OK'),
            divergente: by('DIVERGENTE'),
        };
    }

    /**
     * Reauditoria periódica das NF LANCADA ainda NÃO alertadas, numa janela curta.
     *
     * Porquê: o alerta automático de WhatsApp só dispara no instante em que a NF
     * vira LANCADA (sync). Quando a divergência só aparece DEPOIS — caso típico de
     * uso/consumo, em que o fiscal ajusta o cadastro do produto (SUBTIPO/ST/CEST)
     * após a entrada, e o Stage_Produtos só reflete no próximo ETL — a nota vira
     * DIVERGENTE numa reconferência posterior, que não envia. Esta passada cobre
     * essa lacuna: reaudita com produtoDireto (cadastro ao vivo no ERP) e ENVIA.
     *
     * É idempotente: auditarLancamentoFiscal só dispara o alerta quando há erro E
     * auditoria_alerta_em ainda é nula — então uma nota que continua OK não gera
     * nada, e cada nota é alertada no máximo uma vez. Janela curta (dt_entrada nos
     * últimos N dias) para limitar o nº de consultas OPENQUERY ao ERP por ciclo.
     */
    async reauditarPendentesAlerta(diasJanela = 7, limite = 300): Promise<{ avaliadas: number }> {
        const dias = Number.isFinite(diasJanela) && diasJanela > 0 ? Math.floor(diasJanela) : 7;
        const agora = new Date();
        const cutoff = new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000);
        const pendentes = await this.prisma.nfeConciliacao.findMany({
            where: {
                status_erp: 'LANCADA',
                auditoria_alerta_em: null,
                // Janela curta por data de entrada; teto em "agora" descarta notas
                // com dt_entrada futura (dado inconsistente do ERP) que ficariam
                // sendo reauditadas para sempre.
                dt_entrada: { gte: cutoff, lte: agora },
            },
            select: { chave_nfe: true },
            orderBy: { dt_entrada: 'desc' },
            take: Math.max(1, Math.floor(limite)),
        });
        // A lista inteira já é conhecida aqui: busca os lançamentos de uma vez em
        // vez de deixar cada auditoria perguntar ao ERP pela sua nota.
        const lancamentos = await this.fetchLancamentosErpEmLote(pendentes.map((n) => n.chave_nfe));

        for (const n of pendentes) {
            // enviarAlerta default true; produtoDireto p/ ler o cadastro vigente do ERP.
            await this.auditarLancamentoFiscal(n.chave_nfe, {
                produtoDireto: true,
                lancamento: lancamentos.get(n.chave_nfe) ?? null,
            });
        }
        return { avaliadas: pendentes.length };
    }

    /** Lista NFs lançadas com o status da auditoria, para a aba Conferência Fiscal. */
    async listAuditorias(f: {
        q?: string; emitente?: string; escopo?: string; status?: string;
        dtInicio?: string; dtFim?: string; page?: string | number; pageSize?: string | number;
    }) {
        const { where, params } = this.buildAuditoriaFiltro(f);
        const page = Math.max(1, Number(f.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 20));
        const offset = (page - 1) * pageSize;

        const totalRows = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT count(*)::int AS total FROM com_nfe_conciliacao c WHERE ${where}`,
            ...params,
        );
        const total = totalRows[0]?.total ?? 0;

        // total_erros desconsidera itens ressalvados; tem_ressalva sinaliza intervenção.
        // Protegido caso a tabela com_nfe_ressalva ainda não exista.
        const buildRows = (comRessalva: boolean) => `
            SELECT c.chave_nfe, c.emitente, c.cnpj_emitente, c.data_emissao, c.dt_entrada,
                   c.valor_total, c.auditoria_fiscal_status, c.auditoria_fiscal_em,
                   substring(c.chave_nfe from 26 for 9) AS numero,
                   left(c.chave_nfe, 2) AS cuf,
                   (SELECT count(*)::int FROM com_nfe_auditoria_item a
                     WHERE a.chave_nfe = c.chave_nfe
                       ${comRessalva ? 'AND NOT EXISTS (SELECT 1 FROM com_nfe_ressalva rs WHERE rs.chave_nfe = a.chave_nfe AND rs.n_item = a.n_item)' : ''}
                   ) AS total_erros,
                   ${comRessalva ? 'EXISTS (SELECT 1 FROM com_nfe_ressalva r2 WHERE r2.chave_nfe = c.chave_nfe)' : 'false'} AS tem_ressalva
            FROM com_nfe_conciliacao c
            WHERE ${where}
            ORDER BY c.dt_entrada DESC NULLS LAST, c.data_emissao DESC
            LIMIT ${pageSize} OFFSET ${offset}`;
        let rows: any[];
        try {
            rows = await this.prisma.$queryRawUnsafe<any[]>(buildRows(true), ...params);
        } catch {
            rows = await this.prisma.$queryRawUnsafe<any[]>(buildRows(false), ...params);
        }

        return {
            page, pageSize, total,
            items: rows.map((r) => ({
                chaveNfe: r.chave_nfe,
                numero: String(Number(r.numero ?? '0')),
                emitente: r.emitente,
                cnpj: r.cnpj_emitente,
                uf: this.cufToSigla(r.cuf),
                dentroEstado: r.cuf === '51',
                dataEmissao: r.data_emissao,
                dtEntrada: r.dt_entrada,
                valorTotal: Number(r.valor_total || 0),
                status: r.auditoria_fiscal_status ?? 'PENDENTE',
                auditadoEm: r.auditoria_fiscal_em,
                totalErros: r.total_erros ?? 0,
                temRessalva: !!r.tem_ressalva,
            })),
        };
    }

    /** Exporta os XMLs das NFs LANÇADAS do período filtrado em um .zip.
     *  Reusa o filtro da aba (já restrito a status_erp = 'LANCADA') e exige período. */
    async exportarXmlAuditoria(f: {
        q?: string; emitente?: string; escopo?: string; status?: string; dtInicio?: string; dtFim?: string;
    }): Promise<{ buffer: Buffer; count: number }> {
        if (!f.dtInicio || !f.dtFim) {
            throw new BadRequestException('Selecione um período (data inicial e final) antes de exportar os XMLs.');
        }
        const { where, params } = this.buildAuditoriaFiltro(f);
        const rows = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT c.chave_nfe, c.xml_completo, substring(c.chave_nfe from 26 for 9) AS numero
             FROM com_nfe_conciliacao c WHERE ${where}
             ORDER BY c.dt_entrada DESC NULLS LAST LIMIT 10000`,
            ...params,
        );

        const items: { nome: string; chave: string; xml: string }[] = [];
        for (const r of rows) {
            const xml = await this.normalizeBlobXml(r.xml_completo);
            if (xml) items.push({ nome: String(Number(r.numero ?? '0')), chave: r.chave_nfe, xml });
        }

        const buffer = await this.zipXmls(items);
        return { buffer, count: items.length };
    }

    /** Compacta uma lista de XMLs em um único .zip (nomes únicos por nota). */
    private zipXmls(items: { nome: string; chave: string; xml: string }[]): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const archive = archiver('zip', { zlib: { level: 9 } });
            const chunks: Buffer[] = [];
            const stream = new Writable({
                write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
            });
            archive.pipe(stream);
            stream.on('finish', () => resolve(Buffer.concat(chunks)));
            archive.on('error', reject);

            const usados = new Set<string>();
            for (const it of items) {
                if (!it.xml) continue;
                const base = String(it.nome || it.chave).replace(/[^\w.-]/g, '_');
                let nome = `${base}.xml`;
                if (usados.has(nome)) nome = `${base}_${it.chave}.xml`;
                usados.add(nome);
                archive.append(it.xml, { name: nome });
            }
            archive.finalize();
        });
    }

    /** Detalhe de uma NF: cabeçalho + itens (código/descrição), com cada
     *  conferência marcada como ok/divergente. Calculado ao vivo. */
    async getAuditoriaDetalhe(chaveNfe: string, direto = false) {
        const rows = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT chave_nfe, emitente, cnpj_emitente, data_emissao, dt_entrada, valor_total,
                    auditoria_fiscal_status, auditoria_fiscal_em, status_erp,
                    substring(chave_nfe from 26 for 9) AS numero, left(chave_nfe, 2) AS cuf
             FROM com_nfe_conciliacao WHERE chave_nfe = $1`,
            chaveNfe,
        );
        const b = rows[0];
        if (!b) return null;

        const r = await this.computarAuditoria(chaveNfe, { produtoDireto: direto });

        const baseHeader = {
            chaveNfe: b.chave_nfe,
            numero: String(Number(b.numero ?? '0')),
            serie: r?.nota?.serie ?? null,
            emitente: b.emitente ?? r?.nota?.emitente ?? null,
            cnpj: b.cnpj_emitente,
            uf: this.cufToSigla(b.cuf),
            dentroEstado: b.cuf === '51',
            dataEmissao: b.data_emissao,
            dtEntrada: b.dt_entrada,
            valorTotal: Number(b.valor_total || 0),
            statusErp: b.status_erp ?? null,
            auditadoEm: b.auditoria_fiscal_em,
        };

        if (!r) {
            // Sem XML completo, ou não localizada na NF_ENTRADA (pode ter virado
            // PENDENTE/EXCLUIDA na reconferência).
            const lancada = b.status_erp === 'LANCADA';
            return {
                header: {
                    ...baseHeader,
                    status: b.auditoria_fiscal_status ?? 'PENDENTE',
                    totalErros: 0,
                    semConferencia: false,
                    naoAuditavel: true,
                    mensagem: lancada
                        ? 'NF lançada sem XML completo — não há detalhe a conferir.'
                        : `NF não está mais lançada no ERP (status ${b.status_erp ?? '—'}) — removida da auditoria.`,
                },
                cabecalho: [],
                itens: [],
            };
        }

        const contaErros = (cks: any[]) => cks.filter((c) => !c.ok).length;
        const ressalvas = await this.getRessalvasMap(chaveNfe);
        // Erros efetivos: itens/cabeçalho ressalvados não contam.
        const errosCab = ressalvas.has(0) ? 0 : contaErros(r.cabecalho);
        const totalErros =
            errosCab + r.itens.reduce((s, it) => s + (ressalvas.has(it.nItem) ? 0 : contaErros(it.checks)), 0);
        const status = totalErros > 0 ? 'DIVERGENTE' : 'OK';

        return {
            header: {
                ...baseHeader,
                status,
                totalErros,
                semConferencia: r.semConferencia,
                naoAuditavel: false,
                temRessalva: ressalvas.size > 0,
            },
            cabecalho: r.cabecalho.map((c: any) => ({ ...c, ressalvado: ressalvas.has(0) })),
            itens: r.itens.map((it) => ({
                nItem: it.nItem,
                proCodigo: it.proCodigo,
                descricao: it.descricao,
                imposto: it.imposto,
                destinacao: it.destinacao,
                totalErros: contaErros(it.checks),
                ressalvado: ressalvas.has(it.nItem),
                ressalvaMotivo: ressalvas.get(it.nItem) ?? null,
                checks: it.checks,
            })),
        };
    }

    /** Reexecuta a auditoria manualmente (sem disparar o WhatsApp) e devolve o detalhe. */
    async reconferirAuditoria(chaveNfe: string) {
        // 1. Reconcilia o status com o ERP (pode virar PENDENTE/EXCLUIDA).
        const { status, lancamento } = await this.reconciliarStatusEntrada(chaveNfe);
        // 2. Só audita se ainda estiver lançada; cadastro direto do ERP (sem ETL).
        if (status === 'LANCADA') {
            await this.auditarLancamentoFiscal(chaveNfe, { enviarAlerta: false, produtoDireto: true, lancamento });
        }
        return this.getAuditoriaDetalhe(chaveNfe, true);
    }

    /** Marca um item (ou cabeçalho, n_item=0) como OK por intervenção (ressalva). */
    async adicionarRessalva(chaveNfe: string, nItem: number, motivo?: string, usuario?: string) {
        await this.prisma.$executeRawUnsafe(
            `INSERT INTO com_nfe_ressalva (chave_nfe, n_item, motivo, criado_por)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (chave_nfe, n_item) DO UPDATE
               SET motivo = EXCLUDED.motivo, criado_por = EXCLUDED.criado_por, created_at = now()`,
            chaveNfe, Number(nItem) || 0, motivo ?? null, usuario ?? null,
        );
        await this.auditarLancamentoFiscal(chaveNfe, { enviarAlerta: false });
        return this.getAuditoriaDetalhe(chaveNfe);
    }

    /** Remove a ressalva de um item (volta a contar como divergência). */
    async removerRessalva(chaveNfe: string, nItem: number) {
        await this.prisma.$executeRawUnsafe(
            `DELETE FROM com_nfe_ressalva WHERE chave_nfe = $1 AND n_item = $2`,
            chaveNfe, Number(nItem) || 0,
        );
        await this.auditarLancamentoFiscal(chaveNfe, { enviarAlerta: false });
        return this.getAuditoriaDetalhe(chaveNfe);
    }

    async savePaymentStatus(dto: {
        chaveNfe: string,
        valor?: number,
        observacoes?: string,
        tipo_imposto?: string,
        usuario?: string,
        itens?: FiscalConferenceItemDto[],
    }) {
        let fiscalConference: any = null;
        if (Array.isArray(dto.itens) && dto.itens.length > 0) {
            fiscalConference = await this.runFiscalConference({
                notas: [{ chaveNfe: dto.chaveNfe, itens: dto.itens }],
            }, true);

            const selectedItems = Array.from(
                new Set(
                    dto.itens
                        .map((item) => Number(item?.item))
                        .filter((item) => Number.isFinite(item) && item > 0),
                ),
            );

            if (selectedItems.length > 0) {
                await this.prisma.$executeRawUnsafe(
                    `
                    DELETE FROM com_nfe_conciliacao_item
                    WHERE chave_nfe = $1
                      AND NOT (n_item = ANY($2::int[]))
                    `,
                    dto.chaveNfe,
                    selectedItems,
                );
            }
        }

        const result = await this.prisma.pagamentoGuia.upsert({
            where: { chave_nfe: dto.chaveNfe },
            create: {
                chave_nfe: dto.chaveNfe,
                valor: dto.valor || 0.0,
                observacoes: dto.observacoes || "",
                data_pagamento: new Date()
            },
            update: {
                valor: dto.valor || 0.0,
                observacoes: dto.observacoes || "",
                data_pagamento: new Date()
            }
        });

        if (dto.tipo_imposto !== undefined) {
            await this.prisma.nfeConciliacao.update({
                where: { chave_nfe: dto.chaveNfe },
                data: { tipo_imposto: dto.tipo_imposto }
            }).catch(e => this.logger.error("Error updating tipo_imposto in NfeConciliacao", e));
        }

        await fetch('http://log-service.acacessorios.local/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
            usuario: dto.usuario,
            setor: 'Compras',
            tela: 'ICMS ST',
            acao: 'Create',
            descricao: `Guia de pagamento salva para NFe ${dto.chaveNfe} com valor ${dto.valor} e observações: ${dto.observacoes}`,
            }),
        });

        return {
            ...result,
            fiscalConference,
        };
    }

    async getPaymentStatusMap() {
        const agruparTipoImposto = await this.prisma.nfeConciliacao.findMany({ select: { chave_nfe: true, tipo_imposto: true } });
        const all = await this.prisma.pagamentoGuia.findMany();
        const guias = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT chave_nfe, bucket_name, object_path, uploaded_at FROM com_nfe_guia_pdf`
        );
        const conferenciaItens = await this.prisma.$queryRawUnsafe<any[]>(
            `
            SELECT
                chave_nfe,
                n_item,
                status_conferencia,
                divergencias_json
            FROM com_nfe_conciliacao_item
            `,
        );

        const mapTipoImposto: Record<string, string> = {};
        for (const nfe of agruparTipoImposto) {
            if (nfe.tipo_imposto) mapTipoImposto[nfe.chave_nfe] = nfe.tipo_imposto;
        }

        const map: Record<string, {
            status: string,
            valor: number,
            tipo_imposto?: string,
            guiaGerada?: boolean,
            guiaPath?: string,
            status_conferencia_produtos?: 'OK' | 'ERRO' | 'SEM_RELACIONAMENTO' | 'PENDENTE',
            fluxo?: string,
        }> = {};
        for (const item of all) {
            map[item.chave_nfe] = {
                status: item.observacoes,
                valor: item.valor,
                tipo_imposto: mapTipoImposto[item.chave_nfe]
            };
        }

        for (const guia of guias) {
            const chave = String(guia.chave_nfe || '').trim();
            if (!chave) continue;

            map[chave] = {
                status: map[chave]?.status || '',
                valor: map[chave]?.valor || 0,
                tipo_imposto: map[chave]?.tipo_imposto || mapTipoImposto[chave],
                guiaGerada: true,
                guiaPath: `${guia.bucket_name}/${guia.object_path}`,
            };
        }

        const conferenciaByChave: Record<string, Array<{ status_conferencia?: string | null; divergencias_json?: unknown }>> = {};
        for (const item of conferenciaItens) {
            const chave = String(item?.chave_nfe || '').trim();
            if (!chave) continue;
            if (!conferenciaByChave[chave]) conferenciaByChave[chave] = [];
            conferenciaByChave[chave].push({
                status_conferencia: item?.status_conferencia,
                divergencias_json: item?.divergencias_json,
            });
        }

        for (const [chave, rows] of Object.entries(conferenciaByChave)) {
            const statusConferencia = this.getConferenceStatusFromRows(rows) as 'OK' | 'ERRO' | 'SEM_RELACIONAMENTO' | 'PENDENTE';
            map[chave] = {
                status: map[chave]?.status || '',
                valor: map[chave]?.valor || 0,
                tipo_imposto: map[chave]?.tipo_imposto || mapTipoImposto[chave],
                guiaGerada: map[chave]?.guiaGerada,
                guiaPath: map[chave]?.guiaPath,
                status_conferencia_produtos: statusConferencia,
            };
        }

        // Estado do fluxo automático (docs/automacao-icms-st.md); tabela pode não existir ainda.
        const fluxos = await this.prisma.$queryRawUnsafe<any[]>(`SELECT chave_nfe, estado FROM com_nfe_st_fluxo`).catch(() => []);
        for (const f of fluxos) {
            const chave = String(f.chave_nfe || '');
            if (!chave) continue;
            map[chave] = { ...(map[chave] ?? { status: '', valor: 0 }), fluxo: String(f.estado) };
        }

        return map;
    }

    async getPaymentStatusByKey(chaveNfe: string) {
        const key = String(chaveNfe || '').trim();
        if (!key) return null;

        const nfe = await this.prisma.nfeConciliacao.findUnique({
            where: { chave_nfe: key },
            select: { tipo_imposto: true }
        });

        const pagamento = await this.prisma.pagamentoGuia.findUnique({
            where: { chave_nfe: key }
        });

        const guia = await this.prisma.$queryRawUnsafe<any[]>(
            `
            SELECT
                chave_nfe,
                bucket_name,
                object_path,
                original_file_name,
                numero_documento,
                data_vencimento,
                valor,
                fe_cte,
                numero_nf_extraido,
                fe_cte_confere,
                aviso,
                uploaded_at
            FROM com_nfe_guia_pdf
            WHERE chave_nfe = $1
            `,
            key,
        );

        if (!pagamento && !nfe?.tipo_imposto && guia.length === 0) {
            return null;
        }

        const guiaData = guia[0] || null;

        const itensConciliacao = await this.prisma.$queryRawUnsafe<any[]>(
            `
            SELECT
                n_item,
                cod_prod_fornecedor,
                pro_codigo,
                destinacao_mercadoria,
                imposto_escolhido,
                possui_icms_st,
                possui_difal,
                ncm_xml,
                cst_nota,
                divergencias_json,
                status_conferencia,
                updated_at
            FROM com_nfe_conciliacao_item
            WHERE chave_nfe = $1
            ORDER BY n_item ASC
            `,
            key,
        );

        return {
            chaveNfe: key,
            status: pagamento?.observacoes ?? null,
            valor: pagamento?.valor ?? null,
            tipo_imposto: nfe?.tipo_imposto ?? null,
            data_pagamento: pagamento?.data_pagamento ?? null,
            status_conferencia_produtos: this.getConferenceStatusFromRows(itensConciliacao) as 'OK' | 'ERRO' | 'SEM_RELACIONAMENTO' | 'PENDENTE',
            itens_conciliacao: itensConciliacao.map((item) => ({
                n_item: item.n_item,
                cod_prod_fornecedor: item.cod_prod_fornecedor,
                pro_codigo: item.pro_codigo,
                destinacao_mercadoria: item.destinacao_mercadoria,
                imposto_escolhido: item.imposto_escolhido,
                possui_icms_st: item.possui_icms_st,
                possui_difal: item.possui_difal,
                ncm_xml: item.ncm_xml,
                cst_nota: item.cst_nota,
                divergencias_json: this.parseDivergenciasJson(item.divergencias_json),
                status_conferencia: item.status_conferencia,
                updated_at: item.updated_at,
            })),
            guia_gerada: Boolean(guiaData),
            guia: guiaData
                ? {
                    bucket: guiaData.bucket_name,
                    path: guiaData.object_path,
                    original_file_name: guiaData.original_file_name,
                    numero_documento: guiaData.numero_documento,
                    data_vencimento: guiaData.data_vencimento,
                    valor: guiaData.valor,
                    fe_cte: guiaData.fe_cte,
                    numero_nf_extraido: guiaData.numero_nf_extraido,
                    fe_cte_confere: guiaData.fe_cte_confere,
                    aviso: guiaData.aviso,
                    uploaded_at: guiaData.uploaded_at,
                }
                : null,
        };
    }

    async uploadGuiaByNfe(chaveNfe: string, file: { buffer: Buffer; originalname: string; mimetype: string }) {
        const key = String(chaveNfe || '').trim();
        if (!key) {
            throw new Error('Chave NF-e inválida.');
        }

        const normalizedOriginalName = this.normalizeUploadedFileName(file.originalname);

        const nfe = await this.prisma.nfeConciliacao.findUnique({
            where: { chave_nfe: key },
            select: { chave_nfe: true },
        });

        if (!nfe) {
            throw new Error(`NF não encontrada para vínculo da guia: ${key}`);
        }

        const pdfParseModule: any = await import('pdf-parse');
        const PDFParseClass = pdfParseModule?.PDFParse;
        if (typeof PDFParseClass !== 'function') {
            throw new Error('Biblioteca de leitura de PDF incompatível: classe PDFParse não encontrada.');
        }

        const parser = new PDFParseClass({ data: file.buffer });
        let parsedText = '';
        try {
            const parsed = await parser.getText();
            parsedText = String(parsed?.text || '');
        } finally {
            await parser.destroy().catch(() => undefined);
        }

        const extracted = this.extractGuiaDataFromPdfText(parsedText, key);

        if (extracted.numeroNfExtraido && extracted.feCteConfere === false) {
            throw new BadRequestException(
                `A guia não corresponde à NF selecionada. NFE/CTE da guia: ${extracted.numeroNfExtraido}. Número da NF: ${String(key).substring(25, 34).replace(/^0+/, '')}.`,
            );
        }

        const upload = await this.uploadGuiaPdfToMinio(key, { ...file, originalname: normalizedOriginalName });

        await this.prisma.$executeRawUnsafe(
            `
            INSERT INTO com_nfe_guia_pdf (
                chave_nfe,
                bucket_name,
                object_path,
                original_file_name,
                numero_documento,
                data_vencimento,
                valor,
                fe_cte,
                numero_nf_extraido,
                fe_cte_confere,
                aviso,
                updated_at,
                uploaded_at
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW()
            )
            ON CONFLICT (chave_nfe)
            DO UPDATE SET
                bucket_name = EXCLUDED.bucket_name,
                object_path = EXCLUDED.object_path,
                original_file_name = EXCLUDED.original_file_name,
                numero_documento = EXCLUDED.numero_documento,
                data_vencimento = EXCLUDED.data_vencimento,
                valor = EXCLUDED.valor,
                fe_cte = EXCLUDED.fe_cte,
                numero_nf_extraido = EXCLUDED.numero_nf_extraido,
                fe_cte_confere = EXCLUDED.fe_cte_confere,
                aviso = EXCLUDED.aviso,
                updated_at = NOW(),
                uploaded_at = NOW()
            `,
            key,
            upload.bucket,
            upload.objectPath,
            normalizedOriginalName,
            extracted.numeroDocumento,
            extracted.dataVencimento,
            extracted.valor,
            extracted.feCte,
            extracted.numeroNfExtraido,
            extracted.feCteConfere,
            extracted.aviso,
        );

        return {
            chaveNfe: key,
            guia_gerada: true,
            bucket: upload.bucket,
            path: upload.objectPath,
            original_file_name: normalizedOriginalName,
            numero_documento: extracted.numeroDocumento,
            data_vencimento: extracted.dataVencimento,
            valor: extracted.valor,
            fe_cte: extracted.feCte,
            numero_nf_extraido: extracted.numeroNfExtraido,
            fe_cte_confere: extracted.feCteConfere,
            aviso: extracted.aviso,
        };
    }

    async getGuiaByNfe(chaveNfe: string) {
        const key = String(chaveNfe || '').trim();
        if (!key) return null;

        const rows = await this.prisma.$queryRawUnsafe<any[]>(
            `
            SELECT
                chave_nfe,
                bucket_name,
                object_path,
                original_file_name,
                numero_documento,
                data_vencimento,
                valor,
                fe_cte,
                numero_nf_extraido,
                fe_cte_confere,
                aviso,
                uploaded_at,
                updated_at
            FROM com_nfe_guia_pdf
            WHERE chave_nfe = $1
            `,
            key,
        );

        const guia = rows[0];
        if (!guia) return null;

        return {
            chaveNfe: guia.chave_nfe,
            guia_gerada: true,
            bucket: guia.bucket_name,
            path: guia.object_path,
            original_file_name: this.normalizeUploadedFileName(guia.original_file_name),
            numero_documento: guia.numero_documento,
            data_vencimento: guia.data_vencimento,
            valor: guia.valor,
            fe_cte: guia.fe_cte,
            numero_nf_extraido: guia.numero_nf_extraido,
            fe_cte_confere: guia.fe_cte_confere,
            aviso: guia.aviso,
            uploaded_at: guia.uploaded_at,
            updated_at: guia.updated_at,
        };
    }

    async downloadGuiaByNfe(chaveNfe: string) {
        const guia = await this.getGuiaByNfe(chaveNfe);
        if (!guia?.path) return null;

        const client = this.getMinioClient();
        const stream = await client.getObject(guia.bucket || this.minioBucket, guia.path);
        const fileName = this.normalizeUploadedFileName(guia.original_file_name || `guia-${String(chaveNfe || '').trim()}.pdf`);

        return { stream, fileName };
    }

    async removeGuiaByNfe(chaveNfe: string) {
        const key = String(chaveNfe || '').trim();
        if (!key) return false;

        const guia = await this.getGuiaByNfe(key);
        if (!guia) return false;

        try {
            if (guia.path) {
                const client = this.getMinioClient();
                await client.removeObject(guia.bucket || this.minioBucket, guia.path);
            }
        } catch (error) {
            this.logger.warn(`Falha ao remover objeto da guia no MinIO para NF ${key}: ${error instanceof Error ? error.message : String(error)}`);
        }

        await this.prisma.$executeRawUnsafe(
            `DELETE FROM com_nfe_guia_pdf WHERE chave_nfe = $1`,
            key,
        );

        return true;
    }

    // ---------------------------------------------------------------------------
    // Guias escaneadas no app de Movimento Fiscal (escaner-fiscal-app)
    // ---------------------------------------------------------------------------
    // O app de scan grava o PDF no MinIO e o registro em `esc_documento`, amarrando
    // a guia à nota pelo número + fornecedor (ou pela chave, quando a nota foi
    // escolhida na busca). Aqui a NF já vem identificada pela CHAVE, e dela saem os
    // dois dados do vínculo: número (posições 26-34) e CNPJ do emitente (7-20).
    // São guias do arquivo fiscal — esta tela só as EXIBE, nunca apaga.

    private static readonly TIPO_GUIA_ESCANEADA = 'guia-icms-st';

    private dadosDaChaveNfe(chaveNfe: string) {
        const chave = String(chaveNfe || '').replace(/\D/g, '');
        if (chave.length !== 44) return null;
        return {
            chave,
            numero: chave.slice(25, 34).replace(/^0+/, ''),
            cnpjEmitente: chave.slice(6, 20),
        };
    }

    /**
     * A tabela do app de scan pode ainda não existir neste banco (DDL é manual na
     * org). Falta dela não pode derrubar a tela da NF — vira lista vazia.
     */
    private semTabelaDoScan(error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        const ausente = /esc_documento/i.test(msg) && /(does not exist|não existe|nao existe|42P01)/i.test(msg);
        if (ausente) {
            this.logger.warn(`esc_documento indisponível — guias escaneadas não listadas (${msg}).`);
        }
        return ausente;
    }

    async getGuiasEscaneadasByNfe(chaveNfe: string) {
        const dados = this.dadosDaChaveNfe(chaveNfe);
        if (!dados) return [];

        let rows: any[] = [];
        try {
            rows = await this.prisma.$queryRawUnsafe<any[]>(
                `
                SELECT
                    id,
                    -- DATE vira Date de meia-noite LOCAL; converter no banco evita que o
                    -- fuso do processo empurre a data um dia para trás.
                    to_char(data_documento, 'YYYY-MM-DD') AS data_documento,
                    descricao, minio_bucket, minio_key, nome_arquivo,
                    tamanho_bytes, nf_numero, chave_nfe, fornecedor_nome, fornecedor_cnpj,
                    for_codigo, criado_em,
                    CASE WHEN chave_nfe = $1 THEN 'chave' ELSE 'numero_cnpj' END AS vinculo
                FROM esc_documento
                WHERE tipo = $4
                  AND (chave_nfe = $1 OR (nf_numero = $2 AND fornecedor_cnpj = $3))
                ORDER BY criado_em DESC
                `,
                dados.chave,
                dados.numero,
                dados.cnpjEmitente,
                IcmsService.TIPO_GUIA_ESCANEADA,
            );
        } catch (error) {
            if (this.semTabelaDoScan(error)) return [];
            throw error;
        }

        return rows.map((r) => ({
            // id é BIGSERIAL: sem o Number() vira BigInt e o JSON.stringify quebra.
            id: Number(r.id),
            data_documento: String(r.data_documento ?? ''),
            descricao: r.descricao ?? null,
            nome_arquivo: r.nome_arquivo ?? null,
            tamanho_bytes: r.tamanho_bytes == null ? null : Number(r.tamanho_bytes),
            nf_numero: r.nf_numero ?? null,
            chave_nfe: r.chave_nfe ?? null,
            fornecedor_nome: r.fornecedor_nome ?? null,
            fornecedor_cnpj: r.fornecedor_cnpj ?? null,
            for_codigo: r.for_codigo == null ? null : Number(r.for_codigo),
            criado_em: r.criado_em instanceof Date ? r.criado_em.toISOString() : String(r.criado_em ?? ''),
            vinculo: r.vinculo as 'chave' | 'numero_cnpj',
        }));
    }

    async downloadGuiaEscaneada(id: number) {
        const idNum = Number(id);
        if (!Number.isInteger(idNum) || idNum <= 0) return null;

        let rows: any[] = [];
        try {
            rows = await this.prisma.$queryRawUnsafe<any[]>(
                `
                SELECT minio_bucket, minio_key, nome_arquivo
                FROM esc_documento
                WHERE id = $1 AND tipo = $2
                `,
                idNum,
                IcmsService.TIPO_GUIA_ESCANEADA,
            );
        } catch (error) {
            if (this.semTabelaDoScan(error)) return null;
            throw error;
        }

        const doc = rows[0];
        if (!doc?.minio_key) return null;

        // O bucket vem do próprio registro (o app de scan usa `movimento-fiscal`,
        // não o bucket das guias anexadas aqui).
        const client = this.getMinioClient();
        const stream = await client.getObject(doc.minio_bucket || this.minioBucket, doc.minio_key);
        const fileName = this.normalizeUploadedFileName(doc.nome_arquivo || `guia-escaneada-${idNum}.pdf`);

        return { stream, fileName };
    }

    async generateDanfe(xml: string): Promise<Buffer> {
        return new Promise(async (resolve, reject) => {
            try {
                // Decode XML if it's zipped/base64
                const decodedXml = await this.decodeXml(xml);

                // A distribuição da SEFAZ entrega primeiro um RESUMO (`resNFe`:
                // chave, emitente e valor) e só depois, com a manifestação, o XML
                // completo. Do resumo não sai DANFE — não há itens nem impostos.
                // Sem esta checagem o gerador estoura com "Cannot read properties
                // of undefined (reading 'NFe')", que não diz nada a quem lê.
                //
                // O teste exige `infNFe` COM `Id="NFe…"`: a tag `infNFe` sozinha
                // também aparece dentro de um CT-e (nos documentos transportados),
                // e um cteProc passaria por NF-e.
                if (!/<([A-Za-z0-9_.-]+:)?infNFe\s[^>]*Id\s*=\s*"NFe/i.test(decodedXml)) {
                    const eCte = /<([A-Za-z0-9_.-]+:)?infCte[\s>]/i.test(decodedXml);
                    throw new Error(
                        eCte
                            ? 'Este XML é um CT-e, não uma NF-e — o documento auxiliar dele é o DACTE.'
                            : 'Temos apenas o resumo desta NF-e (resNFe), não o XML completo. ' +
                            'Manifeste a nota na SEFAZ para baixar o documento e gerar o DANFE.',
                    );
                }

                const doc = await gerarPDF(decodedXml, { cancelada: false });
                const chunks: Buffer[] = [];
                const stream = new Writable({
                    write(chunk, encoding, callback) {
                        chunks.push(Buffer.from(chunk));
                        callback();
                    },
                });

                doc.pipe(stream);

                stream.on('finish', () => {
                    resolve(Buffer.concat(chunks));
                });

                // doc.end(); // Library handles this?
            } catch (error) {
                this.logger.error('Error generating DANFE', error);
                reject(error);
            }
        });
    }

    async generateDanfeZip(invoices: { xml: string, chave: string }[]): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });

            const chunks: Buffer[] = [];
            const stream = new Writable({
                write(chunk, encoding, callback) {
                    chunks.push(Buffer.from(chunk));
                    callback();
                },
            });

            archive.pipe(stream);

            stream.on('finish', () => {
                resolve(Buffer.concat(chunks));
            });

            archive.on('error', (err) => {
                reject(err);
            });

            (async () => {
                for (const inv of invoices) {
                    try {
                        // usage of generateDanfe already covers decoding now
                        const pdfBuffer = await this.generateDanfe(inv.xml);
                        archive.append(pdfBuffer, { name: `DANFE_${inv.chave}.pdf` });
                    } catch (e) {
                        console.error(`Failed to generate PDF for ${inv.chave}`, e);
                    }
                }
                archive.finalize();
            })();
        });
    }
}
