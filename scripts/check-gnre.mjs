// Checagem do núcleo da GNRE (parse da NF-e, lote 2.00, retorno e PDF). Sem framework:
//   node scripts/check-gnre.mjs
// Compila só os arquivos puros de src/gnre para uma pasta temporária e roda asserts
// sobre uma NF sintética de DIFAL ao PA.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

// dentro de node_modules/.cache para os requires acharem fast-xml-parser/pdfkit
mkdirSync('node_modules/.cache', { recursive: true });
const out = resolve(mkdtempSync(join('node_modules', '.cache', 'check-gnre-')));
const src = ['gnre-nfe', 'gnre-builder', 'gnre-client', 'gnre-pdf'].map((f) => `src/gnre/${f}.ts`).join(' ');
execSync(`npx tsc ${src} --outDir "${out}" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`, { stdio: 'inherit' });
cpSync('src/gnre/assets', join(out, 'assets'), { recursive: true });
const req = createRequire(import.meta.url);
const { parseNfe } = req(join(out, 'gnre-nfe.js'));
const B = req(join(out, 'gnre-builder.js'));
const { parseResposta } = req(join(out, 'gnre-client.js'));
const { parseGuias, gerarPdfGuia } = req(join(out, 'gnre-pdf.js'));

const nfe = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe51260707351198000105550010001515611207557713">
<ide><mod>55</mod><serie>1</serie><nNF>151561</nNF><dhEmi>2026-07-15T10:00:00-04:00</dhEmi><idDest>2</idDest><indFinal>1</indFinal><natOp>VENDA</natOp></ide>
<emit><CNPJ>07351198000105</CNPJ><xNome>EMITENTE & CIA</xNome><IE>133018008</IE><enderEmit><xLgr>RUA A</xLgr><nro>1</nro><xBairro>CENTRO</xBairro><cMun>5107925</cMun><UF>MT</UF><CEP>78896052</CEP><fone>6635446545</fone></enderEmit></emit>
<dest><CPF>00000000191</CPF><xNome>CONSUMIDOR TESTE</xNome><indIEDest>9</indIEDest><enderDest><cMun>1508050</cMun><xMun>TRAIRAO</xMun><UF>PA</UF></enderDest></dest>
<det nItem="1"><imposto><ICMS><ICMS00><CST>00</CST></ICMS00></ICMS></imposto></det>
<total><ICMSTot><vST>0.00</vST><vICMSUFDest>13.65</vICMSUFDest><vFCPUFDest>0.35</vFCPUFDest></ICMSTot></total>
</infNFe></NFe></nfeProc>`;

const cfg = {
    gnre: { ambiente: 'producao', ufFavorecida: 'PA', urlRecepcao: '', urlResultado: '', versaoDados: '2.00', timeoutSeg: 60 },
    regras: { receitaIcmsSt: '100099', receitaDifal: '100102', tipoDocOrigem: '10', docOrigemUsar: 'numero', incluirMunicipio: true, vencimentoModo: 'hoje', vencimentoDias: 0, periodoReferencia: '0' },
};

const nota = parseNfe(nfe);
assert.equal(nota.chave, '51260707351198000105550010001515611207557713');
assert.equal(nota.interestadual, true);
assert.deepEqual(B.guiasDisponiveis(nota), ['difal']);
assert.equal(B.municipio5('1508050'), '08050');

const { xml, infos } = B.montarLote(nota, cfg, ['difal']);
assert.deepEqual(B.validarLote(nota, cfg, ['difal']), []);
assert.equal(infos[0].valorTotal, '14.00', 'principal + FECP em centavos');
assert.match(xml, /<documentoOrigem tipo="10">151561<\/documentoOrigem>/, 'PA/100102: número da nota, não a chave');
assert.match(xml, /<municipio>07925<\/municipio>/);
assert.match(xml, /<razaoSocial>EMITENTE &amp; CIA<\/razaoSocial>/);
assert.match(xml, /<valor tipo="12">0.35<\/valor>/);
assert.doesNotMatch(xml, /<IE>/, 'DIFAL: destinatário consumidor final sem IE');
assert.ok(B.calcularVencimento(nota, cfg.regras) >= B.hojeIso(), 'vencimento nunca no passado');

// Retorno da consulta: guia processada com barras (reaproveita o lote montado).
const guia = xml.match(/<TDadosGNRE[\s\S]*<\/TDadosGNRE>/)[0]
    .replace('<TDadosGNRE versao="2.00">', '<guia><situacaoGuia>0</situacaoGuia>')
    .replace('</TDadosGNRE>', `<linhaDigitavel>${'8'.repeat(48)}</linhaDigitavel><codigoBarras>${'1'.repeat(44)}</codigoBarras></guia>`);
const raw = `<soap:Envelope xmlns:soap="x"><soap:Body><TResultLote_GNRE xmlns="http://www.gnre.pe.gov.br"><situacaoProcess><codigo>403</codigo><descricao>servi&amp;#xE7;o</descricao></situacaoProcess><resultado>${guia}</resultado></TResultLote_GNRE></soap:Body></soap:Envelope>`;
const resp = parseResposta(200, raw);
assert.equal(resp.codigo, '403');
assert.equal(resp.descricao, 'serviço', 'texto duplo-escapado da SEFAZ decodificado');
assert.equal(resp.situacaoGuia, '0');
const [g] = parseGuias(raw);
assert.equal(g.receita, '100102');
assert.equal(g.valorFecp, '0.35');
assert.equal(g.docOrigem, '151561');
const pdf = await gerarPdfGuia(raw, nota.chave);
assert.equal(pdf.subarray(0, 4).toString(), '%PDF');

console.log('check-gnre: OK');
