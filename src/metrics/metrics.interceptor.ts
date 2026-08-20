// metrics.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Histogram } from 'prom-client';
import { Observable, tap } from 'rxjs';

/** No Fastify o padrão da rota vem em `routeOptions.url` (não em `route.path`). */
function rotaDe(req: any): string {
  return req.routeOptions?.url ?? req.routerPath ?? req.route?.path ?? req.url;
}

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric('http_request_duration_seconds')
    private histogram: Histogram<string>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const end = this.histogram.startTimer();

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse();
          end({
            method: req.method,
            route: rotaDe(req),
            status_code: res.statusCode,
          });
        },
        error: () => {
          end({ method: req.method, route: rotaDe(req), status_code: 500 });
        },
      }),
    );
  }
}
