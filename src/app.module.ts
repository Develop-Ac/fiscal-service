import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

import { IcmsModule } from './icms/icms.module';
import { NfseModule } from './nfse/nfse.module';
import { CteModule } from './cte/cte.module';
import { PrismaModule } from './prisma/prisma.module';
import { OpenQueryModule } from './shared/database/openquery/openquery.module';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        PrismaModule,
        OpenQueryModule,
        IcmsModule,
        NfseModule,
        CteModule,

        PrometheusModule.register({
            defaultMetrics: { enabled: true }, // CPU, memória, event loop, GC
        }),
    ],
})
export class AppModule { }
