import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { cifrar, decifrar } from '../../nfse/nfse-crypto.util';

/**
 * Microsoft Graph (Teams + OneDrive) com permissões DELEGADAS de uma conta de
 * serviço membro do chat em grupo com o escritório contábil. Tudo é polling de
 * saída (a nuvem não alcança a intranet). Sem SDK: fetch puro.
 *
 * Login único: GET /api/teams/auth → Microsoft → /api/teams/auth/callback grava o
 * refresh token cifrado em com_teams_credencial; daí em diante só refresh.
 *
 * Env: TEAMS_TENANT_ID, TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, TEAMS_REDIRECT_URI,
 *      TEAMS_CHAT_ID (19:...@thread.v2), TEAMS_LINK_SCOPE (anonymous | organization).
 */
const SCOPES = 'offline_access User.Read Chat.ReadWrite Files.ReadWrite Files.Read.All';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface AnexoTeams { id: string; name: string; contentUrl: string }

@Injectable()
export class TeamsGraphClient {
    private readonly logger = new Logger(TeamsGraphClient.name);
    private access: { token: string; exp: number } | null = null;
    private stateEsperado: string | null = null;

    constructor(private readonly prisma: PrismaService) {}

    private get cfg() {
        return {
            tenant: process.env.TEAMS_TENANT_ID || '',
            clientId: process.env.TEAMS_CLIENT_ID || '',
            secret: process.env.TEAMS_CLIENT_SECRET || '',
            redirect: process.env.TEAMS_REDIRECT_URI || '',
            chatId: process.env.TEAMS_CHAT_ID || '',
            linkScope: process.env.TEAMS_LINK_SCOPE || 'anonymous',
        };
    }

    get configurado(): boolean {
        const c = this.cfg;
        return !!(c.tenant && c.clientId && c.secret && c.redirect && c.chatId);
    }

    // ---------------- login único ----------------

    urlAutorizacao(): string {
        const c = this.cfg;
        this.stateEsperado = randomBytes(16).toString('hex');
        const q = new URLSearchParams({
            client_id: c.clientId,
            response_type: 'code',
            redirect_uri: c.redirect,
            response_mode: 'query',
            scope: SCOPES,
            state: this.stateEsperado,
            prompt: 'select_account',
        });
        return `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/authorize?${q}`;
    }

    async trocarCodigo(code: string, state: string): Promise<{ conta: string }> {
        if (!this.stateEsperado || state !== this.stateEsperado) throw new Error('state inválido: refaça o login por /api/teams/auth');
        this.stateEsperado = null;
        const tok = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirect });
        this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
        const me: any = await this.graph('GET', '/me');
        const conta = String(me.userPrincipalName || me.mail || me.id);
        await this.prisma.$executeRawUnsafe(
            `INSERT INTO com_teams_credencial (id, conta, usuario_id, refresh_token, updated_at) VALUES (1, $1, $2, $3, NOW())
             ON CONFLICT (id) DO UPDATE SET conta = EXCLUDED.conta, usuario_id = EXCLUDED.usuario_id, refresh_token = EXCLUDED.refresh_token, updated_at = NOW()`,
            conta, String(me.id), cifrar(tok.refresh_token),
        );
        this.logger.log(`Teams conectado como ${conta}.`);
        return { conta };
    }

    async status(): Promise<{ configurado: boolean; conectado: boolean; conta?: string; atualizadoEm?: Date }> {
        const cred = await this.credencial();
        return { configurado: this.configurado, conectado: !!cred, conta: cred?.conta, atualizadoEm: cred?.updated_at };
    }

    /** Id do usuário da conta de serviço no Graph (para ignorar as próprias mensagens). */
    async usuarioId(): Promise<string | null> {
        return (await this.credencial())?.usuario_id ?? null;
    }

    private async credencial(): Promise<{ conta: string; usuario_id: string; refresh_token: string; updated_at: Date } | null> {
        const rows = await this.prisma.$queryRawUnsafe<any[]>(`SELECT conta, usuario_id, refresh_token, updated_at FROM com_teams_credencial WHERE id = 1`).catch(() => []);
        return rows[0] ?? null;
    }

    private async tokenRequest(params: Record<string, string>): Promise<any> {
        const c = this.cfg;
        const body = new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, scope: SCOPES, ...params });
        const resp = await fetch(`https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const json: any = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(`token ${params.grant_type}: HTTP ${resp.status} ${json.error || ''} ${json.error_description || ''}`.trim());
        return json;
    }

    private async token(): Promise<string> {
        if (this.access && Date.now() < this.access.exp) return this.access.token;
        const cred = await this.credencial();
        if (!cred) throw new Error('Teams não conectado: faça o login único em /api/teams/auth');
        const tok = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: decifrar(cred.refresh_token) });
        this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
        // O refresh token é rotacionado a cada uso: guarda o novo.
        if (tok.refresh_token) {
            await this.prisma.$executeRawUnsafe(`UPDATE com_teams_credencial SET refresh_token = $1, updated_at = NOW() WHERE id = 1`, cifrar(tok.refresh_token));
        }
        return this.access.token;
    }

    // ---------------- chamadas ----------------

    private async graph(method: string, path: string, body?: any, headers: Record<string, string> = {}): Promise<any> {
        const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
        const isBuf = Buffer.isBuffer(body);
        const resp = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${await this.token()}`,
                ...(body && !isBuf ? { 'Content-Type': 'application/json' } : {}),
                ...headers,
            },
            body: body === undefined ? undefined : isBuf ? new Uint8Array(body) : JSON.stringify(body),
        });
        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error(`Graph ${method} ${path}: HTTP ${resp.status} ${txt.slice(0, 300)}`);
        }
        if (resp.status === 204) return null;
        const ct = resp.headers.get('content-type') || '';
        return ct.includes('application/json') ? resp.json() : Buffer.from(await resp.arrayBuffer());
    }

    /**
     * Sobe um arquivo (< 4 MB) no OneDrive da conta de serviço, cria o link de
     * compartilhamento (o escritório é externo → `anonymous`; se o tenant
     * bloquear, cai para `organization` e loga) e devolve o anexo pronto para
     * a mensagem do chat.
     */
    async subirArquivo(nome: string, conteudo: Buffer, pasta: string): Promise<AnexoTeams> {
        const item: any = await this.graph(
            'PUT',
            `/me/drive/root:/GuiasST/${encodeURIComponent(pasta)}/${encodeURIComponent(nome)}:/content`,
            conteudo,
            { 'Content-Type': 'application/octet-stream' },
        );
        let link: any;
        try {
            link = await this.graph('POST', `/me/drive/items/${item.id}/createLink`, { type: 'view', scope: this.cfg.linkScope });
        } catch (e) {
            this.logger.warn(`createLink scope=${this.cfg.linkScope} recusado (${e instanceof Error ? e.message : e}); tentando organization.`);
            link = await this.graph('POST', `/me/drive/items/${item.id}/createLink`, { type: 'view', scope: 'organization' });
        }
        // Anexo "reference" usa como id o GUID do eTag do driveItem ("{GUID},1").
        const id = String(item.eTag || '').match(/\{([0-9a-f-]+)\}/i)?.[1] || item.id;
        return { id, name: nome, contentUrl: link?.link?.webUrl || item.webUrl };
    }

    /** Posta mensagem HTML no chat com anexos por referência. Devolve o id da mensagem. */
    async postarMensagem(html: string, anexos: AnexoTeams[]): Promise<string> {
        const body = {
            body: {
                contentType: 'html',
                content: html + anexos.map((a) => `<attachment id="${a.id}"></attachment>`).join(''),
            },
            attachments: anexos.map((a) => ({ id: a.id, contentType: 'reference', contentUrl: a.contentUrl, name: a.name })),
        };
        const msg: any = await this.graph('POST', `/chats/${encodeURIComponent(this.cfg.chatId)}/messages`, body);
        return String(msg.id);
    }

    /** Últimas mensagens do chat (mais recentes primeiro). */
    async listarMensagens(top = 50): Promise<any[]> {
        const r: any = await this.graph('GET', `/chats/${encodeURIComponent(this.cfg.chatId)}/messages?$top=${top}`);
        return Array.isArray(r?.value) ? r.value : [];
    }

    /** Baixa um anexo pelo contentUrl (OneDrive/SharePoint de quem enviou) via a API de shares. */
    async baixarPorUrl(contentUrl: string): Promise<Buffer> {
        const enc = 'u!' + Buffer.from(contentUrl, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
        const r = await this.graph('GET', `/shares/${enc}/driveItem/content`);
        if (!Buffer.isBuffer(r)) throw new Error('resposta do download não é binária');
        return r;
    }
}
