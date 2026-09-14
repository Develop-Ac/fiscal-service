import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StFluxoService } from './st-fluxo.service';

/**
 * Lado Teams do fluxo de guias (docs/automacao-icms-st.md, 2.4): posta as NFs
 * AUTORIZADAS no chat do escritório e lê as respostas com a guia em PDF.
 *  - Só roda com ST_FLUXO_ENABLED=true (mesmo interruptor do fluxo).
 *  - TEAMS_CRON: expressão (default 2 min). TEAMS_CRON_DISABLED=true desliga.
 */
@Injectable()
export class StFluxoTeamsCron {
    private readonly logger = new Logger(StFluxoTeamsCron.name);
    private rodando = false;

    constructor(private readonly fluxo: StFluxoService) {}

    @Cron(process.env.TEAMS_CRON || '*/2 * * * *', { name: 'st-fluxo-teams' })
    async tick() {
        if (process.env.ST_FLUXO_ENABLED !== 'true' || process.env.TEAMS_CRON_DISABLED === 'true') return;
        if (this.rodando) return;
        this.rodando = true;
        try {
            await this.fluxo.processarTeams();
        } catch (e) {
            this.logger.error(`Falha no ciclo do Teams: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.rodando = false;
        }
    }
}
