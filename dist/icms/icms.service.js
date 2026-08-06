"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var IcmsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.IcmsService = void 0;
const common_1 = require("@nestjs/common");
const openquery_service_1 = require("../shared/database/openquery/openquery.service");
const erp_api_service_1 = require("../shared/erp-api/erp-api.service");
const prisma_service_1 = require("../prisma/prisma.service");
const simples_nacional_service_1 = require("./simples-nacional.service");
const xml2js = __importStar(require("xml2js"));
const zlib = __importStar(require("zlib"));
const crypto_1 = require("crypto");
const mva_data_1 = require("./constants/mva-data");
const monofasico_ncm_1 = require("./constants/monofasico-ncm");
const cfop_tributados_1 = require("./constants/cfop-tributados");
const node_pdf_nfe_1 = require("@alexssmusica/node-pdf-nfe");
const archiver_1 = __importDefault(require("archiver"));
const stream_1 = require("stream");
const Minio = __importStar(require("minio"));
let IcmsService = IcmsService_1 = class IcmsService {
    constructor(openQuery, erpApi, prisma, simplesNacional) {
        this.openQuery = openQuery;
        this.erpApi = erpApi;
        this.prisma = prisma;
        this.simplesNacional = simplesNacional;
        this.logger = new common_1.Logger(IcmsService_1.name);
        this.minioBucket = process.env.MINIO_BUCKET || 'documentos';
        this.minioRegion = process.env.MINIO_REGION || 'us-east-1';
        this.minioClient = null;
        this.refData = [];
        this.monofasicoNcmSet = new Set(monofasico_ncm_1.MONOFASICO_NCM_LIST.map((ncm) => this.cleanDigits(ncm)));
        this.launchedSyncJobs = new Map();
        this.xmlNormalizationJobs = new Map();
        this.fiscalRulesCache = null;
        this.fiscalRulesCacheAt = 0;
        this.parseReferenceData();
    }
    parseReferenceData() {
        const lines = mva_data_1.CSV_DATA_CLEAN.split('\n').filter(l => l.trim() !== '');
        const headers = lines[0].split(';');
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(';');
            if (parts.length < 4)
                continue;
            const row = {};
            row['Item'] = parseFloat(parts[0]);
            row['CEST'] = parts[1];
            row['NCM_SH'] = parts[2];
            row['MVA'] = parseFloat(parts[3]);
            row['Descricao'] = parts[4];
            row['NCM_CLEAN'] = row['NCM_SH'].replace(/\./g, '').trim();
            this.refData.push(row);
        }
        this.logger.log(`Loaded ${this.refData.length} reference MVA items.`);
    }
    async syncInvoices(start, end) {
        try {
            const { startDate, endDate } = this.getDateRangeOrDefault(start, end);
            const erpInvoices = await this.fetchErpInvoices(start, end);
            this.logger.log(`Fetched ${erpInvoices.length} invoices from ERP`, 'Sync');
            const erpKeys = new Set();
            const upsertTasks = [];
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
                        update: Object.assign(Object.assign({ status_erp: 'PENDENTE' }, (normalizedXmlCompleto ? { xml_completo: this.encodeXml(normalizedXmlCompleto) } : {})), { updated_at: new Date() })
                    });
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
                    const entradaDates = await this.fetchNfEntradaDatesByKeys(missingKeys);
                    const lancadas = missingKeys
                        .filter((chave) => entradaDates.has(chave))
                        .map((chave) => { var _a; return ({ chave, dt_entrada: (_a = entradaDates.get(chave)) !== null && _a !== void 0 ? _a : null }); });
                    const excluidas = missingKeys.filter((chave) => !entradaDates.has(chave));
                    const updateBatchSize = 20;
                    for (let i = 0; i < lancadas.length; i += updateBatchSize) {
                        const chunk = lancadas.slice(i, i + updateBatchSize);
                        await Promise.all(chunk.map((l) => this.prisma.nfeConciliacao.update({
                            where: { chave_nfe: l.chave },
                            data: {
                                status_erp: 'LANCADA',
                                dt_entrada: l.dt_entrada,
                                updated_at: new Date(),
                            },
                        })));
                    }
                    for (const l of lancadas) {
                        await this.auditarLancamentoFiscal(l.chave);
                    }
                    if (excluidas.length > 0) {
                        await this.prisma.nfeConciliacao.updateMany({
                            where: { chave_nfe: { in: excluidas } },
                            data: { status_erp: 'EXCLUIDA' },
                        });
                    }
                    if (lancadas.length > 0) {
                        const base = process.env.COMPRAS_SERVICE_URL;
                        if (!base) {
                            this.logger.warn('COMPRAS_SERVICE_URL não configurada: pulando notificação de NF lançada ao compras-service.', 'Sync');
                        }
                        else {
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
                            }
                            catch (e) {
                                this.logger.error('Falha ao notificar compras-service de NF lançada', e instanceof Error ? e.stack : String(e), 'Sync');
                            }
                        }
                    }
                }
            }
            const allLocal = await this.prisma.nfeConciliacao.findMany({
                where: {
                    data_emissao: {
                        gte: startDate,
                        lte: endDate,
                    }
                },
                orderBy: { data_emissao: 'desc' },
                take: 1200
            });
            const emMovimentoPorChave = await this.fetchEmMovimentoPorNfe(allLocal.map((l) => l.chave_nfe));
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
                    RASTREIO_SITUACAO: local.status_erp === 'LANCADA'
                        ? 'ENTREGUE'
                        : emMovimentoPorChave.get(local.chave_nfe)
                            ? 'EM_TRANSITO'
                            : null,
                };
            }));
        }
        catch (error) {
            this.logger.error('Error in syncInvoices', error, 'Sync');
            throw error;
        }
    }
    async fetchEmMovimentoPorNfe(chavesNfe) {
        const result = new Map();
        const chaves = [...new Set((chavesNfe || []).map((c) => String(c || '').replace(/\D/g, '')).filter((c) => c.length === 44))];
        if (!chaves.length)
            return result;
        const inList = chaves.map((c) => `'${c}'`).join(',');
        try {
            const rows = await this.prisma.$queryRawUnsafe(`SELECT j.chave AS chave_nfe,
                        bool_or(c.rastreio_cobertura = 'COBERTO' AND c.rastreio_status IS NOT NULL) AS em_movimento
                 FROM com_cte_documento c,
                      jsonb_array_elements_text(c.dados_json -> 'documentosNFe') AS j(chave)
                 WHERE j.chave IN (${inList})
                 GROUP BY j.chave`);
            for (const r of rows)
                result.set(r.chave_nfe, !!r.em_movimento);
        }
        catch (e) {
            this.logger.error('Erro ao resolver situação de transporte das NFs', e instanceof Error ? e.stack : String(e), 'Rastreio');
        }
        return result;
    }
    getDateRangeOrDefault(start, end) {
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
    async getInvoiceByKey(chaveNfe) {
        const key = String(chaveNfe || '').trim();
        if (!key)
            return null;
        const local = await this.prisma.nfeConciliacao.findUnique({
            where: { chave_nfe: key }
        });
        if (!local)
            return null;
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
    async importXmlInvoices(xmls) {
        var _a, _b;
        const parser = new xml2js.Parser({ explicitArray: false });
        const out = [];
        for (const raw of Array.isArray(xmls) ? xmls : []) {
            const xmlStr = await this.decodeXml(raw);
            if (!xmlStr)
                continue;
            let parsed;
            try {
                parsed = await parser.parseStringPromise(xmlStr);
            }
            catch (e) {
                this.logger.warn(`XML importado inválido, ignorado: ${e instanceof Error ? e.message : String(e)}`, 'Import');
                continue;
            }
            const nfe = parsed.nfeProc ? parsed.nfeProc.NFe : parsed.NFe;
            if (!((_b = (_a = nfe === null || nfe === void 0 ? void 0 : nfe.infNFe) === null || _a === void 0 ? void 0 : _a['$']) === null || _b === void 0 ? void 0 : _b.Id))
                continue;
            const infNfe = nfe.infNFe;
            const chave = String(infNfe['$']['Id']).replace('NFe', '').replace(/\D/g, '');
            if (chave.length !== 44)
                continue;
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
            }
            catch (e) {
                this.logger.error(`Falha ao importar NF ${chave}`, e instanceof Error ? e.stack : String(e), 'Import');
            }
        }
        return out;
    }
    detectXmlType(xml) {
        const raw = String(xml || '').trim();
        if (!raw)
            return 'SEM_XML';
        const content = raw.toLowerCase();
        const hasItems = content.includes('<det') && content.includes('<prod');
        if (hasItems)
            return 'COMPLETO';
        return 'RESUMO';
    }
    async startLaunchedInvoicesSyncJob() {
        const jobId = (0, crypto_1.randomUUID)();
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
    getLaunchedInvoicesSyncJob(jobId) {
        var _a;
        return (_a = this.launchedSyncJobs.get(jobId)) !== null && _a !== void 0 ? _a : null;
    }
    async startXmlNormalizationJob(batchSize = 500) {
        const safeBatchSize = Number.isFinite(batchSize) ? Math.min(Math.max(Math.floor(batchSize), 100), 2000) : 500;
        const jobId = (0, crypto_1.randomUUID)();
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
    getXmlNormalizationJob(jobId) {
        var _a;
        return (_a = this.xmlNormalizationJobs.get(jobId)) !== null && _a !== void 0 ? _a : null;
    }
    appendXmlNormalizationLog(jobId, message) {
        const job = this.xmlNormalizationJobs.get(jobId);
        if (!job)
            return;
        job.logs.push(`[${new Date().toISOString()}] ${message}`);
        if (job.logs.length > 300) {
            job.logs = job.logs.slice(-300);
        }
        this.xmlNormalizationJobs.set(jobId, job);
    }
    async runXmlNormalization(jobId, batchSize) {
        try {
            const total = await this.prisma.nfeConciliacao.count();
            const initialJob = this.xmlNormalizationJobs.get(jobId);
            if (!initialJob)
                return;
            initialJob.total = total;
            this.xmlNormalizationJobs.set(jobId, initialJob);
            this.appendXmlNormalizationLog(jobId, `Total de notas para verificar: ${total}`);
            let cursor;
            let processadas = 0;
            let normalizadas = 0;
            let ignoradas = 0;
            let erros = 0;
            while (true) {
                const rows = await this.prisma.nfeConciliacao.findMany(Object.assign({ select: { chave_nfe: true, xml_completo: true }, orderBy: { chave_nfe: 'asc' }, take: batchSize }, (cursor ? { cursor: { chave_nfe: cursor }, skip: 1 } : {})));
                if (!rows.length)
                    break;
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
                        }
                        else {
                            const decoded = await this.decodeXml(raw);
                            if (decoded && decoded.trim().startsWith('<')) {
                                ignoradas++;
                            }
                            else {
                                ignoradas++;
                                erros++;
                            }
                        }
                    }
                    catch (_a) {
                        erros++;
                    }
                    processadas++;
                }
                cursor = rows[rows.length - 1].chave_nfe;
                const job = this.xmlNormalizationJobs.get(jobId);
                if (!job)
                    return;
                job.processadas = processadas;
                job.normalizadas = normalizadas;
                job.ignoradas = ignoradas;
                job.erros = erros;
                job.progresso = total === 0 ? 100 : Math.round((processadas / total) * 100);
                this.xmlNormalizationJobs.set(jobId, job);
                this.appendXmlNormalizationLog(jobId, `Lote concluído. Processadas ${processadas}/${total} | normalizadas ${normalizadas} | ignoradas ${ignoradas} | erros ${erros}`);
            }
            const job = this.xmlNormalizationJobs.get(jobId);
            if (!job)
                return;
            job.status = 'completed';
            job.processadas = processadas;
            job.normalizadas = normalizadas;
            job.ignoradas = ignoradas;
            job.erros = erros;
            job.progresso = 100;
            job.completedAt = new Date().toISOString();
            this.xmlNormalizationJobs.set(jobId, job);
            this.appendXmlNormalizationLog(jobId, `Concluído. Normalizadas: ${normalizadas}. Ignoradas: ${ignoradas}. Erros: ${erros}.`);
        }
        catch (error) {
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
    appendJobLog(jobId, message) {
        if (!jobId)
            return;
        const job = this.launchedSyncJobs.get(jobId);
        if (!job)
            return;
        job.logs.push(`[${new Date().toISOString()}] ${message}`);
        if (job.logs.length > 200) {
            job.logs = job.logs.slice(-200);
        }
        this.launchedSyncJobs.set(jobId, job);
    }
    async runLaunchedInvoicesSync(jobId) {
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
                    }
                    catch (_a) {
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
        }
        catch (error) {
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
    async fetchErpInvoices(start, end) {
        return this.erpApi.comFallback(() => this.fetchErpInvoicesViaApi(start, end), () => this.fetchErpInvoicesViaOpenQuery(start, end));
    }
    async fetchErpInvoicesViaApi(start, end) {
        const { startDate, endDate } = this.getDateRangeOrDefault(start, end);
        const iso = (d) => d.toISOString().slice(0, 10);
        const pendentes = await this.erpApi.nfeDistribuicaoPendentes(iso(startDate), iso(endDate));
        if (!pendentes.length)
            return [];
        const comXml = pendentes
            .filter((linha) => Number(linha.TEM_XML) === 1)
            .map((linha) => String(linha.CHAVE_NFE || '').trim())
            .filter(Boolean);
        const xmlPorChave = new Map();
        for (let i = 0; i < comXml.length; i += erp_api_service_1.ErpApiService.LOTE_CHAVES) {
            const lote = comXml.slice(i, i + erp_api_service_1.ErpApiService.LOTE_CHAVES);
            for (const linha of await this.erpApi.xmlPorChaves(lote)) {
                xmlPorChave.set(String(linha.CHAVE_NFE || '').trim(), {
                    XML_RESUMO: linha.XML_RESUMO,
                    XML_COMPLETO: linha.XML_COMPLETO,
                });
            }
        }
        return pendentes.map((linha) => {
            var _a, _b;
            const chave = String(linha.CHAVE_NFE || '').trim();
            const xml = xmlPorChave.get(chave);
            return Object.assign(Object.assign({}, linha), { CHAVE_NFE: chave, EMPRESA: 1, TIPO_OPERACAO_DESC: Number(linha.TIPO_OPERACAO) === 0
                    ? 'ENTRADA PRÓPRIA'
                    : Number(linha.TIPO_OPERACAO) === 1
                        ? 'SAÍDA'
                        : 'OUTROS', XML_RESUMO: (_a = xml === null || xml === void 0 ? void 0 : xml.XML_RESUMO) !== null && _a !== void 0 ? _a : null, XML_COMPLETO: (_b = xml === null || xml === void 0 ? void 0 : xml.XML_COMPLETO) !== null && _b !== void 0 ? _b : null });
        });
    }
    async fetchErpInvoicesViaOpenQuery(start, end) {
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
        const firebirdSql = sql.replace(/'/g, "''");
        const tsql = `SELECT * FROM OPENQUERY(CONSULTA, '${firebirdSql}')`;
        try {
            const rows = await this.openQuery.query(tsql, {});
            return rows;
        }
        catch (e) {
            this.logger.error("Error fetching ERP invoices", e);
            return [];
        }
    }
    async fetchEntradaXmlKeys() {
        const sql = `
      SELECT
          X.CHAVE_NFE
      FROM NF_ENTRADA_XML X
      WHERE X.EMPRESA = 1
      ORDER BY X.CHAVE_NFE
    `;
        const firebirdSql = sql.replace(/'/g, "''");
        const tsql = `SELECT * FROM OPENQUERY(CONSULTA, '${firebirdSql}')`;
        const rows = await this.openQuery.query(tsql, {}, { timeout: 300000, allowZeroRows: true });
        return rows
            .map(r => String(r.CHAVE_NFE || '').trim())
            .filter(Boolean)
            .reverse();
    }
    async fetchNfEntradaDatesByKeys(keys) {
        if (!keys.length)
            return new Map();
        return this.erpApi.comFallback(() => this.fetchNfEntradaDatesByKeysViaApi(keys), () => this.fetchNfEntradaDatesByKeysViaOpenQuery(keys));
    }
    async fetchNfEntradaDatesByKeysViaApi(keys) {
        const result = new Map();
        for (let i = 0; i < keys.length; i += erp_api_service_1.ErpApiService.LOTE_CHAVES) {
            const lote = keys.slice(i, i + erp_api_service_1.ErpApiService.LOTE_CHAVES);
            for (const row of await this.erpApi.nfEntradaPorChaves(lote)) {
                const chave = String(row.CHAVE_NFE || '').trim();
                if (!chave)
                    continue;
                const dt = row.DT_ENTRADA ? new Date(row.DT_ENTRADA) : null;
                result.set(chave, dt && !Number.isNaN(dt.getTime()) ? dt : null);
            }
        }
        return result;
    }
    async fetchNfEntradaDatesByKeysViaOpenQuery(keys) {
        const result = new Map();
        if (!keys.length)
            return result;
        const batchSize = 100;
        for (let offset = 0; offset < keys.length; offset += batchSize) {
            const batchKeys = keys.slice(offset, offset + batchSize);
            const inList = batchKeys
                .map((k) => `'${String(k).replace(/'/g, "''")}'`)
                .join(',');
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
            const rows = await this.openQuery.query(tsql, {}, { timeout: 300000, allowZeroRows: true });
            for (const row of rows) {
                const chave = String(row.CHAVE_NFE || '').trim();
                if (!chave)
                    continue;
                const dt = row.DT_ENTRADA ? new Date(row.DT_ENTRADA) : null;
                result.set(chave, dt && !Number.isNaN(dt.getTime()) ? dt : null);
            }
        }
        return result;
    }
    async fetchEntradaXmlInvoicesByKeys(keys) {
        if (!keys.length)
            return [];
        return this.erpApi.comFallback(() => this.fetchEntradaXmlInvoicesByKeysViaApi(keys), () => this.fetchEntradaXmlInvoicesByKeysViaOpenQuery(keys));
    }
    async fetchEntradaXmlInvoicesByKeysViaApi(keys) {
        const linhas = [];
        for (let i = 0; i < keys.length; i += erp_api_service_1.ErpApiService.LOTE_CHAVES) {
            const lote = keys.slice(i, i + erp_api_service_1.ErpApiService.LOTE_CHAVES);
            linhas.push(...(await this.erpApi.xmlPorChaves(lote)).map((l) => (Object.assign(Object.assign({}, l), { EMPRESA: 1 }))));
        }
        return linhas;
    }
    async fetchEntradaXmlInvoicesByKeysViaOpenQuery(keys) {
        if (!keys.length)
            return [];
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
        const rows = await this.openQuery.query(tsql, {}, { timeout: 300000, allowZeroRows: true });
        return rows.reverse();
    }
    async decodeXml(content) {
        if (!content)
            return "";
        content = content.trim();
        if (content.startsWith('<'))
            return content;
        try {
            const buffer = Buffer.from(content, 'base64');
            return zlib.gunzipSync(buffer).toString('utf-8');
        }
        catch (e) {
            return content;
        }
    }
    encodeXml(xml) {
        const content = String(xml || '').trim();
        if (!content)
            return '';
        if (!content.startsWith('<'))
            return content;
        const gz = zlib.gzipSync(Buffer.from(content, 'utf-8'));
        return gz.toString('base64');
    }
    async normalizeBlobXml(content) {
        if (!content)
            return '';
        if (Buffer.isBuffer(content)) {
            const asText = content.toString('utf-8').trim();
            if (!asText)
                return '';
            return this.decodeXml(asText);
        }
        const asString = String(content).trim();
        if (!asString)
            return '';
        return this.decodeXml(asString);
    }
    toFirebirdDateOrNull(value) {
        if (!value)
            return null;
        const d = new Date(value);
        if (Number.isNaN(d.getTime()))
            return null;
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return `${dd}.${mm}.${yyyy}`;
    }
    parseDecimal(value) {
        const raw = String(value !== null && value !== void 0 ? value : '').trim();
        if (!raw)
            return 0;
        let normalized = raw;
        if (normalized.includes(',') && normalized.includes('.')) {
            normalized = normalized.replace(/\./g, '').replace(',', '.');
        }
        else if (normalized.includes(',')) {
            normalized = normalized.replace(',', '.');
        }
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    parsePtBrMoney(value) {
        const raw = String(value || '').trim();
        if (!raw)
            return null;
        let normalized = raw;
        if (normalized.includes(',') && normalized.includes('.')) {
            normalized = normalized.replace(/\./g, '').replace(',', '.');
        }
        else if (normalized.includes(',')) {
            normalized = normalized.replace(',', '.');
        }
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }
    parsePtBrDate(value) {
        const raw = String(value || '').trim();
        const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!match)
            return null;
        const [, dd, mm, yyyy] = match;
        const date = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    extractLineField(text, fieldNumber, fieldNamePattern) {
        var _a;
        const regex = new RegExp(`${fieldNumber}\\s*-\\s*${fieldNamePattern}[\\s:.-]*([^\\n\\r]+)`, 'i');
        const match = text.match(regex);
        return ((_a = match === null || match === void 0 ? void 0 : match[1]) === null || _a === void 0 ? void 0 : _a.trim()) || null;
    }
    extractGuiaDataFromPdfText(text, chaveNfe) {
        const compactText = String(text || '').replace(/\r/g, '');
        const numeroDocumento = this.extractLineField(compactText, '23', 'INF\\.?\\s*COMPLEMENTARES');
        const dataVencimentoRaw = this.extractLineField(compactText, '22', 'DATA\\s*VENCTO\\.?');
        const valorRaw = this.extractLineField(compactText, '31', 'VALOR');
        const info32 = this.extractLineField(compactText, '32', 'INFORMA[ÇC][ÕO]ES\\s*PREVISTAS\\s*EM\\s*INSTRU[ÇC][ÕO]ES');
        const textForFeCte = info32 || compactText;
        const normalizedTextForFeCte = textForFeCte.replace(/\s+/g, ' ');
        const numeroNfChave = String(chaveNfe || '').substring(25, 34).replace(/^0+/, '');
        const normalizeDigits = (value) => String(value || '').replace(/\D/g, '').replace(/^0+/, '');
        const captureContextAfterMarker = (source) => {
            const marker = source.match(/NFE?\s*OU\s*CTE\s*[:\-]?/i);
            if (!marker || marker.index == null)
                return '';
            const start = marker.index + marker[0].length;
            const tail = source.slice(start);
            const endBySenhor = tail.search(/Senhor\s+Contribuinte/i);
            const endByNaoReceber = tail.search(/N[ÃA]O\s+RECEBER/i);
            const candidates = [endBySenhor, endByNaoReceber].filter((idx) => idx >= 0);
            const end = candidates.length > 0 ? Math.min(...candidates) : Math.min(tail.length, 260);
            return tail.slice(0, end);
        };
        const selectBestToken = (tokenList) => {
            if (tokenList.length === 0)
                return null;
            const exactByChave = tokenList.find((token) => normalizeDigits(token) === numeroNfChave);
            if (exactByChave)
                return exactByChave;
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
        const feCteByMarker = normalizedTextForFeCte.match(/NFE?\s*OU\s*CTE\s*[:\-]?\s*(\d{1,20})\b/i)
            || textForFeCte.match(/NFE?\s*OU\s*CTE\s*[:\-]?\s*(\d{1,20})\b/i);
        const feCteFallback = normalizedTextForFeCte.match(/\b(?:NFE?|CTE|FE)\s*[:\-]?\s*(\d{1,20})\b/i)
            || textForFeCte.match(/\b(?:NFE?|CTE|FE)\s*[:\-]?\s*(\d{1,20})\b/i);
        const feCteRaw = markerToken || (feCteByMarker === null || feCteByMarker === void 0 ? void 0 : feCteByMarker[1]) || (feCteFallback === null || feCteFallback === void 0 ? void 0 : feCteFallback[1]) || null;
        const dataVencimento = this.parsePtBrDate(dataVencimentoRaw);
        const valor = this.parsePtBrMoney(valorRaw);
        const numeroNfExtraido = feCteRaw ? normalizeDigits(feCteRaw) : null;
        let feCteConfere = null;
        let aviso = null;
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
    getMinioClient() {
        if (this.minioClient)
            return this.minioClient;
        const rawEndpoint = String(process.env.MINIO_ENDPOINT || '').trim();
        const accessKey = process.env.MINIO_ACCESS_KEY;
        const secretKey = process.env.MINIO_SECRET_KEY;
        if (!rawEndpoint || !accessKey || !secretKey) {
            throw new Error('Configuração MinIO incompleta: MINIO_ENDPOINT, MINIO_ACCESS_KEY e MINIO_SECRET_KEY são obrigatórios.');
        }
        let endPoint = rawEndpoint;
        let port = Number(process.env.MINIO_PORT || 9000);
        let useSSL = String(process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true';
        if (rawEndpoint.includes('://')) {
            try {
                const parsed = new URL(rawEndpoint);
                endPoint = parsed.hostname;
                if (parsed.port) {
                    const parsedPort = Number(parsed.port);
                    if (Number.isFinite(parsedPort) && parsedPort > 0) {
                        port = parsedPort;
                    }
                }
                else if (!process.env.MINIO_PORT) {
                    port = parsed.protocol === 'https:' ? 443 : 80;
                }
                if (!process.env.MINIO_USE_SSL) {
                    useSSL = parsed.protocol === 'https:';
                }
            }
            catch (_a) {
                throw new Error(`MINIO_ENDPOINT inválido: ${rawEndpoint}`);
            }
        }
        else {
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
    async ensureMinioBucket() {
        const client = this.getMinioClient();
        const exists = await client.bucketExists(this.minioBucket);
        if (!exists) {
            await client.makeBucket(this.minioBucket, this.minioRegion);
        }
    }
    normalizeUploadedFileName(fileName) {
        const raw = String(fileName || '').trim();
        if (!raw)
            return 'guia.pdf';
        let normalized = raw;
        if (/[ÃÂ]/.test(normalized)) {
            try {
                const repaired = Buffer.from(normalized, 'latin1').toString('utf8');
                if (repaired && !repaired.includes('�')) {
                    normalized = repaired;
                }
            }
            catch (_a) {
            }
        }
        normalized = normalized
            .replace(/[\u0000-\u001F\u007F]/g, '')
            .replace(/[\\/]+/g, '_')
            .trim();
        return normalized || 'guia.pdf';
    }
    async uploadGuiaPdfToMinio(chaveNfe, file) {
        await this.ensureMinioBucket();
        const client = this.getMinioClient();
        const normalizedOriginalName = this.normalizeUploadedFileName(file.originalname);
        const safeFileName = String(normalizedOriginalName || 'guia.pdf').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const objectPath = `notas/${chaveNfe}/${Date.now()}-${safeFileName}`;
        await client.putObject(this.minioBucket, objectPath, file.buffer, file.buffer.length, { 'Content-Type': file.mimetype || 'application/pdf' });
        return { bucket: this.minioBucket, objectPath };
    }
    extractTagValue(xml, tagName) {
        var _a;
        if (!xml)
            return '';
        const match = xml.match(new RegExp(`<(?:\\w+:)?${tagName}>([^<]+)<\\/(?:\\w+:)?${tagName}>`, 'i'));
        return ((_a = match === null || match === void 0 ? void 0 : match[1]) === null || _a === void 0 ? void 0 : _a.trim()) || '';
    }
    extractValorTotalFromXml(xml) {
        const rawVnf = this.extractTagValue(xml, 'vNF');
        return this.parseDecimal(rawVnf);
    }
    extractInvoiceMetadataFromXml(xml, fallbackChave) {
        var _a, _b, _c, _d, _e, _f, _g;
        const emitente = ((_b = (_a = xml.match(/<xNome>([\s\S]*?)<\/xNome>/)) === null || _a === void 0 ? void 0 : _a[1]) === null || _b === void 0 ? void 0 : _b.trim()) || 'Desconhecido';
        const cnpjEmitente = ((_c = xml.match(/<CNPJ>(\d+)<\/CNPJ>/)) === null || _c === void 0 ? void 0 : _c[1])
            || ((_d = xml.match(/<CPF>(\d+)<\/CPF>/)) === null || _d === void 0 ? void 0 : _d[1])
            || null;
        const dhEmi = (_e = xml.match(/<dhEmi>([^<]+)<\/dhEmi>/)) === null || _e === void 0 ? void 0 : _e[1];
        const dEmi = (_f = xml.match(/<dEmi>([^<]+)<\/dEmi>/)) === null || _f === void 0 ? void 0 : _f[1];
        const dataEmissao = new Date(dhEmi || dEmi || Date.now());
        const safeDataEmissao = Number.isNaN(dataEmissao.getTime()) ? new Date() : dataEmissao;
        const valorTotal = this.extractValorTotalFromXml(xml);
        const tpNf = parseInt(((_g = xml.match(/<tpNF>(\d)<\/tpNF>/)) === null || _g === void 0 ? void 0 : _g[1]) || '0', 10);
        const tipoOperacao = Number.isNaN(tpNf) ? 0 : tpNf;
        const tipoOperacaoDesc = tipoOperacao === 0 ? 'ENTRADA PRÓPRIA' : 'SAÍDA';
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
    async isInterstateInvoice(row) {
        const xml = await this.decodeXml(row.XML_COMPLETO);
        if (!xml)
            return false;
        const match = xml.match(/infNFe\s+Id="NFe(\d{44})"/);
        if (match) {
            const uf = match[1].substring(0, 2);
            return uf !== '51';
        }
        if (row.CHAVE_NFE && row.CHAVE_NFE.length === 44) {
            return row.CHAVE_NFE.substring(0, 2) !== '51';
        }
        return false;
    }
    cleanNcm(ncm) {
        return ncm ? ncm.replace(/\./g, '').trim() : '';
    }
    findMvaInRef(ncmProduto) {
        const ncmLimpo = this.cleanNcm(ncmProduto);
        let match = this.refData.find(r => r.NCM_CLEAN === ncmLimpo);
        if (match)
            return { mva: match.MVA, item: match.Item, matchType: 'Exato' };
        if (ncmLimpo.length >= 6) {
            match = this.refData.find(r => r.NCM_CLEAN === ncmLimpo.substring(0, 6));
            if (match)
                return { mva: match.MVA, item: match.Item, matchType: 'Raiz 6' };
        }
        if (ncmLimpo.length >= 4) {
            match = this.refData.find(r => r.NCM_CLEAN === ncmLimpo.substring(0, 4));
            if (match)
                return { mva: match.MVA, item: match.Item, matchType: 'Raiz 4' };
        }
        return { mva: null, item: null, matchType: 'Não Encontrado' };
    }
    aliquotaInterestadualPorUf(ufOrigem, origProduto) {
        if (['1', '2', '3', '8'].includes(origProduto))
            return 0.04;
        const sulSudesteExcetoEs = new Set(['SP', 'RJ', 'MG', 'PR', 'SC', 'RS']);
        return sulSudesteExcetoEs.has(ufOrigem) ? 0.07 : 0.12;
    }
    async calculateStForInvoice(xmlContent, icmsInternoRate = 17.0) {
        var _a;
        const xmlStr = await this.decodeXml(xmlContent);
        if (!xmlStr)
            return [];
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xmlStr);
        const nfe = result.nfeProc ? result.nfeProc.NFe : result.NFe;
        if (!nfe)
            return [];
        const infNfe = nfe.infNFe;
        const chave = infNfe['$']['Id'].replace('NFe', '');
        const emit = infNfe.emit;
        const ide = infNfe.ide;
        const total = infNfe.total.ICMSTot;
        const det = Array.isArray(infNfe.det) ? infNfe.det : [infNfe.det];
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
                    status_erp: 'UPLOAD',
                    tipo_operacao: parseInt(ide.tpNF || 0),
                    tipo_operacao_desc: parseInt(ide.tpNF) === 0 ? 'ENTRADA' : 'SAÍDA'
                },
                update: {
                    xml_completo: compressedXml,
                    updated_at: new Date()
                }
            });
        }
        catch (e) {
            this.logger.error(`Error upserting NFe ${chave} during calculation`, e);
        }
        const results = [];
        const tolGuia = Number(process.env.GUIA_TOLERANCIA_BRL) > 0 ? Number(process.env.GUIA_TOLERANCIA_BRL) : 10;
        const emitUf = String(((_a = emit === null || emit === void 0 ? void 0 : emit.enderEmit) === null || _a === void 0 ? void 0 : _a.UF) || '').toUpperCase();
        const crtEmit = String((emit === null || emit === void 0 ? void 0 : emit.CRT) || '').trim();
        const regime = await this.simplesNacional.consultarOptante(emit.CNPJ || '');
        let optanteSimples = regime.optanteSimples;
        let regimeFonte = regime.fonte;
        if (optanteSimples === null && crtEmit) {
            optanteSimples = crtEmit === '1' || crtEmit === '4';
            regimeFonte = 'crt';
        }
        for (const item of det) {
            const prod = item.prod;
            const imposto = item.imposto;
            const ncm = prod.NCM;
            const { mva, item: itemRef, matchType } = this.findMvaInRef(ncm);
            const vProd = parseFloat(prod.vProd || 0);
            const vFrete = parseFloat(prod.vFrete || 0);
            const vSeg = parseFloat(prod.vSeg || 0);
            const vDesc = parseFloat(prod.vDesc || 0);
            const vOutro = parseFloat(prod.vOutro || 0);
            let vIpi = 0;
            if (imposto.IPI && imposto.IPI.IPITrib) {
                vIpi = parseFloat(imposto.IPI.IPITrib.vIPI || 0);
            }
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
                if (vals.pICMS)
                    pIcmsOrigem = parseFloat(vals.pICMS);
                cstNota = String(vals.CST || vals.CSOSN || '');
                if (vals.orig !== undefined)
                    origProduto = String(vals.orig);
            }
            let taxaOrigem = 0.07;
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
                effectiveMva = 0.5039;
                isDefaultMva = true;
            }
            const baseSoma = vProd + vIpi + vFrete + vSeg + vOutro - vDesc;
            const baseCalcStRef = baseSoma * (1 + effectiveMva);
            const debitoSt = baseCalcStRef * (icmsInternoRate / 100.0);
            const vStCalculadoRaw = Math.max(0, debitoSt - vCreditoOrigem);
            vStCalculado = parseFloat(vStCalculadoRaw.toFixed(2));
            diffSt = vStCalculado - vStDestacado;
            const cfopItem = String(prod.CFOP || '').trim();
            const semTributacaoItem = cfopItem !== '' && !cfop_tributados_1.CFOP_INTERESTADUAIS_TRIBUTADOS.has(cfopItem);
            if (semTributacaoItem) {
                vStCalculado = 0;
                diffSt = 0;
                status = "Sem Tributação";
            }
            else if (!isDefaultMva) {
                if (diffSt > tolGuia)
                    status = "Guia Complementar";
                else if (diffSt < -tolGuia)
                    status = "Pago a Maior";
                else
                    status = "OK";
            }
            else {
                if (diffSt > tolGuia)
                    status = "Guia Compl. (Padrão 50%)";
                else if (diffSt < -tolGuia)
                    status = "Pago Maior (Padrão 50%)";
                else
                    status = "OK (Padrão 50%)";
            }
            const valorGuiaComplementar = parseFloat(Math.max(0, diffSt).toFixed(2));
            const valorPagoAMais = parseFloat(Math.max(0, -diffSt).toFixed(2));
            const aliquotaInternaDecimal = icmsInternoRate / 100.0;
            const aliquotaInterestadualDIFAL = pIcmsOrigem > 0
                ? pIcmsOrigem / 100.0
                : this.aliquotaInterestadualPorUf(emitUf, origProduto);
            let vlDifalCalculado = 0;
            let vlCreditoDifal = 0;
            let formulaDifal;
            if (optanteSimples !== true && vIcmsProprio > 0) {
                formulaDifal = 'COM_DESTAQUE';
                const baseDifal = (baseSoma - vIcmsProprio) / (1 - aliquotaInternaDecimal);
                vlCreditoDifal = baseSoma * aliquotaInterestadualDIFAL;
                vlDifalCalculado = Math.max(0, (baseDifal * aliquotaInternaDecimal) - vlCreditoDifal);
            }
            else {
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
                vlDifal: vlDifalCalculado,
                optanteSimples,
                regimeFonte,
                formulaDifal,
                vlCreditoDifal: parseFloat(vlCreditoDifal.toFixed(2)),
                aliqInterestadualDifal: aliquotaInterestadualDIFAL * 100,
                diferenca: diffSt,
                valorGuiaComplementar,
                valorPagoAMais,
                status: status
            });
        }
        return results;
    }
    async previewFiscalConference(dto) {
        return this.runFiscalConference(dto, false);
    }
    async persistFiscalConference(dto) {
        return this.runFiscalConference(dto, true);
    }
    async runFiscalConference(dto, persist) {
        const notas = Array.isArray(dto === null || dto === void 0 ? void 0 : dto.notas) ? dto.notas : [];
        const result = [];
        for (const nota of notas) {
            const chaveNfe = String((nota === null || nota === void 0 ? void 0 : nota.chaveNfe) || '').trim();
            if (!chaveNfe)
                continue;
            const nfe = await this.prisma.nfeConciliacao.findUnique({
                where: { chave_nfe: chaveNfe },
                select: { cnpj_emitente: true },
            });
            const emitenteCnpj = this.cleanDigits((nfe === null || nfe === void 0 ? void 0 : nfe.cnpj_emitente) || '');
            const isCompraDentroEstado = this.isWithinMtByChave(chaveNfe);
            const itensOut = [];
            const warnings = [];
            let hasComercializacao = false;
            let hasUsoConsumo = false;
            let hasSemTributacao = false;
            for (const item of Array.isArray(nota === null || nota === void 0 ? void 0 : nota.itens) ? nota.itens : []) {
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
                    }
                    catch (error) {
                        warnings.push(`Falha ao persistir item ${analyzed.item}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                itensOut.push(analyzed);
            }
            if (persist) {
                try {
                    await this.saveFiscalConferenceSummary(chaveNfe, hasComercializacao, hasUsoConsumo);
                }
                catch (error) {
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
    async analyzeFiscalItem(input) {
        var _a;
        const { emitenteCnpj, isCompraDentroEstado, item } = input;
        const destinacaoTela = item.destinacaoMercadoria;
        const codProdFornecedorRaw = String(item.codProdFornecedor || '').trim();
        const codProdFornecedor = codProdFornecedorRaw || String(item.item || '');
        const normalizedNcm = this.cleanDigits(item.ncmNota || '');
        const normalizedCstNota = this.cleanDigits(item.cstNota || '');
        const possuiIcmsSt = Boolean(item.possuiIcmsSt || item.impostoEscolhido === 'ST');
        const possuiDifal = Boolean(item.possuiDifal || item.impostoEscolhido === 'DIFAL');
        const cfopNota = String(item.cfop || '').trim();
        const semTributacao = cfopNota !== '' && !cfop_tributados_1.CFOP_INTERESTADUAIS_TRIBUTADOS.has(cfopNota);
        const divergencias = [];
        const conformidades = [];
        const supplier = emitenteCnpj
            ? await this.findSupplierByCpfCnpj(emitenteCnpj)
            : null;
        if (!supplier) {
            divergencias.push('Fornecedor da nota não encontrado na Stage_Fornecedores pelo CPF/CNPJ do emitente.');
        }
        const codigoInternoManual = String(item.codigoInternoManual || '').trim();
        let vinculo = null;
        let produtoInterno = null;
        if (codigoInternoManual) {
            produtoInterno = await this.findInternalProduct(codigoInternoManual);
            if (produtoInterno) {
                conformidades.push(`Relacionamento manual com código interno ${codigoInternoManual} localizado na Stage_Produtos.`);
            }
            else {
                divergencias.push(`Código interno ${codigoInternoManual} informado manualmente não foi encontrado na Stage_Produtos.`);
            }
        }
        else {
            if ((supplier === null || supplier === void 0 ? void 0 : supplier.FOR_CODIGO) && codProdFornecedor) {
                vinculo = await this.findSupplierProductLink(supplier.FOR_CODIGO, codProdFornecedor, item.produto, item.unidadeFornecedor);
                if (!vinculo) {
                    divergencias.push('Produto do fornecedor não foi relacionado ao nosso código interno no Sistema Celta. Por Favor Verifique!');
                }
                else {
                    conformidades.push('Relacionamento do produto do fornecedor com o código interno localizado no Sistema Celta.');
                }
            }
            produtoInterno = (vinculo === null || vinculo === void 0 ? void 0 : vinculo.PRO_CODIGO)
                ? await this.findInternalProduct(vinculo.PRO_CODIGO)
                : null;
            if ((vinculo === null || vinculo === void 0 ? void 0 : vinculo.PRO_CODIGO) && !produtoInterno) {
                divergencias.push('PRO_CODIGO vinculado não encontrado na Stage_Produtos.');
            }
        }
        if (produtoInterno) {
            const stCodigo = String(produtoInterno.ST_CODIGO || '').trim().toUpperCase();
            const temCest = !!String((_a = produtoInterno.CEST) !== null && _a !== void 0 ? _a : '').trim();
            if (temCest && stCodigo !== 'ST0-X') {
                divergencias.push(`Situação Tributária inválida: produto com CEST exige ST_CODIGO=ST0-X e encontrado ${stCodigo || 'vazio'}.`);
            }
            else if (temCest) {
                conformidades.push('Situação Tributária correta: ST0-X (com CEST).');
            }
        }
        const subtipoCadastro = this.digitsOnly(produtoInterno === null || produtoInterno === void 0 ? void 0 : produtoInterno.SUBTIPO);
        const destinacaoMercadoria = subtipoCadastro === '00' ? 'COMERCIALIZACAO' : subtipoCadastro === '07' ? 'USO_CONSUMO' : null;
        if (!destinacaoMercadoria) {
            divergencias.push(produtoInterno
                ? `Não foi possível definir a destinação pelo SUBTIPO do cadastro (esperado 00=comercialização ou 07=uso e consumo, encontrado ${String(produtoInterno.SUBTIPO || '').trim() || 'vazio'}). Corrija o cadastro do produto.`
                : 'Não foi possível definir a destinação pelo SUBTIPO: produto interno não localizado no cadastro.');
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
                const pis = String(produtoInterno.PIS_CODIGO || '').trim().toUpperCase();
                const cofins = String(produtoInterno.COFINS_CODIGO || '').trim().toUpperCase();
                if (pis !== pisEsperado.toUpperCase()) {
                    divergencias.push(`Código do Pis inválido: esperado ${pisEsperado} e encontrado ${pis || 'vazio'}.`);
                }
                else {
                    conformidades.push(`Código do Pis correto: ${pisEsperado}.`);
                }
                if (cofins !== cofinsEsperado.toUpperCase()) {
                    divergencias.push(`Código do Cofins inválido: esperado ${cofinsEsperado} e encontrado ${cofins || 'vazio'}.`);
                }
                else {
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
            }
            else {
                conformidades.push('Código do Pis correto para uso e consumo: P99.');
            }
            if (cofins !== 'C99') {
                divergencias.push(`Código do Cofins inválido para uso e consumo: esperado C99 e encontrado ${cofins || 'vazio'}.`);
            }
            else {
                conformidades.push('Código do Cofins correto para uso e consumo: C99.');
            }
            if (subgrp !== '274') {
                divergencias.push(`SUBGRP_CODIGO inválido para uso e consumo: esperado 274 e encontrado ${subgrp || 'vazio'}.`);
            }
        }
        return {
            item: item.item,
            codProdFornecedor,
            codigoProduto: String((produtoInterno === null || produtoInterno === void 0 ? void 0 : produtoInterno.PRO_CODIGO) || (vinculo === null || vinculo === void 0 ? void 0 : vinculo.PRO_CODIGO) || codigoInternoManual || ''),
            codigoInternoManual: codigoInternoManual || null,
            impostoEscolhido: item.impostoEscolhido,
            destinacaoMercadoria: destinacaoMercadoria !== null && destinacaoMercadoria !== void 0 ? destinacaoMercadoria : destinacaoTela,
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
    async saveFiscalConferenceItem(chaveNfe, analyzed) {
        var _a, _b, _c;
        await this.prisma.$executeRawUnsafe(`
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
            `, chaveNfe, analyzed.item, analyzed.codProdFornecedor, ((_a = analyzed.fornecedor) === null || _a === void 0 ? void 0 : _a.forCodigo) || null, ((_b = analyzed.produtoInterno) === null || _b === void 0 ? void 0 : _b.proCodigo) || ((_c = analyzed.produtoVinculado) === null || _c === void 0 ? void 0 : _c.proCodigo) || null, analyzed.destinacaoMercadoria, analyzed.impostoEscolhido, Boolean(analyzed.possuiIcmsSt), Boolean(analyzed.possuiDifal), Boolean(analyzed.semTributacao), analyzed.ncmNota, analyzed.cstNota, JSON.stringify(analyzed.divergencias || []), analyzed.statusConferencia);
    }
    async saveFiscalConferenceSummary(chaveNfe, compraComercializacao, usoConsumo) {
        await this.prisma.$executeRawUnsafe(`
            UPDATE com_nfe_conciliacao
            SET
                compra_comercializacao = $2,
                uso_consumo = $3,
                updated_at = NOW()
            WHERE chave_nfe = $1
            `, chaveNfe, compraComercializacao, usoConsumo);
    }
    async findSupplierByCpfCnpj(cpfCnpj) {
        var _a;
        const normalized = this.cleanDigits(cpfCnpj);
        if (!normalized)
            return null;
        const rows = await this.openQuery.query(`
            SELECT TOP 1
                FOR_CODIGO,
                FOR_NOME,
                CPF_CNPJ
            FROM [BI].[dbo].[Stage_Fornecedores]
            WHERE REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(CPF_CNPJ, ''), '.', ''), '/', ''), '-', ''), ' ', '') = @cpfCnpj
            ORDER BY FOR_CODIGO
            `, { cpfCnpj: normalized }, { allowZeroRows: true });
        return (_a = rows[0]) !== null && _a !== void 0 ? _a : null;
    }
    async findSupplierProductLink(forCodigo, codProdFornecedor, descProdFornecedor, unidadeFornecedor) {
        var _a;
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
        let rows = [];
        if (usePkCompleteFilter) {
            rows = await this.openQuery.query(tsqlPk, {}, { allowZeroRows: true });
        }
        if (!rows.length) {
            rows = await this.openQuery.query(tsqlCode, {}, { allowZeroRows: true });
        }
        return (_a = rows[0]) !== null && _a !== void 0 ? _a : null;
    }
    async findInternalProduct(proCodigo, direto = false) {
        var _a, _b;
        if (direto) {
            return (_a = (await this.findInternalProductErp(proCodigo))) !== null && _a !== void 0 ? _a : (await this.findInternalProductStage(proCodigo));
        }
        return (_b = (await this.findInternalProductStage(proCodigo))) !== null && _b !== void 0 ? _b : (await this.findInternalProductErp(proCodigo));
    }
    async findInternalProductStage(proCodigo) {
        var _a;
        const rows = await this.openQuery.query(`
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
            `, { proCodigo }, { allowZeroRows: true });
        return (_a = rows[0]) !== null && _a !== void 0 ? _a : null;
    }
    async findInternalProductErp(proCodigo) {
        const code = this.digitsOnly(proCodigo);
        if (!code)
            return null;
        return this.erpApi.comFallback(() => this.erpApi.produtoFiscalUnico(Number(code)), () => this.findInternalProductErpViaOpenQuery(code));
    }
    async findInternalProductErpViaOpenQuery(code) {
        var _a;
        const firebirdSql = `
      SELECT FIRST 1
          PRO_CODIGO, PRO_DESCRICAO, ST_CODIGO, SUBTIPO,
          PIS_CODIGO, COFINS_CODIGO, COMERCIALIZAVEL, SUBGRP_CODIGO, CEST
      FROM PRODUTOS
      WHERE EMPRESA = 1 AND PRO_CODIGO = ${code}
    `;
        try {
            const rows = await this.openQuery.query(`SELECT * FROM OPENQUERY(CONSULTA, '${firebirdSql.replace(/'/g, "''")}')`, {}, { timeout: 120000, allowZeroRows: true });
            return (_a = rows[0]) !== null && _a !== void 0 ? _a : null;
        }
        catch (e) {
            this.logger.error(`Falha no fallback de produto ${code} no banco mãe (PRODUTOS)`, e instanceof Error ? e.stack : String(e), 'Auditoria');
            return null;
        }
    }
    isMonofasicoNcm(ncm) {
        const ncmClean = this.cleanDigits(ncm);
        if (!ncmClean)
            return false;
        if (this.monofasicoNcmSet.has(ncmClean))
            return true;
        if (ncmClean.length >= 6 && this.monofasicoNcmSet.has(ncmClean.slice(0, 6)))
            return true;
        if (ncmClean.length >= 4 && this.monofasicoNcmSet.has(ncmClean.slice(0, 4)))
            return true;
        return false;
    }
    cleanDigits(value) {
        return String(value || '').replace(/\D/g, '');
    }
    normalizeComparisonText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
    }
    parseDivergenciasJson(raw) {
        if (Array.isArray(raw))
            return raw.map((item) => String(item || '')).filter(Boolean);
        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return parsed.map((item) => String(item || '')).filter(Boolean);
                }
            }
            catch (_a) {
                return raw ? [raw] : [];
            }
            return raw ? [raw] : [];
        }
        return [];
    }
    isOnlyNoRelationshipStatus(divergencias) {
        if (!divergencias.length)
            return false;
        return divergencias.every((item) => {
            const normalized = this.normalizeComparisonText(item);
            return normalized.includes('nao foi relacionado ao nosso codigo interno')
                || normalized.includes('nao vinculado na stage_produtos_fornecedor_nfe');
        });
    }
    getConferenceStatusFromRows(rows) {
        if (!rows.length)
            return 'PENDENTE';
        let hasError = false;
        let hasNoRelationship = false;
        let hasOk = false;
        for (const row of rows) {
            const status = String((row === null || row === void 0 ? void 0 : row.status_conferencia) || '').trim().toUpperCase();
            if (status === 'OK') {
                hasOk = true;
                continue;
            }
            const divergencias = this.parseDivergenciasJson(row === null || row === void 0 ? void 0 : row.divergencias_json);
            if (this.isOnlyNoRelationshipStatus(divergencias)) {
                hasNoRelationship = true;
            }
            else {
                hasError = true;
            }
        }
        if (hasError)
            return 'ERRO';
        if (hasNoRelationship)
            return 'SEM_RELACIONAMENTO';
        if (hasOk)
            return 'OK';
        return 'PENDENTE';
    }
    isWithinMtByChave(chaveNfe) {
        const chave = String(chaveNfe || '').trim();
        return chave.slice(0, 2) === '51';
    }
    async maybeAlertMva(chaveNfe, xmlCompleto) {
        try {
            const row = await this.prisma.nfeConciliacao.findUnique({
                where: { chave_nfe: chaveNfe },
                select: { mva_alerta_enviado_em: true },
            });
            if (row === null || row === void 0 ? void 0 : row.mva_alerta_enviado_em)
                return;
            if (this.isWithinMtByChave(chaveNfe)) {
                await this.prisma.nfeConciliacao.update({
                    where: { chave_nfe: chaveNfe },
                    data: { mva_verificado_em: new Date() },
                });
                return;
            }
            const parsed = await this.extractMvaFromXml(xmlCompleto);
            if (!parsed)
                return;
            const itensAcima = parsed.itens.filter((i) => i.pMvaSt > IcmsService_1.MVA_LIMIAR);
            const maiorMva = parsed.itens.reduce((m, i) => Math.max(m, i.pMvaSt), 0);
            await this.prisma.nfeConciliacao.update({
                where: { chave_nfe: chaveNfe },
                data: { mva_verificado_em: new Date(), mva_maior: maiorMva },
            });
            if (itensAcima.length === 0)
                return;
            const webhook = process.env.N8N_MVA_WEBHOOK_URL;
            if (!webhook) {
                this.logger.warn('N8N_MVA_WEBHOOK_URL não configurada: pulando alerta de MVA.', 'MVA');
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
                mvaPadrao: IcmsService_1.MVA_LIMIAR,
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
                this.logger.log(`Alerta de MVA enviado para ${chaveNfe} (${itensAcima.length} item(s), maior ${maiorMva}%).`, 'MVA');
            }
            else {
                this.logger.error(`n8n recusou alerta de MVA ${chaveNfe}: HTTP ${resp.status}. Será reprocessado.`, undefined, 'MVA');
            }
        }
        catch (e) {
            this.logger.error(`Falha ao avaliar/enviar alerta de MVA para ${chaveNfe}`, e instanceof Error ? e.stack : String(e), 'MVA');
        }
    }
    async extractMvaFromXml(xmlContent) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const xmlStr = await this.decodeXml(xmlContent);
        if (!xmlStr)
            return null;
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xmlStr);
        const nfe = result.nfeProc ? result.nfeProc.NFe : result.NFe;
        if (!nfe || !nfe.infNFe)
            return null;
        const infNfe = nfe.infNFe;
        if (!infNfe.det)
            return null;
        const emit = infNfe.emit || {};
        const ide = infNfe.ide || {};
        const icmsTot = ((_a = infNfe.total) === null || _a === void 0 ? void 0 : _a.ICMSTot) || {};
        const det = Array.isArray(infNfe.det) ? infNfe.det : [infNfe.det];
        const itens = det.map((item, idx) => {
            var _a, _b, _c, _d, _e, _f;
            const prod = item.prod || {};
            const imposto = item.imposto || {};
            let pMvaSt = 0;
            for (const key of Object.keys(imposto.ICMS || {})) {
                const vals = imposto.ICMS[key] || {};
                if (vals.pMVAST != null) {
                    pMvaSt = parseFloat(vals.pMVAST) || 0;
                }
            }
            const nItem = parseInt((_b = (_a = item['$']) === null || _a === void 0 ? void 0 : _a.nItem) !== null && _b !== void 0 ? _b : '', 10);
            return {
                nItem: Number.isFinite(nItem) ? nItem : idx + 1,
                cProd: (_c = prod.cProd) !== null && _c !== void 0 ? _c : null,
                descricao: (_d = prod.xProd) !== null && _d !== void 0 ? _d : null,
                ncm: (_e = prod.NCM) !== null && _e !== void 0 ? _e : null,
                cfop: (_f = prod.CFOP) !== null && _f !== void 0 ? _f : null,
                pMvaSt,
            };
        });
        return {
            numeroNf: (_b = ide.nNF) !== null && _b !== void 0 ? _b : null,
            emitente: (_c = emit.xNome) !== null && _c !== void 0 ? _c : null,
            cnpjEmitente: (_e = (_d = emit.CNPJ) !== null && _d !== void 0 ? _d : emit.CPF) !== null && _e !== void 0 ? _e : null,
            ufEmitente: (_g = (_f = emit.enderEmit) === null || _f === void 0 ? void 0 : _f.UF) !== null && _g !== void 0 ? _g : null,
            dataEmissao: (_j = (_h = ide.dhEmi) !== null && _h !== void 0 ? _h : ide.dEmi) !== null && _j !== void 0 ? _j : null,
            valorTotal: parseFloat(icmsTot.vNF || 0) || 0,
            itens,
        };
    }
    digitsOnly(v) {
        return String(v !== null && v !== void 0 ? v : '').replace(/\D/g, '');
    }
    cfopEntradaEsperado(imposto, destinacao, intra) {
        const p = intra ? '1' : '2';
        const I = String(imposto || '').toUpperCase();
        const D = String(destinacao || '').toUpperCase();
        if (I === 'ST' && D === 'COMERCIALIZACAO')
            return p + '403';
        if (I === 'ST' && D === 'USO_CONSUMO')
            return p + '407';
        if (I === 'TRIBUTADA' && D === 'COMERCIALIZACAO')
            return p + '102';
        if (D === 'USO_CONSUMO' && (I === 'TRIBUTADA' || I === 'DIFAL'))
            return p + '556';
        if (I === 'DIFAL')
            return p + '556';
        return null;
    }
    cstFinalEsperado(imposto, destinacao) {
        const I = String(imposto || '').toUpperCase();
        const D = String(destinacao || '').toUpperCase();
        if (I === 'ST')
            return '60';
        if (I === 'TRIBUTADA' && D === 'COMERCIALIZACAO')
            return '00';
        if (D === 'USO_CONSUMO' && (I === 'TRIBUTADA' || I === 'DIFAL'))
            return '90';
        if (I === 'DIFAL')
            return '90';
        return null;
    }
    origemEsperada(origemNota) {
        if (origemNota === '1')
            return '2';
        if (origemNota === '6')
            return '7';
        return origemNota;
    }
    classificacaoPorCfop(cfopDigits) {
        const suf = cfopDigits.slice(1);
        if (suf === '102')
            return { imposto: 'TRIBUTADA', destinacao: 'COMERCIALIZACAO' };
        if (suf === '403')
            return { imposto: 'ST', destinacao: 'COMERCIALIZACAO' };
        if (suf === '407')
            return { imposto: 'ST', destinacao: 'USO_CONSUMO' };
        if (suf === '556')
            return { imposto: 'TRIBUTADA', destinacao: 'USO_CONSUMO' };
        if (suf === '411')
            return { imposto: 'ST', destinacao: 'COMERCIALIZACAO' };
        if (suf === '202')
            return { imposto: 'TRIBUTADA', destinacao: 'COMERCIALIZACAO' };
        if (suf === '653')
            return { imposto: 'ST', destinacao: 'COMERCIALIZACAO' };
        if (suf === '152')
            return { imposto: 'TRIBUTADA', destinacao: 'COMERCIALIZACAO' };
        if (suf === '916')
            return { imposto: 'TRIBUTADA', destinacao: 'COMERCIALIZACAO' };
        if (suf === '949')
            return { imposto: 'ST', destinacao: 'COMERCIALIZACAO' };
        return null;
    }
    destinacaoPorOpf(opfCodigo) {
        const code = this.digitsOnly(opfCodigo);
        if (code === '1' || code === '40')
            return 'COMERCIALIZACAO';
        if (code === '10')
            return 'USO_CONSUMO';
        return null;
    }
    pisCofinsEsperado(cadastroSubtipo, monofasico) {
        const sub = this.digitsOnly(cadastroSubtipo);
        if (sub === '07' || sub === '08')
            return { pis: 'P70', cofins: 'C70' };
        if (monofasico)
            return { pis: '04', cofins: '04' };
        return { pis: 'P01', cofins: 'C01' };
    }
    invalidateFiscalRules() {
        this.fiscalRulesCache = null;
    }
    async getFiscalRules() {
        if (this.fiscalRulesCache && Date.now() - this.fiscalRulesCacheAt < IcmsService_1.FISCAL_RULES_TTL_MS) {
            return this.fiscalRulesCache;
        }
        try {
            const regras = await this.prisma.$queryRawUnsafe(`SELECT * FROM com_fiscal_regra WHERE ativo = true`);
            const opfRows = await this.prisma.$queryRawUnsafe(`SELECT opf_codigo, destinacao FROM com_fiscal_opf_destinacao WHERE ativo = true`);
            const origemRows = await this.prisma.$queryRawUnsafe(`SELECT origem_de, origem_para FROM com_fiscal_origem_cst WHERE ativo = true`);
            let cfops = [];
            try {
                cfops = await this.prisma.$queryRawUnsafe(`SELECT cfop_fornecedor, destinacao, tem_cest, cfop_entrada, cst_final FROM com_fiscal_cfop WHERE ativo = true`);
            }
            catch (_a) {
                cfops = [];
            }
            this.fiscalRulesCache = {
                regras: regras !== null && regras !== void 0 ? regras : [],
                opf: new Map((opfRows !== null && opfRows !== void 0 ? opfRows : []).map((r) => [this.digitsOnly(r.opf_codigo), String(r.destinacao)])),
                origem: new Map((origemRows !== null && origemRows !== void 0 ? origemRows : []).map((r) => [String(r.origem_de), String(r.origem_para)])),
                cfops: cfops !== null && cfops !== void 0 ? cfops : [],
            };
        }
        catch (_b) {
            this.fiscalRulesCache = { regras: [], opf: new Map(), origem: new Map(), cfops: [] };
        }
        this.fiscalRulesCacheAt = Date.now();
        return this.fiscalRulesCache;
    }
    cfopRegraEsperada(rules, cfopFornecedor, destinacao, temCest) {
        var _a;
        if (!cfopFornecedor)
            return null;
        const dest = String(destinacao || '').toUpperCase();
        const cest = temCest ? 'SIM' : 'NAO';
        let best = null;
        let bestScore = -1;
        for (const r of (_a = rules.cfops) !== null && _a !== void 0 ? _a : []) {
            if (this.digitsOnly(r.cfop_fornecedor) !== cfopFornecedor)
                continue;
            const rd = String(r.destinacao || 'QUALQUER').toUpperCase();
            const rc = String(r.tem_cest || 'QUALQUER').toUpperCase();
            if (rd !== 'QUALQUER' && rd !== dest)
                continue;
            if (rc !== 'QUALQUER' && rc !== cest)
                continue;
            const score = (rd !== 'QUALQUER' ? 2 : 0) + (rc !== 'QUALQUER' ? 1 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = r;
            }
        }
        if (!best)
            return null;
        return {
            cfopEntrada: this.digitsOnly(best.cfop_entrada),
            cstFinal: best.cst_final ? this.digitsOnly(best.cst_final).slice(-2) : null,
        };
    }
    regraEsperadaDefault(imposto, destinacao, monofasico) {
        const I = String(imposto).toUpperCase();
        const D = String(destinacao).toUpperCase();
        const pisCom = monofasico ? '04' : 'P01';
        const cofinsCom = monofasico ? '04' : 'C01';
        if (I === 'ST' && D === 'COMERCIALIZACAO')
            return { cfopSufixo: '403', cstFinal: '60', stCodigo: 'ST0-X', pis: pisCom, cofins: cofinsCom, subtipo: '00', comercializavel: null, subgrp: null };
        if (I === 'ST' && D === 'USO_CONSUMO')
            return { cfopSufixo: '407', cstFinal: '60', stCodigo: 'ST0-X', pis: 'P99', cofins: 'C99', subtipo: '07', comercializavel: 'N', subgrp: '274' };
        if (I === 'TRIBUTADA' && D === 'COMERCIALIZACAO')
            return { cfopSufixo: '102', cstFinal: '00', stCodigo: 'TR0-X', pis: pisCom, cofins: cofinsCom, subtipo: '00', comercializavel: null, subgrp: null };
        if (D === 'USO_CONSUMO')
            return { cfopSufixo: '556', cstFinal: '90', stCodigo: 'TR0-X', pis: 'P99', cofins: 'C99', subtipo: '07', comercializavel: 'N', subgrp: '274' };
        return { cfopSufixo: null, cstFinal: null, stCodigo: null, pis: null, cofins: null, subtipo: null, comercializavel: null, subgrp: null };
    }
    regraEsperada(rules, imposto, destinacao, monofasico) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const ehDifal = String(imposto).toUpperCase() === 'DIFAL';
        const I = ehDifal ? 'TRIBUTADA' : String(imposto).toUpperCase();
        const D = ehDifal ? 'USO_CONSUMO' : String(destinacao).toUpperCase();
        const row = ((_a = rules.regras) !== null && _a !== void 0 ? _a : []).find((r) => String(r.imposto).toUpperCase() === I &&
            String(r.destinacao).toUpperCase() === D &&
            (r.monofasico === null || r.monofasico === undefined || Boolean(r.monofasico) === monofasico));
        if (row) {
            return {
                cfopSufixo: (_b = row.cfop_sufixo) !== null && _b !== void 0 ? _b : null,
                cstFinal: (_c = row.cst_final) !== null && _c !== void 0 ? _c : null,
                stCodigo: (_d = row.st_codigo) !== null && _d !== void 0 ? _d : null,
                pis: (_e = row.pis_codigo) !== null && _e !== void 0 ? _e : null,
                cofins: (_f = row.cofins_codigo) !== null && _f !== void 0 ? _f : null,
                subtipo: (_g = row.subtipo) !== null && _g !== void 0 ? _g : null,
                comercializavel: (_h = row.comercializavel) !== null && _h !== void 0 ? _h : null,
                subgrp: (_j = row.subgrp_codigo) !== null && _j !== void 0 ? _j : null,
            };
        }
        return this.regraEsperadaDefault(I, D, monofasico);
    }
    async getFiscalRegras() {
        const regras = await this.prisma.$queryRawUnsafe(`SELECT id::int AS id, imposto, destinacao, monofasico, cfop_sufixo, cst_final,
                    st_codigo, pis_codigo, cofins_codigo, subtipo, comercializavel, subgrp_codigo,
                    ativo, descricao, updated_at
             FROM com_fiscal_regra
             ORDER BY imposto, destinacao, monofasico NULLS FIRST, id`);
        const opf = await this.prisma.$queryRawUnsafe(`SELECT id::int AS id, opf_codigo, destinacao, ativo FROM com_fiscal_opf_destinacao ORDER BY opf_codigo`);
        const origem = await this.prisma.$queryRawUnsafe(`SELECT id::int AS id, origem_de, origem_para, ativo FROM com_fiscal_origem_cst ORDER BY origem_de`);
        let cfops = [];
        try {
            cfops = await this.prisma.$queryRawUnsafe(`SELECT id::int AS id, cfop_fornecedor, destinacao, tem_cest, cfop_entrada, cst_final, ativo, descricao
                 FROM com_fiscal_cfop ORDER BY cfop_fornecedor, destinacao, tem_cest`);
        }
        catch (_a) {
            cfops = [];
        }
        return { regras, opf, origem, cfops };
    }
    async saveFiscalRegras(body) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const ops = [
            this.prisma.$executeRawUnsafe(`DELETE FROM com_fiscal_regra`),
            this.prisma.$executeRawUnsafe(`DELETE FROM com_fiscal_opf_destinacao`),
            this.prisma.$executeRawUnsafe(`DELETE FROM com_fiscal_origem_cst`),
            this.prisma.$executeRawUnsafe(`DELETE FROM com_fiscal_cfop`),
        ];
        const orNull = (v) => (v === undefined || v === '' ? null : v);
        for (const r of (_a = body.regras) !== null && _a !== void 0 ? _a : []) {
            ops.push(this.prisma.$executeRawUnsafe(`INSERT INTO com_fiscal_regra
                       (imposto, destinacao, monofasico, cfop_sufixo, cst_final, st_codigo, pis_codigo, cofins_codigo, subtipo, comercializavel, subgrp_codigo, ativo, descricao)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, String(r.imposto || '').toUpperCase(), String(r.destinacao || '').toUpperCase(), r.monofasico === null || r.monofasico === undefined ? null : Boolean(r.monofasico), orNull(r.cfop_sufixo), orNull(r.cst_final), orNull(r.st_codigo), orNull(r.pis_codigo), orNull(r.cofins_codigo), orNull(r.subtipo), orNull(r.comercializavel), orNull(r.subgrp_codigo), r.ativo !== false, orNull(r.descricao)));
        }
        for (const o of (_b = body.opf) !== null && _b !== void 0 ? _b : []) {
            if (!String((_c = o.opf_codigo) !== null && _c !== void 0 ? _c : '').trim())
                continue;
            ops.push(this.prisma.$executeRawUnsafe(`INSERT INTO com_fiscal_opf_destinacao (opf_codigo, destinacao, ativo) VALUES ($1,$2,$3)`, String(o.opf_codigo).trim(), String(o.destinacao || '').toUpperCase(), o.ativo !== false));
        }
        for (const o of (_d = body.origem) !== null && _d !== void 0 ? _d : []) {
            if (!String((_e = o.origem_de) !== null && _e !== void 0 ? _e : '').trim())
                continue;
            ops.push(this.prisma.$executeRawUnsafe(`INSERT INTO com_fiscal_origem_cst (origem_de, origem_para, ativo) VALUES ($1,$2,$3)`, String(o.origem_de).trim(), String(o.origem_para || '').trim(), o.ativo !== false));
        }
        for (const c of (_f = body.cfops) !== null && _f !== void 0 ? _f : []) {
            if (!String((_g = c.cfop_fornecedor) !== null && _g !== void 0 ? _g : '').trim() || !String((_h = c.cfop_entrada) !== null && _h !== void 0 ? _h : '').trim())
                continue;
            ops.push(this.prisma.$executeRawUnsafe(`INSERT INTO com_fiscal_cfop (cfop_fornecedor, destinacao, tem_cest, cfop_entrada, cst_final, ativo, descricao)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`, this.digitsOnly(c.cfop_fornecedor), String(c.destinacao || 'QUALQUER').toUpperCase(), String(c.tem_cest || 'QUALQUER').toUpperCase(), this.digitsOnly(c.cfop_entrada), orNull(c.cst_final ? this.digitsOnly(c.cst_final).slice(-2) : null), c.ativo !== false, orNull(c.descricao)));
        }
        await this.prisma.$transaction(ops);
        this.invalidateFiscalRules();
        return this.getFiscalRegras();
    }
    async parseNotaParaAuditoria(xmlContent) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        const xmlStr = await this.decodeXml(xmlContent);
        if (!xmlStr)
            return null;
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xmlStr);
        const nfe = result.nfeProc ? result.nfeProc.NFe : result.NFe;
        if (!nfe || !nfe.infNFe || !nfe.infNFe.det)
            return null;
        const infNfe = nfe.infNFe;
        const emit = infNfe.emit || {};
        const ide = infNfe.ide || {};
        const icmsTot = ((_a = infNfe.total) === null || _a === void 0 ? void 0 : _a.ICMSTot) || {};
        const chave = String(((_b = infNfe['$']) === null || _b === void 0 ? void 0 : _b.Id) || '').replace('NFe', '');
        const det = Array.isArray(infNfe.det) ? infNfe.det : [infNfe.det];
        const itens = det.map((item, idx) => {
            var _a, _b, _c, _d, _e;
            const prod = item.prod || {};
            const imposto = item.imposto || {};
            let origem = '';
            let cstFinal = '';
            let stDestacado = 0;
            for (const key of Object.keys(imposto.ICMS || {})) {
                const vals = imposto.ICMS[key] || {};
                if (vals.orig != null)
                    origem = String(vals.orig);
                const cst = String((_b = (_a = vals.CST) !== null && _a !== void 0 ? _a : vals.CSOSN) !== null && _b !== void 0 ? _b : '');
                if (cst)
                    cstFinal = cst.slice(-2);
                if (vals.vICMSST != null)
                    stDestacado = parseFloat(vals.vICMSST) || 0;
            }
            const nItem = parseInt((_d = (_c = item['$']) === null || _c === void 0 ? void 0 : _c.nItem) !== null && _d !== void 0 ? _d : '', 10);
            return {
                nItem: Number.isFinite(nItem) ? nItem : idx + 1,
                ncm: (_e = prod.NCM) !== null && _e !== void 0 ? _e : null,
                origemNota: origem,
                cstFinalNota: cstFinal,
                stDestacado,
            };
        });
        return {
            chave,
            numero: (_c = ide.nNF) !== null && _c !== void 0 ? _c : null,
            serie: (_d = ide.serie) !== null && _d !== void 0 ? _d : null,
            modelo: (_e = ide.mod) !== null && _e !== void 0 ? _e : null,
            dataEmissao: (_g = (_f = ide.dhEmi) !== null && _f !== void 0 ? _f : ide.dEmi) !== null && _g !== void 0 ? _g : null,
            cnpjEmitente: (_j = (_h = emit.CNPJ) !== null && _h !== void 0 ? _h : emit.CPF) !== null && _j !== void 0 ? _j : null,
            ufEmitente: (_l = (_k = emit.enderEmit) === null || _k === void 0 ? void 0 : _k.UF) !== null && _l !== void 0 ? _l : null,
            emitente: (_m = emit.xNome) !== null && _m !== void 0 ? _m : null,
            valorTotal: parseFloat(icmsTot.vNF || 0) || 0,
            itens,
        };
    }
    async fetchLancamentoErp(chaveNfe) {
        return this.erpApi.comFallback(() => this.fetchLancamentoErpViaApi(chaveNfe), () => this.fetchLancamentoErpViaOpenQuery(chaveNfe));
    }
    async fetchLancamentoErpViaApi(chaveNfe) {
        const notas = await this.erpApi.nfEntradaPorChaves([chaveNfe]);
        if (!notas.length)
            return null;
        const header = notas.reduce((maior, atual) => Number(atual.NFE) > Number(maior.NFE) ? atual : maior);
        const itens = await this.erpApi.nfeItens(Number(header.NFE));
        return { header, itens };
    }
    async fetchLancamentoErpViaOpenQuery(chaveNfe) {
        const safeChave = String(chaveNfe).replace(/'/g, "''");
        const headSql = `
      SELECT FIRST 1 NFE, NOTA_FISCAL, SERIE, MODELO_NOTA, FOR_CODIGO, CHAVE_NFE,
             TOTAL_NOTA, DT_EMISSAO, DT_ENTRADA, OPF_CODIGO
      FROM NF_ENTRADA
      WHERE EMPRESA = 1 AND CHAVE_NFE = '${safeChave}' AND STATUS = 1
      ORDER BY NFE DESC
    `;
        const headRows = await this.openQuery.query(`SELECT * FROM OPENQUERY(CONSULTA, '${headSql.replace(/'/g, "''")}')`, {}, { timeout: 300000, allowZeroRows: true });
        const header = headRows[0];
        if (!header)
            return null;
        const itemSql = `
      SELECT ITEM, PRO_CODIGO, CFOP, CFOP_NOTA, CST, CST_FISCAL, ALIQ_ICMS, ST_VALOR
      FROM NFE_ITENS
      WHERE EMPRESA = 1 AND NFE = ${Number(header.NFE)}
      ORDER BY ITEM
    `;
        const itens = await this.openQuery.query(`SELECT * FROM OPENQUERY(CONSULTA, '${itemSql.replace(/'/g, "''")}')`, {}, { timeout: 300000, allowZeroRows: true });
        return { header, itens };
    }
    async existsInNfeDistribuicao(chaveNfe) {
        return this.erpApi.comFallback(() => this.erpApi.nfeDistribuicaoTemChave(chaveNfe), () => this.existsInNfeDistribuicaoViaOpenQuery(chaveNfe));
    }
    async existsInNfeDistribuicaoViaOpenQuery(chaveNfe) {
        const safe = String(chaveNfe).replace(/'/g, "''");
        const fb = `SELECT FIRST 1 CHAVE_NFE FROM NFE_DISTRIBUICAO WHERE EMPRESA = 1 AND IMPORTADA = 'N' AND CHAVE_NFE = '${safe}'`;
        try {
            const rows = await this.openQuery.query(`SELECT * FROM OPENQUERY(CONSULTA, '${fb.replace(/'/g, "''")}')`, {}, { timeout: 120000, allowZeroRows: true });
            return rows.length > 0;
        }
        catch (e) {
            this.logger.error(`Falha ao checar NFE_DISTRIBUICAO ${chaveNfe}`, e instanceof Error ? e.stack : String(e), 'Auditoria');
            return true;
        }
    }
    async reconciliarStatusEntrada(chaveNfe) {
        const erp = await this.fetchLancamentoErp(chaveNfe);
        if (erp)
            return 'LANCADA';
        const naDistribuicao = await this.existsInNfeDistribuicao(chaveNfe);
        const status = naDistribuicao ? 'PENDENTE' : 'EXCLUIDA';
        await this.prisma.nfeConciliacao.update({
            where: { chave_nfe: chaveNfe },
            data: { status_erp: status, updated_at: new Date() },
        });
        this.logger.log(`Reconferência: NF ${chaveNfe} não está mais lançada no ERP → status ${status}.`, 'Auditoria');
        return status;
    }
    async computarAuditoria(chaveNfe, opts = {}) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        const nfeRow = await this.prisma.nfeConciliacao.findUnique({
            where: { chave_nfe: chaveNfe },
            select: { xml_completo: true },
        });
        if (!nfeRow)
            return null;
        const xml = await this.normalizeBlobXml(nfeRow.xml_completo);
        if (this.detectXmlType(xml) !== 'COMPLETO')
            return null;
        const nota = await this.parseNotaParaAuditoria(xml);
        if (!nota)
            return null;
        const erp = await this.fetchLancamentoErp(chaveNfe);
        if (!erp)
            return null;
        const conf = await this.prisma.$queryRawUnsafe(`SELECT n_item, pro_codigo, imposto_escolhido, destinacao_mercadoria
             FROM com_nfe_conciliacao_item WHERE chave_nfe = $1`, chaveNfe);
        const confByItem = new Map();
        for (const c of conf)
            confByItem.set(Number(c.n_item), c);
        const semConferencia = conf.length === 0;
        const intra = this.isWithinMtByChave(chaveNfe);
        const h = erp.header;
        const cabecalho = [];
        const addCab = (campo, esperado, encontrado, norm = (x) => String(x !== null && x !== void 0 ? x : '').trim()) => {
            const ok = norm(esperado) === norm(encontrado);
            cabecalho.push({ campo, esperado: String(esperado !== null && esperado !== void 0 ? esperado : ''), encontrado: String(encontrado !== null && encontrado !== void 0 ? encontrado : ''), ok, mensagem: ok ? undefined : `${campo} divergente` });
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
        const itens = [];
        if (this.digitsOnly(h.MODELO_NOTA) === '55') {
            const rules = await this.getFiscalRules();
            const notaByItem = new Map();
            for (const it of nota.itens)
                notaByItem.set(it.nItem, it);
            let destinacaoIntra = null;
            if (intra) {
                const destOpf = (_a = rules.opf.get(this.digitsOnly(h.OPF_CODIGO))) !== null && _a !== void 0 ? _a : this.destinacaoPorOpf(h.OPF_CODIGO);
                destinacaoIntra = destOpf === 'COMERCIALIZACAO' || destOpf === 'USO_CONSUMO' ? destOpf : null;
            }
            for (const ei of erp.itens) {
                const nItem = Number(ei.ITEM);
                const proCodigo = String((_b = ei.PRO_CODIGO) !== null && _b !== void 0 ? _b : '');
                const cfopLanc = this.digitsOnly(ei.CFOP);
                const cstFiscalLanc = this.digitsOnly(ei.CST_FISCAL).padStart(3, '0');
                const notaItem = notaByItem.get(nItem);
                const cItem = confByItem.get(nItem);
                const checks = [];
                const prod = proCodigo ? await this.findInternalProduct(proCodigo, !!opts.produtoDireto) : null;
                const descricao = (_c = prod === null || prod === void 0 ? void 0 : prod.PRO_DESCRICAO) !== null && _c !== void 0 ? _c : null;
                let imposto = null;
                let destinacao = null;
                if (cItem) {
                    imposto = cItem.imposto_escolhido;
                    destinacao = cItem.destinacao_mercadoria;
                }
                else {
                    const inferido = this.classificacaoPorCfop(cfopLanc);
                    if (inferido) {
                        imposto = inferido.imposto;
                        destinacao = inferido.destinacao;
                    }
                }
                const subItem = this.digitsOnly(prod === null || prod === void 0 ? void 0 : prod.SUBTIPO);
                const destSubtipo = subItem === '00' ? 'COMERCIALIZACAO' : subItem === '07' ? 'USO_CONSUMO' : null;
                if (destSubtipo)
                    destinacao = destSubtipo;
                else if (intra && destinacaoIntra)
                    destinacao = destinacaoIntra;
                const monofasico = this.isMonofasicoNcm(this.cleanDigits((_d = notaItem === null || notaItem === void 0 ? void 0 : notaItem.ncm) !== null && _d !== void 0 ? _d : ''));
                const reg = this.regraEsperada(rules, imposto, destinacao, monofasico);
                const cfopNota = this.digitsOnly(ei.CFOP_NOTA);
                const ehSt = cItem
                    ? String((_e = cItem.imposto_escolhido) !== null && _e !== void 0 ? _e : '').toUpperCase() === 'ST'
                    : (String((_f = prod === null || prod === void 0 ? void 0 : prod.ST_CODIGO) !== null && _f !== void 0 ? _f : '').toUpperCase() === 'ST0-X' || !!String((_g = prod === null || prod === void 0 ? void 0 : prod.CEST) !== null && _g !== void 0 ? _g : '').trim());
                const expCfop = this.cfopRegraEsperada(rules, cfopNota, destinacao, ehSt);
                const cfopExp = (_h = expCfop === null || expCfop === void 0 ? void 0 : expCfop.cfopEntrada) !== null && _h !== void 0 ? _h : (reg.cfopSufixo ? (intra ? '1' : '2') + reg.cfopSufixo : null);
                const cstFinalExp = (_j = expCfop === null || expCfop === void 0 ? void 0 : expCfop.cstFinal) !== null && _j !== void 0 ? _j : reg.cstFinal;
                if (cfopExp) {
                    checks.push({ campo: 'CFOP', esperado: cfopExp, encontrado: cfopLanc || '', ok: !cfopLanc || cfopLanc === cfopExp });
                }
                else if (cfopLanc) {
                    checks.push({ campo: 'CFOP', esperado: null, encontrado: cfopLanc, ok: false, mensagem: `CFOP ${cfopLanc} (fornecedor ${cfopNota || '?'}) sem regra cadastrada — verifique em Regras fiscais` });
                }
                if (cstFinalExp) {
                    const enc = cstFiscalLanc ? cstFiscalLanc.slice(-2) : '';
                    checks.push({ campo: 'CST final', esperado: cstFinalExp, encontrado: enc, ok: !enc || enc === cstFinalExp });
                }
                if ((notaItem === null || notaItem === void 0 ? void 0 : notaItem.origemNota) && cstFiscalLanc.length === 3) {
                    const origemExp = (_k = rules.origem.get(notaItem.origemNota)) !== null && _k !== void 0 ? _k : this.origemEsperada(notaItem.origemNota);
                    const enc = cstFiscalLanc.slice(0, 1);
                    checks.push({ campo: 'CST origem', esperado: origemExp, encontrado: enc, ok: enc === origemExp });
                }
                if (proCodigo && !prod) {
                    checks.push({ campo: 'Cadastro', esperado: 'Cadastrado', encontrado: 'Não encontrado', ok: false, mensagem: `Produto ${proCodigo} não encontrado no cadastro (Stage_Produtos)` });
                }
                else if (prod) {
                    const pc = this.pisCofinsEsperado(prod.SUBTIPO, monofasico);
                    const stEsperado = String((_l = prod.CEST) !== null && _l !== void 0 ? _l : '').trim() ? 'ST0-X' : null;
                    const cad = [
                        ['Cadastro ST_CODIGO', stEsperado, prod.ST_CODIGO],
                        ['Cadastro PIS', pc.pis, prod.PIS_CODIGO],
                        ['Cadastro COFINS', pc.cofins, prod.COFINS_CODIGO],
                        ['Cadastro SUBTIPO', reg.subtipo, prod.SUBTIPO],
                        ['Cadastro COMERCIALIZAVEL', reg.comercializavel, prod.COMERCIALIZAVEL],
                        ['Cadastro SUBGRP', reg.subgrp, prod.SUBGRP_CODIGO],
                    ];
                    for (const [campo, esp, enc] of cad) {
                        if (esp == null || String(esp).trim() === '')
                            continue;
                        const ok = String(enc !== null && enc !== void 0 ? enc : '').trim().toUpperCase() === String(esp).trim().toUpperCase();
                        checks.push({ campo, esperado: String(esp), encontrado: String(enc !== null && enc !== void 0 ? enc : '') || 'vazio', ok });
                    }
                }
                itens.push({ nItem, proCodigo, descricao, imposto, destinacao, checks });
            }
        }
        return { nota, header: h, semConferencia, cabecalho, itens };
    }
    errosFromComputado(r) {
        var _a, _b;
        const erros = [];
        for (const c of r.cabecalho) {
            if (!c.ok)
                erros.push({ escopo: 'CABECALHO', campo: c.campo, esperado: c.esperado, encontrado: c.encontrado, mensagem: (_a = c.mensagem) !== null && _a !== void 0 ? _a : `${c.campo} divergente` });
        }
        for (const it of r.itens) {
            for (const c of it.checks) {
                if (!c.ok)
                    erros.push({ escopo: 'ITEM', nItem: it.nItem, proCodigo: it.proCodigo, campo: c.campo, esperado: c.esperado, encontrado: c.encontrado, mensagem: (_b = c.mensagem) !== null && _b !== void 0 ? _b : `${c.campo}: esperado ${c.esperado}, lançado ${c.encontrado}` });
            }
        }
        return erros;
    }
    async getRessalvasMap(chaveNfe) {
        var _a;
        const m = new Map();
        try {
            const rows = await this.prisma.$queryRawUnsafe(`SELECT n_item, motivo FROM com_nfe_ressalva WHERE chave_nfe = $1`, chaveNfe);
            for (const r of rows)
                m.set(Number(r.n_item), (_a = r.motivo) !== null && _a !== void 0 ? _a : null);
        }
        catch (_b) {
        }
        return m;
    }
    escopoNItem(e) {
        var _a;
        return e.escopo === 'CABECALHO' ? 0 : ((_a = e.nItem) !== null && _a !== void 0 ? _a : 0);
    }
    async auditarLancamentoFiscal(chaveNfe, opts = {}) {
        var _a, _b, _c;
        const enviarAlerta = opts.enviarAlerta !== false;
        try {
            const nfeRow = await this.prisma.nfeConciliacao.findUnique({
                where: { chave_nfe: chaveNfe },
                select: { auditoria_alerta_em: true },
            });
            const r = await this.computarAuditoria(chaveNfe, { produtoDireto: opts.produtoDireto });
            if (!r)
                return;
            const erros = this.errosFromComputado(r);
            const ressalvas = await this.getRessalvasMap(chaveNfe);
            const errosEfetivos = erros.filter((e) => !ressalvas.has(this.escopoNItem(e)));
            const status = errosEfetivos.length > 0 ? 'DIVERGENTE' : 'OK';
            await this.prisma.nfeConciliacao.update({
                where: { chave_nfe: chaveNfe },
                data: { auditoria_fiscal_em: new Date(), auditoria_fiscal_status: status },
            });
            await this.prisma.$executeRawUnsafe(`DELETE FROM com_nfe_auditoria_item WHERE chave_nfe = $1`, chaveNfe);
            for (const e of erros) {
                await this.prisma.$executeRawUnsafe(`INSERT INTO com_nfe_auditoria_item (chave_nfe, n_item, campo, esperado, encontrado, mensagem)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (chave_nfe, n_item, campo) DO UPDATE
                       SET esperado = EXCLUDED.esperado, encontrado = EXCLUDED.encontrado, mensagem = EXCLUDED.mensagem`, chaveNfe, (_a = e.nItem) !== null && _a !== void 0 ? _a : 0, e.campo, (_b = e.esperado) !== null && _b !== void 0 ? _b : null, (_c = e.encontrado) !== null && _c !== void 0 ? _c : null, e.mensagem);
            }
            if (enviarAlerta && errosEfetivos.length > 0 && !(nfeRow === null || nfeRow === void 0 ? void 0 : nfeRow.auditoria_alerta_em)) {
                const webhook = process.env.N8N_AUDITORIA_WEBHOOK_URL;
                if (!webhook) {
                    this.logger.warn('N8N_AUDITORIA_WEBHOOK_URL não configurada: pulando alerta de auditoria.', 'Auditoria');
                }
                else {
                    const payload = this.montarPayloadAuditoria(chaveNfe, r, status, errosEfetivos, 'automatico');
                    const resp = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    if (resp.ok) {
                        await this.prisma.nfeConciliacao.update({ where: { chave_nfe: chaveNfe }, data: { auditoria_alerta_em: new Date() } });
                        this.logger.log(`Alerta de auditoria enviado para ${chaveNfe} (${erros.length} erro(s)).`, 'Auditoria');
                    }
                    else {
                        this.logger.error(`n8n recusou alerta de auditoria ${chaveNfe}: HTTP ${resp.status}.`, undefined, 'Auditoria');
                    }
                }
            }
        }
        catch (e) {
            this.logger.error(`Falha ao auditar lançamento ${chaveNfe}`, e instanceof Error ? e.stack : String(e), 'Auditoria');
        }
    }
    montarPayloadAuditoria(chaveNfe, r, status, errosEfetivos, origem = 'automatico') {
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
    async enviarAlertaAuditoria(chaveNfe) {
        const r = await this.computarAuditoria(chaveNfe, { produtoDireto: true });
        if (!r)
            return null;
        const erros = this.errosFromComputado(r);
        const ressalvas = await this.getRessalvasMap(chaveNfe);
        const errosEfetivos = erros.filter((e) => !ressalvas.has(this.escopoNItem(e)));
        const status = errosEfetivos.length > 0 ? 'DIVERGENTE' : 'OK';
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
        this.logger.log(`Alerta de auditoria (manual) enviado para ${chaveNfe} (${errosEfetivos.length} erro(s)).`, 'Auditoria');
        return { enviado: true, totalErros: errosEfetivos.length, status };
    }
    blocosErrosDoDetalhe(detalhe) {
        var _a, _b, _c;
        const fmt = (c) => {
            var _a, _b;
            return c.esperado != null || c.encontrado != null
                ? `   • ${c.campo}: Errado ${(_a = c.encontrado) !== null && _a !== void 0 ? _a : '-'}. mudar para ${(_b = c.esperado) !== null && _b !== void 0 ? _b : '-'}`
                : `   • ${c.mensagem || c.campo}`;
        };
        const blocos = [];
        const cab = ((_a = detalhe === null || detalhe === void 0 ? void 0 : detalhe.cabecalho) !== null && _a !== void 0 ? _a : []).filter((c) => !c.ok && !c.ressalvado);
        if (cab.length)
            blocos.push(`• CABEÇALHO\n${cab.map(fmt).join('\n')}`);
        for (const it of (_b = detalhe === null || detalhe === void 0 ? void 0 : detalhe.itens) !== null && _b !== void 0 ? _b : []) {
            if (it.ressalvado)
                continue;
            const ck = ((_c = it.checks) !== null && _c !== void 0 ? _c : []).filter((c) => !c.ok);
            if (!ck.length)
                continue;
            const key = it.proCodigo || `Item ${it.nItem}`;
            blocos.push(`• PRODUTO: ${key}\n${ck.map(fmt).join('\n')}`);
        }
        return blocos.join('\n\n');
    }
    async wahaEnviarTexto(text, replyTo) {
        const base = process.env.WAHA_BASE_URL;
        const key = process.env.WAHA_API_KEY;
        const session = process.env.WAHA_SESSION || 'default';
        const group = process.env.WAHA_GROUP_CHAT_ID;
        if (!base || !key || !group)
            return;
        const body = { session, chatId: group, text };
        if (replyTo)
            body.reply_to = replyTo;
        await fetch(`${base.replace(/\/$/, '')}/api/sendText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
            body: JSON.stringify(body),
        });
    }
    async processarRespostasAjustadoWaha() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
        const base = process.env.WAHA_BASE_URL;
        const key = process.env.WAHA_API_KEY;
        const session = process.env.WAHA_SESSION || 'default';
        const group = process.env.WAHA_GROUP_CHAT_ID;
        if (!base || !key || !group) {
            this.logger.warn('WAHA_BASE_URL/WAHA_API_KEY/WAHA_GROUP_CHAT_ID não configurados: pulando polling de "ajustado".', 'Auditoria');
            return;
        }
        const janelaMin = Number(process.env.WAHA_AJUSTADO_JANELA_MIN) > 0 ? Number(process.env.WAHA_AJUSTADO_JANELA_MIN) : 1440;
        const limiteAntigoSec = Math.floor(Date.now() / 1000) - janelaMin * 60;
        const msgLimit = Number(process.env.WAHA_AJUSTADO_MSG_LIMIT) > 0 ? Number(process.env.WAHA_AJUSTADO_MSG_LIMIT) : 200;
        const url = `${base.replace(/\/$/, '')}/api/${session}/chats/${encodeURIComponent(group)}/messages?limit=${msgLimit}&downloadMedia=false`;
        const resp = await fetch(url, { headers: { 'X-Api-Key': key } });
        if (!resp.ok) {
            this.logger.error(`WAHA recusou leitura de mensagens: HTTP ${resp.status}`, undefined, 'Auditoria');
            return;
        }
        const msgs = await resp.json();
        if (!Array.isArray(msgs))
            return;
        for (const m of msgs) {
            try {
                if (m === null || m === void 0 ? void 0 : m.fromMe)
                    continue;
                const body = String((_a = m === null || m === void 0 ? void 0 : m.body) !== null && _a !== void 0 ? _a : '');
                if (!/ajustad[oa]/i.test(body))
                    continue;
                const msgId = String((_b = m === null || m === void 0 ? void 0 : m.id) !== null && _b !== void 0 ? _b : '');
                if (!msgId)
                    continue;
                const ja = await this.prisma.$queryRawUnsafe(`SELECT 1 FROM com_nfe_ajustado_processado WHERE waha_msg_id = $1`, msgId);
                if (ja.length > 0)
                    continue;
                const ts = Number((_c = m === null || m === void 0 ? void 0 : m.timestamp) !== null && _c !== void 0 ? _c : 0);
                if (ts && ts < limiteAntigoSec) {
                    await this.marcarAjustadoProcessado(msgId, null, 'ANTIGO');
                    continue;
                }
                const citada = String((_h = (_e = (_d = m === null || m === void 0 ? void 0 : m.replyTo) === null || _d === void 0 ? void 0 : _d.body) !== null && _e !== void 0 ? _e : (_g = (_f = m === null || m === void 0 ? void 0 : m._data) === null || _f === void 0 ? void 0 : _f.quotedMsg) === null || _g === void 0 ? void 0 : _g.body) !== null && _h !== void 0 ? _h : '');
                const match = `${citada}\n${body}`.match(/(\d{44})/);
                if (!match) {
                    await this.wahaEnviarTexto('❓ Não consegui identificar a NF. *Responda à mensagem do alerta* (citando) com *ajustado*.', msgId);
                    await this.marcarAjustadoProcessado(msgId, null, 'SEM_CHAVE');
                    continue;
                }
                const chave = match[1];
                const detalhe = await this.reconferirAuditoria(chave);
                if (!detalhe) {
                    await this.wahaEnviarTexto(`⚠️ NF não encontrada na base de conciliação.\nChave: ${chave}`, msgId);
                    await this.marcarAjustadoProcessado(msgId, chave, 'NAO_ENCONTRADA');
                    continue;
                }
                const h = detalhe.header;
                const numero = (_j = h === null || h === void 0 ? void 0 : h.numero) !== null && _j !== void 0 ? _j : '-';
                let texto;
                let resultado;
                if (h === null || h === void 0 ? void 0 : h.naoAuditavel) {
                    texto = `ℹ️ *NF ${numero}* não está mais lançada no ERP (${(_k = h === null || h === void 0 ? void 0 : h.statusErp) !== null && _k !== void 0 ? _k : '—'}) — fora da auditoria.\n\`${chave}\``;
                    resultado = 'NAO_AUDITAVEL';
                }
                else if (((_l = h === null || h === void 0 ? void 0 : h.totalErros) !== null && _l !== void 0 ? _l : 0) === 0) {
                    texto =
                        `🧾 *Auditoria fiscal* — ✅ *OK*\n\n` +
                            `NF: *${numero}* - ${(_m = h === null || h === void 0 ? void 0 : h.emitente) !== null && _m !== void 0 ? _m : '-'} (${(_o = h === null || h === void 0 ? void 0 : h.uf) !== null && _o !== void 0 ? _o : '-'})\n\n` +
                            `100% ajustada! Sem divergências. 👏\n\`${chave}\``;
                    resultado = 'OK';
                }
                else {
                    texto =
                        `🧾 *Auditoria fiscal* — 🚫 *ERRO* 🚫\n\n` +
                            `NF: *${numero}* - ${(_p = h === null || h === void 0 ? void 0 : h.emitente) !== null && _p !== void 0 ? _p : '-'} (${(_q = h === null || h === void 0 ? void 0 : h.uf) !== null && _q !== void 0 ? _q : '-'})\n\n` +
                            `Erros (${h.totalErros}):\n\n${this.blocosErrosDoDetalhe(detalhe) || '—'}\n\n` +
                            `↩️ Após ajustar no ERP, responda *ajustado* novamente.\n\`${chave}\``;
                    resultado = 'DIVERGENTE';
                }
                await this.wahaEnviarTexto(texto, msgId);
                await this.marcarAjustadoProcessado(msgId, chave, resultado);
                this.logger.log(`Resposta "ajustado" tratada (NF ${numero}, ${resultado}).`, 'Auditoria');
            }
            catch (e) {
                this.logger.error(`Falha ao tratar resposta "ajustado" (msg ${m === null || m === void 0 ? void 0 : m.id}): ${e instanceof Error ? e.message : String(e)}`, undefined, 'Auditoria');
            }
        }
    }
    async marcarAjustadoProcessado(msgId, chave, resultado) {
        await this.prisma.$executeRawUnsafe(`INSERT INTO com_nfe_ajustado_processado (waha_msg_id, chave_nfe, resultado)
             VALUES ($1, $2, $3) ON CONFLICT (waha_msg_id) DO NOTHING`, msgId, chave, resultado);
    }
    cufToSigla(cuf) {
        var _a;
        return (_a = IcmsService_1.CUF_SIGLA[String(cuf !== null && cuf !== void 0 ? cuf : '')]) !== null && _a !== void 0 ? _a : String(cuf !== null && cuf !== void 0 ? cuf : '');
    }
    resolveJanelaEntrada(dtInicio, dtFim) {
        const now = new Date();
        const inicio = dtInicio
            ? new Date(`${dtInicio}T00:00:00`)
            : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        const fim = dtFim
            ? new Date(`${dtFim}T23:59:59.999`)
            : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        return { inicio, fim };
    }
    buildAuditoriaFiltro(f) {
        const { inicio, fim } = this.resolveJanelaEntrada(f.dtInicio, f.dtFim);
        const params = [];
        const cond = [`c.status_erp = 'LANCADA'`];
        params.push(inicio);
        cond.push(`c.dt_entrada >= $${params.length}`);
        params.push(fim);
        cond.push(`c.dt_entrada <= $${params.length}`);
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
        if (esc === 'DENTRO')
            cond.push(`left(c.chave_nfe, 2) = '51'`);
        else if (esc === 'FORA')
            cond.push(`left(c.chave_nfe, 2) <> '51'`);
        const st = String(f.status || 'TODOS').toUpperCase();
        if (st === 'PENDENTE')
            cond.push(`c.auditoria_fiscal_status IS NULL`);
        else if (st === 'OK' || st === 'DIVERGENTE' || st === 'SEM_CONFERENCIA') {
            params.push(st);
            cond.push(`c.auditoria_fiscal_status = $${params.length}`);
        }
        return { where: cond.join(' AND '), params };
    }
    async reconferirPeriodo(f) {
        const { where, params } = this.buildAuditoriaFiltro(f);
        const chaveRows = await this.prisma.$queryRawUnsafe(`SELECT c.chave_nfe FROM com_nfe_conciliacao c WHERE ${where}
             ORDER BY c.dt_entrada DESC NULLS LAST LIMIT 2000`, ...params);
        const chaves = chaveRows.map((r) => r.chave_nfe);
        for (const chave of chaves) {
            const status = await this.reconciliarStatusEntrada(chave);
            if (status === 'LANCADA') {
                await this.auditarLancamentoFiscal(chave, { enviarAlerta: false, produtoDireto: true });
            }
        }
        const sumRows = await this.prisma.$queryRawUnsafe(`SELECT auditoria_fiscal_status AS s, count(*)::int AS c
             FROM com_nfe_conciliacao c WHERE ${where} GROUP BY auditoria_fiscal_status`, ...params);
        const by = (s) => { var _a, _b; return Number((_b = (_a = sumRows.find((r) => r.s === s)) === null || _a === void 0 ? void 0 : _a.c) !== null && _b !== void 0 ? _b : 0); };
        return {
            total: chaves.length,
            ok: by('OK'),
            divergente: by('DIVERGENTE'),
        };
    }
    async reauditarPendentesAlerta(diasJanela = 7, limite = 300) {
        const dias = Number.isFinite(diasJanela) && diasJanela > 0 ? Math.floor(diasJanela) : 7;
        const agora = new Date();
        const cutoff = new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000);
        const pendentes = await this.prisma.nfeConciliacao.findMany({
            where: {
                status_erp: 'LANCADA',
                auditoria_alerta_em: null,
                dt_entrada: { gte: cutoff, lte: agora },
            },
            select: { chave_nfe: true },
            orderBy: { dt_entrada: 'desc' },
            take: Math.max(1, Math.floor(limite)),
        });
        for (const n of pendentes) {
            await this.auditarLancamentoFiscal(n.chave_nfe, { produtoDireto: true });
        }
        return { avaliadas: pendentes.length };
    }
    async listAuditorias(f) {
        var _a, _b;
        const { where, params } = this.buildAuditoriaFiltro(f);
        const page = Math.max(1, Number(f.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 20));
        const offset = (page - 1) * pageSize;
        const totalRows = await this.prisma.$queryRawUnsafe(`SELECT count(*)::int AS total FROM com_nfe_conciliacao c WHERE ${where}`, ...params);
        const total = (_b = (_a = totalRows[0]) === null || _a === void 0 ? void 0 : _a.total) !== null && _b !== void 0 ? _b : 0;
        const buildRows = (comRessalva) => `
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
        let rows;
        try {
            rows = await this.prisma.$queryRawUnsafe(buildRows(true), ...params);
        }
        catch (_c) {
            rows = await this.prisma.$queryRawUnsafe(buildRows(false), ...params);
        }
        return {
            page, pageSize, total,
            items: rows.map((r) => {
                var _a, _b, _c;
                return ({
                    chaveNfe: r.chave_nfe,
                    numero: String(Number((_a = r.numero) !== null && _a !== void 0 ? _a : '0')),
                    emitente: r.emitente,
                    cnpj: r.cnpj_emitente,
                    uf: this.cufToSigla(r.cuf),
                    dentroEstado: r.cuf === '51',
                    dataEmissao: r.data_emissao,
                    dtEntrada: r.dt_entrada,
                    valorTotal: Number(r.valor_total || 0),
                    status: (_b = r.auditoria_fiscal_status) !== null && _b !== void 0 ? _b : 'PENDENTE',
                    auditadoEm: r.auditoria_fiscal_em,
                    totalErros: (_c = r.total_erros) !== null && _c !== void 0 ? _c : 0,
                    temRessalva: !!r.tem_ressalva,
                });
            }),
        };
    }
    async exportarXmlAuditoria(f) {
        var _a;
        if (!f.dtInicio || !f.dtFim) {
            throw new common_1.BadRequestException('Selecione um período (data inicial e final) antes de exportar os XMLs.');
        }
        const { where, params } = this.buildAuditoriaFiltro(f);
        const rows = await this.prisma.$queryRawUnsafe(`SELECT c.chave_nfe, c.xml_completo, substring(c.chave_nfe from 26 for 9) AS numero
             FROM com_nfe_conciliacao c WHERE ${where}
             ORDER BY c.dt_entrada DESC NULLS LAST LIMIT 10000`, ...params);
        const items = [];
        for (const r of rows) {
            const xml = await this.normalizeBlobXml(r.xml_completo);
            if (xml)
                items.push({ nome: String(Number((_a = r.numero) !== null && _a !== void 0 ? _a : '0')), chave: r.chave_nfe, xml });
        }
        const buffer = await this.zipXmls(items);
        return { buffer, count: items.length };
    }
    zipXmls(items) {
        return new Promise((resolve, reject) => {
            const archive = (0, archiver_1.default)('zip', { zlib: { level: 9 } });
            const chunks = [];
            const stream = new stream_1.Writable({
                write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
            });
            archive.pipe(stream);
            stream.on('finish', () => resolve(Buffer.concat(chunks)));
            archive.on('error', reject);
            const usados = new Set();
            for (const it of items) {
                if (!it.xml)
                    continue;
                const base = String(it.nome || it.chave).replace(/[^\w.-]/g, '_');
                let nome = `${base}.xml`;
                if (usados.has(nome))
                    nome = `${base}_${it.chave}.xml`;
                usados.add(nome);
                archive.append(it.xml, { name: nome });
            }
            archive.finalize();
        });
    }
    async getAuditoriaDetalhe(chaveNfe, direto = false) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const rows = await this.prisma.$queryRawUnsafe(`SELECT chave_nfe, emitente, cnpj_emitente, data_emissao, dt_entrada, valor_total,
                    auditoria_fiscal_status, auditoria_fiscal_em, status_erp,
                    substring(chave_nfe from 26 for 9) AS numero, left(chave_nfe, 2) AS cuf
             FROM com_nfe_conciliacao WHERE chave_nfe = $1`, chaveNfe);
        const b = rows[0];
        if (!b)
            return null;
        const r = await this.computarAuditoria(chaveNfe, { produtoDireto: direto });
        const baseHeader = {
            chaveNfe: b.chave_nfe,
            numero: String(Number((_a = b.numero) !== null && _a !== void 0 ? _a : '0')),
            serie: (_c = (_b = r === null || r === void 0 ? void 0 : r.nota) === null || _b === void 0 ? void 0 : _b.serie) !== null && _c !== void 0 ? _c : null,
            emitente: (_f = (_d = b.emitente) !== null && _d !== void 0 ? _d : (_e = r === null || r === void 0 ? void 0 : r.nota) === null || _e === void 0 ? void 0 : _e.emitente) !== null && _f !== void 0 ? _f : null,
            cnpj: b.cnpj_emitente,
            uf: this.cufToSigla(b.cuf),
            dentroEstado: b.cuf === '51',
            dataEmissao: b.data_emissao,
            dtEntrada: b.dt_entrada,
            valorTotal: Number(b.valor_total || 0),
            statusErp: (_g = b.status_erp) !== null && _g !== void 0 ? _g : null,
            auditadoEm: b.auditoria_fiscal_em,
        };
        if (!r) {
            const lancada = b.status_erp === 'LANCADA';
            return {
                header: Object.assign(Object.assign({}, baseHeader), { status: (_h = b.auditoria_fiscal_status) !== null && _h !== void 0 ? _h : 'PENDENTE', totalErros: 0, semConferencia: false, naoAuditavel: true, mensagem: lancada
                        ? 'NF lançada sem XML completo — não há detalhe a conferir.'
                        : `NF não está mais lançada no ERP (status ${(_j = b.status_erp) !== null && _j !== void 0 ? _j : '—'}) — removida da auditoria.` }),
                cabecalho: [],
                itens: [],
            };
        }
        const contaErros = (cks) => cks.filter((c) => !c.ok).length;
        const ressalvas = await this.getRessalvasMap(chaveNfe);
        const errosCab = ressalvas.has(0) ? 0 : contaErros(r.cabecalho);
        const totalErros = errosCab + r.itens.reduce((s, it) => s + (ressalvas.has(it.nItem) ? 0 : contaErros(it.checks)), 0);
        const status = totalErros > 0 ? 'DIVERGENTE' : 'OK';
        return {
            header: Object.assign(Object.assign({}, baseHeader), { status,
                totalErros, semConferencia: r.semConferencia, naoAuditavel: false, temRessalva: ressalvas.size > 0 }),
            cabecalho: r.cabecalho.map((c) => (Object.assign(Object.assign({}, c), { ressalvado: ressalvas.has(0) }))),
            itens: r.itens.map((it) => {
                var _a;
                return ({
                    nItem: it.nItem,
                    proCodigo: it.proCodigo,
                    descricao: it.descricao,
                    imposto: it.imposto,
                    destinacao: it.destinacao,
                    totalErros: contaErros(it.checks),
                    ressalvado: ressalvas.has(it.nItem),
                    ressalvaMotivo: (_a = ressalvas.get(it.nItem)) !== null && _a !== void 0 ? _a : null,
                    checks: it.checks,
                });
            }),
        };
    }
    async reconferirAuditoria(chaveNfe) {
        const status = await this.reconciliarStatusEntrada(chaveNfe);
        if (status === 'LANCADA') {
            await this.auditarLancamentoFiscal(chaveNfe, { enviarAlerta: false, produtoDireto: true });
        }
        return this.getAuditoriaDetalhe(chaveNfe, true);
    }
    async adicionarRessalva(chaveNfe, nItem, motivo, usuario) {
        await this.prisma.$executeRawUnsafe(`INSERT INTO com_nfe_ressalva (chave_nfe, n_item, motivo, criado_por)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (chave_nfe, n_item) DO UPDATE
               SET motivo = EXCLUDED.motivo, criado_por = EXCLUDED.criado_por, created_at = now()`, chaveNfe, Number(nItem) || 0, motivo !== null && motivo !== void 0 ? motivo : null, usuario !== null && usuario !== void 0 ? usuario : null);
        await this.auditarLancamentoFiscal(chaveNfe, { enviarAlerta: false });
        return this.getAuditoriaDetalhe(chaveNfe);
    }
    async removerRessalva(chaveNfe, nItem) {
        await this.prisma.$executeRawUnsafe(`DELETE FROM com_nfe_ressalva WHERE chave_nfe = $1 AND n_item = $2`, chaveNfe, Number(nItem) || 0);
        await this.auditarLancamentoFiscal(chaveNfe, { enviarAlerta: false });
        return this.getAuditoriaDetalhe(chaveNfe);
    }
    async savePaymentStatus(dto) {
        let fiscalConference = null;
        if (Array.isArray(dto.itens) && dto.itens.length > 0) {
            fiscalConference = await this.runFiscalConference({
                notas: [{ chaveNfe: dto.chaveNfe, itens: dto.itens }],
            }, true);
            const selectedItems = Array.from(new Set(dto.itens
                .map((item) => Number(item === null || item === void 0 ? void 0 : item.item))
                .filter((item) => Number.isFinite(item) && item > 0)));
            if (selectedItems.length > 0) {
                await this.prisma.$executeRawUnsafe(`
                    DELETE FROM com_nfe_conciliacao_item
                    WHERE chave_nfe = $1
                      AND NOT (n_item = ANY($2::int[]))
                    `, dto.chaveNfe, selectedItems);
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
        return Object.assign(Object.assign({}, result), { fiscalConference });
    }
    async getPaymentStatusMap() {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const agruparTipoImposto = await this.prisma.nfeConciliacao.findMany({ select: { chave_nfe: true, tipo_imposto: true } });
        const all = await this.prisma.pagamentoGuia.findMany();
        const guias = await this.prisma.$queryRawUnsafe(`SELECT chave_nfe, bucket_name, object_path, uploaded_at FROM com_nfe_guia_pdf`);
        const conferenciaItens = await this.prisma.$queryRawUnsafe(`
            SELECT
                chave_nfe,
                n_item,
                status_conferencia,
                divergencias_json
            FROM com_nfe_conciliacao_item
            `);
        const mapTipoImposto = {};
        for (const nfe of agruparTipoImposto) {
            if (nfe.tipo_imposto)
                mapTipoImposto[nfe.chave_nfe] = nfe.tipo_imposto;
        }
        const map = {};
        for (const item of all) {
            map[item.chave_nfe] = {
                status: item.observacoes,
                valor: item.valor,
                tipo_imposto: mapTipoImposto[item.chave_nfe]
            };
        }
        for (const guia of guias) {
            const chave = String(guia.chave_nfe || '').trim();
            if (!chave)
                continue;
            map[chave] = {
                status: ((_a = map[chave]) === null || _a === void 0 ? void 0 : _a.status) || '',
                valor: ((_b = map[chave]) === null || _b === void 0 ? void 0 : _b.valor) || 0,
                tipo_imposto: ((_c = map[chave]) === null || _c === void 0 ? void 0 : _c.tipo_imposto) || mapTipoImposto[chave],
                guiaGerada: true,
                guiaPath: `${guia.bucket_name}/${guia.object_path}`,
            };
        }
        const conferenciaByChave = {};
        for (const item of conferenciaItens) {
            const chave = String((item === null || item === void 0 ? void 0 : item.chave_nfe) || '').trim();
            if (!chave)
                continue;
            if (!conferenciaByChave[chave])
                conferenciaByChave[chave] = [];
            conferenciaByChave[chave].push({
                status_conferencia: item === null || item === void 0 ? void 0 : item.status_conferencia,
                divergencias_json: item === null || item === void 0 ? void 0 : item.divergencias_json,
            });
        }
        for (const [chave, rows] of Object.entries(conferenciaByChave)) {
            const statusConferencia = this.getConferenceStatusFromRows(rows);
            map[chave] = {
                status: ((_d = map[chave]) === null || _d === void 0 ? void 0 : _d.status) || '',
                valor: ((_e = map[chave]) === null || _e === void 0 ? void 0 : _e.valor) || 0,
                tipo_imposto: ((_f = map[chave]) === null || _f === void 0 ? void 0 : _f.tipo_imposto) || mapTipoImposto[chave],
                guiaGerada: (_g = map[chave]) === null || _g === void 0 ? void 0 : _g.guiaGerada,
                guiaPath: (_h = map[chave]) === null || _h === void 0 ? void 0 : _h.guiaPath,
                status_conferencia_produtos: statusConferencia,
            };
        }
        return map;
    }
    async getPaymentStatusByKey(chaveNfe) {
        var _a, _b, _c, _d;
        const key = String(chaveNfe || '').trim();
        if (!key)
            return null;
        const nfe = await this.prisma.nfeConciliacao.findUnique({
            where: { chave_nfe: key },
            select: { tipo_imposto: true }
        });
        const pagamento = await this.prisma.pagamentoGuia.findUnique({
            where: { chave_nfe: key }
        });
        const guia = await this.prisma.$queryRawUnsafe(`
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
            `, key);
        if (!pagamento && !(nfe === null || nfe === void 0 ? void 0 : nfe.tipo_imposto) && guia.length === 0) {
            return null;
        }
        const guiaData = guia[0] || null;
        const itensConciliacao = await this.prisma.$queryRawUnsafe(`
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
            `, key);
        return {
            chaveNfe: key,
            status: (_a = pagamento === null || pagamento === void 0 ? void 0 : pagamento.observacoes) !== null && _a !== void 0 ? _a : null,
            valor: (_b = pagamento === null || pagamento === void 0 ? void 0 : pagamento.valor) !== null && _b !== void 0 ? _b : null,
            tipo_imposto: (_c = nfe === null || nfe === void 0 ? void 0 : nfe.tipo_imposto) !== null && _c !== void 0 ? _c : null,
            data_pagamento: (_d = pagamento === null || pagamento === void 0 ? void 0 : pagamento.data_pagamento) !== null && _d !== void 0 ? _d : null,
            status_conferencia_produtos: this.getConferenceStatusFromRows(itensConciliacao),
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
    async uploadGuiaByNfe(chaveNfe, file) {
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
        const pdfParseModule = await Promise.resolve().then(() => __importStar(require('pdf-parse')));
        const PDFParseClass = pdfParseModule === null || pdfParseModule === void 0 ? void 0 : pdfParseModule.PDFParse;
        if (typeof PDFParseClass !== 'function') {
            throw new Error('Biblioteca de leitura de PDF incompatível: classe PDFParse não encontrada.');
        }
        const parser = new PDFParseClass({ data: file.buffer });
        let parsedText = '';
        try {
            const parsed = await parser.getText();
            parsedText = String((parsed === null || parsed === void 0 ? void 0 : parsed.text) || '');
        }
        finally {
            await parser.destroy().catch(() => undefined);
        }
        const extracted = this.extractGuiaDataFromPdfText(parsedText, key);
        if (extracted.numeroNfExtraido && extracted.feCteConfere === false) {
            throw new common_1.BadRequestException(`A guia não corresponde à NF selecionada. NFE/CTE da guia: ${extracted.numeroNfExtraido}. Número da NF: ${String(key).substring(25, 34).replace(/^0+/, '')}.`);
        }
        const upload = await this.uploadGuiaPdfToMinio(key, Object.assign(Object.assign({}, file), { originalname: normalizedOriginalName }));
        await this.prisma.$executeRawUnsafe(`
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
            `, key, upload.bucket, upload.objectPath, normalizedOriginalName, extracted.numeroDocumento, extracted.dataVencimento, extracted.valor, extracted.feCte, extracted.numeroNfExtraido, extracted.feCteConfere, extracted.aviso);
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
    async getGuiaByNfe(chaveNfe) {
        const key = String(chaveNfe || '').trim();
        if (!key)
            return null;
        const rows = await this.prisma.$queryRawUnsafe(`
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
            `, key);
        const guia = rows[0];
        if (!guia)
            return null;
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
    async downloadGuiaByNfe(chaveNfe) {
        const guia = await this.getGuiaByNfe(chaveNfe);
        if (!(guia === null || guia === void 0 ? void 0 : guia.path))
            return null;
        const client = this.getMinioClient();
        const stream = await client.getObject(guia.bucket || this.minioBucket, guia.path);
        const fileName = this.normalizeUploadedFileName(guia.original_file_name || `guia-${String(chaveNfe || '').trim()}.pdf`);
        return { stream, fileName };
    }
    async removeGuiaByNfe(chaveNfe) {
        const key = String(chaveNfe || '').trim();
        if (!key)
            return false;
        const guia = await this.getGuiaByNfe(key);
        if (!guia)
            return false;
        try {
            if (guia.path) {
                const client = this.getMinioClient();
                await client.removeObject(guia.bucket || this.minioBucket, guia.path);
            }
        }
        catch (error) {
            this.logger.warn(`Falha ao remover objeto da guia no MinIO para NF ${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
        await this.prisma.$executeRawUnsafe(`DELETE FROM com_nfe_guia_pdf WHERE chave_nfe = $1`, key);
        return true;
    }
    dadosDaChaveNfe(chaveNfe) {
        const chave = String(chaveNfe || '').replace(/\D/g, '');
        if (chave.length !== 44)
            return null;
        return {
            chave,
            numero: chave.slice(25, 34).replace(/^0+/, ''),
            cnpjEmitente: chave.slice(6, 20),
        };
    }
    semTabelaDoScan(error) {
        const msg = error instanceof Error ? error.message : String(error);
        const ausente = /esc_documento/i.test(msg) && /(does not exist|não existe|nao existe|42P01)/i.test(msg);
        if (ausente) {
            this.logger.warn(`esc_documento indisponível — guias escaneadas não listadas (${msg}).`);
        }
        return ausente;
    }
    async getGuiasEscaneadasByNfe(chaveNfe) {
        const dados = this.dadosDaChaveNfe(chaveNfe);
        if (!dados)
            return [];
        let rows = [];
        try {
            rows = await this.prisma.$queryRawUnsafe(`
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
                `, dados.chave, dados.numero, dados.cnpjEmitente, IcmsService_1.TIPO_GUIA_ESCANEADA);
        }
        catch (error) {
            if (this.semTabelaDoScan(error))
                return [];
            throw error;
        }
        return rows.map((r) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            return ({
                id: Number(r.id),
                data_documento: String((_a = r.data_documento) !== null && _a !== void 0 ? _a : ''),
                descricao: (_b = r.descricao) !== null && _b !== void 0 ? _b : null,
                nome_arquivo: (_c = r.nome_arquivo) !== null && _c !== void 0 ? _c : null,
                tamanho_bytes: r.tamanho_bytes == null ? null : Number(r.tamanho_bytes),
                nf_numero: (_d = r.nf_numero) !== null && _d !== void 0 ? _d : null,
                chave_nfe: (_e = r.chave_nfe) !== null && _e !== void 0 ? _e : null,
                fornecedor_nome: (_f = r.fornecedor_nome) !== null && _f !== void 0 ? _f : null,
                fornecedor_cnpj: (_g = r.fornecedor_cnpj) !== null && _g !== void 0 ? _g : null,
                for_codigo: r.for_codigo == null ? null : Number(r.for_codigo),
                criado_em: r.criado_em instanceof Date ? r.criado_em.toISOString() : String((_h = r.criado_em) !== null && _h !== void 0 ? _h : ''),
                vinculo: r.vinculo,
            });
        });
    }
    async downloadGuiaEscaneada(id) {
        const idNum = Number(id);
        if (!Number.isInteger(idNum) || idNum <= 0)
            return null;
        let rows = [];
        try {
            rows = await this.prisma.$queryRawUnsafe(`
                SELECT minio_bucket, minio_key, nome_arquivo
                FROM esc_documento
                WHERE id = $1 AND tipo = $2
                `, idNum, IcmsService_1.TIPO_GUIA_ESCANEADA);
        }
        catch (error) {
            if (this.semTabelaDoScan(error))
                return null;
            throw error;
        }
        const doc = rows[0];
        if (!(doc === null || doc === void 0 ? void 0 : doc.minio_key))
            return null;
        const client = this.getMinioClient();
        const stream = await client.getObject(doc.minio_bucket || this.minioBucket, doc.minio_key);
        const fileName = this.normalizeUploadedFileName(doc.nome_arquivo || `guia-escaneada-${idNum}.pdf`);
        return { stream, fileName };
    }
    async generateDanfe(xml) {
        return new Promise(async (resolve, reject) => {
            try {
                const decodedXml = await this.decodeXml(xml);
                if (!/<([A-Za-z0-9_.-]+:)?infNFe\s[^>]*Id\s*=\s*"NFe/i.test(decodedXml)) {
                    const eCte = /<([A-Za-z0-9_.-]+:)?infCte[\s>]/i.test(decodedXml);
                    throw new Error(eCte
                        ? 'Este XML é um CT-e, não uma NF-e — o documento auxiliar dele é o DACTE.'
                        : 'Temos apenas o resumo desta NF-e (resNFe), não o XML completo. ' +
                            'Manifeste a nota na SEFAZ para baixar o documento e gerar o DANFE.');
                }
                const doc = await (0, node_pdf_nfe_1.gerarPDF)(decodedXml, { cancelada: false });
                const chunks = [];
                const stream = new stream_1.Writable({
                    write(chunk, encoding, callback) {
                        chunks.push(Buffer.from(chunk));
                        callback();
                    },
                });
                doc.pipe(stream);
                stream.on('finish', () => {
                    resolve(Buffer.concat(chunks));
                });
            }
            catch (error) {
                this.logger.error('Error generating DANFE', error);
                reject(error);
            }
        });
    }
    async generateDanfeZip(invoices) {
        return new Promise((resolve, reject) => {
            const archive = (0, archiver_1.default)('zip', {
                zlib: { level: 9 }
            });
            const chunks = [];
            const stream = new stream_1.Writable({
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
                        const pdfBuffer = await this.generateDanfe(inv.xml);
                        archive.append(pdfBuffer, { name: `DANFE_${inv.chave}.pdf` });
                    }
                    catch (e) {
                        console.error(`Failed to generate PDF for ${inv.chave}`, e);
                    }
                }
                archive.finalize();
            })();
        });
    }
};
exports.IcmsService = IcmsService;
IcmsService.MVA_LIMIAR = 50.39;
IcmsService.FISCAL_RULES_TTL_MS = 60000;
IcmsService.CUF_SIGLA = {
    '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
    '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
    '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS',
    '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
};
IcmsService.TIPO_GUIA_ESCANEADA = 'guia-icms-st';
exports.IcmsService = IcmsService = IcmsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [openquery_service_1.OpenQueryService,
        erp_api_service_1.ErpApiService,
        prisma_service_1.PrismaService,
        simples_nacional_service_1.SimplesNacionalService])
], IcmsService);
//# sourceMappingURL=icms.service.js.map