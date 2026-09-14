# Teams: preparação para a automação das guias de ICMS-ST (passo a passo)

O que é: a intranet da AC Acessórios vai passar a **pedir as guias de ICMS-ST ao escritório
contábil pelo chat do Teams** e a **ler a guia em PDF que o escritório responder**, anexando
automaticamente à nota fiscal. Para isso a intranet precisa de uma identidade no Microsoft 365
da empresa. Este documento lista o que o administrador do Microsoft 365 precisa fazer, uma
única vez, e o que deve entregar ao desenvolvimento.

Tempo estimado: 30 minutos. Nada disto muda o Teams de ninguém.

## Etapa 1 — Conta de serviço

1. No **Centro de administração do Microsoft 365** (admin.microsoft.com) → Usuários →
   Usuários ativos → **Adicionar um usuário**.
2. Nome: `Intranet Fiscal`; e-mail sugerido: `fiscal.intranet@acacessorios.com.br`.
3. Licença: qualquer plano que inclua Teams e OneDrive (Business Basic basta). A conta precisa
   de OneDrive porque os anexos enviados no chat ficam guardados lá.
4. Senha: anote em local seguro. Ela será usada **uma vez**, no login da Etapa 5. Se a empresa
   exige MFA, configure normalmente; o login único aceita MFA.
5. Se houver política de "frequência de entrada" (Conditional Access que força novo login a
   cada X dias), **isente esta conta**, senão a automação para de funcionar quando o prazo vencer.

## Etapa 2 — Colocar a conta no chat com o escritório

1. No Teams, abra o **chat em grupo** que a AC já usa com o escritório contábil.
2. Clique no ícone de participantes (canto superior direito) → **Adicionar pessoas** →
   `Intranet Fiscal`. Marque "incluir histórico" se quiser (não é necessário).
3. Ainda nesse chat, clique nos três pontos ao lado do nome do chat → **Obter link para o chat**
   (ou "Copiar link"). O link tem esta forma:

   ```
   https://teams.microsoft.com/l/chat/19%3Aabc123...%40thread.v2/0?...
   ```

   O trecho entre `chat/` e `/0` é o **identificador do chat**. Trocando `%3A` por `:` e
   `%40` por `@`, fica assim: `19:abc123...@thread.v2`. Guarde-o; é o item 5 da lista final.

4. Anote também **como o escritório participa do chat**: se as pessoas do escritório entram
   com contas de outra empresa (aparecem como "Externo" ao lado do nome) ou se foram
   convidadas como visitantes do nosso Microsoft 365. Isso muda como a intranet consegue
   baixar o PDF que eles anexam, e o desenvolvimento precisa saber antes de testar.
5. Em **Centro de administração do SharePoint → Políticas → Compartilhamento**, confira se o
   nível permite links para **"Qualquer pessoa"**. É assim que o escritório externo abre o XML e
   o DANFE anexados pela intranet. Se a política for mais restrita, avise o desenvolvimento.

## Etapa 3 — Registrar o aplicativo no Microsoft Entra

1. Acesse **entra.microsoft.com** (antigo Azure AD) → Identidade → Aplicativos →
   **Registros de aplicativo** → **Novo registro**.
2. Nome: `Intranet AC – Guias ICMS-ST`.
3. Tipos de conta com suporte: **Somente contas neste diretório organizacional** (locatário único).
4. URI de redirecionamento: plataforma **Web**, valor:

   ```
   https://fiscal-service.acacessorios.local/api/teams/auth/callback
   ```

   Depois de registrar, em **Autenticação** → Adicionar URI, inclua também (para testes):

   ```
   http://localhost:3001/api/teams/auth/callback
   ```

5. Clique em **Registrar**. Na página **Visão geral**, copie:
   - **ID do aplicativo (cliente)** → item 1 da lista final;
   - **ID do diretório (locatário)** → item 2.

## Etapa 4 — Segredo e permissões

1. **Certificados e segredos** → **Novo segredo do cliente** → descrição `intranet-fiscal`,
   validade **24 meses** → Adicionar. Copie o campo **Valor** na hora (ele só aparece uma vez)
   → item 3. Anote a **data de expiração** → item 4. Quando vencer, repetir só este passo e
   passar o novo valor ao desenvolvimento.
2. **Permissões de API** → **Adicionar uma permissão** → **Microsoft Graph** →
   **Permissões delegadas** → marque:

   | Permissão | Para quê |
   |---|---|
   | `Chat.ReadWrite` | ler o chat com o escritório e postar o pedido de guia |
   | `Files.ReadWrite` | subir o XML e o DANFE no OneDrive da conta de serviço para anexar |
   | `Files.Read.All` | baixar o PDF da guia que o escritório anexar |
   | `User.Read` | identificar a conta logada |
   | `offline_access` | manter a sessão sem novo login |

   → Adicionar permissões.
3. Na mesma tela, clique em **Conceder consentimento do administrador para <empresa>** → Sim.
   Todas as linhas devem ficar com o status "Concedido".

Não é necessário marcar nenhuma **permissão de aplicativo** (a coluna "Application"). Elas
exigiriam aprovação da própria Microsoft e não são usadas aqui.

## Etapa 5 — Login único (feito depois, quando o desenvolvimento avisar)

Com os itens acima configurados na intranet, alguém com a senha da conta de serviço abre, num
computador da rede da AC, o endereço:

```
https://fiscal-service.acacessorios.local/api/teams/auth
```

Faz login como `fiscal.intranet@acacessorios.com.br`, aceita e fecha. A intranet guarda a
sessão cifrada e renova sozinha. Só precisa repetir se a senha da conta for trocada, se a
sessão for revogada no Entra, ou se a conta ficar 90 dias sem uso.

## O que entregar ao desenvolvimento

| # | Item | Onde pegar |
|---|---|---|
| 1 | ID do aplicativo (cliente) | Etapa 3, Visão geral |
| 2 | ID do diretório (locatário) | Etapa 3, Visão geral |
| 3 | Valor do segredo do cliente | Etapa 4, passo 1 |
| 4 | Data de expiração do segredo | Etapa 4, passo 1 |
| 5 | Identificador do chat (`19:...@thread.v2`) | Etapa 2, passo 3 |
| 6 | E-mail da conta de serviço | Etapa 1 |
| 7 | Como o escritório participa do chat (externo ou visitante) e se links "Qualquer pessoa" são permitidos | Etapa 2, passos 4 e 5 |

A senha da conta **não** precisa ser entregue: quem a tiver faz o login da Etapa 5.

## Se algo travar

- **"Precisa de aprovação do administrador"** ao fazer login: faltou a Etapa 4, passo 3.
- **A conta não vê o chat**: ela não foi adicionada ao chat (Etapa 2) ou não tem licença do Teams.
- **Anexos não sobem**: a conta está sem OneDrive (licença sem SharePoint/OneDrive).
- **Parou de funcionar sozinho depois de semanas**: segredo expirado (item 4) ou política de
  frequência de entrada (Etapa 1, passo 5).
