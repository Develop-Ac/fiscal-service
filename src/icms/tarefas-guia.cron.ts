import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { envLimpo } from './st-fluxo.parse';
import { fecharTarefasGuia } from './tarefas-guia.client';

/**
 * Fecha a tarefa "Anexar guia…" do Meu dia quando a guia da NF é anexada (tela ou scanner).
 * Roda a cada minuto, ligado quando AVISOS_SERVICE_URL existe. Detalhes em tarefas-guia.client.ts.
 */
@Injectable()
export class TarefasGuiaCron implements OnModuleInit {
    private readonly logger = new Logger(TarefasGuiaCron.name);
    private rodando = false;

    constructor(private readonly prisma: PrismaService) {}

    onModuleInit() {
        this.logger.log(
            envLimpo('AVISOS_SERVICE_URL')
                ? `Tarefas "Anexar guia" LIGADAS (avisos-service em ${envLimpo('AVISOS_SERVICE_URL')}).`
                : 'Tarefas "Anexar guia" desligadas (AVISOS_SERVICE_URL vazia).',
        );
    }

    @Cron('* * * * *', { name: 'tarefas-guia' })
    async tick() {
        if (!envLimpo('AVISOS_SERVICE_URL') || this.rodando) return;
        this.rodando = true;
        try {
            const n = await fecharTarefasGuia(this.prisma);
            if (n) this.logger.log(`${n} tarefa(s) de guia concluída(s): guia anexada.`);
        } catch (e) {
            this.logger.error(`Falha no fechamento das tarefas de guia: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.rodando = false;
        }
    }
}
