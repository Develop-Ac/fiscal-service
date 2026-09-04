import { Controller, Get, NotFoundException, Param, Post, Query, Res, StreamableFile, Body } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiTags } from '@nestjs/swagger';
import { CteService } from './cte.service';
import { CteRastreioService } from './cte-rastreio.service';

@ApiTags('cte')
@Controller('cte')
export class CteController {
  constructor(
    private readonly service: CteService,
    private readonly rastreio: CteRastreioService,
  ) {}

  /** Lista paginada (servida do Postgres) com filtros. */
  @Get('documentos')
  async listar(
    @Query('status') status?: string,
    @Query('tipoFrete') tipoFrete?: string,
    @Query('somosTomador') somosTomador?: string,
    @Query('numero') numero?: string,
    @Query('emitente') emitente?: string,
    @Query('cnpj') cnpj?: string,
    @Query('dataInicio') dataInicio?: string,
    @Query('dataFim') dataFim?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listCtes({ status, tipoFrete, somosTomador, numero, emitente, cnpj, dataInicio, dataFim, page, pageSize });
  }

  /** Detalhe (cabeçalho do CT-e parseado). */
  @Get('documentos/:chave')
  async detalhe(@Param('chave') chave: string) {
    const data = await this.service.getCteByKey(chave);
    if (!data) throw new NotFoundException(`CT-e não encontrado: ${chave}`);
    return data;
  }

  /** Sincronização incremental (botão "Atualizar"). */
  @Post('sincronizar')
  async sincronizar() {
    return this.service.sincronizar();
  }

  /** Rastreio SSW (movimentação física) de um CT-e, para a tela de detalhe. */
  @Get('rastreio/:chave')
  async getRastreio(@Param('chave') chave: string) {
    const data = await this.rastreio.getRastreio(chave);
    if (!data) throw new NotFoundException(`CT-e não encontrado: ${chave}`);
    return data;
  }

  /** Rastreio resolvido pela chave de uma NF transportada (tela da NF e do Pedido). */
  @Get('rastreio/por-nfe/:chaveNfe')
  async getRastreioPorNfe(@Param('chaveNfe') chaveNfe: string) {
    return this.rastreio.getRastreioPorNfe(chaveNfe);
  }

  /** Dispara o polling do rastreio no SSW manualmente (mesmo trabalho do cron). */
  @Post('rastreio/sincronizar')
  async sincronizarRastreio() {
    return this.rastreio.sincronizar();
  }

  /** Carga inicial (job assíncrono com progresso). */
  @Post('carga-inicial')
  async cargaInicial() {
    return this.service.startCargaInicialJob();
  }

  @Get('carga-inicial/:jobId')
  async cargaInicialStatus(@Param('jobId') jobId: string) {
    const job = this.service.getCargaInicialJob(jobId);
    if (!job) throw new NotFoundException(`Job não encontrado: ${jobId}`);
    return job;
  }

  /** Gera o DACTE (PDF) do CT-e a partir da chave. */
  @Post('dacte')
  async dacte(@Body() body: { chave?: string }, @Res({ passthrough: true }) res: FastifyReply) {
    const chave = String(body?.chave || '').trim();
    if (!chave) throw new NotFoundException('Chave do CT-e não informada.');
    const buffer = await this.service.generateDacteByKey(chave);
    if (!buffer) throw new NotFoundException(`XML do CT-e não disponível para: ${chave}`);
    res.headers({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="dacte.pdf"',
    });
    return new StreamableFile(buffer);
  }
}
