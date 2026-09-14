// Checagem dos parsers das respostas do WhatsApp (fluxo ST). Sem framework:
//   node scripts/check-st-fluxo-parse.mjs
// Compila só src/icms/st-fluxo.parse.ts para uma pasta temporária e roda asserts.
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const out = mkdtempSync(join(tmpdir(), 'st-fluxo-'));
execSync(`npx tsc src/icms/st-fluxo.parse.ts --outDir "${out}" --module commonjs --target es2020 --skipLibCheck`, { stdio: 'inherit' });
const { comando, parseVencimento, parseClassificacao } = createRequire(import.meta.url)(join(out, 'st-fluxo.parse.js'));

// comando()
assert.equal(comando('Ajustado!'), 'AJUSTADO');
assert.equal(comando('pode enviar 25/09'), 'AUTORIZAR');
assert.equal(comando('manual'), 'MANUAL');
assert.equal(comando('3 st\n7 difal'), 'CLASSIFICAR');
assert.equal(comando('todos st'), 'CLASSIFICAR');
assert.equal(comando('bom dia pessoal'), null);
assert.equal(comando('tem 3 caixas'), null, 'número seguido de palavra comum não é classificação');

// parseVencimento()
assert.equal(parseVencimento('pode enviar 25/09', 2026), '2026-09-25');
assert.equal(parseVencimento('pode enviar 5/1/27', 2026), '2027-01-05');
assert.equal(parseVencimento('pode enviar 05/01/2027', 2026), '2027-01-05');
assert.equal(parseVencimento('pode enviar', 2026), null);
assert.equal(parseVencimento('pode enviar 32/13', 2026), null);

// parseClassificacao()
assert.deepEqual(parseClassificacao('3 st\n7 difal\n9 tributada', [3, 7, 9]), { 3: 'ST', 7: 'DIFAL', 9: 'TRIBUTADA' });
assert.deepEqual(parseClassificacao('3: revenda; 7 - consumo, 9 uso', [3, 7, 9]), { 3: 'ST', 7: 'DIFAL', 9: 'DIFAL' });
assert.deepEqual(parseClassificacao('todos st', [3, 7]), { 3: 'ST', 7: 'ST' });
assert.deepEqual(parseClassificacao('todos difal\n7 tributada', [3, 7]), { 3: 'DIFAL', 7: 'TRIBUTADA' }, 'linha específica depois do todos prevalece');
assert.deepEqual(parseClassificacao('5 st', [3, 7]), {}, 'item que não está pendente é ignorado');
assert.deepEqual(parseClassificacao('3 st', [3, 7]), { 3: 'ST' }, 'resposta parcial mantém o resto pendente');

console.log('check-st-fluxo-parse: OK');
