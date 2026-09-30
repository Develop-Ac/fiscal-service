import { Logger } from '@nestjs/common';
import { envLimpo } from './st-fluxo.parse';

/**
 * Tarefa "Anexar guia…" no Meu dia (avisos-service, docs/automacao-icms-st.md seção 8).
 *
 * Toda NF de entrada salva com "Tem Guia Complementar" (pela tela ou pelo robô, os dois passam por
 * savePaymentStatus) vira uma tarefa pessoal do responsável pelo fiscal, por chave `fiscal.guia_st` +
 * ref = chave da NF. Quem recebe, o prazo em dias úteis e a etiqueta vêm da regra no avisos-service
 * (Avisos › Configuração); daqui só vão título, observação e link. A tarefa é concluída quando a guia
 * aparece (upload na tela ou scanner) e cancelada se a NF for reclassificada como sem guia.
 *
 * Nada aqui derruba o salvamento do cálculo: falha de rede vira aviso no log. Sem Nest de propósito:
 * `node scripts/check-tarefas-guia.mjs` exercita tudo com banco e avisos-service falsos.
 */

const logger = new Logger('TarefasGuia');
export const CHAVE_TAREFA = 'fiscal.guia_st';
const TIMEOUT_MS = 8000;
const TEM_GUIA = 'Tem Guia Complementar';

/** O que usamos do Prisma (raw); permite testar com um banco falso. */
export type Db = {
    $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
};

type Item = { item?: number; produto?: string; impostoEscolhido?: string };

// ---------- funções puras ----------

/** "ICMS ST/DIFAL/Tributada" (formato da tela e do robô) → rótulo da guia no título. */
export function tipoGuia(tipoImposto?: string | null): 'ICMS-ST' | 'DIFAL' | 'ICMS-ST/DIFAL' {
    const t = String(tipoImposto || '');
    const difal = /DIFAL/i.test(t);
    const st = /\bST\b/i.test(t);
    return difal && st ? 'ICMS-ST/DIFAL' : difal ? 'DIFAL' : 'ICMS-ST';
}

/** Número da NF nas posições 26–34 da chave, sem zeros à esquerda. */
export function numeroNf(chave: string): string {
    return String(chave).substring(25, 34).replace(/^0+/, '');
}

export function tituloTarefa(p: { chave: string; tipoImposto?: string | null; emitente?: string | null; valor?: number | null }): string {
    const brl = Number(p.valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const emitente = String(p.emitente || '').trim() || 'emitente não identificado';
    return `Anexar guia ${tipoGuia(p.tipoImposto)} — NF ${numeroNf(p.chave)} — ${emitente} — R$ ${brl}`.slice(0, 300);
}

/** Tipo de imposto, itens que geram guia (ST/DIFAL) e quando o robô avisou no grupo (dd/mm). */
export function obsTarefa(p: { tipoImposto?: string | null; itens?: Item[] | null; avisadoEm?: string | null }): string {
    const linhas = [`Imposto: ${p.tipoImposto || tipoGuia(p.tipoImposto)}`];
    const comGuia = (p.itens || []).filter((i) => i?.impostoEscolhido === 'ST' || i?.impostoEscolhido === 'DIFAL');
    if (comGuia.length) {
        linhas.push('Itens:');
        for (const i of comGuia.slice(0, 20)) linhas.push(`${i.item ?? '?'}. ${i.produto || 'item sem descrição'} (${i.impostoEscolhido})`);
        if (comGuia.length > 20) linhas.push(`… e mais ${comGuia.length - 20}`);
    }
    if (p.avisadoEm) linhas.push(`Avisado no grupo em ${p.avisadoEm}`);
    return linhas.join('\n').slice(0, 4000);
}

// ---------- cliente HTTP (rotas de máquina do avisos-service) ----------

let avisouSemUrl = false;

/** Sem AVISOS_SERVICE_URL a funcionalidade fica desligada; avisa uma vez no log. */
export function ligado(): boolean {
    if (envLimpo('AVISOS_SERVICE_URL')) return true;
    if (!avisouSemUrl) {
        avisouSemUrl = true;
        logger.warn('AVISOS_SERVICE_URL não configurada: tarefas "Anexar guia" no Meu dia desligadas.');
    }
    return false;
}

/** POST em /pessoal/tarefas/sistema[caminho]. Nunca lança: erro → warn no log e null. */
async function post(caminho: string, corpo: Record<string, unknown>): Promise<any | null> {
    if (!ligado()) return null;
    const url = `${envLimpo('AVISOS_SERVICE_URL').replace(/\/+$/, '')}/pessoal/tarefas/sistema${caminho}`;
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-app-token': envLimpo('APP_TOKEN') },
            body: JSON.stringify(corpo),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!r.ok) {
            logger.warn(`avisos-service ${caminho || '/'} respondeu HTTP ${r.status} (ref ${corpo.ref}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
            return null;
        }
        return await r.json().catch(() => ({}));
    } catch (e) {
        logger.warn(`avisos-service ${caminho || '/'} falhou (ref ${corpo.ref}): ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

/** Resposta: {tarefa:{id}, criada} | {ativo:false} | {descoberta:true} | null (falha). */
export function criar(p: { chave: string; ref: string; titulo: string; obs?: string; link?: string; base?: string }) {
    return post('', {
        ...p,
        // Só usada se a regra ainda não existir: nasce como rascunho desligado no catálogo.
        descricao: 'NF de entrada com guia de ICMS-ST/DIFAL a pagar: anexar a guia na tela da NF (fiscal-service).',
    });
}
export const concluir = (p: { chave: string; ref: string }) => post('/concluir', p);
export const cancelar = (p: { chave: string; ref: string }) => post('/cancelar', p);

// ---------- gatilho, fechamento e carga (com_pagamento_guia) ----------

/** Guia anexada à NF `alias.chave_nfe`: PDF pela tela ou documento do scanner. */
const temGuiaSql = (alias: string) =>
    `(EXISTS (SELECT 1 FROM com_nfe_guia_pdf g WHERE g.chave_nfe = ${alias}.chave_nfe)
      OR EXISTS (SELECT 1 FROM esc_documento e WHERE e.chave_nfe = ${alias}.chave_nfe AND e.tipo = 'guia-icms-st'))`;

/** Aviso do robô no grupo (dry-run não conta como enviado), em dd/mm de Cuiabá. */
const avisadoEmSql = `CASE WHEN f.waha_msg_aviso IS NOT NULL AND f.waha_msg_aviso <> 'dry-run'
                           THEN to_char(f.created_at AT TIME ZONE 'America/Cuiaba', 'DD/MM') END`;

async function criarEMarcar(db: Db, chave: string, corpo: { titulo: string; obs: string; base?: string }) {
    const r = await criar({ chave: CHAVE_TAREFA, ref: chave, link: `/fiscal/nfe/${chave}`, ...corpo });
    if (!r?.tarefa) return r; // regra desligada/rascunho ou falha: nada a acompanhar
    // criada:false = já havia tarefa aberta para a NF; marca mesmo assim para o fechamento acompanhá-la.
    await db.$executeRawUnsafe(
        `UPDATE com_pagamento_guia
            SET tarefa_criada_em = CASE WHEN $2::boolean THEN now() ELSE COALESCE(tarefa_criada_em, now()) END,
                tarefa_concluida_em = NULL
          WHERE chave_nfe = $1`,
        chave, r.criada === true,
    );
    return r;
}

/**
 * Chamado por savePaymentStatus depois do upsert (tela e robô). "Tem guia" → cria a tarefa (se a
 * guia ainda não foi anexada); qualquer outro resultado → cancela a tarefa aberta, se houver.
 */
export async function tarefaAoSalvarPagamento(
    db: Db,
    dto: { chaveNfe: string; valor?: number; observacoes?: string; tipo_imposto?: string; itens?: Item[] },
): Promise<void> {
    if (!ligado()) return;
    try {
        if (dto.observacoes !== TEM_GUIA) {
            if (await cancelar({ chave: CHAVE_TAREFA, ref: dto.chaveNfe })) {
                await db.$executeRawUnsafe(`UPDATE com_pagamento_guia SET tarefa_criada_em = NULL WHERE chave_nfe = $1`, dto.chaveNfe);
            }
            return;
        }
        const [nf] = await db.$queryRawUnsafe<any[]>(
            `SELECT c.emitente, c.tipo_imposto, ${avisadoEmSql} AS avisado_em, ${temGuiaSql('k')} AS tem_guia
               FROM (SELECT $1::varchar AS chave_nfe) k
               LEFT JOIN com_nfe_conciliacao c ON c.chave_nfe = k.chave_nfe
               LEFT JOIN com_nfe_st_fluxo f ON f.chave_nfe = k.chave_nfe`,
            dto.chaveNfe,
        );
        if (nf?.tem_guia) return; // guia já anexada: nada a fazer
        const tipoImposto = dto.tipo_imposto ?? nf?.tipo_imposto;
        await criarEMarcar(db, dto.chaveNfe, {
            titulo: tituloTarefa({ chave: dto.chaveNfe, tipoImposto, emitente: nf?.emitente, valor: dto.valor }),
            obs: obsTarefa({ tipoImposto, itens: dto.itens, avisadoEm: nf?.avisado_em }),
        });
    } catch (e) {
        logger.warn(`Tarefa da guia da NF ${numeroNf(dto.chaveNfe)} não sincronizada: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Ciclo de fechamento (cron de 1 min): tarefa criada e não concluída cuja NF já tem guia anexada →
 * concluir. Grava tarefa_concluida_em só quando o avisos-service respondeu, então cada NF é concluída
 * uma vez; guia removida depois não reabre. Não mexe em com_nfe_st_fluxo.
 */
export async function fecharTarefasGuia(db: Db): Promise<number> {
    const rows = await db.$queryRawUnsafe<Array<{ chave_nfe: string }>>(
        `SELECT p.chave_nfe FROM com_pagamento_guia p
          WHERE p.tarefa_criada_em IS NOT NULL AND p.tarefa_concluida_em IS NULL
            AND ${temGuiaSql('p')}
          LIMIT 50`,
    );
    let n = 0;
    for (const r of rows) {
        if (!(await concluir({ chave: CHAVE_TAREFA, ref: r.chave_nfe }))) continue;
        await db.$executeRawUnsafe(`UPDATE com_pagamento_guia SET tarefa_concluida_em = now() WHERE chave_nfe = $1`, r.chave_nfe);
        n++;
    }
    return n;
}

/**
 * Carga inicial (rodada uma vez depois do deploy): "Tem guia" calculadas nos últimos `dias`, sem guia
 * anexada e sem tarefa. O prazo parte do dia em que o robô avisou (linha no fluxo) ou do cálculo,
 * para as vencidas já nascerem atrasadas. `dry` só lista.
 */
export async function cargaTarefasGuia(db: Db, dias: number, dry: boolean) {
    const rows = await db.$queryRawUnsafe<any[]>(
        `SELECT p.chave_nfe, p.valor, c.emitente, c.tipo_imposto, ${avisadoEmSql} AS avisado_em,
                to_char(COALESCE(f.created_at, p.data_pagamento AT TIME ZONE 'UTC') AT TIME ZONE 'America/Cuiaba', 'YYYY-MM-DD') AS base
           FROM com_pagamento_guia p
           LEFT JOIN com_nfe_conciliacao c ON c.chave_nfe = p.chave_nfe
           LEFT JOIN com_nfe_st_fluxo f ON f.chave_nfe = p.chave_nfe
          WHERE p.observacoes = '${TEM_GUIA}'
            AND p.data_pagamento >= (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int)
            AND p.tarefa_criada_em IS NULL
            AND NOT ${temGuiaSql('p')}
          ORDER BY p.data_pagamento`,
        dias,
    );
    const lista = rows.map((r) => ({
        chave: r.chave_nfe as string,
        titulo: tituloTarefa({ chave: r.chave_nfe, tipoImposto: r.tipo_imposto, emitente: r.emitente, valor: Number(r.valor) }),
        obs: obsTarefa({ tipoImposto: r.tipo_imposto, avisadoEm: r.avisado_em }),
        base: r.base as string,
    }));
    let criadas = 0;
    if (!dry && ligado()) {
        for (const t of lista) {
            const r = await criarEMarcar(db, t.chave, { titulo: t.titulo, obs: t.obs, base: t.base });
            if (r?.criada === true) criadas++;
        }
    }
    return { total: lista.length, criadas, lista: lista.map(({ chave, titulo, base }) => ({ chave, titulo, base })) };
}
