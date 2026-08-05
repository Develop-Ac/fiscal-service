import { Module } from '@nestjs/common';
import { IcmsModule } from '../icms/icms.module';
import { SpedController } from './sped.controller';
import { SpedService } from './sped.service';
import { SpedXmlService } from './sped-xml.service';

/**
 * Fechamento do SPED Fiscal. Importa o IcmsModule para reusar o gerador de DANFE
 * que a tela de NF-e já usa — dois renderizadores diferentes para o mesmo
 * documento sairiam diferentes, e o da tela é o que o fiscal já reconhece.
 */
@Module({
    imports: [IcmsModule],
    controllers: [SpedController],
    providers: [SpedService, SpedXmlService],
})
export class SpedModule { }
