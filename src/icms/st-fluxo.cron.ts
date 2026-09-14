import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StFluxoService } from './st-fluxo.service';

/**
 * Disparo do fluxo automático do ICMS-ST (docs/automacao-icms-st.md).
 * Fala com pessoas (WhatsApp), por isso é OPT-IN: só roda com ST_FLUXO_ENABLED=true.
 *  - ST_FLUXO_CRON: expressão (default 1 min).
 *  - ST_FLUXO_DRY_RUN=1: monta a mensagem e loga em vez de enviar.
 *  - ST_FLUXO_JANELA_DIAS: só NFs emitidas nos últimos N dias (default 7).
 */
@Injectable()
export class StFluxoCron {
    private readonly logger = new Logger(StFluxoCron.name);
    private rodando = false;

    constructor(private readonly fluxo: StFluxoService) {}

    @Cron(process.env.ST_FLUXO_CRON || '* * * * *', { name: 'st-fluxo' })
    async tick() {
        if (process.env.ST_FLUXO_ENABLED !== 'true') return;
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
