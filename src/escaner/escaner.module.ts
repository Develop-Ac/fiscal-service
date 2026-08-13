import { Module } from '@nestjs/common';
import { EscanerController } from './escaner.controller';
import { EscanerService } from './escaner.service';

/** Arquivo do Movimento Fiscal (documentos do escaner-fiscal-app) — leitura p/ intranet. */
@Module({
    controllers: [EscanerController],
    providers: [EscanerService],
})
export class EscanerModule {}
