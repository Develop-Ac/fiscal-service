"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IcmsController = void 0;
const common_1 = require("@nestjs/common");
const icms_service_1 = require("./icms.service");
const fastify_file_interceptor_1 = require("../shared/http/fastify-file.interceptor");
let IcmsController = class IcmsController {
    constructor(service) {
        this.service = service;
    }
    async getInvoices(start, end) {
        return this.service.syncInvoices(start, end);
    }
    async importXmlInvoices(body) {
        const xmls = Array.isArray(body === null || body === void 0 ? void 0 : body.xmls) ? body.xmls : [];
        if (xmls.length === 0) {
            throw new common_1.BadRequestException('Nenhum XML enviado para importação.');
        }
        return this.service.importXmlInvoices(xmls);
    }
    async getInvoiceByKey(chaveNfe) {
        const invoice = await this.service.getInvoiceByKey(chaveNfe);
        if (!invoice) {
            throw new common_1.NotFoundException(`NF não encontrada: ${chaveNfe}`);
        }
        return invoice;
    }
    async syncLaunchedInvoices() {
        return this.service.startLaunchedInvoicesSyncJob();
    }
    async getSyncLaunchedInvoicesStatus(jobId) {
        const status = this.service.getLaunchedInvoicesSyncJob(jobId);
        if (!status) {
            throw new common_1.NotFoundException(`Job não encontrado: ${jobId}`);
        }
        return status;
    }
    async startXmlNormalization(body) {
        var _a;
        return this.service.startXmlNormalizationJob((_a = body === null || body === void 0 ? void 0 : body.batchSize) !== null && _a !== void 0 ? _a : 500);
    }
    async getXmlNormalizationStatus(jobId) {
        const status = this.service.getXmlNormalizationJob(jobId);
        if (!status) {
            throw new common_1.NotFoundException(`Job não encontrado: ${jobId}`);
        }
        return status;
    }
    async calculate(body) {
        const results = [];
        for (const xml of body.xmls) {
            const itemResults = await this.service.calculateStForInvoice(xml);
            results.push(...itemResults);
        }
        return results;
    }
    async savePaymentStatus(body) {
        if (Array.isArray(body)) {
            const results = [];
            for (const item of body) {
                results.push(await this.service.savePaymentStatus(item));
            }
            return results;
        }
        return this.service.savePaymentStatus(body);
    }
    async previewFiscalConference(body) {
        return this.service.previewFiscalConference(body);
    }
    async persistFiscalConference(body) {
        return this.service.persistFiscalConference(body);
    }
    async listAuditoria(q, emitente, escopo, status, dtInicio, dtFim, page, pageSize) {
        return this.service.listAuditorias({ q, emitente, escopo, status, dtInicio, dtFim, page, pageSize });
    }
    async reconferirPeriodo(q, emitente, escopo, status, dtInicio, dtFim) {
        return this.service.reconferirPeriodo({ q, emitente, escopo, status, dtInicio, dtFim });
    }
    async exportarXmlAuditoria(q, emitente, escopo, status, dtInicio, dtFim, res) {
        const { buffer, count } = await this.service.exportarXmlAuditoria({ q, emitente, escopo, status, dtInicio, dtFim });
        res.headers({
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="nfe-lancadas-xmls.zip"',
            'X-Total-Notas': String(count),
        });
        return new common_1.StreamableFile(buffer);
    }
    async getAuditoria(chaveNfe) {
        const detalhe = await this.service.getAuditoriaDetalhe(chaveNfe);
        if (!detalhe) {
            throw new common_1.NotFoundException(`Auditoria não encontrada para a NF: ${chaveNfe}`);
        }
        return detalhe;
    }
    async adicionarRessalva(chaveNfe, body) {
        var _a;
        return this.service.adicionarRessalva(chaveNfe, Number((_a = body === null || body === void 0 ? void 0 : body.nItem) !== null && _a !== void 0 ? _a : 0), body === null || body === void 0 ? void 0 : body.motivo, body === null || body === void 0 ? void 0 : body.usuario);
    }
    async removerRessalva(chaveNfe, nItem) {
        return this.service.removerRessalva(chaveNfe, Number(nItem));
    }
    async reconferirAuditoria(chaveNfe) {
        const detalhe = await this.service.reconferirAuditoria(chaveNfe);
        if (!detalhe) {
            throw new common_1.NotFoundException(`NF não encontrada para reconferir: ${chaveNfe}`);
        }
        return detalhe;
    }
    async enviarAlertaAuditoria(chaveNfe) {
        const r = await this.service.enviarAlertaAuditoria(chaveNfe);
        if (r === null) {
            throw new common_1.NotFoundException(`NF não encontrada ou sem XML completo para auditar: ${chaveNfe}`);
        }
        return r;
    }
    async getFiscalRegras() {
        return this.service.getFiscalRegras();
    }
    async saveFiscalRegras(body) {
        return this.service.saveFiscalRegras(body || {});
    }
    async getPaymentStatus() {
        return this.service.getPaymentStatusMap();
    }
    async getPaymentStatusByKey(chaveNfe) {
        const status = await this.service.getPaymentStatusByKey(chaveNfe);
        if (!status) {
            throw new common_1.NotFoundException(`Status não encontrado para a NF: ${chaveNfe}`);
        }
        return status;
    }
    async uploadGuiaByNfe(chaveNfe, file) {
        var _a;
        if (!file) {
            throw new common_1.BadRequestException('Arquivo PDF da guia não enviado.');
        }
        if (!((_a = file.mimetype) === null || _a === void 0 ? void 0 : _a.toLowerCase().includes('pdf'))) {
            throw new common_1.BadRequestException('Arquivo inválido. Envie um PDF da guia.');
        }
        return this.service.uploadGuiaByNfe(chaveNfe, file);
    }
    async getGuiaByNfe(chaveNfe) {
        const guia = await this.service.getGuiaByNfe(chaveNfe);
        if (!guia) {
            throw new common_1.NotFoundException(`Guia não encontrada para a NF: ${chaveNfe}`);
        }
        return guia;
    }
    async downloadGuiaByNfe(chaveNfe, res) {
        const payload = await this.service.downloadGuiaByNfe(chaveNfe);
        if (!payload) {
            throw new common_1.NotFoundException(`Guia não encontrada para a NF: ${chaveNfe}`);
        }
        res.headers(this.cabecalhoPdf(payload.fileName));
        return new common_1.StreamableFile(payload.stream);
    }
    async getGuiasEscaneadas(chaveNfe) {
        const guias = await this.service.getGuiasEscaneadasByNfe(chaveNfe);
        return { count: guias.length, guias };
    }
    async downloadGuiaEscaneada(id, res) {
        const payload = await this.service.downloadGuiaEscaneada(Number(id));
        if (!payload) {
            throw new common_1.NotFoundException(`Guia escaneada n\u00e3o encontrada: ${id}`);
        }
        res.headers(this.cabecalhoPdf(payload.fileName));
        return new common_1.StreamableFile(payload.stream);
    }
    cabecalhoPdf(fileName) {
        const utf8FileName = String(fileName || 'guia.pdf');
        const asciiFallback = utf8FileName
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9_.-]/g, '_') || 'guia.pdf';
        return {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(utf8FileName)}`,
        };
    }
    async removeGuiaByNfe(chaveNfe) {
        const removed = await this.service.removeGuiaByNfe(chaveNfe);
        if (!removed) {
            throw new common_1.NotFoundException(`Guia não encontrada para a NF: ${chaveNfe}`);
        }
        return { success: true, chaveNfe };
    }
    async generateDanfe(body, res) {
        const buffer = await this.service.generateDanfe(body.xml);
        res.headers({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="danfe.pdf"',
        });
        return new common_1.StreamableFile(buffer);
    }
    async generateDanfeBatch(body, res) {
        const buffer = await this.service.generateDanfeZip(body.invoices);
        res.headers({
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="danfes.zip"',
        });
        return new common_1.StreamableFile(buffer);
    }
};
exports.IcmsController = IcmsController;
__decorate([
    (0, common_1.Get)('nfe-distribuicao'),
    __param(0, (0, common_1.Query)('start')),
    __param(1, (0, common_1.Query)('end')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getInvoices", null);
__decorate([
    (0, common_1.Post)('nfe-distribuicao/import'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "importXmlInvoices", null);
__decorate([
    (0, common_1.Get)('nfe-distribuicao/:chaveNfe'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getInvoiceByKey", null);
__decorate([
    (0, common_1.Post)('nfe-lancadas/sync'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "syncLaunchedInvoices", null);
__decorate([
    (0, common_1.Get)('nfe-lancadas/sync/:jobId'),
    __param(0, (0, common_1.Param)('jobId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getSyncLaunchedInvoicesStatus", null);
__decorate([
    (0, common_1.Post)('xml/normalize'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "startXmlNormalization", null);
__decorate([
    (0, common_1.Get)('xml/normalize/:jobId'),
    __param(0, (0, common_1.Param)('jobId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getXmlNormalizationStatus", null);
__decorate([
    (0, common_1.Post)('calculate'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "calculate", null);
__decorate([
    (0, common_1.Post)('payment-status'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "savePaymentStatus", null);
__decorate([
    (0, common_1.Post)('fiscal-conferencia/preview'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "previewFiscalConference", null);
__decorate([
    (0, common_1.Post)('fiscal-conferencia'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "persistFiscalConference", null);
__decorate([
    (0, common_1.Get)('auditoria'),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, common_1.Query)('emitente')),
    __param(2, (0, common_1.Query)('escopo')),
    __param(3, (0, common_1.Query)('status')),
    __param(4, (0, common_1.Query)('dtInicio')),
    __param(5, (0, common_1.Query)('dtFim')),
    __param(6, (0, common_1.Query)('page')),
    __param(7, (0, common_1.Query)('pageSize')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String, String, String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "listAuditoria", null);
__decorate([
    (0, common_1.Post)('auditoria/reconferir-periodo'),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, common_1.Query)('emitente')),
    __param(2, (0, common_1.Query)('escopo')),
    __param(3, (0, common_1.Query)('status')),
    __param(4, (0, common_1.Query)('dtInicio')),
    __param(5, (0, common_1.Query)('dtFim')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "reconferirPeriodo", null);
__decorate([
    (0, common_1.Get)('auditoria/exportar-xml'),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, common_1.Query)('emitente')),
    __param(2, (0, common_1.Query)('escopo')),
    __param(3, (0, common_1.Query)('status')),
    __param(4, (0, common_1.Query)('dtInicio')),
    __param(5, (0, common_1.Query)('dtFim')),
    __param(6, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String, Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "exportarXmlAuditoria", null);
__decorate([
    (0, common_1.Get)('auditoria/:chaveNfe'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getAuditoria", null);
__decorate([
    (0, common_1.Post)('auditoria/:chaveNfe/ressalva'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "adicionarRessalva", null);
__decorate([
    (0, common_1.Delete)('auditoria/:chaveNfe/ressalva/:nItem'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __param(1, (0, common_1.Param)('nItem')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "removerRessalva", null);
__decorate([
    (0, common_1.Post)('auditoria/:chaveNfe/reconferir'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "reconferirAuditoria", null);
__decorate([
    (0, common_1.Post)('auditoria/:chaveNfe/enviar-whatsapp'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "enviarAlertaAuditoria", null);
__decorate([
    (0, common_1.Get)('fiscal-regras'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getFiscalRegras", null);
__decorate([
    (0, common_1.Put)('fiscal-regras'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "saveFiscalRegras", null);
__decorate([
    (0, common_1.Get)('payment-status'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getPaymentStatus", null);
__decorate([
    (0, common_1.Get)('payment-status/:chaveNfe'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getPaymentStatusByKey", null);
__decorate([
    (0, common_1.Post)('guia/:chaveNfe/upload'),
    (0, common_1.UseInterceptors)((0, fastify_file_interceptor_1.FileInterceptor)('file')),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "uploadGuiaByNfe", null);
__decorate([
    (0, common_1.Get)('guia/:chaveNfe'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getGuiaByNfe", null);
__decorate([
    (0, common_1.Get)('guia/:chaveNfe/download'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "downloadGuiaByNfe", null);
__decorate([
    (0, common_1.Get)('guia/:chaveNfe/escaneadas'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "getGuiasEscaneadas", null);
__decorate([
    (0, common_1.Get)('guia-escaneada/:id/download'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "downloadGuiaEscaneada", null);
__decorate([
    (0, common_1.Delete)('guia/:chaveNfe'),
    __param(0, (0, common_1.Param)('chaveNfe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "removeGuiaByNfe", null);
__decorate([
    (0, common_1.Post)('danfe'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "generateDanfe", null);
__decorate([
    (0, common_1.Post)('danfe/batch'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], IcmsController.prototype, "generateDanfeBatch", null);
exports.IcmsController = IcmsController = __decorate([
    (0, common_1.Controller)('icms'),
    __metadata("design:paramtypes", [icms_service_1.IcmsService])
], IcmsController);
//# sourceMappingURL=icms.controller.js.map