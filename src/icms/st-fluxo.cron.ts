import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StFluxoService } from './st-fluxo.service';
import { envLimpo } from './st-fluxo.parse';

/**
 * Disparo do fluxo automático do ICMS-ST (docs/automacao-icms-st.md).
 * Fala com pessoas (WhatsApp), por isso é OPT-IN: só roda com ST_FLUXO_ENABLED=true.
 *  - ST_FLUXO_CRON: expressão (default 1 min).
 *  - ST_FLUXO_DRY_RUN=1: monta a mensagem e loga em vez de enviar.
 *  - ST_FLUXO_JANELA_DIAS: só NFs emitidas nos últimos N dias (default 7).
 */
@Injectable()
export class StFluxoCron implements OnModuleInit {
    private readonly logger = new Logger(StFluxoCron.name);
    private rodando = false;

    constructor(private readonly fluxo: StFluxoService) {}

    private get ligado(): boolean {
        return envLimpo('ST_FLUXO_ENABLED') === 'true';
    }

    onModuleInit() {
        // Uma linha no boot para o log dizer se o fluxo está ligado e em que modo.
        this.logger.log(
            this.ligado
                ? `Fluxo ST LIGADO (${envLimpo('ST_FLUXO_DRY_RUN') === '1' ? 'DRY-RUN: só loga' : 'enviando no WhatsApp'}; grupo ${envLimpo('WAHA_GUIAS_CHAT_ID') || envLimpo('WAHA_GROUP_CHAT_ID') || '?'}; janela ${envLimpo('ST_FLUXO_JANELA_DIAS', '7')} dias)`
                : 'Fluxo ST desligado (ST_FLUXO_ENABLED != true).',
        );
    }

    @Cron(envLimpo('ST_FLUXO_CRON', '* * * * *'), { name: 'st-fluxo' })
    async tick() {
        if (!this.ligado) return;
        if (this.rodando) return;
        this.rodando = true;
        try {
            await this.fluxo.processarCiclo();
        } catch (e) {
            this.logger.error(`Falha no ciclo do fluxo ST: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.rodando = false;
        }
    }
}
