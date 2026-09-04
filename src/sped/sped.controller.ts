import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Param,
    Post,
    Res,
    StreamableFile,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '../shared/http/fastify-file.interceptor';
import type { FastifyReply } from 'fastify';
import * as fs from 'fs';
import { SpedService, SpedOpcoes } from './sped.service';

/** O arquivo do SPED de um mês fica na casa das dezenas de MB. */
const LIMITE_ARQUIVO = 200 * 1024 * 1024;

@Controller('sped')
export class SpedController {
    constructor(private readonly service: SpedService) { }

    /** Prévia da classificação — não busca XML nem consulta o ERP. */
    @Post('analisar')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LIMITE_ARQUIVO } }))
    analisar(@UploadedFile() file?: any) {
        return this.service.analisar(this.conteudo(file));
    }

    /**
     * Cria o job que monta o pacote. Devolve o id na hora; o progresso é
     * acompanhado pelo GET e o .zip sai no /download.
     */
    @Post('jobs')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LIMITE_ARQUIVO } }))
    criar(
        @UploadedFile() file?: any,
        @Body()
        body?: {
            empresa?: string;
            danfe?: string;
            dacte?: string;
            danfse?: string;
            xmlNfe?: string;
            xmlCte?: string;
            xmlNfse?: string;
            somentePostgres?: string;
        },
    ) {
        const opcoes: SpedOpcoes = {
            empresa: Number(body?.empresa ?? 1) || 1,
            danfe: this.bool(body?.danfe, true),
            dacte: this.bool(body?.dacte, true),
            danfse: this.bool(body?.danfse, true),
            xmlNfe: this.bool(body?.xmlNfe, true),
            xmlCte: this.bool(body?.xmlCte, true),
            xmlNfse: this.bool(body?.xmlNfse, true),
            somentePostgres: this.bool(body?.somentePostgres, false),
        };
        const algoMarcado =
            opcoes.danfe || opcoes.dacte || opcoes.danfse || opcoes.xmlNfe || opcoes.xmlCte || opcoes.xmlNfse;
        if (!algoMarcado) {
            throw new BadRequestException('Selecione ao menos um item para gerar.');
        }

        const job = this.service.criarJob(this.conteudo(file), file.originalname, opcoes);
        return { jobId: job.id, status: job.status, etapa: job.etapa };
    }

    @Get('jobs/:id')
    status(@Param('id') id: string) {
        const { arquivo, ...resto } = this.service.status(id);
        return { ...resto, pronto: resto.status === 'concluido' };
    }

    @Get('jobs/:id/download')
    baixar(@Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
        const { caminho, nome } = this.service.arquivoDoJob(id);
        res.headers({
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${nome}"`,
            'Content-Length': String(fs.statSync(caminho).size),
        });
        return new StreamableFile(fs.createReadStream(caminho));
    }

    private conteudo(file?: any): Buffer {
        if (!file?.buffer?.length) {
            throw new BadRequestException('Envie o arquivo .txt do SPED Fiscal no campo "file".');
        }
        return file.buffer as Buffer;
    }

    private bool(v: string | undefined, padrao: boolean): boolean {
        if (v === undefined || v === null || v === '') return padrao;
        return v === 'true' || v === '1' || v === 'on';
    }
}
