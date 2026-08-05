import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Writable } from 'stream';
import archiver from 'archiver';
import { parseStringPromise } from 'xml2js';
import { PrismaService } from '../prisma/prisma.service';
import { NfseAdnClient, AdnDfeItem } from './nfse-adn.client';
import { NfseCertService } from './nfse-cert.service';
import { extrairNacional } from './danfse/nfse-nacional.extract';
import { gerarDanfse } from './danfse/danfse-pdf';

/**
 * Distribuição de NFS-e do Padrão Nacional via ADN.
 *
 * Consumo por NSU (igual à distribuição de NF-e): ponteiro por CNPJ em
 * com_nfse_dist_controle; GET /DFe/{ultimoNSU} traz o próximo lote; avançamos
 * o NSU e repetimos até zerar o backlog ou bater o teto de iterações.
 *
 * Persistência: a NFS-e é a entidade (chave de acesso). Nota nova -> insere;
 * nota alterada (hash do XML mudou) -> atualiza; evento -> registra e ajusta a
 * `situacao` da NFS-e (ex.: CANCELADA).
 */
@Injectable()
export class NfseDistService {
  private readonly logger = new Logger(NfseDistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adn: NfseAdnClient,
    private readonly cert: NfseCertService,
  ) {}

  /**
   * Capta NFS-e de TODAS as empresas (um CNPJ por certificado ativo vinculado).
   * Cada empresa tem seu próprio ponteiro de NSU e seu certificado.
   */
  async sincronizar(): Promise<{
    empresas: number;
    novos: number;
    atualizados: number;
    eventos: number;
    porEmpresa: Array<{
      cnpj: string;
      novos: number;
      atualizados: number;
      eventos: number;
      ultimoNSU: number;
      maxNSU: number;
    }>;
  }> {
    const cnpjs = await this.cnpjsParaCaptar();
    if (!cnpjs.length) {
      throw new Error(
        'Nenhuma empresa para captar: vincule um certificado ou configure NFSE_ADN_CNPJ.',
      );
    }

    let novos = 0;
    let atualizados = 0;
    let eventos = 0;
    const porEmpresa: Array<{
      cnpj: string; novos: number; atualizados: number; eventos: number; ultimoNSU: number; maxNSU: number;
    }> = [];

    for (const cnpj of cnpjs) {
      try {
        const r = await this.sincronizarCnpj(cnpj);
        novos += r.novos;
        atualizados += r.atualizados;
        eventos += r.eventos;
        porEmpresa.push({ cnpj, novos: r.novos, atualizados: r.atualizados, eventos: r.eventos, ultimoNSU: r.ultimoNSU, maxNSU: r.maxNSU });
      } catch (e) {
        this.logger.error(
          `Falha ao captar NFS-e do CNPJ ${cnpj}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return { empresas: cnpjs.length, novos, atualizados, eventos, porEmpresa };
  }

  /** CNPJs a captar = certificados ativos vinculados; fallback: NFSE_ADN_CNPJ. */
  private async cnpjsParaCaptar(): Promise<string[]> {
    const doBanco = await this.cert.listarCnpjsAtivos();
    if (doBanco.length) return Array.from(new Set(doBanco));
    const env = (process.env.NFSE_ADN_CNPJ || '').replace(/\D/g, '');
    return env ? [env] : [];
  }

  /** Capta a distribuição de NFS-e de UM CNPJ (loop de NSU). */
  private async sincronizarCnpj(cnpj: string): Promise<{
    novos: number;
    atualizados: number;
    eventos: number;
    ultimoNSU: number;
    maxNSU: number;
    iteracoes: number;
  }> {
    const controle = await this.prisma.nfseDistControle.upsert({
      where: { cnpj },
      create: { cnpj },
      update: {},
    });

    let ultimoNSU = Number(controle.ultimo_nsu);
    let maxNSU = Number(controle.max_nsu);
    let novos = 0;
    let atualizados = 0;
    let eventos = 0;
    let iteracoes = 0;
    const maxLoops = Number(process.env.NFSE_DIST_MAX_LOOPS) || 20;

    for (let i = 0; i < maxLoops; i++) {
      iteracoes++;
      const resp = await this.adn.consultarDFe(ultimoNSU, cnpj);

      // Condição normal de "fim da fila" (404/E2220 ou 204): encerra sem alarde.
      if (resp.semDocumentos) break;
      if (resp.status !== 200) {
        const detalhe = resp.erros?.length ? JSON.stringify(resp.erros) : resp.rawBody.slice(0, 300);
        this.logger.warn(`ADN retornou status ${resp.status} (NSU ${ultimoNSU}): ${detalhe}`);
        break;
      }

      for (const doc of resp.documentos) {
        const r = await this.processar(cnpj, doc);
        if (r === 'novo') novos++;
        else if (r === 'atualizado') atualizados++;
        else if (r === 'evento') eventos++;
      }

      maxNSU = resp.maxNSU || maxNSU;
      const avanco = resp.ultimoNSU || ultimoNSU;
      if (avanco <= ultimoNSU && resp.documentos.length === 0) break;
      ultimoNSU = Math.max(ultimoNSU, avanco);

      await this.prisma.nfseDistControle.update({
        where: { cnpj },
        data: { ultimo_nsu: BigInt(ultimoNSU), max_nsu: BigInt(maxNSU), ultima_consulta: new Date() },
      });

      if (maxNSU && ultimoNSU >= maxNSU) break;
    }

    this.logger.log(
      `Distribuição NFS-e [${cnpj}]: ${novos} nova(s), ${atualizados} atualizada(s), ${eventos} evento(s); ` +
        `NSU ${ultimoNSU}/${maxNSU} em ${iteracoes} iteração(ões).`,
    );
    return { novos, atualizados, eventos, ultimoNSU, maxNSU, iteracoes };
  }

  /** Processa um DF-e: NFS-e (insere/atualiza) ou Evento (registra + ajusta situação). */
  private async processar(
    cnpjDest: string,
    doc: AdnDfeItem,
  ): Promise<'novo' | 'atualizado' | 'evento' | 'ignorado'> {
    const extra = await this.extrair(doc.xml).catch(() => ({}) as ExtractedNfse);
    const ehEvento = (doc.tipoDocumento || extra.tipo || '').toUpperCase().includes('EVENTO');

    if (ehEvento) {
      return (await this.persistirEvento(doc, extra)) ? 'evento' : 'ignorado';
    }
    return this.persistirNfse(cnpjDest, doc, extra);
  }

  private async persistirNfse(
    cnpjDest: string,
    doc: AdnDfeItem,
    extra: ExtractedNfse,
  ): Promise<'novo' | 'atualizado' | 'ignorado'> {
    const chave = doc.chaveAcesso || extra.chave;
    if (!chave) {
      this.logger.warn(`DF-e NSU ${doc.nsu} sem chave de acesso; ignorado.`);
      return 'ignorado';
    }
    const hash = createHash('sha256').update(doc.xml || '').digest('hex');
    const existente = await this.prisma.nfseDocumento.findUnique({ where: { chave_acesso: chave } });

    const dados = {
      cnpj_destinatario: cnpjDest,
      ultimo_nsu: BigInt(doc.nsu || 0),
      numero: extra.numero || null,
      serie: extra.serie || null,
      cnpj_prestador: extra.cnpjPrestador || null,
      nome_prestador: extra.nomePrestador || null,
      cnpj_tomador: extra.cnpjTomador || null,
      nome_tomador: extra.nomeTomador || null,
      valor: extra.valor ?? null,
      retencao_federal: extra.retencaoFederal ?? 0,
      data_emissao: extra.dataEmissao || null,
      competencia: extra.competencia || null,
      papel: this.definirPapel(cnpjDest, extra),
      xml: doc.xml || '',
      hash,
      dados_json: extra.json ?? undefined,
    };

    if (!existente) {
      await this.prisma.nfseDocumento.create({ data: { chave_acesso: chave, ...dados } });
      return 'novo';
    }
    if (existente.hash === hash) return 'ignorado'; // nada mudou
    await this.prisma.nfseDocumento.update({ where: { chave_acesso: chave }, data: dados });
    return 'atualizado';
  }

  private async persistirEvento(doc: AdnDfeItem, extra: ExtractedNfse): Promise<boolean> {
    if (!doc.nsu) return false;
    const ja = await this.prisma.nfseEvento.findUnique({ where: { nsu: BigInt(doc.nsu) } });
    if (ja) return false;

    const chave = extra.chave || doc.chaveAcesso || '';
    await this.prisma.nfseEvento.create({
      data: {
        nsu: BigInt(doc.nsu),
        chave_acesso: chave,
        tipo_evento: extra.tipoEvento || null,
        data_evento: extra.dataEmissao || null,
        xml: doc.xml || '',
        dados_json: extra.json ?? undefined,
      },
    });

    // Reflete o evento na situação da NFS-e (cancelamento/substituição).
    if (chave) {
      const tipo = (extra.tipoEvento || '').toLowerCase();
      const situacao = tipo.includes('cancel')
        ? 'CANCELADA'
        : tipo.includes('substitu')
          ? 'SUBSTITUIDA'
          : null;
      if (situacao) {
        await this.prisma.nfseDocumento
          .update({ where: { chave_acesso: chave }, data: { situacao } })
          .catch(() => undefined); // NFS-e pode ainda não ter chegado
      }
    }
    return true;
  }

  // Classifica por RAIZ do CNPJ (8 díg.): o destinatário pode ser uma filial
  // diferente do prestador/tomador que aparece na nota (mesma raiz, CNPJ distinto).
  private definirPapel(cnpjDest: string, extra: ExtractedNfse): string | null {
    const root = (cnpjDest || '').replace(/\D/g, '').slice(0, 8);
    if (!root) return null;
    const tom = (extra.cnpjTomador || '').replace(/\D/g, '').slice(0, 8);
    const pres = (extra.cnpjPrestador || '').replace(/\D/g, '').slice(0, 8);
    if (tom === root) return 'TOMADOR';
    if (pres === root) return 'PRESTADOR';
    return null;
  }

  /**
   * Extração best-effort do XML da NFS-e Nacional (leiaute infNFSe/emit/DPS/valores).
   * Tolerante a variações; guarda o JSON completo em dados_json p/ enriquecer depois.
   */
  private async extrair(xml: string): Promise<ExtractedNfse> {
    if (!xml) return {};
    const obj: any = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [(name) => name.replace(/^.*:/, '')], // remove namespace
    });

    const ehEvento = !!(obj?.evento || obj?.Evento || obj?.pedRegEvento || obj?.eventoNFSe);
    const root = obj?.NFSe || obj?.nfse || obj;
    const inf = root?.infNFSe || root?.InfNFSe || {};
    const emit = inf?.emit || inf?.prest || {};
    const dps = inf?.DPS?.infDPS || inf?.DPS || {};
    const toma = dps?.toma || dps?.tomador || {};
    const valores = inf?.valores || dps?.serv?.valores || {};

    const chave =
      this.limparChave(inf?.$?.Id) ||
      inf?.chNFSe ||
      root?.chNFSe ||
      this.buscarChaveEvento(obj) ||
      undefined;

    const valorRaw =
      valores?.vLiq ?? valores?.vServPrest?.vServ ?? valores?.vServ ?? valores?.vNF ?? undefined;
    const valor = valorRaw != null ? Number(String(valorRaw).replace(',', '.')) : undefined;

    // Retenção federal = PIS+COFINS+IRRF+CSLL+INSS (em DPS/.../trib/tribFed).
    const num = (v: any): number => {
      if (v == null) return 0;
      const x = Number(String(v).replace(',', '.'));
      return Number.isFinite(x) ? x : 0;
    };
    const tribFed = dps?.valores?.trib?.tribFed || {};
    const pisCofins = tribFed?.piscofins || {};
    // PIS/COFINS só contam como RETIDOS quando tpRetPisCofins = 1 (senão é apuração própria).
    const pisCofinsRetido = String(pisCofins?.tpRetPisCofins || '') === '1';
    const retencaoFederal =
      num(tribFed?.vRetIRRF) +
      num(tribFed?.vRetCP) +
      num(tribFed?.vRetCSLL) +
      (pisCofinsRetido ? num(pisCofins?.vPis) + num(pisCofins?.vCofins) : 0);

    return {
      tipo: ehEvento ? 'EVENTO' : 'NFSE',
      tipoEvento: ehEvento ? this.tipoEvento(obj) : undefined,
      chave: chave ? String(chave) : undefined,
      numero: inf?.nNFSe || inf?.numero || dps?.nDPS || undefined,
      serie: dps?.serie || inf?.serie || undefined,
      cnpjPrestador: emit?.CNPJ || emit?.cnpj || undefined,
      nomePrestador: emit?.xNome || emit?.nome || undefined,
      cnpjTomador: toma?.CNPJ || toma?.cnpj || undefined,
      nomeTomador: toma?.xNome || toma?.nome || undefined,
      valor: Number.isFinite(valor as number) ? (valor as number) : undefined,
      retencaoFederal: Math.round(retencaoFederal * 100) / 100,
      dataEmissao: this.parseData(inf?.dhProc || inf?.dhEmi || dps?.dhEmi),
      competencia: this.parseData(dps?.dCompet || inf?.dCompet),
      json: obj,
    };
  }

  private limparChave(id: any): string | undefined {
    if (!id) return undefined;
    const s = String(id).replace(/^NFS?e?/i, '').replace(/\D/g, '');
    return s.length >= 40 ? s : undefined;
  }

  private buscarChaveEvento(obj: any): string | undefined {
    // Procura recursivamente um campo com a chave da NFS-e referenciada.
    const alvo = ['chNFSe', 'chaveAcesso', 'ChaveAcesso'];
    const stack = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      for (const k of Object.keys(cur)) {
        if (alvo.includes(k) && typeof cur[k] === 'string') return cur[k];
        if (typeof cur[k] === 'object') stack.push(cur[k]);
      }
    }
    return undefined;
  }

  private tipoEvento(obj: any): string | undefined {
    const stack = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      for (const k of Object.keys(cur)) {
        if (/tipoEvento|tpEvento|xMotivo|descEvento/i.test(k) && cur[k]) return String(cur[k]);
        if (typeof cur[k] === 'object') stack.push(cur[k]);
      }
    }
    return undefined;
  }

  private parseData(v: any): Date | undefined {
    if (!v) return undefined;
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? undefined : d;
  }

  // -------- Consultas p/ o frontend --------

  async listar(filtros: {
    numero?: string;
    cnpj?: string;
    empresa?: string;
    dataInicio?: string;
    dataFim?: string;
    papel?: string;
    comRetFederal?: string;
    page?: string;
    pageSize?: string;
  }) {
    const where = this.montarWhere(filtros);

    const page = Math.max(1, Number(filtros.page) || 1);
    const pageSize = Math.min(Math.max(Number(filtros.pageSize) || 50, 1), 500);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.nfseDocumento.count({ where }),
      this.prisma.nfseDocumento.findMany({
        where,
        orderBy: { data_emissao: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { total, page, pageSize, items: rows.map((r) => this.serializar(r)) };
  }

  /** WHERE compartilhado entre a listagem e a exportação. */
  private montarWhere(filtros: {
    numero?: string;
    cnpj?: string;
    empresa?: string;
    dataInicio?: string;
    dataFim?: string;
    papel?: string;
    comRetFederal?: string;
  }): any {
    const where: any = {};
    if (filtros.comRetFederal === '1' || filtros.comRetFederal === 'true') {
      where.retencao_federal = { gt: 0 };
    }
    // Empresa (multiempresa): filtra pelo CNPJ de destino (a empresa que captou).
    const empresa = (filtros.empresa || '').replace(/\D/g, '');
    if (empresa) where.cnpj_destinatario = empresa;
    const prestados = (filtros.papel || '').toUpperCase() === 'PRESTADOS';
    const c = (filtros.cnpj || '').replace(/\D/g, '');

    // Filtra pela coluna `papel` (gravada por linha a partir do cnpj_destinatario),
    // independente de variável de ambiente. Tomados = somos o TOMADOR; a contraparte
    // filtrável é o prestador. Prestados = somos o PRESTADOR; contraparte é o tomador.
    where.papel = prestados ? 'PRESTADOR' : 'TOMADOR';
    if (prestados) {
      if (c) where.cnpj_tomador = { contains: c };
    } else {
      if (c) where.cnpj_prestador = { contains: c };
    }

    if (filtros.numero) where.numero = { contains: filtros.numero.trim() };
    if (filtros.dataInicio || filtros.dataFim) {
      where.data_emissao = {};
      if (filtros.dataInicio) where.data_emissao.gte = new Date(`${filtros.dataInicio}T00:00:00`);
      if (filtros.dataFim) where.data_emissao.lte = new Date(`${filtros.dataFim}T23:59:59`);
    }
    return where;
  }

  /** Exporta os XMLs das NFS-e do período filtrado em um .zip. Exige período. */
  async exportarXml(filtros: {
    numero?: string;
    cnpj?: string;
    empresa?: string;
    dataInicio?: string;
    dataFim?: string;
    papel?: string;
    comRetFederal?: string;
  }): Promise<{ buffer: Buffer; count: number }> {
    if (!filtros.dataInicio || !filtros.dataFim) {
      throw new BadRequestException(
        'Selecione um período (data inicial e final) antes de exportar os XMLs.',
      );
    }
    const where = this.montarWhere(filtros);
    const rows = await this.prisma.nfseDocumento.findMany({
      where,
      select: { chave_acesso: true, numero: true, xml: true },
      orderBy: { data_emissao: 'desc' },
      take: 10000,
    });
    const buffer = await this.zipXmls(
      rows.map((r) => ({ nome: r.numero || r.chave_acesso, chave: r.chave_acesso, xml: r.xml || '' })),
    );
    return { buffer, count: rows.length };
  }

  /** Compacta uma lista de XMLs em um único .zip (nomes únicos por nota). */
  private zipXmls(items: { nome: string; chave: string; xml: string }[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];
      const stream = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      archive.pipe(stream);
      stream.on('finish', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      const usados = new Set<string>();
      for (const it of items) {
        if (!it.xml) continue;
        const base = String(it.nome || it.chave).replace(/[^\w.-]/g, '_');
        let nome = `${base}.xml`;
        if (usados.has(nome)) nome = `${base}_${it.chave}.xml`;
        usados.add(nome);
        archive.append(it.xml, { name: nome });
      }
      archive.finalize();
    });
  }

  async detalhe(chave: string) {
    const doc = await this.prisma.nfseDocumento.findUnique({ where: { chave_acesso: chave } });
    if (!doc) throw new NotFoundException(`NFS-e não encontrada: ${chave}`);
    const eventos = await this.prisma.nfseEvento.findMany({
      where: { chave_acesso: chave },
      orderBy: { nsu: 'asc' },
    });
    return {
      ...this.serializar(doc),
      xml: doc.xml,
      detalhado: await this.detalhar(doc.xml).catch(() => null),
      eventos: eventos.map((e) => ({ ...e, nsu: e.nsu.toString() })),
    };
  }

  /** Extrai a NFS-e em blocos estruturados (partes, serviço, valores e IMPOSTOS). */
  private async detalhar(xml: string): Promise<any> {
    if (!xml) return null;
    const obj: any = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [(name) => name.replace(/^.*:/, '')],
    });

    const root = obj?.NFSe || obj?.nfse || obj;
    const inf = root?.infNFSe || root?.InfNFSe || {};
    const emit = inf?.emit || {};
    const valN = inf?.valores || {}; // valores efetivos da NFS-e (vBC, pAliqAplic, vISSQN, vLiq)
    const dps = inf?.DPS?.infDPS || inf?.DPS || {};
    const prest = dps?.prest || {};
    const toma = dps?.toma || {};
    const serv = dps?.serv || {};
    const cServ = serv?.cServ || {};
    const valD = dps?.valores || {}; // valores declarados na DPS (trib, totTrib)
    const trib = valD?.trib || {};
    const tribMun = trib?.tribMun || {};
    const tribFed = trib?.tribFed || {};
    const pisCofins = tribFed?.piscofins || {};
    const pisCofinsRetido = String(pisCofins?.tpRetPisCofins || '') === '1';
    const totTrib = trib?.totTrib?.vTotTrib || {};

    const n = (v: any): number | null => {
      if (v == null) return null;
      const x = Number(String(v).replace(',', '.'));
      return Number.isFinite(x) ? x : null;
    };
    const ender = (e: any) =>
      e
        ? {
            logradouro: e.xLgr,
            numero: e.nro,
            complemento: e.xCpl,
            bairro: e.xBairro,
            municipio: e.enderNac?.cMun || e.endNac?.cMun || e.cMun,
            uf: e.UF || e.enderNac?.UF,
            cep: e.CEP || e.enderNac?.CEP || e.endNac?.CEP,
          }
        : null;

    const TRIB_ISSQN: Record<string, string> = {
      '1': 'Operação tributável',
      '2': 'Exportação de serviços',
      '3': 'Não incidência',
      '4': 'Imunidade',
      '5': 'Exigibilidade suspensa (judicial)',
      '6': 'Exigibilidade suspensa (administrativa)',
    };
    const RET_ISSQN: Record<string, string> = {
      '1': 'Não retido',
      '2': 'Retido pelo tomador',
      '3': 'Retido pelo intermediário',
    };
    const SIMPLES: Record<string, string> = {
      '1': 'Não optante',
      '2': 'Optante - MEI',
      '3': 'Optante - ME/EPP',
    };

    return {
      identificacao: {
        numero: inf?.nNFSe,
        serie: dps?.serie,
        dhProcessamento: inf?.dhProc,
        dhEmissao: dps?.dhEmi,
        competencia: dps?.dCompet,
        situacaoCodigo: inf?.cStat,
        nDFSe: inf?.nDFSe,
        localEmissao: inf?.xLocEmi,
        localPrestacao: inf?.xLocPrestacao,
        localIncidencia: inf?.xLocIncid,
        codTribNacional: cServ?.cTribNac,
        descTribNacional: inf?.xTribNac,
      },
      prestador: {
        cnpj: emit?.CNPJ || emit?.CPF,
        inscricaoMunicipal: emit?.IM,
        nome: emit?.xNome,
        fone: emit?.fone,
        email: emit?.email,
        endereco: ender(emit?.enderNac ? emit : null) || ender(emit),
        simplesNacional: SIMPLES[String(prest?.regTrib?.opSimpNac)] || prest?.regTrib?.opSimpNac,
        regimeEspecial: prest?.regTrib?.regEspTrib,
      },
      tomador: {
        cnpj: toma?.CNPJ || toma?.CPF,
        nome: toma?.xNome,
        fone: toma?.fone,
        email: toma?.email,
        endereco: ender(toma?.end),
      },
      servico: {
        codTribNacional: cServ?.cTribNac,
        descricao: cServ?.xDescServ,
        cNBS: cServ?.cNBS,
        codLocalPrestacao: serv?.locPrest?.cLocPrestacao,
      },
      valores: {
        valorServico: n(valD?.vServPrest?.vServ) ?? n(valN?.vServ),
        baseCalculo: n(valN?.vBC),
        aliquota: n(valN?.pAliqAplic),
        valorIssqn: n(valN?.vISSQN),
        valorLiquido: n(valN?.vLiq),
        descontoIncondicionado: n(valD?.vServPrest?.vDescCondIncond?.vDescIncond),
        descontoCondicionado: n(valD?.vServPrest?.vDescCondIncond?.vDescCond),
      },
      impostos: {
        issqn: {
          tributacao: TRIB_ISSQN[String(tribMun?.tribISSQN)] || tribMun?.tribISSQN,
          retencao: RET_ISSQN[String(tribMun?.tpRetISSQN)] || tribMun?.tpRetISSQN,
          baseCalculo: n(valN?.vBC),
          aliquota: n(valN?.pAliqAplic),
          valor: n(valN?.vISSQN),
          municipioIncidencia: inf?.xLocIncid,
        },
        federais: {
          // Retidos pelo tomador
          irrf: n(tribFed?.vRetIRRF),
          contribPrevidenciaria: n(tribFed?.vRetCP),
          csllRetida: n(tribFed?.vRetCSLL),
          pisRetido: pisCofinsRetido ? n(pisCofins?.vPis) : null,
          cofinsRetido: pisCofinsRetido ? n(pisCofins?.vCofins) : null,
          retidoTotal:
            n(tribFed?.vRetIRRF) || n(tribFed?.vRetCP) || n(tribFed?.vRetCSLL) || pisCofinsRetido
              ? (n(tribFed?.vRetIRRF) ?? 0) +
                (n(tribFed?.vRetCP) ?? 0) +
                (n(tribFed?.vRetCSLL) ?? 0) +
                (pisCofinsRetido ? (n(pisCofins?.vPis) ?? 0) + (n(pisCofins?.vCofins) ?? 0) : 0)
              : null,
          // Apuração própria (não retido) — débito do prestador
          pisProprio: pisCofinsRetido ? null : n(pisCofins?.vPis),
          cofinsProprio: pisCofinsRetido ? null : n(pisCofins?.vCofins),
        },
        totalTributos: {
          federal: n(totTrib?.vTotTribFed),
          estadual: n(totTrib?.vTotTribEst),
          municipal: n(totTrib?.vTotTribMun),
        },
      },
    };
  }

  /**
   * DANFSe da nota.
   *
   * `fonte = 'local'` (padrão) desenha o documento aqui, a partir do XML que a
   * distribuição já guardou — não depende do ADN estar no ar nem do certificado
   * a cada abertura, e vale para qualquer nota do acervo.
   *
   * `fonte = 'adn'` baixa o PDF oficial do portal nacional. Fica como escape para
   * conferência, e é o caminho automático quando não temos o XML guardado.
   */
  async danfse(chave: string, fonte: 'local' | 'adn' = 'local'): Promise<Buffer> {
    const doc = await this.prisma.nfseDocumento.findUnique({ where: { chave_acesso: chave } });

    if (fonte === 'local' && doc?.xml) {
      const dados = await extrairNacional(doc.xml, doc.situacao === 'CANCELADA');
      return gerarDanfse(dados);
    }

    if (fonte === 'local') {
      this.logger.warn(`DANFSe ${chave.slice(0, 12)}…: sem XML guardado, caindo para o ADN.`);
    }
    const cnpj = doc?.cnpj_destinatario || process.env.NFSE_ADN_CNPJ;
    return this.adn.baixarDanfse(chave, cnpj || undefined);
  }

  async eventos(chave: string) {
    const r = await this.adn.consultarEventos(chave);
    return { status: r.status, total: r.documentos.length, eventos: r.documentos };
  }

  /** Backfill: recalcula campos derivados do XML já salvo (ex.: retencao_federal). */
  async reprocessar(): Promise<{ total: number; atualizados: number }> {
    const rows = await this.prisma.nfseDocumento.findMany({
      select: { chave_acesso: true, cnpj_destinatario: true, xml: true },
    });
    let atualizados = 0;
    for (const r of rows) {
      if (!r.xml) continue;
      const extra = await this.extrair(r.xml).catch(() => null);
      if (!extra) continue;
      await this.prisma.nfseDocumento.update({
        where: { chave_acesso: r.chave_acesso },
        data: {
          retencao_federal: extra.retencaoFederal ?? 0,
          papel: this.definirPapel(r.cnpj_destinatario, extra),
        },
      });
      atualizados++;
    }
    this.logger.log(`Reprocessamento NFS-e: ${atualizados}/${rows.length} atualizado(s).`);
    return { total: rows.length, atualizados };
  }

  /** Remove campos pesados (xml) e serializa BigInt p/ a listagem. */
  private serializar(r: any) {
    const { xml, ...rest } = r;
    return { ...rest, ultimo_nsu: r.ultimo_nsu?.toString() };
  }
}

interface ExtractedNfse {
  tipo?: string;
  tipoEvento?: string;
  chave?: string;
  numero?: string;
  serie?: string;
  cnpjPrestador?: string;
  nomePrestador?: string;
  cnpjTomador?: string;
  nomeTomador?: string;
  valor?: number;
  retencaoFederal?: number;
  dataEmissao?: Date;
  competencia?: Date;
  papel?: string;
  json?: any;
}
