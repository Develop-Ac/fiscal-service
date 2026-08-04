import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, StreamableFile, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { IcmsService } from './icms.service';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { FiscalConferenceRequestDto } from './dto/fiscal-conference.dto';
import { FileInterceptor } from '@nestjs/platform-express';
@Controller('icms')
export class IcmsController {
    constructor(private readonly service: IcmsService) { }

    @Get('nfe-distribuicao')
    async getInvoices(@Query('start') start?: string, @Query('end') end?: string) {
        return this.service.syncInvoices(start, end);
    }

    @Post('nfe-distribuicao/import')
    async importXmlInvoices(@Body() body: { xmls: string[] }) {
        const xmls = Array.isArray(body?.xmls) ? body.xmls : [];
        if (xmls.length === 0) {
            throw new BadRequestException('Nenhum XML enviado para importação.');
        }
        return this.service.importXmlInvoices(xmls);
    }

    @Get('nfe-distribuicao/:chaveNfe')
    async getInvoiceByKey(@Param('chaveNfe') chaveNfe: string) {
        const invoice = await this.service.getInvoiceByKey(chaveNfe);
        if (!invoice) {
            throw new NotFoundException(`NF não encontrada: ${chaveNfe}`);
        }
        return invoice;
    }

    @Post('nfe-lancadas/sync')
    async syncLaunchedInvoices() {
        return this.service.startLaunchedInvoicesSyncJob();
    }

    @Get('nfe-lancadas/sync/:jobId')
    async getSyncLaunchedInvoicesStatus(@Param('jobId') jobId: string) {
        const status = this.service.getLaunchedInvoicesSyncJob(jobId);
        if (!status) {
            throw new NotFoundException(`Job não encontrado: ${jobId}`);
        }
        return status;
    }

    @Post('xml/normalize')
    async startXmlNormalization(@Body() body?: { batchSize?: number }) {
        return this.service.startXmlNormalizationJob(body?.batchSize ?? 500);
    }

    @Get('xml/normalize/:jobId')
    async getXmlNormalizationStatus(@Param('jobId') jobId: string) {
        const status = this.service.getXmlNormalizationJob(jobId);
        if (!status) {
            throw new NotFoundException(`Job não encontrado: ${jobId}`);
        }
        return status;
    }

    @Post('calculate')
    async calculate(@Body() body: { xmls: string[] }) {
        // In a real scenario, we might pass keys and fetch XML from DB again, or pass XML content
        // For now assuming we pass XML content or keys.
        // Ideally the frontend sends keys, and backend fetches XML from DB to calculate.
        // Let's implement key-based calculation logic helper if needed, but for now generic:

        // For 'nfe-distribuicao', frontend has the XML_COMPLETO. 
        // It can send it back to calculate, OR backend can re-fetch.
        // Sending back is easier for "Upload" mode compatibility.

        const results = [];
        for (const xml of body.xmls) {
            const itemResults = await this.service.calculateStForInvoice(xml);
            results.push(...itemResults);
        }
        return results;
    }

    @Post('payment-status')
    async savePaymentStatus(@Body() body: any) {
        if (Array.isArray(body)) {
            const results = [];
            for (const item of body) {
                results.push(await this.service.savePaymentStatus(item));
            }
            return results;
        }
        return this.service.savePaymentStatus(body);
    }

    @Post('fiscal-conferencia/preview')
    async previewFiscalConference(@Body() body: FiscalConferenceRequestDto) {
        return this.service.previewFiscalConference(body);
    }

    @Post('fiscal-conferencia')
    async persistFiscalConference(@Body() body: FiscalConferenceRequestDto) {
        return this.service.persistFiscalConference(body);
    }

    // ---- Aba "Conferência Fiscal": auditoria do lançamento ----

    @Get('auditoria')
    async listAuditoria(
        @Query('q') q?: string,
        @Query('emitente') emitente?: string,
        @Query('escopo') escopo?: string,
        @Query('status') status?: string,
        @Query('dtInicio') dtInicio?: string,
        @Query('dtFim') dtFim?: string,
        @Query('page') page?: string,
        @Query('pageSize') pageSize?: string,
    ) {
        return this.service.listAuditorias({ q, emitente, escopo, status, dtInicio, dtFim, page, pageSize });
    }

    @Post('auditoria/reconferir-periodo')
    async reconferirPeriodo(
        @Query('q') q?: string,
        @Query('emitente') emitente?: string,
        @Query('escopo') escopo?: string,
        @Query('status') status?: string,
        @Query('dtInicio') dtInicio?: string,
        @Query('dtFim') dtFim?: string,
    ) {
        return this.service.reconferirPeriodo({ q, emitente, escopo, status, dtInicio, dtFim });
    }

    @Get('auditoria/exportar-xml')
    async exportarXmlAuditoria(
        @Query('q') q: string | undefined,
        @Query('emitente') emitente: string | undefined,
        @Query('escopo') escopo: string | undefined,
        @Query('status') status: string | undefined,
        @Query('dtInicio') dtInicio: string | undefined,
        @Query('dtFim') dtFim: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { buffer, count } = await this.service.exportarXmlAuditoria({ q, emitente, escopo, status, dtInicio, dtFim });
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="nfe-lancadas-xmls.zip"',
            'X-Total-Notas': String(count),
        });
        return new StreamableFile(buffer);
    }

    @Get('auditoria/:chaveNfe')
    async getAuditoria(@Param('chaveNfe') chaveNfe: string) {
        const detalhe = await this.service.getAuditoriaDetalhe(chaveNfe);
        if (!detalhe) {
            throw new NotFoundException(`Auditoria não encontrada para a NF: ${chaveNfe}`);
        }
        return detalhe;
    }

    @Post('auditoria/:chaveNfe/ressalva')
    async adicionarRessalva(
        @Param('chaveNfe') chaveNfe: string,
        @Body() body: { nItem?: number; motivo?: string; usuario?: string },
    ) {
        return this.service.adicionarRessalva(chaveNfe, Number(body?.nItem ?? 0), body?.motivo, body?.usuario);
    }

    @Delete('auditoria/:chaveNfe/ressalva/:nItem')
    async removerRessalva(@Param('chaveNfe') chaveNfe: string, @Param('nItem') nItem: string) {
        return this.service.removerRessalva(chaveNfe, Number(nItem));
    }

    @Post('auditoria/:chaveNfe/reconferir')
    async reconferirAuditoria(@Param('chaveNfe') chaveNfe: string) {
        const detalhe = await this.service.reconferirAuditoria(chaveNfe);
        if (!detalhe) {
            throw new NotFoundException(`NF não encontrada para reconferir: ${chaveNfe}`);
        }
        return detalhe;
    }

    @Post('auditoria/:chaveNfe/enviar-whatsapp')
    async enviarAlertaAuditoria(@Param('chaveNfe') chaveNfe: string) {
        const r = await this.service.enviarAlertaAuditoria(chaveNfe);
        if (r === null) {
            throw new NotFoundException(`NF não encontrada ou sem XML completo para auditar: ${chaveNfe}`);
        }
        return r;
    }

    // ---- Regras fiscais configuráveis (modal da aba Conferência Fiscal) ----

    @Get('fiscal-regras')
    async getFiscalRegras() {
        return this.service.getFiscalRegras();
    }

    @Put('fiscal-regras')
    async saveFiscalRegras(@Body() body: { regras?: any[]; opf?: any[]; origem?: any[] }) {
        return this.service.saveFiscalRegras(body || {});
    }

    @Get('payment-status')
    async getPaymentStatus() {
        return this.service.getPaymentStatusMap();
    }

    @Get('payment-status/:chaveNfe')
    async getPaymentStatusByKey(@Param('chaveNfe') chaveNfe: string) {
        const status = await this.service.getPaymentStatusByKey(chaveNfe);
        if (!status) {
            throw new NotFoundException(`Status não encontrado para a NF: ${chaveNfe}`);
        }
        return status;
    }

    @Post('guia/:chaveNfe/upload')
    @UseInterceptors(FileInterceptor('file'))
    async uploadGuiaByNfe(
        @Param('chaveNfe') chaveNfe: string,
        @UploadedFile() file?: any,
    ) {
        if (!file) {
            throw new BadRequestException('Arquivo PDF da guia não enviado.');
        }

        if (!file.mimetype?.toLowerCase().includes('pdf')) {
            throw new BadRequestException('Arquivo inválido. Envie um PDF da guia.');
        }

        return this.service.uploadGuiaByNfe(chaveNfe, file);
    }

    @Get('guia/:chaveNfe')
    async getGuiaByNfe(@Param('chaveNfe') chaveNfe: string) {
        const guia = await this.service.getGuiaByNfe(chaveNfe);
        if (!guia) {
            throw new NotFoundException(`Guia não encontrada para a NF: ${chaveNfe}`);
        }
        return guia;
    }

    @Get('guia/:chaveNfe/download')
    async downloadGuiaByNfe(
        @Param('chaveNfe') chaveNfe: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        const payload = await this.service.downloadGuiaByNfe(chaveNfe);
        if (!payload) {
            throw new NotFoundException(`Guia não encontrada para a NF: ${chaveNfe}`);
        }

        res.set(this.cabecalhoPdf(payload.fileName));

        return new StreamableFile(payload.stream);
    }

    /**
     * Guias do ICMS-ST escaneadas no app de Movimento Fiscal e amarradas a esta NF.
     * S\u00f3 leitura: o PDF pertence ao arquivo fiscal, n\u00e3o se apaga por aqui.
     */
    @Get('guia/:chaveNfe/escaneadas')
    async getGuiasEscaneadas(@Param('chaveNfe') chaveNfe: string) {
        const guias = await this.service.getGuiasEscaneadasByNfe(chaveNfe);
        return { count: guias.length, guias };
    }

    @Get('guia-escaneada/:id/download')
    async downloadGuiaEscaneada(
        @Param('id') id: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        const payload = await this.service.downloadGuiaEscaneada(Number(id));
        if (!payload) {
            throw new NotFoundException(`Guia escaneada n\u00e3o encontrada: ${id}`);
        }

        res.set(this.cabecalhoPdf(payload.fileName));

        return new StreamableFile(payload.stream);
    }

    /** Content-Disposition com nome ASCII de fallback + o nome real em UTF-8. */
    private cabecalhoPdf(fileName?: string | null) {
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

    @Delete('guia/:chaveNfe')
    async removeGuiaByNfe(@Param('chaveNfe') chaveNfe: string) {
        const removed = await this.service.removeGuiaByNfe(chaveNfe);
        if (!removed) {
            throw new NotFoundException(`Guia não encontrada para a NF: ${chaveNfe}`);
        }
        return { success: true, chaveNfe };
    }

    @Post('danfe')
    async generateDanfe(@Body() body: { xml: string }, @Res({ passthrough: true }) res: Response) {
        const buffer = await this.service.generateDanfe(body.xml);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="danfe.pdf"',
        });
        return new StreamableFile(buffer);
    }

    @Post('danfe/batch')
    async generateDanfeBatch(@Body() body: { invoices: { xml: string, chave: string }[] }, @Res({ passthrough: true }) res: Response) {
        const buffer = await this.service.generateDanfeZip(body.invoices);
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="danfes.zip"',
        });
        return new StreamableFile(buffer);
    }
}
