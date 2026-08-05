import { DanfseDados, Valor } from './nfse-nacional.extract';
import { logoNfse } from './municipios';

// pdfkit e bwip-js não trazem types no projeto; usamos require (mesmo padrão do DACTE).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bwipjs = require('bwip-js');

/**
 * DANFSe v2.0 (NT 008/2026) — Documento Auxiliar da NFS-e, em PDF.
 *
 * Substitui o download do PDF oficial na API nacional (ADN): o XML que o ADN nos
 * entrega já tem tudo o que o documento mostra, então o desenho é nosso e não
 * depende da disponibilidade do serviço nem do certificado a cada abertura.
 *
 * O cabeçalho traz a PREFEITURA DO MUNICÍPIO DO PRESTADOR e não leva brasão: o
 * órgão emissor muda a cada nota e só temos o brasão de Sorriso — usá-lo em nota
 * de outra cidade seria errado.
 *
 * Layout portado do modelo validado em `sped-fiscal-app` (HTML impresso pelo
 * Chrome). Aqui é desenhado com pdfkit, o mesmo motor do DACTE e do DANFE deste
 * serviço: mesma grade, mesmos campos, mesma ordem, sem navegador no container.
 */

const A4_LARGURA = 595.28;
const A4_ALTURA = 841.89;
const MARGEM = 22.68; // 8mm, como o @page do modelo
const LARGURA = A4_LARGURA - 2 * MARGEM;

// Respiro da célula: 6px na horizontal, 2px na vertical — como o modelo. O
// vertical é apertado de propósito: com 4pt o documento estoura para a 2ª página.
const PAD = 4.5;
const PAD_Y = 1.5;
const ALT_MIN = 19.5; // 26px
const FT_LABEL = 5.25; // 7px
const FT_VALOR = 6.75; // 9px
const FT_VALOR_G = 8.25; // 11px
const FT_SECAO = 6; // 8px

const CINZA_SECAO = '#d9d9d9';
const CINZA_CELULA = '#e6e6e6';

const QR_NOTA =
    'A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ' +
    'ou pela consulta da chave de acesso no portal nacional da NFS-e.';

const urlPortal = (chave: string) => `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`;

// ---------------------------------------------------------------- formatação
const money = (v: Valor): string => {
    const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) return '';
    return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const pct = (v: Valor): string => {
    const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) return '';
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
};
/** Campo sem valor vira "-": o modelo oficial não deixa célula em branco. */
const ou = (v: unknown): string => (v === '' || v == null ? '-' : String(v));
/** Chave de acesso em grupos de 4, como no documento oficial. */
const grp4 = (s: string): string => String(s || '').replace(/(.{4})/g, '$1 ').trim();

interface Celula {
    label: string;
    valor?: string;
    /** Peso da largura dentro da linha (default 1). */
    flex?: number;
    grande?: boolean;
    destaque?: boolean;
}

export async function gerarDanfse(d: DanfseDados): Promise<Buffer> {
    let qr: Buffer | null = null;
    if (d.chaveAcesso) {
        try {
            qr = await bwipjs.toBuffer({ bcid: 'qrcode', text: urlPortal(d.chaveAcesso), scale: 3 });
        } catch {
            qr = null;
        }
    }

    return new Promise<Buffer>((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, autoFirstPage: true });
            const pedacos: Buffer[] = [];
            doc.on('data', (c: Buffer) => pedacos.push(c));
            doc.on('end', () => resolve(Buffer.concat(pedacos)));

            doc.lineWidth(0.5).strokeColor('#000');

            let y = MARGEM;
            let inicioPagina = MARGEM;

            // -------------------------------------------------- primitivas
            const fecharMoldura = () => {
                doc.rect(MARGEM, inicioPagina, LARGURA, y - inicioPagina).stroke();
            };
            /** Quebra de página só se o bloco não couber; o documento nasce de 1 página. */
            const garantir = (altura: number) => {
                if (y + altura <= A4_ALTURA - MARGEM) return;
                fecharMoldura();
                doc.addPage();
                y = MARGEM;
                inicioPagina = MARGEM;
            };

            const alturaTexto = (texto: string, largura: number, fonte: string, tam: number) => {
                doc.font(fonte).fontSize(tam);
                return doc.heightOfString(texto || ' ', { width: largura });
            };

            /** Faixa cinza de seção. */
            const secao = (titulo: string) => {
                const h = 11;
                garantir(h);
                doc.rect(MARGEM, y, LARGURA, h).fillAndStroke(CINZA_SECAO, '#000');
                doc
                    .fillColor('#000')
                    .font('Helvetica-Bold')
                    .fontSize(FT_SECAO)
                    .text(titulo.toUpperCase(), MARGEM + 6, y + 3, { width: LARGURA - 12, lineBreak: false });
                y += h;
            };

            /** Linha de células rótulo/valor, com larguras proporcionais. */
            const linha = (celulas: Celula[]) => {
                const pesoTotal = celulas.reduce((s, c) => s + (c.flex ?? 1), 0);
                const larguras = celulas.map((c) => (LARGURA * (c.flex ?? 1)) / pesoTotal);

                let altura = ALT_MIN;
                celulas.forEach((c, i) => {
                    const w = larguras[i] - 2 * PAD;
                    const hL = alturaTexto(c.label, w, 'Helvetica', FT_LABEL);
                    const hV = alturaTexto(c.valor ?? '', w, 'Helvetica-Bold', c.grande ? FT_VALOR_G : FT_VALOR);
                    altura = Math.max(altura, hL + hV + 2 * PAD_Y + 1);
                });

                garantir(altura);
                let x = MARGEM;
                celulas.forEach((c, i) => {
                    const w = larguras[i];
                    if (c.destaque) doc.rect(x, y, w, altura).fillAndStroke(CINZA_CELULA, '#000');
                    else doc.rect(x, y, w, altura).stroke();

                    const wTexto = w - 2 * PAD;
                    doc
                        .fillColor('#000')
                        .font('Helvetica')
                        .fontSize(FT_LABEL)
                        .text(c.label, x + PAD, y + PAD_Y, { width: wTexto });
                    const hL = alturaTexto(c.label, wTexto, 'Helvetica', FT_LABEL);
                    doc
                        .font('Helvetica-Bold')
                        .fontSize(c.grande ? FT_VALOR_G : FT_VALOR)
                        .text(c.valor ?? '', x + PAD, y + PAD_Y + hL + 1, { width: wTexto });
                    x += w;
                });
                y += altura;
            };

            /** Bloco de largura total com texto longo (descrição, complementares). */
            const bloco = (label: string, texto: string) => {
                const w = LARGURA - 2 * PAD;
                const hL = label ? alturaTexto(label, w, 'Helvetica', FT_LABEL) : 0;
                const hV = alturaTexto(texto || ' ', w, 'Helvetica-Bold', FT_VALOR);
                const altura = Math.max(ALT_MIN, hL + hV + 2 * PAD_Y + 1);
                garantir(altura);
                doc.rect(MARGEM, y, LARGURA, altura).stroke();
                if (label) {
                    doc
                        .fillColor('#000')
                        .font('Helvetica')
                        .fontSize(FT_LABEL)
                        .text(label, MARGEM + PAD, y + PAD_Y, { width: w });
                }
                doc
                    .fillColor('#000')
                    .font('Helvetica-Bold')
                    .fontSize(FT_VALOR)
                    .text(texto || ' ', MARGEM + PAD, y + PAD_Y + hL + (label ? 1 : 0), { width: w });
                y += altura;
            };

            // -------------------------------------------------- cabeçalho
            const hCab = 40;
            const colLogo = LARGURA * 0.36;
            const colMeio = 120;
            const colOrgao = LARGURA - colLogo - colMeio;

            doc.rect(MARGEM, y, colLogo, hCab).stroke();
            doc.rect(MARGEM + colLogo, y, colMeio, hCab).stroke();
            doc.rect(MARGEM + colLogo + colMeio, y, colOrgao, hCab).stroke();

            const logo = logoNfse();
            if (logo) {
                try {
                    doc.image(logo, MARGEM + 8, y + 8, { fit: [colLogo - 16, hCab - 16], align: 'left' });
                } catch {
                    /* imagem inválida: segue sem logo */
                }
            } else {
                doc.fillColor('#000').font('Helvetica-Bold').fontSize(13).text('NFS-e', MARGEM + 8, y + 13);
            }

            doc
                .fillColor('#000')
                .font('Helvetica-Bold')
                .fontSize(11.25)
                .text('DANFSe v2.0', MARGEM + colLogo, y + 10, { width: colMeio, align: 'center' });
            doc
                .font('Helvetica')
                .fontSize(FT_SECAO)
                .text('Documento Auxiliar da NFS-e', MARGEM + colLogo, y + 24, { width: colMeio, align: 'center' });

            const orgao = `PREFEITURA MUNICIPAL DE ${d.municipioEmissor || 'MUNICÍPIO EMISSOR'}`;
            doc
                .font('Helvetica-Bold')
                .fontSize(6.75)
                .text(orgao, MARGEM + colLogo + colMeio + 6, y + 10, { width: colOrgao - 12 });
            doc
                .font('Helvetica')
                .fontSize(FT_SECAO)
                .text('Órgão emissor da NFS-e', MARGEM + colLogo + colMeio + 6, y + 24, { width: colOrgao - 12 });
            y += hCab;

            if (d.ambiente === 'homologacao') {
                const h = 12;
                doc.rect(MARGEM, y, LARGURA, h).fillAndStroke('#ffe08a', '#000');
                doc
                    .fillColor('#000')
                    .font('Helvetica-Bold')
                    .fontSize(7.5)
                    .text('NFS-e SEM VALIDADE JURÍDICA (HOMOLOGAÇÃO)', MARGEM, y + 3, {
                        width: LARGURA,
                        align: 'center',
                    });
                y += h;
            }

            // -------------------------------------------------- chave + QR
            const colQr = 112;
            const colEsq = LARGURA - colQr;
            const yTopo = y;

            // coluna esquerda: chave de acesso + duas linhas de 3 células
            const hChave = 26;
            doc.rect(MARGEM, y, colEsq, hChave).stroke();
            doc
                .fillColor('#000')
                .font('Helvetica-Bold')
                .fontSize(FT_LABEL)
                .text('Chave de Acesso', MARGEM + PAD, y + PAD, { width: colEsq - 2 * PAD });
            doc
                .font('Courier-Bold')
                .fontSize(8.25)
                .text(grp4(d.chaveAcesso) || '-', MARGEM + PAD, y + PAD + 7, { width: colEsq - 2 * PAD });
            let yEsq = y + hChave;

            const linhaEsq = (cels: { label: string; valor: string }[]) => {
                const w = colEsq / cels.length;
                cels.forEach((c, i) => {
                    const x = MARGEM + i * w;
                    doc.rect(x, yEsq, w, ALT_MIN).stroke();
                    doc
                        .fillColor('#000')
                        .font('Helvetica')
                        .fontSize(FT_LABEL)
                        .text(c.label, x + PAD, yEsq + PAD_Y, { width: w - 2 * PAD, lineBreak: false });
                    doc
                        .font('Helvetica-Bold')
                        .fontSize(FT_VALOR)
                        .text(c.valor, x + PAD, yEsq + PAD_Y + 6, { width: w - 2 * PAD, lineBreak: false });
                });
                yEsq += ALT_MIN;
            };

            linhaEsq([
                { label: 'Número da NFS-e', valor: ou(d.numeroNfse) },
                { label: 'Competência da NFS-e', valor: ou(d.competencia) },
                { label: 'Data e Hora da emissão da NFS-e', valor: ou(d.dataEmissao) },
            ]);
            linhaEsq([
                { label: 'Número da DPS', valor: ou(d.numeroDps) },
                { label: 'Série da DPS', valor: ou(d.serieDps) },
                { label: 'Data e Hora da emissão da DPS', valor: ou(d.dataDps) },
            ]);

            // coluna direita: QR + a nota de autenticidade
            const hTopo = yEsq - yTopo;
            doc.rect(MARGEM + colEsq, yTopo, colQr, hTopo).stroke();
            const ladoQr = 43; // 1,52cm
            const xQr = MARGEM + colEsq + (colQr - ladoQr) / 2;
            if (qr) {
                try {
                    doc.image(qr, xQr, yTopo + 4, { width: ladoQr, height: ladoQr });
                } catch {
                    /* sem QR */
                }
            }
            doc
                .fillColor('#333')
                .font('Helvetica')
                .fontSize(3.9)
                .text(QR_NOTA, MARGEM + colEsq + 4, yTopo + 4 + (qr ? ladoQr + 2 : 0), {
                    width: colQr - 8,
                    align: 'center',
                });
            doc.fillColor('#000');
            y = yTopo + hTopo;

            // -------------------------------------------------- prestador
            secao('Emitente da NFS-e (Prestador do Serviço)');
            linha([
                { label: 'Nome Fantasia', valor: ou(d.prestador.fantasia) },
                { label: 'CNPJ / CPF / NIF', valor: ou(d.prestador.cnpj) },
                { label: 'Inscrição Municipal', valor: ou(d.prestador.im) },
                { label: 'Telefone', valor: ou(d.prestador.telefone) },
            ]);
            linha([
                { label: 'Nome / Nome Empresarial', valor: ou(d.prestador.nome) },
                { label: 'E-mail', valor: ou(d.prestador.email) },
            ]);
            linha([
                { label: 'Endereço', valor: ou(d.prestador.endereco) },
                { label: 'Município', valor: ou(d.prestador.municipio) },
                { label: 'CEP', valor: ou(d.prestador.cep) },
            ]);
            linha([
                { label: 'Simples Nacional na Data de Competência', valor: ou(d.prestador.optanteSimples) },
                { label: 'Regime de Apuração Tributária pelo SN', valor: ou(d.regimeApuracaoSN) },
            ]);

            // -------------------------------------------------- tomador
            secao('Tomador do Serviço');
            linha([
                { label: '', valor: '' },
                { label: 'CNPJ / CPF / NIF', valor: ou(d.tomador.cnpj) },
                { label: 'Inscrição Municipal', valor: ou(d.tomador.im) },
                { label: 'Telefone', valor: ou(d.tomador.telefone) },
            ]);
            linha([
                { label: 'Nome / Nome Empresarial', valor: ou(d.tomador.nome) },
                { label: 'E-mail', valor: ou(d.tomador.email) },
            ]);
            linha([
                { label: 'Endereço', valor: ou(d.tomador.endereco) },
                { label: 'Município', valor: ou(d.tomador.municipio) },
                { label: 'CEP', valor: ou(d.tomador.cep) },
            ]);

            // Intermediário: os XMLs do ADN não trazem o grupo; o modelo oficial
            // exige a declaração explícita de ausência.
            const hInterm = 12;
            garantir(hInterm);
            doc.rect(MARGEM, y, LARGURA, hInterm).stroke();
            doc
                .fillColor('#000')
                .font('Helvetica-Oblique')
                .fontSize(FT_SECAO)
                .text('INTERMEDIÁRIO DO SERVIÇO NÃO IDENTIFICADO NA NFS-e', MARGEM, y + 3.5, {
                    width: LARGURA,
                    align: 'center',
                });
            y += hInterm;

            // -------------------------------------------------- serviço
            secao('Serviço Prestado');
            linha([
                { label: 'Código de Tributação Nacional', valor: ou(d.servico.codTribNacional) },
                { label: 'Código de Tributação Municipal', valor: ou(d.servico.codTribMunicipal) },
                { label: 'Local da Prestação', valor: ou(d.servico.localPrestacao) },
                { label: 'País da Prestação', valor: 'Brasil' },
            ]);
            bloco('Descrição do Serviço', d.servico.descricao);

            // -------------------------------------------------- ISSQN
            secao('Tributação Municipal');
            linha([
                { label: 'Tributação do ISSQN', valor: ou(d.issqn.tributacao) },
                { label: 'País Resultado da Prestação do Serviço', valor: 'Brasil' },
                { label: 'Município de Incidência do ISSQN', valor: ou(d.issqn.municipioIncidencia) },
                { label: 'Regime Especial de Tributação', valor: ou(d.issqn.regimeEspecial) },
            ]);
            linha([
                { label: 'Valor do Serviço', valor: ou(money(d.issqn.valorServico)) },
                { label: 'Desconto Incondicionado', valor: ou(money(d.issqn.descontoIncond)) },
                { label: 'BC ISSQN', valor: ou(money(d.issqn.bc)) },
                { label: 'Alíquota Aplicada', valor: ou(pct(d.issqn.aliquota)) },
            ]);
            linha([
                { label: 'Retenção do ISSQN', valor: ou(d.issqn.retencaoTxt) },
                { label: 'ISSQN Apurado', valor: ou(money(d.issqn.apurado)) },
            ]);

            // -------------------------------------------------- federais
            secao('Tributação Federal');
            linha([
                { label: 'IRRF', valor: ou(money(d.federal.irrf)) },
                { label: 'Contribuição Previdenciária-Retida', valor: ou(money(d.federal.inss)) },
                { label: 'Contribuições Sociais-Retidas', valor: ou(money(d.federal.csll)) },
                { label: 'Total das Retenções', valor: ou(money(d.total.retencoes)) },
            ]);
            linha([
                { label: 'PIS-Débito Apuração Própria', valor: ou(money(d.federal.pis)) },
                { label: 'COFINS-Débito Apuração Própria', valor: ou(money(d.federal.cofins)) },
            ]);

            // -------------------------------------------------- IBS/CBS
            secao('Tributação sobre o Consumo — IBS / CBS (Reforma Tributária)');
            const g5 = [1.4, 1, 1.2, 1, 1.2];
            linha([
                { label: 'Tributo', valor: '', flex: g5[0] },
                { label: 'CST', valor: '-', flex: g5[1] },
                { label: 'Base de Cálculo', valor: '', flex: g5[2] },
                { label: 'Alíquota', valor: '', flex: g5[3] },
                { label: 'Valor', valor: '', flex: g5[4] },
            ]);
            linha([
                { label: 'IBS (Estadual + Municipal)', valor: '', flex: g5[0] },
                { label: '', valor: '-', flex: g5[1] },
                { label: '', valor: ou(money(d.ibscbs.base)), flex: g5[2] },
                { label: '', valor: ou(pct(d.ibscbs.aliqIbs)), flex: g5[3] },
                { label: '', valor: ou(money(d.ibscbs.valorIbs)), flex: g5[4] },
            ]);
            linha([
                { label: 'CBS (Federal)', valor: '', flex: g5[0] },
                { label: '', valor: '-', flex: g5[1] },
                { label: '', valor: ou(money(d.ibscbs.base)), flex: g5[2] },
                { label: '', valor: ou(pct(d.ibscbs.aliqCbs)), flex: g5[3] },
                { label: '', valor: ou(money(d.ibscbs.valorCbs)), flex: g5[4] },
            ]);

            // -------------------------------------------------- totais
            secao('Valor Total da NFS-e');
            linha([
                { label: 'Valor do Serviço', valor: ou(money(d.total.valorServico)) },
                { label: 'Desconto Incondicionado', valor: ou(money(d.total.descontoIncond)) },
                { label: 'ISSQN Retido', valor: ou(money(d.total.issqnRetido)) },
                { label: 'Total das Retenções', valor: ou(money(d.total.retencoes)) },
            ]);
            linha([
                { label: 'Valor Líquido da NFS-e', valor: ou(money(d.total.liquido)) },
                {
                    label: 'Valor Líquido da NFS-e + IBS/CBS',
                    valor: ou(money(d.total.liquidoComTributos)),
                    grande: true,
                    destaque: true,
                },
            ]);

            secao('Totais Aproximados dos Tributos (Lei 12.741/2012)');
            linha([
                { label: 'Federais', valor: ou(money(d.tributos.federais)) },
                { label: 'Estaduais', valor: ou(money(d.tributos.estaduais)) },
                { label: 'Municipais', valor: ou(money(d.tributos.municipais)) },
            ]);

            secao('Informações Complementares');
            bloco('', [d.nbs ? `NBS: ${d.nbs}` : '', d.complementares].filter(Boolean).join('\n'));

            fecharMoldura();

            // Tarja de cancelamento por cima de tudo, em todas as páginas.
            if (d.cancelada) {
                const faixas = doc.bufferedPageRange();
                for (let p = faixas.start; p < faixas.start + faixas.count; p++) {
                    doc.switchToPage(p);
                    doc.save();
                    doc.rotate(-32, { origin: [A4_LARGURA / 2, A4_ALTURA / 2] });
                    doc
                        .fillColor('#c80000')
                        .opacity(0.3)
                        .font('Helvetica-Bold')
                        .fontSize(60)
                        .text('CANCELADO', 0, A4_ALTURA / 2 - 30, { width: A4_LARGURA, align: 'center' });
                    doc.restore();
                }
            }

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}
