import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '../shared/http/fastify-file.interceptor';
import type { FastifyReply } from 'fastify';
import { NfseDistService } from './nfse-dist.service';
import { NfseCertService } from './nfse-cert.service';
import { NfseAdnClient } from './nfse-adn.client';

@Controller('nfse')
export class NfseController {
  constructor(
    private readonly service: NfseDistService,
    private readonly cert: NfseCertService,
    private readonly adn: NfseAdnClient,
  ) {}

  // ---- Distribuição / consulta ----

  /** Dispara a distribuição manualmente (botão "Atualizar" / teste). */
  @Post('distribuicao/sincronizar')
  sincronizar() {
    return this.service.sincronizar();
  }

  /** Lista NFS-e com filtros: numero, cnpj (prestador), dataInicio, dataFim. */
  @Get('documentos')
  listar(
    @Query('numero') numero?: string,
    @Query('cnpj') cnpj?: string,
    @Query('empresa') empresa?: string,
    @Query('dataInicio') dataInicio?: string,
    @Query('dataFim') dataFim?: string,
    @Query('papel') papel?: string,
    @Query('comRetFederal') comRetFederal?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listar({ numero, cnpj, empresa, dataInicio, dataFim, papel, comRetFederal, page, pageSize });
  }

  /** Backfill: recalcula campos derivados (ex.: retenção federal) do histórico. */
  @Post('reprocessar')
  reprocessar() {
    return this.service.reprocessar();
  }

  /** Exporta os XMLs do período filtrado em .zip (exige data inicial e final). */
  @Get('documentos/exportar-xml')
  async exportarXml(
    @Query('numero') numero: string | undefined,
    @Query('cnpj') cnpj: string | undefined,
    @Query('empresa') empresa: string | undefined,
    @Query('dataInicio') dataInicio: string | undefined,
    @Query('dataFim') dataFim: string | undefined,
    @Query('papel') papel: string | undefined,
    @Query('comRetFederal') comRetFederal: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { buffer, count } = await this.service.exportarXml({
      numero,
      cnpj,
      empresa,
      dataInicio,
      dataFim,
      papel,
      comRetFederal,
    });
    res.headers({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="nfse-xmls.zip"',
      'X-Total-Notas': String(count),
    });
    return new StreamableFile(buffer);
  }

  /** Detalhe completo de uma NFS-e (todos os dados + eventos + XML). */
  @Get('documentos/:chave')
  detalhe(@Param('chave') chave: string) {
    return this.service.detalhe(chave);
  }

  /**
   * DANFSe (PDF) da NFS-e. Por padrão desenhado aqui a partir do XML guardado;
   * `?fonte=adn` baixa o PDF oficial do portal nacional, para conferência.
   */
  @Get('documentos/:chave/danfse')
  async danfse(
    @Param('chave') chave: string,
    @Res({ passthrough: true }) res: FastifyReply,
    @Query('fonte') fonte?: string,
  ) {
    const buffer = await this.service.danfse(chave, fonte === 'adn' ? 'adn' : 'local');
    res.headers({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="danfse-${chave}.pdf"`,
    });
    return new StreamableFile(buffer);
  }

  /** Eventos de uma chave consultados ao vivo na ADN. */
  @Get('eventos/:chave')
  eventos(@Param('chave') chave: string) {
    return this.service.eventos(chave);
  }

  // ---- Certificado (vínculo pelo frontend) ----

  @Get('certificado')
  statusCertificado() {
    return this.cert.status();
  }

  /** Backfill: re-extrai a Razão Social dos certificados já vinculados. */
  @Post('certificado/reextrair')
  reextrairNomesCertificado() {
    return this.cert.reextrairNomes();
  }

  @Post('certificado')
  @UseInterceptors(FileInterceptor('file'))
  async vincularCertificado(
    @UploadedFile() file?: any,
    @Body() body?: { cnpj?: string; senha?: string; nome?: string; validadeAte?: string },
  ) {
    if (!file) throw new BadRequestException('Arquivo .pfx não enviado.');
    const nome = file.originalname?.toLowerCase() || '';
    if (!/\.(pfx|p12)$/.test(nome)) {
      throw new BadRequestException('Arquivo inválido. Envie o certificado A1 (.pfx ou .p12).');
    }
    if (!body?.cnpj) throw new BadRequestException('CNPJ do certificado é obrigatório.');
    if (!body?.senha) throw new BadRequestException('Senha do certificado é obrigatória.');

    const saved = await this.cert.salvar({
      cnpj: body.cnpj,
      nome: body.nome || file.originalname,
      pfx: file.buffer,
      senha: body.senha,
      validadeAte: body.validadeAte ? new Date(body.validadeAte) : null,
    });
    this.adn.resetAgent(); // passa a usar o novo certificado
    return saved;
  }

  @Delete('certificado/:cnpj')
  async removerCertificado(@Param('cnpj') cnpj: string) {
    const r = await this.cert.remover(cnpj);
    this.adn.resetAgent();
    return r;
  }
}
