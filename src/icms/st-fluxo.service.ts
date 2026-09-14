import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IcmsService } from './icms.service';
import { FiscalConferenceItemDto } from './dto/fiscal-conference.dto';

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
export type Classificacao = 'ST' | 'DIFAL' | 'TRIBUTADA';

@Injectable()
export class StFluxoService {
    private readonly logger = new Logger(StFluxoService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly icms: IcmsService,
    ) {}

    /** Um ciclo: NFs novas + reenvio de avisos que falharam. Nunca lança. */
    async processarCiclo(): Promise<void> {
        const janelaDias = Number(process.env.ST_FLUXO_JANELA_DIAS) > 0 ? Number(process.env.ST_FLUXO_JANELA_DIAS) : 7;
        const novas = await this.prisma.$queryRawUnsafe<Array<{ chave_nfe: string }>>(
            `SELECT c.chave_nfe
               FROM com_nfe_conciliacao c
              WHERE c.tipo_operacao = 0
                AND LEFT(c.chave_nfe, 2) <> '51'
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

        // Aviso que não saiu (WAHA fora, etc.): tenta de novo.
        const semAviso = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT * FROM com_nfe_st_fluxo
              WHERE waha_msg_aviso IS NULL AND estado IN ('AGUARDANDO_AUTORIZACAO','NCM_PENDENTE')
              ORDER BY created_at LIMIT 20`,
        );
        for (const f of semAviso) {
            try {
                await this.avisar(f);
            } catch (e) {
                this.logger.error(`Falha ao avisar NF ${f.chave_nfe}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
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
            estado: temGuia ? 'AGUARDANDO_AUTORIZACAO' : 'SEM_GUIA',
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
        const numero = String(f.chave_nfe).substring(25, 34).replace(/^0+/, '');
        const uf = this.icms.cufToSigla(String(f.chave_nfe).substring(0, 2));
        const brl = (v: any) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        let texto: string;

        if (f.estado === 'NCM_PENDENTE') {
            const linhas = (f.itens_pendentes || [])
                .map((p: any) => `• item ${p.nItem} — ${p.cProd} ${p.xProd} (NCM ${p.ncm}) — ${p.motivo}`)
                .join('\n');
            texto =
                `❓ *Imposto a definir* — NF *${numero}* · ${nf?.emitente ?? '-'} (${uf})\n` +
                `Preciso saber o imposto de cada item para calcular:\n${linhas}\n\n` +
                `↩️ Responda citando esta mensagem, um item por linha:\n` +
                `3 st · 7 difal · 9 tributada · ou: todos st\n` +
                `\`${f.chave_nfe}\``;
        } else {
            const tipos = String(f.tipo_guia || '');
            texto =
                `🧾 *${tipos.replace('_', '-').replace('/', ' + ')} calculado* — NF *${numero}*\n` +
                `Fornecedor: ${nf?.emitente ?? '-'} (${uf})\n` +
                `A recolher: *R$ ${brl(f.valor_guia)}*\n` +
                (Number(f.valor_excedente) > 0 ? `Excedente: ST destacada acima da calculada em R$ ${brl(f.valor_excedente)} (sem guia)\n` : '') +
                (Number(f.itens_padrao) > 0 ? `${f.itens_padrao} item(ns) com MVA padrão 50,39% (NCM fora da tabela)\n` : '') +
                `\n↩️ Responda a esta mensagem com *pode enviar dd/mm* (vencimento) para pedir a guia ao escritório, ou *manual* para tratar na tela.\n` +
                `\`${f.chave_nfe}\``;
        }

        if (process.env.ST_FLUXO_DRY_RUN === '1') {
            this.logger.log(`DRY-RUN WhatsApp:\n${texto}`);
            await this.gravar(f.chave_nfe, { waha_msg_aviso: 'dry-run' });
            return;
        }
        const id = await this.icms.wahaEnviarTexto(texto);
        if (id) await this.gravar(f.chave_nfe, { waha_msg_aviso: id });
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
