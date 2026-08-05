"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IcmsModule = void 0;
const common_1 = require("@nestjs/common");
const icms_controller_1 = require("./icms.controller");
const icms_service_1 = require("./icms.service");
const icms_sync_cron_1 = require("./icms-sync.cron");
const auditoria_ajustado_cron_1 = require("./auditoria-ajustado.cron");
const auditoria_reauditoria_cron_1 = require("./auditoria-reauditoria.cron");
const simples_nacional_service_1 = require("./simples-nacional.service");
let IcmsModule = class IcmsModule {
};
exports.IcmsModule = IcmsModule;
exports.IcmsModule = IcmsModule = __decorate([
    (0, common_1.Module)({
        controllers: [icms_controller_1.IcmsController],
        providers: [icms_service_1.IcmsService, simples_nacional_service_1.SimplesNacionalService, icms_sync_cron_1.IcmsSyncCron, auditoria_ajustado_cron_1.AuditoriaAjustadoCron, auditoria_reauditoria_cron_1.AuditoriaReauditoriaCron],
        exports: [icms_service_1.IcmsService],
    })
], IcmsModule);
//# sourceMappingURL=icms.module.js.map