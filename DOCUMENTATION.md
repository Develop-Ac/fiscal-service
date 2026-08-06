# Documentação de Desenvolvimento - Calculadora ICMS ST Service

Este documento serve como guia para o desenvolvimento e manutenção da API `fiscal-service`.

## Visão Geral

O serviço é responsável por:
1.  Calcular o ICMS Sutbstituição Tributária (ST) e Diferencial de Alíquota (DIFAL) conforme a Portaria 195/2019 (MT).
2.  Gerar PDFs da DANFE a partir do XML da nota fiscal.
3.  Fornecer endpoints para conciliação de notas fiscais de entrada.

## Stack Tecnológica

*   **Framework**: NestJS (Node.js)
*   **Linguagem**: TypeScript
*   **Banco de Dados**: Postgres (acessado via Prisma ORM)
*   **Documentação**: Swagger (OpenAPI)
*   **Libs Principais**:
    *   `@alexssmusica/node-pdf-nfe`: Geração de DANFE
    *   `archiver`: Compactação ZIP
    *   `xml2js`: Parse de XML

## Configuração do Ambiente

Certifique-se de ter instalado:
*   Node.js (v18 ou superior)
*   NPM
*   Docker (opcional, para facilitar deploy)

### 1. Instalação de Dependências

```bash
npm install
```

### 2. Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto com as seguintes chaves (exemplo):

```env
DATABASE_URL="sqlserver://host:port;database=db;user=user;password=pass;encrypt=true;trustServerCertificate=true"
PORT=3001
CORS_ORIGIN=http://localhost:3000,http://cotacao-frontend.acacessorios.local
```

### 3. Prisma

Se houver alterações no schema do banco de dados (`prisma/schema.prisma`):

```bash
npx prisma generate
```

## Execução

### Desenvolvimento

```bash
npm run dev
```

O servidor iniciará em `http://localhost:3001` (ou a porta definida no .env).

### Produção

```bash
npm run build
npm run start:prod
```

## Documentação da API (Swagger)

A API possui documentação automática gerada pelo Swagger.

*   Acesse: **`/api/docs`** (ex: `http://localhost:3001/api/docs`)
*   Aqui você pode ver todos os endpoints disponíveis, seus parâmetros e testar requisições diretamente pelo navegador.

### Status do Servidor

Ao acessar a raiz (`/`), o servidor retorna um JSON indicando status online:

```json
{
  "status": "online",
  "message": "O servidor está online e funcional",
  "docs": "/api/docs",
  "timestamp": "..."
}
```

## Estrutura do Projeto

*   `src/main.ts`: Ponto de entrada. Configuração do Swagger e CORS.
*   `src/app.module.ts`: Módulo raiz.
*   `src/icms/`: Módulo principal de cálculo de ICMS.
    *   `icms.controller.ts`: Definição das rotas (`/icms/*`).
    *   `icms.service.ts`: Lógica de negócio (cálculos e geração de PDF).
*   `src/prisma/`: Configuração do cliente ORM.

## Fluxos Principais

### Cálculo de ST
1.  Frontend envia XMLs ou chaves de nota.
2.  Backend processa cada item do XML.
3.  Verifica NCM, aplica MVA (Margem de Valor Agregado).
4.  Compara ST destacado na nota com o calculado.
5.  Retorna divergências e valores a recolher.

### Geração de DANFE
1.  Endpoint `/icms/danfe` recebe o XML completo.
2.  Utiliza a lib `@alexssmusica/node-pdf-nfe` para gerar o PDF em memória.
3.  Retorna o stream do arquivo PDF.

## Manutenção Futura

*   **Adicionar novas rotas**: Crie novos métodos no `IcmsController` e decore com `@Get`, `@Post`, etc. O Swagger detectará automaticamente.
*   **Alterar regras de cálculo**: Edite `icms.service.ts`.
*   **Atualizar dependências**: Execute `npm update`. Teste sempre a geração de PDF após updates, pois libs de PDF podem ser sensíveis.

## Conciliação Fiscal por Item (abril/2026)

Foi adicionada a trilha de conferência fiscal por item da nota com vínculo de cadastro entre fornecedor e produto interno.

### Estrutura de banco (PostgreSQL)

Aplicar manualmente o script:

`sql/2026-04-17_conciliacao_fiscal_item.sql`

Esse script:

* adiciona em `com_nfe_conciliacao` os campos:
  * `compra_comercializacao`
  * `uso_consumo`
* cria a tabela `com_nfe_conciliacao_item` para persistência por item da conferência fiscal.

### Novo endpoint

* `POST /icms/fiscal-conferencia/preview`

Entrada:

```json
{
  "notas": [
    {
      "chaveNfe": "...",
      "itens": [
        {
          "item": 1,
          "codProdFornecedor": "123",
          "impostoEscolhido": "ST",
          "destinacaoMercadoria": "COMERCIALIZACAO",
          "ncmNota": "8708...",
          "cstNota": "060"
        }
      ]
    }
  ]
}
```

Saída:

* flags por nota (`compraComercializacao`, `usoConsumo`)
* status por item (`OK` ou `DIVERGENTE`)
* lista de divergências para conferência de cadastro.

### Regras implementadas

1. Vínculo fornecedor/produto:
   * `CPF_CNPJ` do emitente na `Stage_Fornecedores` para obter `FOR_CODIGO`.
   * `FOR_CODIGO + COD_PROD_FORNECEDOR` na `Stage_Produtos_Fornecedor_NFE` para obter `PRO_CODIGO`.

2. Comercialização:
   * quando item marcado com ST: `ST_CODIGO = ST0-X`.
   * `SUBTIPO = 00`.
   * NCM monofásico (match completo, raiz 6 ou raiz 4): `PIS_CODIGO=04` e `COFINS_CODIGO=04`.
   * não monofásico: `PIS_CODIGO=P01` e `COFINS_CODIGO=C01`.
   * compra interna com ST: CST da nota precisa terminar em `10` ou `60`.

3. Uso e consumo:
   * `COMERCIALIZAVEL = N`
   * `PIS_CODIGO = P99`
   * `COFINS_CODIGO = C99`
   * `SUBGRP_CODIGO = 274`
   * `SUBTIPO = 07`

### Observação operacional

O endpoint `POST /icms/payment-status` passou a aceitar a coleção de itens para, além do status da nota, persistir a conferência fiscal por item quando a estrutura SQL já estiver aplicada.

## Alerta de MVA acima do padrão — NF interestadual (junho/2026)

Automação que, ao chegar o **XML completo** de uma NF de entrada **de fora de MT**,
verifica o MVA destacado e, se exceder o padrão, avisa a equipe pelo WhatsApp
(grupo **Conferência Fiscal**) via um workflow do n8n.

### Fluxo

```
ERP --(sync 1min)--> syncInvoices() --(transição p/ XML completo)--> maybeAlertMva()
   --(regra atende)--> POST N8N_MVA_WEBHOOK_URL --> n8n (workflow Alerta_MVA_NF_Compra)
   --> HTTP WAHA /api/sendText --> grupo "Conferência Fiscal"
```

A intranet toma toda a **decisão** (reusa o parser de XML já existente) e o n8n
apenas **formata e envia** a mensagem, reaproveitando a sessão WhatsApp (`default`)
já usada por outros fluxos.

### Regra

* NF de **fora do estado**: os 2 primeiros dígitos da chave ≠ `51` (MT).
* **Algum item** com `pMVAST` destacado **> 50,39%** (limiar = MVA-padrão/fallback do serviço).
* O alerta lista todos os itens que excederam o limiar.

### Estrutura de banco (PostgreSQL)

Aplicar manualmente o script:

`sql/2026-06-24_alerta_mva_nf_interestadual.sql`

Adiciona em `com_nfe_conciliacao` as colunas de controle:

* `mva_verificado_em` — regra já avaliada para a NF (evita reprocessar a cada minuto).
* `mva_alerta_enviado_em` — WhatsApp já disparado (anti-duplicidade).
* `mva_maior` — maior `pMVAST` encontrado na nota (auditoria).

Após aplicar, rodar `npx prisma generate` (as colunas já estão em `prisma/schema.prisma`).

### Variável de ambiente

```env
# Webhook do n8n (workflow Alerta_MVA_NF_Compra) que envia o WhatsApp via WAHA.
# Sem isso, o alerta é pulado (apenas warning no log).
N8N_MVA_WEBHOOK_URL=https://atendimento-n8n.naayqg.easypanel.host/webhook/mva-alerta
```

### Implementação

* `icms.service.ts`:
  * `maybeAlertMva(chaveNfe, xmlCompleto)` — chamada no loop de upsert do `syncInvoices()`
    quando há `normalizedXmlCompleto`. Idempotente (colunas acima) e **tolerante a falha**
    (envolvida em try/catch — nunca quebra o sync; o alerta só é marcado como enviado em
    resposta HTTP 2xx, então falha de rede é reprocessada no próximo ciclo).
  * `extractMvaFromXml(xml)` — extrai cabeçalho (emitente, UF, nº, valor) e o `pMVAST`
    por item, reaproveitando o mesmo padrão de parse de `calculateStForInvoice()`.
  * Constante `MVA_LIMIAR = 50.39`.

### Contrato do webhook (intranet → n8n)

```json
{
  "chaveNfe": "...",
  "numeroNf": "1234",
  "emitente": "FORNECEDOR XPTO LTDA",
  "cnpjEmitente": "12345678000190",
  "ufEmitente": "SP",
  "dataEmissao": "2026-06-24T10:32:00-04:00",
  "valorTotal": 18450.77,
  "mvaPadrao": 50.39,
  "maiorMva": 62.5,
  "qtdItensAcima": 2,
  "itensAcima": [
    { "nItem": 1, "cProd": "ABC123", "descricao": "PASTILHA FREIO", "ncm": "87083090", "cfop": "6403", "pMvaSt": 62.5 }
  ]
}
```

### n8n / WhatsApp

* Workflow **`Alerta_MVA_NF_Compra`** (n8n online EasyPanel), nós:
  `Webhook MVA → Montar mensagem → Enviar WhatsApp (WAHA) → Responder 200`.
* Envio: `POST https://atendimento-waha.naayqg.easypanel.host/api/sendText`
  (header `X-Api-Key`, body `{ session: "default", chatId, text }`).
* Grupo de destino **Conferência Fiscal**: `chatId = 120363410637434985@g.us`.
* Para testar sem o ERP: `POST` do contrato acima no webhook de produção
  (`/webhook/mva-alerta`). O caminho `/webhook-test/...` só funciona com o editor
  do n8n em modo "Listen for test event".

## Auditoria fiscal do lançamento — NF LANCADA (junho/2026)

Quando uma NF de entrada passa para **LANCADA** (confirmada na `NF_ENTRADA` do ERP),
a auditoria cruza três fontes e, havendo divergência, avisa o grupo **Conferência
Fiscal** no WhatsApp com o número da nota e os erros identificados.

### Gatilho

No `syncInvoices()`, logo após marcar as notas como `LANCADA`, chama
`auditarLancamentoFiscal(chave)` para cada uma. Idempotente (alerta 1x por NF via
`auditoria_alerta_em`) e tolerante a falha (try/catch — nunca quebra o sync).

### Três fontes cruzadas

| Fonte | Origem | Fornece |
|-------|--------|---------|
| Nota (verdade) | `com_nfe_conciliacao.xml_completo` | Cabeçalho (CNPJ, nº, série, modelo, emissão, chave, vNF) e itens (NCM, origem, CST/ST da nota) |
| Conferência da tela | `com_nfe_conciliacao_item` | `imposto_escolhido` (ST/DIFAL/TRIBUTADA) e `destinacao_mercadoria` (COMERCIALIZACAO/USO_CONSUMO) por item |
| Lançamento ERP | Firebird via OPENQUERY: `NF_ENTRADA` + `NFE_ITENS` (EMPRESA=1, join por `NFE`, item por `ITEM`) | O que foi lançado: `CFOP` (entrada), `CST_FISCAL`, `TOTAL_NOTA`, etc. |

> Colunas duplas do ERP: audita-se o **`CFOP`** (entrada escriturado, ex. `2.407`) e
> o **`CST_FISCAL`** (ex. `560`). `CFOP_NOTA`/`CST` são da nota do fornecedor
> (informativos).

### Auditoria de cabeçalho (`NF_ENTRADA` × nota)

Número (`NOTA_FISCAL`), série, modelo, chave, CNPJ do emitente (dígitos 7–20 da
chave), data de emissão e valor total (`TOTAL_NOTA`, tolerância R$ 0,01).

### Auditoria por item — matriz esperada

CFOP de entrada e final do CST conforme `imposto × destinação × (intra 1.x / inter 2.x)`:

| imposto × destinação | CFOP entrada | CST final |
|----------------------|--------------|-----------|
| TRIBUTADA + Comercialização (revenda) | 1.102 / 2.102 | 00 |
| ST + Comercialização (revenda) | 1.403 / 2.403 | 60 |
| ST + Uso/Consumo | 1.407 / 2.407 | 60 |
| TRIBUTADA + Uso/Consumo (DIFAL) | 1.556 / 2.556 | 90 |

> Na ENTRADA, mercadoria com ST sempre tem **CST final 60** — o imposto já veio
> retido pelo fornecedor (substituto). O final 10 é de operação de saída.

**Origem do CST** (1º dígito): mantém a da nota, convertendo `1→2` e `6→7`
(fornecedor importou direto, mas a aquisição foi no mercado interno).

**Destinação em notas DENTRO do estado:** revenda x uso/consumo é determinada pelo
`OPF_CODIGO` da `NF_ENTRADA` (não pela tela nem pelo CFOP do item): `1` ou `40` =
compra/comercialização; `10` = uso/consumo. OPF não reconhecido vira divergência de
cabeçalho. Em notas de fora do estado, segue a conferência da tela (ou inferência
pelo CFOP lançado).

A matriz e a conversão de origem vivem como funções de configuração no
`icms.service.ts` (`cfopEntradaEsperado`, `cstFinalEsperado`, `origemEsperada`,
`classificacaoPorCfop`), fáceis de ajustar para exceções da contabilidade.

### NF lançada sem conferência na tela

Se não há linhas em `com_nfe_conciliacao_item`, a auditoria **infere** imposto/
destinação a partir do **CFOP lançado** (`classificacaoPorCfop`) e checa a coerência
do CST/origem + cabeçalho. O resultado fica com status `SEM_CONFERENCIA`.

### Estrutura de banco (PostgreSQL)

Aplicar manualmente: `sql/2026-06-24_auditoria_fiscal_lancamento.sql`

* `com_nfe_conciliacao`: `auditoria_fiscal_em`, `auditoria_fiscal_status`
  (OK / DIVERGENTE / SEM_CONFERENCIA), `auditoria_alerta_em`.
* `com_nfe_auditoria_item`: uma linha por divergência (`n_item = 0` para cabeçalho).

Após aplicar, rodar `npx prisma generate`.

### Variável de ambiente

```env
N8N_AUDITORIA_WEBHOOK_URL=https://atendimento-n8n.naayqg.easypanel.host/webhook/auditoria-nf
```

### n8n / WhatsApp

Workflow **`Alerta_Auditoria_NF_Compra`** (webhook `/webhook/auditoria-nf`), mesmos
nós do alerta de MVA (`Webhook → Montar mensagem → WAHA → Responder 200`), enviando
para o grupo **Conferência Fiscal** (`120363410637434985@g.us`).

Contrato do webhook (intranet → n8n):

```json
{
  "chaveNfe": "...",
  "numeroNf": "517098",
  "serie": "1",
  "emitente": "...",
  "ufEmitente": "GO",
  "dtEntrada": "2026-06-19",
  "statusAuditoria": "DIVERGENTE",
  "totalErros": 2,
  "erros": [
    { "escopo": "ITEM", "nItem": 6, "proCodigo": "49458", "campo": "CFOP", "esperado": "2403", "encontrado": "2102", "mensagem": "CFOP esperado 2403, lançado 2102" },
    { "escopo": "CABECALHO", "campo": "Valor total", "esperado": "1062.27", "encontrado": "1060.00", "mensagem": "Valor total divergente" }
  ]
}
```

### Endpoints de consulta (aba "Conferência Fiscal" do frontend)

* `GET /icms/auditoria` — lista NFs lançadas com o status da auditoria.
  Query params: `q` (nº ou chave), `emitente` (nome ou CNPJ), `escopo`
  (`TODOS`|`DENTRO`|`FORA`), `dtInicio`, `dtFim` (data de entrada; **default = mês
  corrente**), `page`, `pageSize`. Retorna `{ page, pageSize, total, items[] }`.
* `GET /icms/auditoria/:chaveNfe` — detalhe calculado ao vivo (`computarAuditoria`):
  `{ header, cabecalho[], itens[] }`. Cada item traz `proCodigo`, `descricao`,
  `imposto`, `destinacao` e `checks[]` com cada conferência marcada `ok: true|false`
  (mostra o que está correto **e** o que divergiu). O cabeçalho também vem como `checks`.
* `POST /icms/auditoria/:chaveNfe/ressalva` — marca um item (`nItem`, 0=cabeçalho)
  como **OK por intervenção** (body `{ nItem, motivo?, usuario? }`). Item ressalvado
  não conta no status (tabela `com_nfe_ressalva`, script
  `sql/2026-06-24_ressalvas_auditoria.sql`). Recalcula e devolve o detalhe.
* `DELETE /icms/auditoria/:chaveNfe/ressalva/:nItem` — remove a ressalva.

  Na tela: botão **Ressalvar** por item (com motivo opcional); itens ressalvados
  ficam com badge âmbar "Ressalva" e a nota mostra "Com ressalva". O alerta de
  WhatsApp e o status consideram só as divergências **não** ressalvadas.
* `POST /icms/auditoria/:chaveNfe/reconferir` — **reexecuta a auditoria manualmente
  sem disparar o WhatsApp** (`auditarLancamentoFiscal(chave, { enviarAlerta: false })`)
  e devolve o detalhe atualizado.
* `POST /icms/auditoria/reconferir-periodo` — reexecuta a auditoria de **todas as NFs
  do período filtrado** (mesmos query params da lista; sem WhatsApp; teto de 2000).
  Retorna resumo `{ total, ok, divergente }`.

As reconferências (individual e período) buscam o cadastro do produto **direto na
`PRODUTOS` do ERP** (linked server `CONSULTA`, empresa 1), sem esperar o ETL do
`Stage_Produtos` (~1 min) — assim refletem alterações de cadastro na hora. A abertura
normal do detalhe e o sync automático continuam usando o Stage (com fallback no ERP).

**Reconciliação de status na reconferência** (`reconciliarStatusEntrada`): antes de
auditar, confere o ERP — está em `NF_ENTRADA` → `LANCADA` (audita); voltou para
`NFE_DISTRIBUICAO` → `PENDENTE`; sumiu das duas → `EXCLUIDA`. Notas que deixam de
estar `LANCADA` saem da auditoria (a lista filtra por `LANCADA`). Em falha de consulta
ao ERP, **não** marca como excluída (conservador).

O `OPF_CODIGO` **apenas determina** a destinação (revenda x uso/consumo) das notas
intra — não aparece como item de conferência.

Frontend: aba **Conferência Fiscal** na tela de NF de entrada
(`cotacao-frontend/app/(private)/compras/notaFiscal/notaFiscal/`), componente
`components/ConferenciaFiscal.tsx` — lista com filtros (nº/chave, emitente/CNPJ,
dentro/fora do estado, data de entrada), status por nota, detalhe com erros item a
item e botão **Reconferir**.

### Conferência do cadastro do produto

Além de CFOP/CST, a auditoria confere o **cadastro** de cada item: pega o
`PRO_CODIGO` que o ERP lançou em `NFE_ITENS`, consulta `Stage_Produtos` (com
**fallback** na `PRODUTOS` empresa 1 do Firebird via linked server `CONSULTA`,
caso o Stage esteja desatualizado pelo ETL) e compara
`SUBTIPO`, `COMERCIALIZAVEL` e `SUBGRP_CODIGO` com o esperado da regra.

**Situação Tributária** (`ST_CODIGO`, exibida como "Situação Tributária"): depende do
produto ter **CEST** — com CEST → `ST0-X` (substituto tributário); sem CEST → `TR0-X`.
Mesma regra na conferência da tela de NF (`analyzeFiscalItem`).

**PIS/COFINS** não vêm da matriz: são calculados pelo **SUBTIPO do cadastro** +
monofásico (`pisCofinsEsperado`):
* SUBTIPO `07` ou `08` → `P70` / `C70`;
* monofásico (e não 07/08) → `04` / `04`;
* demais (não monofásico, não 07/08) → `P01` / `C01`.

(As colunas `pis_codigo`/`cofins_codigo` da matriz deixaram de ser usadas nessa
conferência.)

### Regras fiscais configuráveis

A matriz e os mapeamentos saíram do código para tabelas editáveis (script
`sql/2026-06-24_regras_fiscais_configuraveis.sql`):

* `com_fiscal_cfop` — **regras por CFOP de entrada (norma MT, precedência sobre a matriz):**
  chave `cfop_fornecedor × destinacao × tem_cest` → `cfop_entrada` + `cst_final`.
  Cobre compra, devolução, transferência, retorno, etc. Em MT o ICMS-ST/antecipação
  se aplica ao **produto** (tem CEST), então fornecedor tributado (6102) pode virar
  entrada ST (2403) quando o produto é ST. Script: `sql/2026-06-24_regras_cfop_entrada.sql`.
* `com_fiscal_regra` — matriz `imposto × destinação (× monofásico)` (fallback) → `cfop_sufixo`,
  `cst_final`, `st_codigo`, `pis_codigo`, `cofins_codigo`, `subtipo`,
  `comercializavel`, `subgrp_codigo`. Campo vazio = não confere.
* `com_fiscal_opf_destinacao` — `OPF_CODIGO` → destinação (notas intra).
* `com_fiscal_origem_cst` — conversão do 1º dígito (origem) do CST.

A auditoria carrega as regras com cache (`getFiscalRules`, invalidado ao salvar) e,
se as tabelas estiverem vazias, usa os **defaults embutidos** (`regraEsperadaDefault`).
DIFAL é tratado como Tributada + Uso/Consumo.

Endpoints + UI:
* `GET /icms/fiscal-regras` — retorna `{ regras, opf, origem }`.
* `PUT /icms/fiscal-regras` — substitui tudo (full replace atômico) e invalida o cache.
* Botão **Regras fiscais** no topo da aba abre o modal `RegrasFiscaisModal.tsx`
  (3 seções editáveis: matriz, OPF→destinação, origem CST).

## Leitura do ERP pela erp-firebird-api (agosto/2026)

Até aqui, **toda** consulta ao Celta saía deste serviço por
`OPENQUERY(CONSULTA, ...)`: o SQL Server abre uma sessão no Firebird e devolve o
resultado. Quando essa sessão trava — ou quando o linked server engasga — o
fiscal-service para junto, com o ERP saudável do outro lado.

O fiscal-service é o **primeiro serviço a consumir a
[erp-firebird-api](../erp-firebird-api/README.md)**, que lê o Firebird direto.

### O que muda além do caminho

A API monta o `SELECT` a partir do catálogo dela: nome de coluna é validado
contra os metadados e valor viaja como parâmetro. Duas defesas que este serviço
não tinha:

* **`EMPRESA` obrigatória** nas tabelas que têm a coluna. O mesmo cadastro
  existe nas empresas 1 e 3; sem o filtro vêm as duas e "a primeira linha" é
  arbitrária. Medido: `PRODUTOS` sem `EMPRESA` = 119ms e 3 linhas; com = 12ms e
  1 linha.
* **Agrupamento de consulta unitária.** A conferência fiscal pergunta produto a
  produto. Medido contra o ERP real: **10 consultas simultâneas viraram 1 ida ao
  Firebird**, e cada chamador recebeu o seu produto (10/10).

### Variáveis de ambiente

```bash
# Endereço da erp-firebird-api. VAZIO = tudo continua indo por OPENQUERY.
ERP_API_URL=http://intranet_erp-firebird-api:8010
# Mesmo token dos outros serviços (header x-app-token).
ERP_API_TOKEN=
# Opcional. Default 30000.
ERP_API_TIMEOUT_MS=30000
```

Ligar e desligar é só a variável: sem ela o serviço se comporta exatamente como
antes. Toda chamada tem o caminho antigo como alternativa — se a API não
responder, a leitura vai por OPENQUERY e o log diz que caiu. Depois de 3 falhas
seguidas o cliente para de tentar por 60s, para não pagar o timeout inteiro em
cada consulta enquanto a API está fora.

### O que passou a usar a API

| Método (`src/`) | Rota |
|---|---|
| `icms.service.ts` · `fetchErpInvoices` | `/erp/nfe-distribuicao/pendentes` + `/erp/nf-entrada-xml/por-chaves` |
| `icms.service.ts` · `fetchNfEntradaDatesByKeys` | `/erp/nf-entrada/por-chaves` |
| `icms.service.ts` · `fetchEntradaXmlInvoicesByKeys` | `/erp/nf-entrada-xml/por-chaves` |
| `icms.service.ts` · `fetchLancamentoErp` | `/erp/nf-entrada/por-chaves` + `/erp/nfe-itens` |
| `icms.service.ts` · `existsInNfeDistribuicao` | `/erp/nfe-distribuicao` |
| `icms.service.ts` · `findInternalProductErp` | `/erp/produtos` (`PRO_CODIGO:igual`) |
| `cte.service.ts` · `fetchNfEntradaDatesByKeys` | `/erp/nf-entrada/por-chaves` |

O produto é buscado pela consulta livre com `PRO_CODIGO:igual`, e não pela rota
em lote `/erp/produtos/fiscal`: só o operador `igual` sobre coluna única entra no
agrupamento do outro lado. A rota em lote continua certa quando já se tem a
lista inteira em mãos.

### O que continua no OPENQUERY, e por quê

* **`fetchEntradaXmlKeys`** — pede TODAS as chaves de `NF_ENTRADA_XML`. A API
  recusa por construção: a tabela exige filtro e tem teto de linhas, justamente
  para não permitir varredura sem recorte. Enquanto a carga inicial depender de
  varrer a tabela inteira, ela fica no caminho antigo.
* **`findSupplierProductLink`** — o de-para de código do fornecedor compara
  `TRIM(COALESCE(...))` com duas variantes do código (com e sem zeros à
  esquerda), mais descrição e unidade. A rota em lote da API usa o operador `em`,
  que **não** aplica TRIM, e o ERP grava esse código com espaço à direita.
* **`CTE_DISTRIBUICAO` e `CTE_ENTRADA_XML`** — ainda não estão no catálogo da
  API. Só a confirmação do lançamento (`NF_ENTRADA`, modelo 57) migrou.
* **`Stage_*`** — são tabelas do SQL Server, não do Firebird. Não têm nada a ver
  com a API.

### Uma diferença de comportamento

Pela API, a lista de pendentes exige **período fechado**. O caminho por
OPENQUERY, sem data informada, varre desde 01/2025 sem limite superior — a
varredura sem recorte que a API existe para evitar. Sem data na chamada, o
período usado é o mesmo default do serviço (90 dias). O cron já manda as duas
datas (`NFE_SYNC_DIAS`, default 30), então na prática nada muda para ele.

Se a lista de pendentes bater no teto de linhas da rota, o cliente trata como
falha e a chamada volta para o OPENQUERY. Meia lista de sincronização é pior que
nenhuma: as notas que ficaram de fora não voltariam a ser vistas.

### Quando a API não responde

Todo desvio para o OPENQUERY loga antes de cair — não existe caminho silencioso.
Se no log só aparece a linha de "leitura do ERP habilitada", tudo foi pela API.

O `fetch` do Node embrulha qualquer problema de rede na mesma mensagem ("fetch
failed") e guarda a causa real no `cause`; o cliente abre esse nível, porque cada
causa pede uma correção diferente:

| No log | O que fazer |
|---|---|
| `ENOTFOUND` | o nome não resolve **deste container**. DNS interno do EasyPanel só vale dentro do mesmo host. |
| `ECONNREFUSED` | endereço certo, porta errada. Confira a `PORT` do container da API (8010 por padrão). |
| `ETIMEDOUT` | saiu e não voltou: firewall, ou host de outra máquina. |
| `DEPTH_ZERO_SELF_SIGNED_CERT` | o servidor apresenta certificado autoassinado — **não** foi a CA interna que emitiu. Instalar a CA não resolve. |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | certificado é da CA interna, mas o container não a conhece: `NODE_EXTRA_CA_CERTS`. |
| `HTTP 401` | `ERP_API_TOKEN` diferente do `APP_TOKEN` da API. |

Sonda direta, de dentro do container do fiscal-service (mesma pilha de rede e
TLS que o serviço usa):

```bash
node -e "fetch(process.env.ERP_API_URL+'/health').then(r=>r.text()).then(console.log).catch(e=>console.log('FALHOU:',e.cause?.code||e.cause?.message||e.message))"
```

Entre serviços do mesmo EasyPanel, prefira `http://<projeto>_erp-firebird-api:8010`:
o tráfego não sai da rede do Docker e não há certificado para manter.
