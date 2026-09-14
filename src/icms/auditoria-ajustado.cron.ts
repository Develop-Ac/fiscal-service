import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StFluxoService } from './st-fluxo.service';

/**
 * Loop fechado do grupo "Conferência Fiscal" via WhatsApp (WAHA), 100% de SAÍDA.
 *
 * Topologia: o WAHA/n8n rodam num EasyPanel ONLINE (Hostinger) e este serviço
 * roda no EasyPanel LOCAL (intranet). A intranet alcança a nuvem (saída HTTPS),
 * mas a nuvem NÃO alcança a intranet — então não dá para receber webhook do WAHA
 * aqui. Por isso fazemos POLLING: lemos as mensagens do grupo no WAHA e tratamos
 * as respostas que citam uma NF:
 *  - "ajustado"            → reconfere a auditoria fiscal (IcmsService.tratarRespostaAjustado)
 *  - "pode enviar dd/mm"   → autoriza o pedido da guia ao escritório (fluxo ST)
 *  - "manual"              → tira a NF do fluxo automático
 *  - "3 st / 7 difal / …"  → classifica itens pendentes e calcula (fluxo ST)
 * Roteador: StFluxoService.processarRespostasWaha() (docs/automacao-icms-st.md, 2.3).
 *
 * Config por env:
 *  - WAHA_BASE_URL / WAHA_API_KEY / WAHA_SESSION / WAHA_GROUP_CHAT_ID (obrigatórios)
 *  - WAHA_AJUSTADO_CRON: expressão cron (default a cada 1 min).
 *  - WAHA_AJUSTADO_CRON_DISABLED=true: desliga o polling.
 */
@Injectable()
export class AuditoriaAjustadoCron {
  private readonly logger = new Logger(AuditoriaAjustadoCron.name);
  private rodando = false;

  constructor(private readonly fluxo: StFluxoService) {}

  @Cron(process.env.WAHA_AJUSTADO_CRON || '* * * * *', {
    name: 'waha-auditoria-ajustado',
  })
  async poll() {
    if (process.env.WAHA_AJUSTADO_CRON_DISABLED === 'true') return;
    if (this.rodando) {
      this.logger.warn('Polling anterior de respostas do WhatsApp ainda em execução; pulando.');
      return;
    }
    this.rodando = true;
    try {
      await this.fluxo.processarRespostasWaha();
    } catch (err) {
      this.logger.error(
        `Falha no polling de respostas do WhatsApp: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.rodando = false;
    }
  }
}
