import {
    BadRequestException,
    Controller,
    Get,
    NotFoundException,
    Param,
    Query,
    Res,
    StreamableFile,
} from '@nestjs/common';
import { Response } from 'express';
import archiver from 'archiver';
import { EscanerService } from './escaner.service';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Arquivo do Movimento Fiscal (documentos do escaner-fiscal-app) para a intranet.
 * Somente leitura: listar, visualizar/baixar e exportar em lote.
 */
@Controller('escaner')
export class EscanerController {
    constructor(private readonly service: EscanerService) {}

    @Get('documentos')
    async list(
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('tipo') tipo?: string,
        @Query('q') q?: string,
        @Query('page') page?: string,
        @Query('pageSize') pageSize?: string,
    ) {
        if (from && !ISO_DATE.test(from)) throw new BadRequestException('Parâmetro "from" inválido (AAAA-MM-DD).');
        if (to && !ISO_DATE.test(to)) throw new BadRequestException('Parâmetro "to" inválido (AAAA-MM-DD).');
        const pageNum = Math.max(1, Number(page) || 1);
        const sizeNum = Math.min(200, Math.max(1, Number(pageSize) || 50));
        return this.service.listDocumentos({
            from,
            to,
            tipo: tipo || undefined,
            q: (q || '').trim() || undefined,
            page: pageNum,
            pageSize: sizeNum,
        });
    }

    @Get('tipos')
    async tipos() {
        const tipos = await this.service.listTipos();
        return { tipos };
    }

    /** PDF do documento. `?inline=1` abre no navegador (visualizar) em vez de baixar. */
    @Get('documentos/:id/download')
    async download(
        @Param('id') id: string,
        @Query('inline') inline: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        const payload = await this.service.downloadDocumento(Number(id));
        if (!payload) throw new NotFoundException(`Documento não encontrado: ${id}`);

        const disposition = inline === '1' ? 'inline' : 'attachment';
        res.set(this.cabecalhoPdf(payload.fileName, disposition));
        return new StreamableFile(payload.stream);
    }

    /** Zip com os PDFs do período (organizado por tipo/). */
    @Get('export')
    async export(
        @Res() res: Response,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('tipo') tipo?: string,
    ) {
        if (from && !ISO_DATE.test(from)) throw new BadRequestException('Parâmetro "from" inválido (AAAA-MM-DD).');
        if (to && !ISO_DATE.test(to)) throw new BadRequestException('Parâmetro "to" inválido (AAAA-MM-DD).');

        const entries = await this.service.listParaExport({ from, to, tipo: tipo || undefined });
        if (entries.length === 0) throw new NotFoundException('Nenhum documento no período informado.');

        const stamp = [from, to].filter(Boolean).join('_a_') || 'todos';
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="movimento-fiscal_${stamp}.zip"`);

        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', () => {
            try {
                res.status(500).end();
            } catch {
                /* stream já fechado */
            }
        });
        archive.pipe(res);
        for (const e of entries) {
            if (!e.key) continue;
            const stream = await this.service.getObjectStream(e.bucket, e.key);
            archive.append(stream, { name: `${e.tipo}/${e.nomeArquivo}` });
        }
        await archive.finalize();
    }

    /** Content-Disposition com nome ASCII de fallback + o nome real em UTF-8. */
    private cabecalhoPdf(fileName: string | null | undefined, disposition: 'inline' | 'attachment') {
        const utf8FileName = String(fileName || 'documento.pdf');
        const asciiFallback =
            utf8FileName
                .normalize('NFD')
                .replace(/[̀-ͯ]/g, '')
                .replace(/[^a-zA-Z0-9_.-]/g, '_') || 'documento.pdf';
        return {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(utf8FileName)}`,
        };
    }
}
