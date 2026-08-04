// metrics.module.ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { MetricsInterceptor } from './metrics.interceptor';

@Module({
  providers: [
    makeHistogramProvider({
      name: 'http_request_duration_seconds',
      help: 'Duração das requisições HTTP',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    }),
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class MetricsModule {}