import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { GnreService } from './gnre.service';

/** GNRE de venda (ICMS-ST/DIFAL da NF-e de saída) — tela /fiscal/gnre. */
@Controller('gnre')
export class GnreController {
    constructor(private readonly service: GnreService) {}

    @Get('status')
    status() {
        return this.service.status();
    }

    /** Lê a NF de saída no ERP e diz quais guias ela permite. */
    @Get('nf/:numero')
    consultar(@Param('numero') numero: string, @Query('empresa') empresa?: string) {
        return this.service.consultarNf(numero, empresa);
    }

    /** Monta e valida o lote (não transmite). */
    @Post('gerar')
    gerar(@Body() body: { numero: string; empresa?: string; tipos: string[] }) {
        return this.service.gerar(body?.numero, body?.empresa, body?.tipos);
    }

    /** Transmite em PRODUÇÃO, consulta o resultado e arquiva o PDF. */
    @Post('transmitir')
    transmitir(@Body() body: { numero: string; empresa?: string; tipos: string[]; usuario?: string }) {
        return this.service.transmitir(body?.numero, body?.empresa, body?.tipos, body?.usuario);
    }

    @Get('guias')
    guias(@Query('nf') nf?: string) {
        return this.service.listarParaTela(nf);
    }

    @Post('guias/importar-recibo')
    importar(@Body() body: { recibo: string; usuario?: string }) {
        return this.service.importarRecibo(body?.recibo, body?.usuario);
    }

    /** Gera/arquiva no MinIO os PDFs das guias processadas que ainda não têm arquivo. */
    @Post('guias/arquivar-pendentes')
    arquivarPendentes() {
        return this.service.arquivarPendentes();
    }

    @Post('guias/:id/reconsultar')
    reconsultar(@Param('id', ParseIntPipe) id: number) {
        return this.service.reconsultar(id);
    }

    /** PDF da guia (`?inline=1` abre no navegador). */
    @Get('guias/:id/pdf')
    async pdf(
        @Param('id', ParseIntPipe) id: number,
        @Query('inline') inline: string,
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        const { stream, fileName } = await this.service.pdf(id);
        res.headers({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `${inline === '1' ? 'inline' : 'attachment'}; filename="${fileName}"`,
        });
        return new StreamableFile(stream);
    }
}
