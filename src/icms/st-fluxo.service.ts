import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IcmsService } from './icms.service';
import { FiscalConferenceItemDto } from './dto/fiscal-conference.dto';
import { Classificacao, comando, envLimpo, parseClassificacao, parseVencimento } from './st-fluxo.parse';

/**
 * Fluxo automático do ICMS-ST/DIFAL de entrada (docs/automacao-icms-st.md).
 *
 * Fase 1: quando o XML completo de uma NF de fora de MT chega, decide o imposto
 * item a item, calcula e grava pelo MESMO caminho da tela (savePaymentStatus)
 * e avisa no grupo do WhatsApp. Ordem da decisão:
 *   1. CFOP fora da lista de tributados      → TRIBUTADA (sem tributação)
 *   2. SUBTIPO 07 no cadastro (uso/consumo)  → DIFAL
 *   3. SUBTIPO 00 (revenda) E NCM na tabela  → ST
 *   4. resposta do WhatsApp                  → o que a pessoa disse
 *   5. senão                                 → pendente (pergunta no grupo)
 * NCM na tabela sozinho não decide: sem o cadastro dizer revenda, a pessoa
 * escolhe entre st / difal / tributada. O cálculo só roda quando todos os
 * itens têm imposto (a leitura da resposta é a Fase 2).
 *
 * Detecção da NF nova: polling na com_nfe_conciliacao. `mva_verificado_em`
 * só é preenchido quando o XML completo foi lido (maybeAlertMva), então serve
 * de sinal "tem itens" sem decodificar XML de resumo a cada minuto.
 */

@Injectable()
export class StFluxoService {
    private readonly logger = new Logger(StFluxoService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly icms: IcmsService,
    ) {}

    /** Um ciclo: NFs novas + reenvio de avisos que falharam. Nunca lança. */
    async processarCiclo(): Promise<void> {
        const janelaDias = Number(envLimpo('ST_FLUXO_JANELA_DIAS')) > 0 ? Number(envLimpo('ST_FLUXO_JANELA_DIAS')) : 7;
        const novas = await this.prisma.$queryRawUnsafe<Array<{ chave_nfe: string }>>(
            `SELECT c.chave_nfe
               FROM com_nfe_conciliacao c
              WHERE LEFT(c.chave_nfe, 2) <> '51'  -- NFE_DISTRIBUICAO só traz nota recebida (tipo_operacao 1 = saída do fornecedor)
                AND c.mva_verificado_em IS NOT NULL
                AND c.data_emissao >= NOW() - ($1 || ' days')::interval
                AND NOT EXISTS (SELECT 1 FROM com_nfe_st_fluxo f WHERE f.chave_nfe = c.chave_nfe)
              ORDER BY c.data_emissao
              LIMIT 20`,
            String(janelaDias),
        );
        for (const n of novas) {
            try {
                await this.iniciar(n.chave_nfe);
            } catch (e) {
                this.logger.error(`Falha ao iniciar fluxo da NF ${n.chave_nfe}: ${e instanceof Error ? e.message : String(e)}`);
                await this.gravar(n.chave_nfe, { estado: 'ERRO', erro: e instanceof Error ? e.message : String(e) });
            }
        }

        // Aviso que não saiu (WAHA fora, etc.): tenta de novo. Aviso feito em DRY-RUN
        // conta como não enviado assim que o dry-run é desligado.
        const dryRun = envLimpo('ST_FLUXO_DRY_RUN') === '1';
        const semAviso = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT * FROM com_nfe_st_fluxo
              WHERE (waha_msg_aviso IS NULL${dryRun ? '' : ` OR waha_msg_aviso = 'dry-run'`})
                AND estado IN ('AGUARDANDO_ENVIO','NCM_PENDENTE')
              ORDER BY created_at LIMIT 20`,
        );
        for (const f of semAviso) {
            try {
                await this.avisar(f);
            } catch (e) {
                this.logger.error(`Falha ao avisar NF ${f.chave_nfe}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        await this.detectarGuiasAnexadas();
        await this.lembrar();
    }

    /**
     * O envio ao escritório e o anexo da guia são manuais. Quando a guia aparece
     * (upload pela tela em com_nfe_guia_pdf, ou scanner em esc_documento), o
     * fluxo fecha sozinho, sem aviso — a tela já mostra "Guia recebida".
     */
    private async detectarGuiasAnexadas(): Promise<void> {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ chave_nfe: string }>>(
            `SELECT f.chave_nfe FROM com_nfe_st_fluxo f
              WHERE f.estado IN ('AGUARDANDO_ENVIO','ENVIADA_ESCRITORIO')
                AND (EXISTS (SELECT 1 FROM com_nfe_guia_pdf g WHERE g.chave_nfe = f.chave_nfe)
                  OR EXISTS (SELECT 1 FROM esc_documento e WHERE e.chave_nfe = f.chave_nfe AND e.tipo = 'guia-icms-st'))
              LIMIT 50`,
        ).catch((e) => {
            this.logger.warn(`Detecção de guia anexada falhou: ${e instanceof Error ? e.message : String(e)}`);
            return [];
        });
        for (const r of rows) {
            await this.gravar(r.chave_nfe, { estado: 'GUIA_RECEBIDA', guia_recebida_em: new Date() });
            this.logger.log(`NF ${this.numeroNf(r.chave_nfe)}: guia anexada, fluxo encerrado.`);
        }
    }

    private numeroNf(chave: string): string {
        return String(chave).substring(25, 34).replace(/^0+/, '');
    }

    private async iniciar(chave: string): Promise<void> {
        // Já calculada por alguém na tela: entra como MANUAL, sem mexer e sem avisar.
        const jaCalculada = await this.prisma.pagamentoGuia.findUnique({ where: { chave_nfe: chave }, select: { chave_nfe: true } });
        if (jaCalculada) {
            await this.gravar(chave, { estado: 'MANUAL' });
            return;
        }
        await this.calcular(chave, {});
    }

    /**
     * Decide o imposto de cada item, calcula e grava. `classificacao`
     * (nItem → ST/DIFAL/TRIBUTADA) vem das respostas do WhatsApp.
     */
    async calcular(chave: string, classificacao: Record<string, Classificacao>): Promise<void> {
        const nf = await this.prisma.nfeConciliacao.findUnique({ where: { chave_nfe: chave } });
        if (!nf) return;

        const itens = await this.icms.calculateStForInvoice(nf.xml_completo);
        if (!itens.length) {
            await this.gravar(chave, { estado: 'ERRO', erro: 'XML sem itens legíveis' });
            return;
        }

        const fornecedor = nf.cnpj_emitente ? await this.icms.findSupplierByCpfCnpj(nf.cnpj_emitente) : null;

        const dto: FiscalConferenceItemDto[] = [];
        const pendentes: Array<{ nItem: number; cProd: string; xProd: string; ncm: string; motivo: string }> = [];

        for (const it of itens) {
            const ncmNaTabela = it.matchType !== 'Não Encontrado';
            let imposto: Classificacao | null = it.semTributacao ? 'TRIBUTADA' : null;

            // SUBTIPO do cadastro (produto do fornecedor vinculado no ERP).
            let subtipo = '';
            if (!imposto && fornecedor?.FOR_CODIGO) {
                const vinculo = await this.icms.findSupplierProductLink(fornecedor.FOR_CODIGO, it.codProd, it.produto, it.unidadeFornecedor);
                const prod = vinculo?.PRO_CODIGO ? await this.icms.findInternalProduct(vinculo.PRO_CODIGO) : null;
                subtipo = this.icms.digitsOnly(prod?.SUBTIPO);
                if (subtipo === '07') imposto = 'DIFAL';
                else if (subtipo === '00' && ncmNaTabela) imposto = 'ST';
            }

            if (!imposto) imposto = classificacao[String(it.item)] ?? null;

            if (!imposto) {
                pendentes.push({
                    nItem: it.item, cProd: it.codProd, xProd: it.produto, ncm: it.ncmNota,
                    motivo: subtipo === '00' ? 'revenda, NCM fora da tabela de ST' : ncmNaTabela ? 'sem vínculo no cadastro' : 'sem vínculo e NCM fora da tabela',
                });
                continue;
            }

            dto.push({
                item: it.item,
                codProdFornecedor: String(it.codProd || ''),
                produto: String(it.produto || ''),
                unidadeFornecedor: String(it.unidadeFornecedor || ''),
                impostoEscolhido: imposto,
                destinacaoMercadoria: imposto === 'DIFAL' ? 'USO_CONSUMO' : 'COMERCIALIZACAO',
                ncmNota: it.ncmNota,
                cfop: it.cfop,
                cstNota: it.cstNota,
                possuiIcmsSt: Boolean(it.possuiIcmsSt),
                possuiDifal: imposto === 'DIFAL',
            });
        }

        if (pendentes.length) {
            await this.gravar(chave, { estado: 'NCM_PENDENTE', itens_pendentes: pendentes, classificacao, waha_msg_aviso: null });
            return;
        }

        // Mesma conta da tela (StCalculationResults.tsx): ST líquida dos itens ST + DIFAL dos itens DIFAL.
        const porItem = new Map(dto.map((d) => [d.item, d.impostoEscolhido]));
        const st = itens.filter((i) => porItem.get(i.item) === 'ST');
        const difal = itens.filter((i) => porItem.get(i.item) === 'DIFAL');
        const stTotal = Math.max(0, st.reduce((a, i) => a + i.diferenca, 0));
        const difalTotal = difal.reduce((a, i) => a + (i.vlDifal || 0), 0);
        const total = Number((stTotal + difalTotal).toFixed(2));
        const excedente = Number(st.reduce((a, i) => a + (i.valorPagoAMais || 0), 0).toFixed(2));
        const itensPadrao = st.filter((i) => i.matchType === 'Não Encontrado').length;
        const tipos = [st.length && 'ICMS ST', difal.length && 'DIFAL', dto.some((d) => d.impostoEscolhido === 'TRIBUTADA') && 'Tributada'].filter(Boolean);
        const temGuia = total > 0.05;

        await this.icms.savePaymentStatus({
            chaveNfe: chave,
            valor: total,
            observacoes: temGuia ? 'Tem Guia Complementar' : 'Sem Guia - Verificado',
            tipo_imposto: tipos.join('/'),
            usuario: 'Automático',
            itens: dto,
        });

        await this.gravar(chave, {
            estado: temGuia ? 'AGUARDANDO_ENVIO' : 'SEM_GUIA',
            tipo_guia: [st.length && 'ICMS_ST', difal.length && 'DIFAL'].filter(Boolean).join('/') || null,
            valor_guia: total,
            valor_excedente: excedente,
            itens_padrao: itensPadrao,
            itens_pendentes: null,
            classificacao,
            waha_msg_aviso: null,
        });
        this.logger.log(`NF ${chave}: ${temGuia ? `guia R$ ${total.toFixed(2)}` : 'sem guia'} (${tipos.join('/')}).`);
    }

    /** Monta e envia a mensagem do estado atual; só grava o id com resposta ok. */
    private async avisar(f: any): Promise<void> {
        const nf = await this.prisma.nfeConciliacao.findUnique({
            where: { chave_nfe: f.chave_nfe },
            select: { emitente: true },
        });
        const texto = this.montarAviso(f, nf?.emitente ?? '-');

        if (envLimpo('ST_FLUXO_DRY_RUN') === '1') {
            this.logger.log(`DRY-RUN WhatsApp:\n${texto}`);
            await this.gravar(f.chave_nfe, { waha_msg_aviso: 'dry-run' });
            return;
        }
        const id = await this.icms.wahaEnviarTexto(texto, undefined, this.grupoGuias);
        if (id) await this.gravar(f.chave_nfe, { waha_msg_aviso: id });
    }

    /** Texto da mensagem A (tem guia) ou B (imposto a definir) para a linha do fluxo. */
    private montarAviso(f: any, emitente: string): string {
        const numero = this.numeroNf(f.chave_nfe);
        const uf = this.icms.cufToSigla(String(f.chave_nfe).substring(0, 2));
        const brl = (v: any) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

        if (f.estado === 'NCM_PENDENTE') {
            const itens: any[] = f.itens_pendentes || [];
            const linhas = itens.map((p: any) => `• item ${p.nItem} — ${p.xProd} (cód. ${p.cProd})`).join('\n');
            const ex = itens[0]?.nItem ?? 1;
            return (
                `❓ *Preciso de uma resposta* — NF *${numero}* · ${emitente} (${uf})\n` +
                `Não consegui definir o imposto de ${itens.length} item(ns). Me diga o que é cada um:\n${linhas}\n\n` +
                `Responda a esta mensagem, um item por linha:\n` +
                `*${ex} st* = revenda com ICMS-ST · *${ex} difal* = uso e consumo · *${ex} tributada* = sem ST\n` +
                `ou *todos st* para todos iguais.\n` +
                `Assim que responder, eu calculo e aviso se tem guia.\n` +
                `\`${f.chave_nfe}\``
            );
        }
        const tipo = String(f.tipo_guia || 'ICMS_ST');
        const rotuloTipo = tipo === 'DIFAL' ? 'DIFAL' : tipo.includes('DIFAL') ? 'ICMS complementar (ST + DIFAL)' : 'ICMS complementar';
        const apuracao = [
            Number(f.valor_excedente) > 0 ? `• Em alguns itens o fornecedor destacou ST a mais: R$ ${brl(f.valor_excedente)} (não gera guia)` : '',
            Number(f.itens_padrao) > 0 ? `• ${f.itens_padrao} item(ns) calculado(s) com o MVA padrão, por não estar(em) na tabela` : '',
        ].filter(Boolean).join('\n');
        return (
            `🧾 *Existe guia a recolher* — NF *${numero}* · ${emitente} (${uf})\n` +
            `*${rotuloTipo}: R$ ${brl(f.valor_guia)}*\n\n` +
            `📨 *O que fazer:* pedir a guia ao escritório.\n` +
            `Depois de pedir, responda a esta mensagem com *enviado 25/09* (data do vencimento).\n` +
            `Se preferir tratar pela tela, responda *manual*.\n` +
            (apuracao ? `\nDetalhes da apuração:\n${apuracao}\n` : '') +
            `\`${f.chave_nfe}\``
        );
    }

    /** Estado do fluxo em linguagem da equipe (respostas no grupo). */
    private rotulo(estado: string): string {
        return ({
            NCM_PENDENTE: 'aguardando a classificação dos itens',
            SEM_GUIA: 'calculada, sem guia a recolher',
            AGUARDANDO_ENVIO: 'com guia a pedir ao escritório',
            ENVIADA_ESCRITORIO: 'guia já pedida ao escritório, aguardando o PDF',
            GUIA_RECEBIDA: 'guia recebida e anexada',
            MANUAL: 'fora do automático, tratada pela tela',
            ERRO: 'com erro no cálculo automático',
        } as Record<string, string>)[estado] ?? estado;
    }

    /**
     * Manda no grupo das guias as mensagens que o fluxo produz, com dados
     * fictícios, para a equipe ver o formato. É explícito (POST /icms/st-fluxo/exemplo),
     * então envia mesmo com ST_FLUXO_DRY_RUN=1. Não grava nada.
     */
    async enviarExemplos(): Promise<{ grupo: string | undefined; enviadas: string[] }> {
        const chaveA = '35260912345678000199550010000123451000123456';
        const chaveB = '41260998765432000188550010000098761000098765';
        const exemplos: Array<[string, string]> = [
            ['A_tem_guia', this.montarAviso({
                chave_nfe: chaveA, estado: 'AGUARDANDO_ENVIO', tipo_guia: 'ICMS_ST/DIFAL',
                valor_guia: 1234.56, valor_excedente: 80.1, itens_padrao: 2,
            }, 'FORNECEDOR EXEMPLO LTDA')],
            ['B_imposto_a_definir', this.montarAviso({
                chave_nfe: chaveB, estado: 'NCM_PENDENTE',
                itens_pendentes: [
                    { nItem: 3, cProd: 'ABC123', xProd: 'PARAFUSO SEXTAVADO M8', ncm: '73181500', motivo: 'sem vínculo no cadastro' },
                    { nItem: 7, cProd: 'XYZ9', xProd: 'ÓLEO LUBRIFICANTE 1L', ncm: '27101932', motivo: 'revenda, NCM fora da tabela de ST' },
                ],
            }, 'OUTRO FORNECEDOR EXEMPLO SA')],
            ['F_lembrete', this.montarLembrete({ chave_nfe: chaveA, estado: 'ENVIADA_ESCRITORIO', valor_guia: 1234.56 }, 3)],
            ['exemplo_aviso', '⚠️ As 3 mensagens acima são *exemplos* com dados fictícios, disparados para mostrar o formato. Nada foi calculado nem registrado.'],
        ];
        const enviadas: string[] = [];
        for (const [nome, texto] of exemplos) {
            const id = await this.icms.wahaEnviarTexto(texto, undefined, this.grupoGuias);
            if (id) enviadas.push(nome);
        }
        return { grupo: this.grupoGuias, enviadas };
    }

    // ------------------------------------------------------------------
    // Fase 3: lembrete e intervenção
    // ------------------------------------------------------------------

    private montarLembrete(f: any, dias: number): string {
        const numero = this.numeroNf(f.chave_nfe);
        const brl = Number(f.valor_guia || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        return f.estado === 'ENVIADA_ESCRITORIO'
            ? `⏳ *Guia pendente há ${dias} dias* — NF *${numero}* · R$ ${brl}\n` +
              `A guia foi pedida ao escritório e o PDF ainda não foi anexado. Quando chegar, anexe pela tela ou pelo scanner.\n\`${f.chave_nfe}\``
            : `⏳ *Guia pendente há ${dias} dias* — NF *${numero}* · R$ ${brl}\n` +
              `Ainda não há registro do pedido ao escritório. Peça a guia e responda *enviado dd/mm* na mensagem da NF.\n\`${f.chave_nfe}\``;
    }

    /**
     * Guia parada: NF com guia a pedir (AGUARDANDO_ENVIO) ou pedida (ENVIADA_ESCRITORIO)
     * há mais de ST_FLUXO_LEMBRETE_DIAS sem PDF → lembrete citando o aviso original;
     * repete a cada N dias enquanto não fechar.
     */
    private async lembrar(): Promise<void> {
        const dias = Number(envLimpo('ST_FLUXO_LEMBRETE_DIAS')) > 0 ? Number(envLimpo('ST_FLUXO_LEMBRETE_DIAS')) : 3;
        const rows = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT *, EXTRACT(EPOCH FROM NOW() - COALESCE(autorizado_em, created_at)) / 86400 AS idade_dias
               FROM com_nfe_st_fluxo
              WHERE estado IN ('AGUARDANDO_ENVIO','ENVIADA_ESCRITORIO')
                AND waha_msg_aviso IS NOT NULL
                AND COALESCE(lembrete_em, autorizado_em, created_at) < NOW() - ($1 || ' days')::interval
              ORDER BY created_at LIMIT 20`,
            String(dias),
        );
        for (const f of rows) {
            const texto = this.montarLembrete(f, Math.floor(Number(f.idade_dias)));
            if (envLimpo('ST_FLUXO_DRY_RUN') === '1') {
                this.logger.log(`DRY-RUN lembrete WhatsApp: ${texto}`);
            } else {
                const replyTo = f.waha_msg_aviso && !['dry-run', 'ok'].includes(f.waha_msg_aviso) ? f.waha_msg_aviso : undefined;
                const id = await this.icms.wahaEnviarTexto(texto, replyTo, this.grupoGuias);
                if (!id) continue; // WAHA fora: tenta no próximo ciclo
            }
            await this.gravar(f.chave_nfe, { lembrete_em: new Date() });
        }
    }

    /** Linhas do fluxo (tela/intervenção). */
    async listar(estado?: string): Promise<any[]> {
        return this.prisma.$queryRawUnsafe<any[]>(
            `SELECT f.*, c.emitente, c.data_emissao FROM com_nfe_st_fluxo f
               JOIN com_nfe_conciliacao c ON c.chave_nfe = f.chave_nfe
              ${estado ? 'WHERE f.estado = $1' : ''}
              ORDER BY f.updated_at DESC LIMIT 500`,
            ...(estado ? [estado] : []),
        );
    }

    /** Tira a NF do fluxo automático (mesmo efeito do "manual" no WhatsApp). */
    async marcarManual(chave: string, usuario?: string): Promise<void> {
        await this.gravar(chave, { estado: 'MANUAL', autorizado_por: (usuario || 'tela').slice(0, 30), autorizado_em: new Date() });
    }

    /** Recalcula e reavisa (ex.: depois de vincular o produto no ERP ou de ERRO). */
    async reprocessar(chave: string): Promise<void> {
        const [f] = await this.prisma.$queryRawUnsafe<any[]>(`SELECT classificacao FROM com_nfe_st_fluxo WHERE chave_nfe = $1`, chave);
        await this.calcular(chave, f?.classificacao || {});
    }

    // ------------------------------------------------------------------
    // Fase 2: respostas no grupo do WhatsApp (docs/automacao-icms-st.md, 2.3)
    // ------------------------------------------------------------------

    /**
     * Lê o grupo e trata cada resposta não processada que cita uma NF (chave de
     * 44 dígitos na mensagem citada ou no texto). Idempotente por id de mensagem
     * em com_nfe_ajustado_processado. Mensagem sem comando conhecido é ignorada
     * sem tocar no banco. Nunca lança.
     */
    async processarRespostasWaha(): Promise<void> {
        const auditoria = envLimpo('WAHA_GROUP_CHAT_ID') || undefined;
        const guias = this.grupoGuias;
        const cmdGuias = ['ENVIADO', 'MANUAL', 'CLASSIFICAR'];
        if (auditoria && auditoria === guias) {
            await this.lerGrupo(auditoria, new Set(['AJUSTADO', ...cmdGuias]));
            return;
        }
        if (auditoria) await this.lerGrupo(auditoria, new Set(['AJUSTADO']));
        if (guias) await this.lerGrupo(guias, new Set(cmdGuias));
    }

    /** Grupo do WhatsApp do fluxo de guias; sem WAHA_GUIAS_CHAT_ID cai no grupo da auditoria. */
    private get grupoGuias(): string | undefined {
        return envLimpo('WAHA_GUIAS_CHAT_ID') || envLimpo('WAHA_GROUP_CHAT_ID') || undefined;
    }

    private async lerGrupo(chatId: string, aceitos: Set<string>): Promise<void> {
        const msgs = await this.icms.wahaLerMensagens(chatId);
        if (!msgs) return;
        const janelaMin = Number(process.env.WAHA_AJUSTADO_JANELA_MIN) > 0 ? Number(process.env.WAHA_AJUSTADO_JANELA_MIN) : 1440;
        const limiteAntigoSec = Math.floor(Date.now() / 1000) - janelaMin * 60;

        for (const m of msgs) {
            try {
                if (m?.fromMe) continue;
                const body = String(m?.body ?? '');
                const cmd = comando(body);
                if (!cmd || !aceitos.has(cmd)) continue;
                const msgId = String(m?.id ?? '');
                if (!msgId) continue;

                const ja = await this.prisma.$queryRawUnsafe<any[]>(`SELECT 1 FROM com_nfe_ajustado_processado WHERE waha_msg_id = $1`, msgId);
                if (ja.length > 0) continue;

                // Mensagem antiga (ex.: histórico no 1º deploy): marca e ignora, sem responder.
                const ts = Number(m?.timestamp ?? 0);
                if (ts && ts < limiteAntigoSec) {
                    await this.icms.marcarAjustadoProcessado(msgId, null, 'ANTIGO');
                    continue;
                }

                const citada = String(m?.replyTo?.body ?? m?._data?.quotedMsg?.body ?? '');
                const chave = `${citada}\n${body}`.match(/(\d{44})/)?.[1] ?? null;
                if (!chave) {
                    await this.responder('❓ Não sei de qual NF você fala. Responda *citando a mensagem da NF*.', msgId, chatId);
                    await this.icms.marcarAjustadoProcessado(msgId, null, 'SEM_CHAVE');
                    continue;
                }

                if (cmd === 'AJUSTADO') {
                    await this.icms.tratarRespostaAjustado(msgId, chave);
                    continue;
                }

                const [f] = await this.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM com_nfe_st_fluxo WHERE chave_nfe = $1`, chave);
                const numero = chave.substring(25, 34).replace(/^0+/, '');
                if (!f) {
                    await this.responder(`ℹ️ NF *${numero}* não está no automático de ICMS-ST.`, msgId, chatId);
                    await this.icms.marcarAjustadoProcessado(msgId, chave, 'FORA_DO_FLUXO');
                    continue;
                }
                const quem = String(m?.participant ?? m?._data?.author ?? m?.from ?? '').replace(/\D/g, '').slice(0, 30);
                const resultado = await this.rotear(cmd, f, body, numero, quem, msgId, chatId);
                await this.icms.marcarAjustadoProcessado(msgId, chave, resultado);
                this.logger.log(`Resposta ${cmd} tratada (NF ${numero}, ${resultado}).`);
            } catch (e) {
                // Não marca como processada: tenta de novo no próximo ciclo.
                this.logger.error(`Falha ao tratar resposta (msg ${m?.id}): ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    /** Aplica o comando ao estado da NF e responde no grupo. Devolve o resultado para o registro. */
    private async rotear(cmd: string, f: any, body: string, numero: string, quem: string, msgId: string, chatId: string): Promise<string> {
        const estado = String(f.estado);

        if (cmd === 'MANUAL') {
            await this.gravar(f.chave_nfe, { estado: 'MANUAL', autorizado_por: quem, autorizado_em: new Date() });
            await this.responder(`👍 NF *${numero}* saiu do automático. Trate pela tela.`, msgId, chatId);
            return 'MANUAL';
        }

        if (cmd === 'ENVIADO') {
            if (estado !== 'AGUARDANDO_ENVIO') {
                await this.responder(`ℹ️ NF *${numero}* já está ${this.rotulo(estado)}. Nada a registrar.`, msgId, chatId);
                return 'ESTADO_INVALIDO';
            }
            const venc = parseVencimento(body);
            if (!venc) {
                await this.responder('❓ Qual o vencimento da guia? Responda, por exemplo: *enviado 25/09*', msgId, chatId);
                return 'SEM_VENCIMENTO';
            }
            await this.gravar(f.chave_nfe, { estado: 'ENVIADA_ESCRITORIO', vencimento: venc, autorizado_por: quem, autorizado_em: new Date() });
            const [a, mes, d] = venc.split('-');
            await this.responder(`✅ Anotado: guia da NF *${numero}* pedida ao escritório, vencimento ${d}/${mes}/${a}. Quando o PDF chegar, anexe pela tela ou pelo scanner.`, msgId, chatId);
            return 'ENVIADA';
        }

        // CLASSIFICAR
        if (estado !== 'NCM_PENDENTE') {
            await this.responder(`ℹ️ NF *${numero}* já está ${this.rotulo(estado)}. Não há item para classificar.`, msgId, chatId);
            return 'ESTADO_INVALIDO';
        }
        const pendentes: number[] = (f.itens_pendentes || []).map((p: any) => Number(p.nItem));
        const novas = parseClassificacao(body, pendentes);
        if (!Object.keys(novas).length) {
            await this.responder(`❓ Não entendi. Faltam os itens ${pendentes.join(', ')}. Responda um por linha, por exemplo *${pendentes[0]} st*, *${pendentes[0]} difal* ou *${pendentes[0]} tributada*, ou *todos st*.`, msgId, chatId);
            return 'CLASSIFICACAO_INVALIDA';
        }
        // calcular() repergunta só o que faltar, ou avisa o resultado (waha_msg_aviso volta a null).
        await this.calcular(f.chave_nfe, { ...(f.classificacao || {}), ...novas });
        return 'CLASSIFICADA';
    }

    /** Resposta curta citando a mensagem da pessoa, no grupo de onde ela veio; em DRY-RUN só loga. */
    private async responder(texto: string, replyTo: string, chatId: string): Promise<void> {
        if (envLimpo('ST_FLUXO_DRY_RUN') === '1') {
            this.logger.log(`DRY-RUN resposta WhatsApp (${replyTo}): ${texto}`);
            return;
        }
        await this.icms.wahaEnviarTexto(texto, replyTo, chatId);
    }

    /** Upsert da linha do fluxo. Colunas jsonb recebem objeto; o resto, valor simples. */
    private async gravar(chave: string, campos: Record<string, any>): Promise<void> {
        const JSONB = new Set(['itens_pendentes', 'classificacao']);
        const cols = Object.keys(campos);
        const vals = cols.map((c) => (JSONB.has(c) && campos[c] !== null ? JSON.stringify(campos[c]) : campos[c]));
        const ph = cols.map((c, i) => (JSONB.has(c) ? `$${i + 2}::jsonb` : `$${i + 2}`));
        // estado é NOT NULL: quem só atualiza (ex.: id do aviso) precisa que a linha já exista.
        const estadoInsert = cols.includes('estado') ? ph[cols.indexOf('estado')] : `'ERRO'`;
        const outras = cols.filter((c) => c !== 'estado');
        await this.prisma.$executeRawUnsafe(
            `INSERT INTO com_nfe_st_fluxo (chave_nfe, estado${outras.map((c) => `, ${c}`).join('')})
             VALUES ($1, ${estadoInsert}${outras.map((c) => `, ${ph[cols.indexOf(c)]}`).join('')})
             ON CONFLICT (chave_nfe) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = NOW()`,
            chave,
            ...vals,
        );
    }
}
