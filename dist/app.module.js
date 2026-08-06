"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const schedule_1 = require("@nestjs/schedule");
const nestjs_prometheus_1 = require("@willsoto/nestjs-prometheus");
const icms_module_1 = require("./icms/icms.module");
const nfse_module_1 = require("./nfse/nfse.module");
const cte_module_1 = require("./cte/cte.module");
const sped_module_1 = require("./sped/sped.module");
const prisma_module_1 = require("./prisma/prisma.module");
const openquery_module_1 = require("./shared/database/openquery/openquery.module");
const erp_api_module_1 = require("./shared/erp-api/erp-api.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            schedule_1.ScheduleModule.forRoot(),
            prisma_module_1.PrismaModule,
            openquery_module_1.OpenQueryModule,
            erp_api_module_1.ErpApiModule,
            icms_module_1.IcmsModule,
            nfse_module_1.NfseModule,
            cte_module_1.CteModule,
            sped_module_1.SpedModule,
            nestjs_prometheus_1.PrometheusModule.register({
                defaultMetrics: { enabled: true },
            }),
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map