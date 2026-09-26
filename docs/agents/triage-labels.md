# Triage Labels

As skills falam em cinco papéis de triagem. Aqui as listas do Trello carregam
o estado (ver `issue-tracker.md`), então só dois papéis viram etiqueta.

| Label in mattpocock/skills | Etiqueta no Trello | Significado                                   |
| -------------------------- | ------------------ | --------------------------------------------- |
| `needs-triage`             | (nenhuma)          | Está em `User history` ou `Tarefas` sem etiqueta |
| `needs-info`               | `needs-info`       | Aguardando mais informação de quem pediu      |
| `ready-for-agent`          | `ready-for-agent`  | Documentado, pronto para o agente             |
| `ready-for-human`          | (nenhuma)          | Está em `Tarefas Documentadas` ou `Doc/Precificadas` sem `ready-for-agent` |
| `wontfix`                  | (nenhuma)          | Cartão arquivado com comentário do motivo     |

Categoria: `bug` = título `Módulo: Hotfix - ...`; `enhancement` = o resto.

Crie as etiquetas `needs-info` e `ready-for-agent` uma vez, manualmente, no
quadro Sprint Back Log. O conector só anexa etiquetas que já existem.
