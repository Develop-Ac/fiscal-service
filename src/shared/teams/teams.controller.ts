import { Controller, Get, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { TeamsGraphClient } from './teams-graph.client';

/**
 * Login único da conta de serviço do Teams (docs/teams-fase0-passo-a-passo.md, Etapa 5).
 * Abrir /api/teams/auth num navegador da intranet, entrar com a conta de serviço,
 * e pronto: o refresh token fica guardado e renova sozinho.
 */
@Controller('teams')
export class TeamsController {
    constructor(private readonly teams: TeamsGraphClient) {}

    @Get('auth')
    auth(@Res() res: FastifyReply) {
        if (!this.teams.configurado) {
            return res.code(500).type('text/plain; charset=utf-8').send('Teams não configurado: faltam TEAMS_TENANT_ID / TEAMS_CLIENT_ID / TEAMS_CLIENT_SECRET / TEAMS_REDIRECT_URI / TEAMS_CHAT_ID.');
        }
        return res.code(302).header('Location', this.teams.urlAutorizacao()).send();
    }

    @Get('auth/callback')
    async callback(
        @Query('code') code: string,
        @Query('state') state: string,
        @Query('error') error: string,
        @Query('error_description') errorDescription: string,
        @Res() res: FastifyReply,
    ) {
        res.type('text/plain; charset=utf-8');
        if (error) return res.code(400).send(`Microsoft recusou o login: ${error} — ${errorDescription || ''}`);
        try {
            const { conta } = await this.teams.trocarCodigo(String(code || ''), String(state || ''));
            return res.send(`Teams conectado como ${conta}. Pode fechar esta janela.`);
        } catch (e) {
            return res.code(400).send(`Falha ao concluir o login: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    @Get('status')
    status() {
        return this.teams.status();
    }
}
