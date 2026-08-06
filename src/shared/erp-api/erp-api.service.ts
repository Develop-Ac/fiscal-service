import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/* =============================================================================
   CLIENTE DA erp-firebird-api
   -----------------------------------------------------------------------------
   Caminho de leitura do ERP que NÃO passa pelo SQL Server. Hoje toda consulta
   ao Celta sai daqui por OPENQUERY(CONSULTA): o SQL Server abre uma sessão no
   Firebird, e quando essa sessão trava — ou quando o linked server engasga — o
   fiscal-service para junto, mesmo com o ERP saudável.

   A API do lado de lá monta o SELECT a partir do catálogo dela: os nomes de
   coluna são validados contra os metadados e os valores viajam como parâmetro.
   Ela também tem duas defesas que aqui não existiam:

     - filtro de EMPRESA obrigatório nas tabelas que têm a coluna (o mesmo
       cadastro existe nas empresas 1 e 3; sem o filtro vêm as duas e a primeira
       linha é arbitrária);
     - agrupamento das consultas unitárias que chegam juntas — a conferência
       fiscal pergunta produto a produto, e do outro lado isso vira um SELECT
       com IN.

   MIGRAÇÃO SEM JANELA: cada chamada tem o caminho antigo como alternativa. Sem
   `ERP_API_URL` configurada, nada muda de comportamento; com ela, o OPENQUERY
   vira plano B e o log diz sempre que caiu para ele.
   ============================================================================= */

/** Envelope de resposta da erp-firebird-api. */
interface RespostaErp {
  dados: any[];
  meta: {
    tabela: string;
    linhas: number;
    ms: number;
    /** Bateu no teto da tabela: falta filtro, ou a lista precisa ser paginada. */
    truncado: boolean;
    cache: boolean;
  };
}

@Injectable()
export class ErpApiService {
  private readonly logger = new Logger(ErpApiService.name);

  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  /**
   * Breaker de saída. Quando a API está fora, insistir custa o timeout inteiro
   * a cada chamada — e o caminho de OPENQUERY, que funciona, só começa depois
   * disso. Passadas as falhas seguidas, para de tentar por um tempo e vai
   * direto para o plano B.
   */
  private falhasSeguidas = 0;
  private mudoAte = 0;
  private static readonly LIMITE_FALHAS = 3;
  private static readonly COOLDOWN_MS = 60_000;

  constructor(private readonly config: ConfigService) {
    this.base = String(this.config.get('ERP_API_URL') ?? '').trim().replace(/\/+$/, '');
    this.token = String(this.config.get('ERP_API_TOKEN') ?? '').trim();
    this.timeoutMs = Number(this.config.get('ERP_API_TIMEOUT_MS') ?? 30_000);

    if (this.base) {
      this.logger.log(`[ERP-API] leitura do ERP habilitada em ${this.base}`);
    } else {
      this.logger.log('[ERP-API] ERP_API_URL não configurada — leitura do ERP segue por OPENQUERY.');
    }
  }

  /** Só chama a API quem tem para onde chamar, e fora do período de cooldown. */
  get habilitado(): boolean {
    if (!this.base) return false;
    return Date.now() >= this.mudoAte;
  }

  /* ------------------------------ transporte ------------------------------- */

  private async pedir(
    caminho: string,
    params: Record<string, any> = {},
    opts: { exigirCompleto?: boolean; checarTruncado?: boolean } = {},
  ): Promise<any[]> {
    const url = new URL(this.base + caminho);
    for (const [chave, valor] of Object.entries(params)) {
      if (valor === undefined || valor === null || valor === '') continue;
      // `f` é repetível: cada filtro vai no seu próprio parâmetro. Juntar dois
      // filtros numa string só faria o segundo virar valor do primeiro, porque
      // o operador `em` também usa vírgula.
      for (const item of Array.isArray(valor) ? valor : [valor]) {
        url.searchParams.append(chave, String(item));
      }
    }

    try {
      const resposta = await fetch(url, {
        headers: {
          'x-app-token': this.token,
          // O relatório /health/n1 do outro lado é por serviço: sem este header
          // o padrão de consulta unitária aparece como "desconhecido".
          'x-servico': 'fiscal-service',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!resposta.ok) {
        const corpo = await resposta.text().catch(() => '');
        throw new Error(`HTTP ${resposta.status} em ${caminho}: ${corpo.slice(0, 300)}`);
      }

      const json = (await resposta.json()) as RespostaErp;
      this.falhasSeguidas = 0;

      // Truncamento silencioso é o pior desfecho possível: a resposta parece
      // completa e o consumidor conclui que o resto não existe. Onde a lista
      // alimenta uma sincronização, meia resposta é pior que nenhuma — o erro
      // devolve a chamada para o caminho antigo, que não tem teto.
      //
      // Nas rotas em lote o teto é o TAMANHO DA LISTA que mandamos: pedir 3
      // chaves e receber 3 marca `truncado`, e avisar aí seria ruído puro.
      if (json?.meta?.truncado && opts.checarTruncado !== false) {
        const aviso = `${caminho} bateu no teto da tabela (${json.meta.linhas} linhas) e o resultado está INCOMPLETO`;
        if (opts.exigirCompleto) throw new Error(aviso);
        this.logger.warn(`[ERP-API] ${aviso} — reduza o período ou o lote.`);
      }

      return json?.dados ?? [];
    } catch (erro: any) {
      this.registrarFalha(caminho, erro);
      throw erro;
    }
  }

  /**
   * Motivo da falha em uma linha.
   *
   * `fetch` embrulha qualquer problema de rede numa mensagem única — "fetch
   * failed" — e joga a causa real no `cause`. Sem abrir esse nível, o log não
   * distingue nome que não resolve de porta fechada, de certificado recusado,
   * e cada um deles pede uma correção diferente.
   */
  private motivo(erro: any): string {
    if (erro?.name === 'TimeoutError' || erro?.name === 'AbortError') {
      return `timeout de ${this.timeoutMs}ms`;
    }

    // Quando o host tem IPv4 e IPv6, o Node tenta os dois e embrulha as duas
    // falhas num AggregateError — que não tem `code`. O motivo está nos filhos.
    let causa: any = erro?.cause;
    if (Array.isArray(causa?.errors) && causa.errors.length) causa = causa.errors[0];

    const codigo = causa?.code ?? causa?.errno;
    // Nem toda causa tem código (porta fora da faixa permitida, por exemplo,
    // vem só como texto). A mensagem dela ainda é melhor que "fetch failed".
    if (!codigo) return causa?.message || erro?.message || String(erro);

    const onde = causa?.hostname ?? causa?.address;
    const porta = causa?.port ? `:${causa.port}` : '';
    const explicacao: Record<string, string> = {
      ENOTFOUND: 'o nome não resolve neste container',
      EAI_AGAIN: 'o DNS não respondeu',
      ECONNREFUSED: 'o endereço resolve, mas ninguém atende nessa porta',
      ECONNRESET: 'a conexão foi cortada pelo outro lado',
      ETIMEDOUT: 'o pacote saiu e não voltou — normalmente firewall ou host errado',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado autoassinado: não foi emitido pela CA interna',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'falta a CA interna no container (NODE_EXTRA_CA_CERTS)',
      SELF_SIGNED_CERT_IN_CHAIN: 'falta a CA interna no container (NODE_EXTRA_CA_CERTS)',
    };

    const detalhe = explicacao[codigo] ? ` — ${explicacao[codigo]}` : '';
    return `${codigo}${onde ? ` em ${onde}${porta}` : ''}${detalhe}`;
  }

  private registrarFalha(caminho: string, erro: any) {
    this.falhasSeguidas++;
    const motivo = this.motivo(erro);

    if (this.falhasSeguidas >= ErpApiService.LIMITE_FALHAS) {
      this.mudoAte = Date.now() + ErpApiService.COOLDOWN_MS;
      this.falhasSeguidas = 0;
      this.logger.error(
        `[ERP-API] ${caminho} falhou ${ErpApiService.LIMITE_FALHAS}x seguidas (${motivo}). ` +
          `Pausando por ${ErpApiService.COOLDOWN_MS / 1000}s — as leituras vão por OPENQUERY nesse período.`,
      );
    } else {
      this.logger.warn(`[ERP-API] ${caminho} falhou (${motivo}). Tentando pelo OPENQUERY.`);
    }
  }

  /**
   * Executa pela API e cai para o caminho antigo se ela não responder.
   *
   * A leitura do ERP não pode depender da disponibilidade de mais um serviço:
   * enquanto os dois caminhos existem, indisponibilidade da API é degradação,
   * não interrupção.
   */
  async comFallback<T>(viaApi: () => Promise<T>, viaOpenQuery: () => Promise<T>): Promise<T> {
    if (!this.habilitado) return viaOpenQuery();
    try {
      return await viaApi();
    } catch {
      return viaOpenQuery();
    }
  }

  /* ------------------------------- consultas ------------------------------- */

  /**
   * Cadastro fiscal de produtos, em lote.
   *
   * Empresa 1: a conferência é da nota de ENTRADA, lançada na matriz. O padrão
   * da API é 3 (atacado) — pedir sem informar traria o cadastro errado.
   */
  async produtosFiscal(codigos: number[], empresa = 1): Promise<any[]> {
    if (!codigos.length) return [];
    return this.pedir(
      '/erp/produtos/fiscal',
      { produtos: codigos.join(','), empresa },
      { checarTruncado: false },
    );
  }

  /** Colunas do cadastro fiscal — as mesmas da rota em lote `/erp/produtos/fiscal`. */
  private static readonly CAMPOS_FISCAIS =
    'PRO_CODIGO,PRO_DESCRICAO,ST_CODIGO,SUBTIPO,PIS_CODIGO,COFINS_CODIGO,COMERCIALIZAVEL,SUBGRP_CODIGO,CEST,NCM';

  /**
   * Cadastro fiscal de UM produto.
   *
   * Vai pela consulta livre com `PRO_CODIGO:igual`, e não pela rota em lote,
   * porque é essa forma que o agrupador do outro lado reconhece: ele junta as
   * consultas que chegam na mesma janela e diferem só no valor de um filtro
   * `igual` sobre coluna única. A rota em lote usa o operador `em`, que não
   * entra no agrupamento — dez consultas unitárias por ali seriam dez idas ao
   * Firebird.
   */
  async produtoFiscalUnico(codigo: number, empresa = 1): Promise<any | null> {
    const linhas = await this.pedir(
      '/erp/produtos',
      {
        empresa,
        campos: ErpApiService.CAMPOS_FISCAIS,
        f: `PRO_CODIGO:igual:${codigo}`,
        limite: 1,
      },
      { checarTruncado: false },
    );
    return linhas[0] ?? null;
  }

  /** De-para do código do fornecedor (PRODUTOS_FORNECEDOR_NFE), em lote. */
  async referenciasFornecedor(fornecedor: number, codigos: string[], empresa = 1): Promise<any[]> {
    if (!fornecedor || !codigos.length) return [];
    return this.pedir(
      '/erp/produtos-fornecedor/referencias',
      { fornecedor, codigos: codigos.join(','), empresa },
      { checarTruncado: false },
    );
  }

  /**
   * NF-e recebidas e ainda não importadas, no período. Não traz o XML: a
   * coluna TEM_XML diz se ele existe, e o conteúdo se busca por chave.
   *
   * A rota tem teto de linhas. Como o resultado é a lista do que precisa ser
   * sincronizado, uma resposta cortada faria a sincronização ignorar notas em
   * silêncio — por isso o truncamento é tratado como falha e a chamada volta
   * para o OPENQUERY.
   */
  async nfeDistribuicaoPendentes(dataIni: string, dataFim: string, empresa = 1): Promise<any[]> {
    return this.pedir(
      '/erp/nfe-distribuicao/pendentes',
      { dataIni, dataFim, empresa },
      { exigirCompleto: true },
    );
  }

  /** Uma chave específica ainda está na fila de importação? */
  async nfeDistribuicaoTemChave(chave: string, empresa = 1): Promise<boolean> {
    const linhas = await this.pedir(
      '/erp/nfe-distribuicao',
      {
        empresa,
        campos: 'CHAVE_NFE',
        f: [`IMPORTADA:igual:N`, `CHAVE_NFE:igual:${chave}`],
        limite: 1,
      },
      { checarTruncado: false },
    );
    return linhas.length > 0;
  }

  /** Notas de entrada já lançadas (STATUS 1), por lista de chaves. Máx. 50. */
  async nfEntradaPorChaves(chaves: string[], empresa = 1): Promise<any[]> {
    if (!chaves.length) return [];
    return this.pedir(
      '/erp/nf-entrada/por-chaves',
      { chaves: chaves.join(','), empresa },
      { checarTruncado: false },
    );
  }

  /** Itens de uma nota de entrada, pela chave interna NFE. */
  async nfeItens(nfe: number, empresa = 1): Promise<any[]> {
    return this.pedir('/erp/nfe-itens', {
      empresa,
      campos: 'ITEM,PRO_CODIGO,CFOP,CFOP_NOTA,CST,CST_FISCAL,ALIQ_ICMS,ST_VALOR',
      f: `NFE:igual:${nfe}`,
      ordenar: 'ITEM',
      limite: 500,
    });
  }

  /**
   * Itens de VÁRIAS notas de uma vez. Traz `NFE` junto porque, no lote, é o que
   * diz de qual nota é cada item.
   *
   * Trunca se o conjunto passar do teto — e aqui truncar significaria auditar
   * uma nota com itens faltando, que é pior que não auditar. Por isso a falha.
   */
  async nfeItensEmLote(nfes: number[], empresa = 1): Promise<any[]> {
    if (!nfes.length) return [];
    return this.pedir(
      '/erp/nfe-itens',
      {
        empresa,
        campos: 'NFE,ITEM,PRO_CODIGO,CFOP,CFOP_NOTA,CST,CST_FISCAL,ALIQ_ICMS,ST_VALOR',
        f: `NFE:em:${nfes.join(',')}`,
        ordenar: 'NFE,ITEM',
        limite: 20_000,
      },
      { exigirCompleto: true },
    );
  }

  /**
   * XML das notas, por chave. Máx. 50 por chamada — é BLOB, e o custo é por
   * nota. O teto é do outro lado; quem chama precisa fatiar antes.
   */
  async xmlPorChaves(chaves: string[], empresa = 1): Promise<any[]> {
    if (!chaves.length) return [];
    return this.pedir(
      '/erp/nf-entrada-xml/por-chaves',
      { chaves: chaves.join(','), empresa },
      { checarTruncado: false },
    );
  }

  /** Tamanho do lote aceito pelas rotas que recebem lista de chaves. */
  static readonly LOTE_CHAVES = 50;
}
