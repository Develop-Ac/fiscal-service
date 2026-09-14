import { Module } from '@nestjs/common';
import { IcmsController } from './icms.controller';
import { IcmsService } from './icms.service';
import { IcmsSyncCron } from './icms-sync.cron';
import { AuditoriaAjustadoCron } from './auditoria-ajustado.cron';
import { AuditoriaReauditoriaCron } from './auditoria-reauditoria.cron';
import { SimplesNacionalService } from './simples-nacional.service';
import { StFluxoService } from './st-fluxo.service';
import { StFluxoCron } from './st-fluxo.cron';

@Module({
    controllers: [IcmsController],
    providers: [IcmsService, SimplesNacionalService, IcmsSyncCron, AuditoriaAjustadoCron, AuditoriaReauditoriaCron, StFluxoService, StFluxoCron],
    // O SpedModule reusa o gerador de DANFE daqui em vez de ter o seu próprio.
    exports: [IcmsService],
})
export class IcmsModule { }
