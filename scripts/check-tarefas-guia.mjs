// Checagem da tarefa "Anexar guia…" no Meu dia (src/icms/tarefas-guia.client.ts). Sem framework:
//   node scripts/check-tarefas-guia.mjs
// Compila o módulo para node_modules/.cache e roda contra um avisos-service falso (servidor HTTP que
// registra as chamadas) e um banco falso em memória. Leva ~10 s por causa do teste de timeout (8 s).
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const out = join('node_modules', '.cache', 'check-tarefas-guia');
mkdirSync(out, { recursive: true });
execSync(`npx tsc src/icms/tarefas-guia.client.ts --outDir "${out}" --module commonjs --target es2020 --skipLibCheck`, { stdio: 'inherit' });
const m = createRequire(import.meta.url)(join(process.cwd(), out, 'tarefas-guia.client.js'));

// ---------- funções puras ----------
const CHAVE_A = '35260912345678000190550010000123451000012345'; // NF 12345
const CHAVE_B = '41260998765432000110550010000000071000000071'; // NF 7
assert.equal(m.numeroNf(CHAVE_A), '12345');
assert.equal(m.numeroNf(CHAVE_B), '7');
assert.equal(m.tipoGuia('ICMS ST'), 'ICMS-ST');
assert.equal(m.tipoGuia('DIFAL'), 'DIFAL');
assert.equal(m.tipoGuia('DIFAL/Tributada'), 'DIFAL');
assert.equal(m.tipoGuia('ICMS ST/DIFAL/Tributada'), 'ICMS-ST/DIFAL');
assert.equal(m.tipoGuia(undefined), 'ICMS-ST');
assert.equal(
    m.tituloTarefa({ chave: CHAVE_A, tipoImposto: 'ICMS ST/DIFAL', emitente: ' AUTO PECAS SUL LTDA ', valor: 1234.5 }),
    'Anexar guia ICMS-ST/DIFAL — NF 12345 — AUTO PECAS SUL LTDA — R$ 1.234,50',
);
const obs = m.obsTarefa({
    tipoImposto: 'ICMS ST/DIFAL/Tributada',
    itens: [{ item: 1, produto: 'PARA-BRISA GOL', impostoEscolhido: 'ST' }, { item: 2, produto: 'COLA', impostoEscolhido: 'TRIBUTADA' }, { item: 3, produto: 'LUVA', impostoEscolhido: 'DIFAL' }],
    avisadoEm: '29/09',
});
assert.equal(obs, 'Imposto: ICMS ST/DIFAL/Tributada\nItens:\n1. PARA-BRISA GOL (ST)\n3. LUVA (DIFAL)\nAvisado no grupo em 29/09');

// ---------- banco falso ----------
const db = {
    pag: new Map(), conc: new Map(), fluxo: new Map(), guiaPdf: new Set(), esc: new Set(), consultas: 0,
    temGuia(c) { return this.guiaPdf.has(c) || this.esc.has(c); },
    async $queryRawUnsafe(sql, ...v) {
        this.consultas++;
        if (sql.includes('FROM (SELECT $1::varchar')) {
            const c = this.conc.get(v[0]) || {}, f = this.fluxo.get(v[0]);
            return [{ emitente: c.emitente, tipo_imposto: c.tipo_imposto, avisado_em: f?.waha ? f.dia : null, tem_guia: this.temGuia(v[0]) }];
        }
        if (sql.includes('make_interval')) {
            return [...this.pag].filter(([c, p]) => p.observacoes === 'Tem Guia Complementar' && !p.tarefa_criada_em && !this.temGuia(c))
                .map(([c, p]) => ({ chave_nfe: c, valor: p.valor, ...this.conc.get(c), avisado_em: this.fluxo.get(c)?.dia ?? null, base: this.fluxo.get(c)?.base ?? p.data }));
        }
        if (sql.includes('tarefa_concluida_em IS NULL')) {
            return [...this.pag].filter(([c, p]) => p.tarefa_criada_em && !p.tarefa_concluida_em && this.temGuia(c)).map(([c]) => ({ chave_nfe: c }));
        }
        throw new Error('consulta inesperada: ' + sql);
    },
    async $executeRawUnsafe(sql, ...v) {
        const p = this.pag.get(v[0]);
        if (sql.includes('CASE WHEN')) { p.tarefa_criada_em = v[1] ? 'agora' : p.tarefa_criada_em || 'agora'; p.tarefa_concluida_em = null; }
        else if (sql.includes('tarefa_criada_em = NULL')) p.tarefa_criada_em = null;
        else if (sql.includes('tarefa_concluida_em = now()')) p.tarefa_concluida_em = 'agora';
        else throw new Error('update inesperado: ' + sql);
        return 1;
    },
};
/** Simula savePaymentStatus: upsert (mantém as colunas de tarefa) + gatilho. */
async function salvar(dto) {
    const antes = db.pag.get(dto.chaveNfe) || { tarefa_criada_em: null, tarefa_concluida_em: null, data: '2026-09-28' };
    db.pag.set(dto.chaveNfe, { ...antes, valor: dto.valor, observacoes: dto.observacoes });
    await m.tarefaAoSalvarPagamento(db, dto);
}

// ---------- avisos-service falso ----------
let modo = 'ok';
const chamadas = [];
const server = createServer((req, res) => {
    let corpo = '';
    req.on('data', (d) => (corpo += d));
    req.on('end', () => {
        chamadas.push({ path: req.url, token: req.headers['x-app-token'], tipo: req.headers['content-type'], body: JSON.parse(corpo || '{}') });
        if (modo === 'hang') return; // nunca responde: o cliente tem que desistir sozinho
        if (modo === '500') { res.writeHead(500); return res.end('erro'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/pessoal/tarefas/sistema') return res.end(JSON.stringify(modo === 'inativo' ? { ativo: false } : { tarefa: { id: 't1' }, criada: true }));
        res.end(JSON.stringify(req.url.endsWith('/concluir') ? { concluidas: 1 } : { canceladas: 1 }));
    });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

try {
    const telaA = { chaveNfe: CHAVE_A, valor: 1234.5, observacoes: 'Tem Guia Complementar', tipo_imposto: 'ICMS ST/DIFAL', usuario: 'Fulano',
        itens: [{ item: 1, produto: 'PARA-BRISA GOL', impostoEscolhido: 'ST' }] };
    db.conc.set(CHAVE_A, { emitente: 'AUTO PECAS SUL LTDA', tipo_imposto: 'ICMS ST' });

    // Sem AVISOS_SERVICE_URL: o salvamento segue, sem chamada e sem consulta.
    delete process.env.AVISOS_SERVICE_URL;
    await salvar(telaA);
    assert.equal(chamadas.length, 0);
    assert.equal(db.consultas, 0);
    assert.equal(await m.criar({ chave: 'x', ref: 'y', titulo: 'z' }), null);

    process.env.AVISOS_SERVICE_URL = `${url}/  # comentário do EasyPanel`;
    process.env.APP_TOKEN = 'segredo';

    // "Tem guia" pela tela e depois pelo robô: criar com o mesmo título, token no header, link da NF.
    db.fluxo.set(CHAVE_A, { waha: 'msg1', dia: '29/09', base: '2026-09-29' });
    await salvar(telaA);
    await salvar({ ...telaA, usuario: 'Automático' });
    assert.equal(chamadas.length, 2);
    for (const c of chamadas) {
        assert.equal(c.path, '/pessoal/tarefas/sistema');
        assert.equal(c.token, 'segredo');
        assert.equal(c.tipo, 'application/json');
        assert.equal(c.body.chave, 'fiscal.guia_st');
        assert.equal(c.body.ref, CHAVE_A);
        assert.equal(c.body.link, `/fiscal/nfe/${CHAVE_A}`);
        assert.equal(c.body.titulo, 'Anexar guia ICMS-ST/DIFAL — NF 12345 — AUTO PECAS SUL LTDA — R$ 1.234,50');
        assert.match(c.body.obs, /1\. PARA-BRISA GOL \(ST\)\nAvisado no grupo em 29\/09$/);
    }
    assert.equal(db.pag.get(CHAVE_A).tarefa_criada_em, 'agora');

    // Reclassificada "Sem guia": cancelar e zera a marca.
    chamadas.length = 0;
    await salvar({ ...telaA, valor: 0, observacoes: 'Sem Guia - Verificado' });
    assert.deepEqual(chamadas.map((c) => [c.path, c.body]), [['/pessoal/tarefas/sistema/cancelar', { chave: 'fiscal.guia_st', ref: CHAVE_A }]]);
    assert.equal(db.pag.get(CHAVE_A).tarefa_criada_em, null);

    // Guia já anexada no momento do cálculo: não cria.
    chamadas.length = 0;
    db.guiaPdf.add(CHAVE_A);
    await salvar(telaA);
    assert.equal(chamadas.length, 0);
    db.guiaPdf.delete(CHAVE_A);

    // Regra desligada no avisos-service: nada a acompanhar.
    modo = 'inativo';
    await salvar(telaA);
    assert.equal(db.pag.get(CHAVE_A).tarefa_criada_em, null);
    modo = 'ok';

    // Fechamento: guia pela tela (PDF) e pelo scanner → concluir uma vez só cada.
    db.conc.set(CHAVE_B, { emitente: 'DISTRIB NORTE', tipo_imposto: 'DIFAL' });
    await salvar(telaA);
    await salvar({ chaveNfe: CHAVE_B, valor: 50, observacoes: 'Tem Guia Complementar', tipo_imposto: 'DIFAL', usuario: 'Automático' });
    chamadas.length = 0;
    assert.equal(await m.fecharTarefasGuia(db), 0, 'sem guia anexada não conclui');
    db.guiaPdf.add(CHAVE_A);
    db.esc.add(CHAVE_B);
    assert.equal(await m.fecharTarefasGuia(db), 2);
    assert.equal(await m.fecharTarefasGuia(db), 0, 'segunda passada não repete');
    assert.deepEqual(chamadas.map((c) => [c.path, c.body.ref]).sort(), [['/pessoal/tarefas/sistema/concluir', CHAVE_A], ['/pessoal/tarefas/sistema/concluir', CHAVE_B]].sort());
    db.guiaPdf.delete(CHAVE_A); // guia removida depois não reabre
    assert.equal(await m.fecharTarefasGuia(db), 0);

    // Carga inicial: só "Tem guia" sem guia e sem tarefa; base = aviso do robô ou data do cálculo.
    const CHAVE_C = '35260912345678000190550010000009991000009991';
    const CHAVE_D = '35260912345678000190550010000008881000008881';
    db.pag.set(CHAVE_C, { valor: 80, observacoes: 'Tem Guia Complementar', tarefa_criada_em: null, tarefa_concluida_em: null, data: '2026-09-20' });
    db.pag.set(CHAVE_D, { valor: 90, observacoes: 'Tem Guia Complementar', tarefa_criada_em: null, tarefa_concluida_em: null, data: '2026-09-22' });
    db.conc.set(CHAVE_C, { emitente: 'FORN C', tipo_imposto: 'ICMS ST' });
    db.fluxo.set(CHAVE_D, { waha: 'm', dia: '21/09', base: '2026-09-21' });
    chamadas.length = 0;
    const seco = await m.cargaTarefasGuia(db, 15, true);
    assert.equal(chamadas.length, 0, 'dry não chama o avisos-service');
    assert.deepEqual(seco.lista.map((t) => [t.chave, t.base]), [[CHAVE_C, '2026-09-20'], [CHAVE_D, '2026-09-21']]);
    assert.equal(seco.lista[0].titulo, 'Anexar guia ICMS-ST — NF 999 — FORN C — R$ 80,00');
    assert.equal(seco.criadas, 0);
    const real = await m.cargaTarefasGuia(db, 15, false);
    assert.deepEqual([real.total, real.criadas], [2, 2]);
    assert.deepEqual(chamadas.map((c) => c.body.base), ['2026-09-20', '2026-09-21']);
    assert.equal((await m.cargaTarefasGuia(db, 15, true)).total, 0, 'segunda carga não duplica');

    // Falhas do avisos-service nunca lançam: HTTP 500 e timeout (8 s) devolvem null.
    modo = '500';
    assert.equal(await m.concluir({ chave: 'fiscal.guia_st', ref: CHAVE_A }), null);
    modo = 'hang';
    const t0 = Date.now();
    assert.equal(await m.cancelar({ chave: 'fiscal.guia_st', ref: CHAVE_A }), null);
    const dt = Date.now() - t0;
    assert.ok(dt >= 7500 && dt < 12000, `timeout em ${dt} ms`);

    console.log('check-tarefas-guia: OK');
} finally {
    server.closeAllConnections?.();
    server.close();
}
