import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

import { IcmsModule } from './icms/icms.module';
import { NfseModule } from './nfse/nfse.module';
import { CteModule } from './cte/cte.module';
import { SpedModule } from './sped/sped.module';
import { EscanerModule } from './escaner/escaner.module';
import { GnreModule } from './gnre/gnre.module';
import { PrismaModule } from './prisma/prisma.module';
import { OpenQueryModule } from './shared/database/openquery/openquery.module';
import { ErpApiModule } from './shared/erp-api/erp-api.module';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        PrismaModule,
        OpenQueryModule,
        ErpApiModule,
        IcmsModule,
        NfseModule,
        CteModule,
        SpedModule,
        EscanerModule,
        GnreModule,

        PrometheusModule.register({
            defaultMetrics: { enabled: true }, // CPU, memória, event loop, GC
        }),
    ],
})
export class AppModule { }
