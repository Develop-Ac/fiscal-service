# `calculadora-st-service` → `fiscal-service` — passo a passo do deploy

O código já está renomeado. O que falta é fora do repositório: GitHub, EasyPanel,
DNS/certificado e as variáveis de ambiente. Este arquivo é o roteiro.

**Princípio que guia a ordem:** o nome do serviço **não aparece em nenhuma rota** da API
(`/icms`, `/cte`, `/nfse` continuam iguais). Quem quebra é o **endereço** — quem chama
precisa saber para onde ir. Por isso todo consumidor aceita o nome antigo como fallback:
dá para trocar o endereço primeiro e as variáveis depois, sem janela de indisponibilidade.

---

## 1. GitHub

1. `github.com/Develop-Ac/calculadora-st-service` → **Settings** → **Repository name** →
   `fiscal-service` → **Rename**.
2. Nos clones locais, apontar o remote para o nome novo:

```bash
git -C intranet-workspace/fiscal-service remote set-url origin https://github.com/Develop-Ac/fiscal-service.git
```

O GitHub **redireciona a URL antiga**, então clones e CI que ainda não foram atualizados
continuam funcionando. O redirecionamento morre se alguém criar um repositório novo com o
nome antigo — não recrie `calculadora-st-service`.

A pasta local já foi renomeada para `intranet-workspace/fiscal-service`.

---

## 2. DNS e certificado (fazer ANTES do EasyPanel)

O host novo precisa existir e ser confiável **antes** de você apontar alguém para ele:

1. Entrada no DNS interno para `fiscal-service.acacessorios.local` (ou o host que você
   escolher), apontando para o mesmo destino do host atual.
2. Certificado da CA interna cobrindo o host novo — ver `certificados-intranet/`. Se o SAN
   não cobrir, o navegador barra e **parece serviço fora do ar**, não erro de certificado.

Teste antes de seguir (o serviço tem prefixo global `/api` — ver `setGlobalPrefix` em
`src/main.ts`, então **toda** rota vive sob `/api`):

```bash
curl -I http://fiscal-service.acacessorios.local/api/icms/payment-status
```

---

## 3. EasyPanel

**Não renomeie o app in-place.** O nome do app é o DNS interno (`<projeto>_<serviço>`), e
renomear troca esse nome no mesmo instante para todo mundo.

Caminho sem janela:

1. No app atual, **adicione o domínio novo** (`fiscal-service.acacessorios.local`) ao lado
   do antigo. Os dois respondem.
2. Aponte a imagem para o repositório novo (`Source` → repo `fiscal-service`) e faça deploy.
3. Valide pelo domínio novo (passo 5).
4. Só depois: renomeie o app para `fiscal-service` e remova o domínio antigo.

Um app novo em paralelo também funciona, mas cuidado: **os crons subiriam duplicados**
(sync de NF-e, auditoria, rastreio SSW, distribuição NFS-e). Se optar por app novo, suba com
`NFE_SYNC_CRON_DISABLED=true`, `WAHA_AJUSTADO_CRON_DISABLED=true`,
`NFSE_DIST_CRON_DISABLED=true` e `SSW_TRACKING_CRON_DISABLED=true`, e só desligue essas
flags depois de derrubar o app antigo.

---

## 4. Variáveis de ambiente

Nenhuma variável **dentro** do `fiscal-service` cita o próprio nome — não há nada a mudar lá.
O que muda é nos dois consumidores:

| App no EasyPanel | Variável nova | Valor | Variável antiga |
|---|---|---|---|
| `cotacao-frontend` | `NEXT_PUBLIC_FISCAL_SERVICE_BASE` | mesma URL de `NEXT_PUBLIC_CALCULADORA_ST_BASE` | `NEXT_PUBLIC_CALCULADORA_ST_BASE` |
| `financeiro-service` | `FISCAL_SERVICE_URL` | mesma URL de `CALCULADORA_ST_URL` (DANFSe do ADN) | `CALCULADORA_ST_URL` |

O valor **termina em `/api`** — o serviço roda com `setGlobalPrefix('api')`, então o front
monta `<base>/icms/...` e isso precisa cair em `/api/icms/...`. Mesmo padrão do
`NEXT_PUBLIC_QUALIDADE_API_BASE`, que é `http://garantia-service.acacessorios.local/api`.

O jeito seguro de preencher: **copie o valor da variável antiga e troque só o host.** Assim
você não erra o esquema (`http`/`https`), a porta nem o `/api`.

```
NEXT_PUBLIC_FISCAL_SERVICE_BASE=http://fiscal-service.acacessorios.local/api
```

**Adicione a nova sem apagar a antiga.** Os dois serviços leem a nova primeiro e caem na
antiga se ela não existir (`lib/services.ts` e `danfse.service.ts`). Assim, um ambiente
esquecido continua de pé em vez de ficar com a base vazia — que não dá erro claro, só faz a
chamada falhar de um jeito difícil de diagnosticar.

Remova as antigas só depois que **todos** os ambientes estiverem com a nova, e aí apague
também os dois fallbacks no código.

### Ainda no `fiscal-service`: MinIO do app de scan

Para as guias de ICMS-ST escaneadas aparecerem na tela da NF, a credencial MinIO deste
serviço precisa ler o bucket **`movimento-fiscal`** (o do `escaner-fiscal-app`). Sem isso a
lista aparece e só o botão *Abrir* falha.

---

## 5. Banco: permissões do módulo Fiscal

As 4 abas viraram páginas próprias em `/fiscal`. Rode
**`sql/2026-08-04_modulo_fiscal_permissoes.sql`** — ele copia as permissões de cada usuário
para os caminhos novos, sem mudar direito de ninguém.

**Aplique ANTES de subir o front novo.** Entre o deploy e o script, o menu Fiscal não
aparece para ninguém, porque ninguém tem permissão em `/fiscal/*`.

Ensaiado contra o banco real (em transação, com rollback): 55 linhas, as 6 telas com o mesmo
número de usuários da origem, e repetir o script não duplica nada.

---

## 6. Validação

| O quê | Como |
|---|---|
| Serviço no ar | `curl -I https://<host-novo>/icms/payment-status` |
| DANFSe do financeiro | baixar um DANFSe em Contas a Receber (usa `FISCAL_SERVICE_URL`) |
| Menu Fiscal | logar como usuário de Compras: seção **Fiscal** com 4 itens |
| As 4 telas | `/fiscal/nfe`, `/fiscal/conferencia`, `/fiscal/nfse`, `/fiscal/cte` |
| Detalhe da NF | abrir uma nota da lista → `/fiscal/nfe/<chave>` |
| Compras intacto | `/compras/cotacao/pedido/<id>`, link da NF vinculada leva a `/fiscal/nfe/...` |

---

## 7. Voltar atrás

- **Front:** redeploy da versão anterior. As permissões antigas continuam no banco enquanto o
  passo 4 do SQL (o `DELETE`, comentado) não for executado — por isso ele é separado.
- **Serviço:** o domínio antigo responde até você removê-lo no passo 3.4, e as variáveis
  antigas seguem válidas pelos fallbacks.

Ou seja: enquanto você não fizer 3.4 e o `DELETE` do SQL, cada passo é reversível sozinho.

---

## 8. O que ficou de fora

`intranet-workspace/.docs/**` e `WORKSPACE.md` ainda dizem `calculadora-st-service`
(11 arquivos). Ficaram intocados de propósito: pelo `CLAUDE.md` do workspace, esses
documentos só se editam pela porta OKF (`/okf-record`).

As pastas de `SPRINT/` e `_kb-sources/` também mantêm o nome antigo — de propósito: são
registro do que era verdade naquela quinzena.
