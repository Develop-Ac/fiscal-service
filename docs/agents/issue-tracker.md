# Issue tracker: Trello

Issues, tickets e specs deste repositório vivem no Trello do workspace
"Ac Acessórios", acessado pelo conector Trello (MCP) do Claude.
Não usamos GitHub Issues.

## Quadros e listas

- **Sprint Back Log** (`https://trello.com/b/Hh8kDxcj`): tudo que ainda não foi
  planejado. Listas, na ordem do fluxo:
  `User history` / `Tarefas` → `Tarefas Documentadas` → `Tarefas Doc/Precificadas`.
- **Sprint** (`https://trello.com/b/IS9c67jx`): trabalho da quinzena.
  Listas: `Em andamento` → `Em teste` → `Concluido`.
  Sprint = 15 dias (1–15 e 16–fim do mês). Ao fechar, `Concluido` é renomeada
  para o período (`16/08-31/08`).
- O cartão é **movido** do Back Log para o Sprint no planejamento da quinzena.
  Essa movimentação é do time, nunca de uma skill.

## Máquina de estados

As listas carregam o estado. Etiqueta só onde a lista não distingue.

| Estado da skill            | Onde fica no Trello                                                    |
| -------------------------- | ---------------------------------------------------------------------- |
| sem triagem / `needs-triage` | Back Log, `User history` ou `Tarefas`                                |
| `needs-info`               | mesma lista, etiqueta `needs-info` + comentário "Triage Notes"         |
| `ready-for-human`          | Back Log, `Tarefas Documentadas` ou `Tarefas Doc/Precificadas`, sem etiqueta |
| `ready-for-agent`          | mesmas listas, etiqueta `ready-for-agent`                              |
| `wontfix`                  | cartão arquivado, com comentário do motivo                             |
| categoria `bug`            | título `Módulo: Hotfix - ...`                                          |
| categoria `enhancement`    | qualquer outro título                                                  |
| claimed                    | Sprint, `Em andamento`                                                 |
| resolved                   | Sprint, `Em teste` quando o agente termina; `Concluido` quando o usuário valida |

## Convenções do cartão

- Título: `Módulo: descrição curta`. Módulos usados: Estoque, Compras,
  Portal B2B, Fiscal, Sac, Vendas, Pessoal, Oficina, Electron, etl-worker.
  Correção: `Módulo: Hotfix - descrição`.
- Pontuação no título, escala 2/3/8/13/20/40/100; `(?)` = ainda sem nota.
  Estimar como dev sênior que reaproveita: serviço de molde = 13, agregação
  de existente = 3–8, 20+ só com tecnologia nova. Régua: ~300 pontos por
  sprint com dois devs.
- Descrição em linguagem de usuário, sem jargão da conversa, ≤ 2048 caracteres.
  Tarefa: 🎯 Objetivo / 🧩 Escopo e pontos / ✅ Critérios.
  Hotfix: 🐞 Problema / 🔎 Causa / ✅ Correção / 🧾 Como validar.
  Esse formato **é** o agent brief da skill: não criar um segundo formato.
- Membro = quem desenvolveu (Lucas `developeracacessorios` nesta estação).
- Etiqueta `próximo sprint` no Back Log marca o que entra no planejamento.
- O conector só anexa etiquetas existentes; criar etiqueta é manual, no Trello.
- Só criar ou mover cartão quando o usuário pedir explicitamente; caso
  contrário, mostrar o texto no chat.

## O que cada skill faz aqui

**`/triage` "o que precisa de atenção"**: ler `User history` e `Tarefas` do
Back Log, mais os cartões `needs-info` com comentário posterior às Triage Notes.
Apresentar os três grupos, mais antigo primeiro.

**`/triage` num cartão**: ler descrição e comentários, procurar no código se já
existe, fazer grill se precisar. Ao final:
- `ready-for-agent` / `ready-for-human`: reescrever a descrição no formato
  🎯/🧩/✅, mover para `Tarefas Documentadas`, anexar etiqueta se for agente.
- `needs-info`: comentar Triage Notes, anexar etiqueta `needs-info`.
- `wontfix`: comentar o motivo e arquivar. Se já existe no código, apontar onde.
  Se foi rejeitado como melhoria, registrar em `.out-of-scope/` neste repositório.

**`/to-spec`**: a spec vira a descrição do cartão pai. Se passar de 2048
caracteres, salvar em `docs/<slug>.md` neste repositório e linkar no cartão.

**`/to-tickets`**: cada fatia vertical vira um cartão filho em
`Tarefas Doc/Precificadas`, já pontuado, com etiqueta `ready-for-agent`, e as
linhas `Parte de: <link do pai>` e `Bloqueado por: <links>` no topo da
descrição (ou `Bloqueado por: nenhum`). O Trello não tem bloqueio nativo, fica
em texto. Publicar na ordem de dependência, bloqueadores primeiro, para que os
links existam. Não mexer no cartão pai.

**`/implement`**: o usuário passa o link do cartão em `Em andamento`.
Implementar, rodar typecheck e testes, e ao terminar mover para `Em teste`
com um comentário do que foi feito e como validar. `Concluido` é do usuário.

**`/wayfinder`**: o **mapa** é um cartão pai no Back Log com a descrição
Notes / Decisions-so-far / Fog. Cada **filho** é um cartão `Módulo: <pergunta>`
com o tipo entre colchetes no início (`[research]`, `[prototype]`,
`[grilling]`, `[task]`) e `Parte de:` apontando para o mapa.
- **Blocking**: `Bloqueado por: <links>` no topo da descrição do filho.
- **Frontier**: filhos em `Tarefas Doc/Precificadas` sem bloqueio pendente.
- **Claim**: mover o filho para `Em andamento` no Sprint.
- **Resolve**: comentar a resposta no filho, mover para `Em teste`, e
  acrescentar gist + link em Decisions-so-far no mapa.

## Quando uma skill disser "buscar o ticket"

O usuário passa o link ou o título do cartão. Ler com `trelloReadCard`; se
passar só o título, procurar com `trelloSearch` no workspace "Ac Acessórios".

## PRs como superfície de pedidos

Desligado. Pull requests não entram na fila de triagem.
