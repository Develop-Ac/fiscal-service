import { Module, Global } from '@nestjs/common';
import { ErpApiService } from './erp-api.service';

/** Global como o OpenQueryModule: a leitura do ERP é usada por vários domínios. */
@Global()
@Module({
    providers: [ErpApiService],
    exports: [ErpApiService],
})
export class ErpApiModule { }
