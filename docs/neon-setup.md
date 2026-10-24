# Auditoria de configuração Neon — 24/10/2026

Skill oficial consultada: https://neon.com/.well-known/agent-skills/neon/SKILL.md

## Inventário verificado

- Neon CLI 8.11.1 instalado; autenticação concluída com autorização do proprietário.
- Skills globais presentes: neon, neon-postgres, neon-postgres-branches, neon-auth, neon-functions, neon-object-storage, neon-ai-gateway, neon-realtime, neon-postgres-egress-optimizer.
- O conteúdo da skill `neon` instalada é idêntico ao conteúdo obtido no endereço oficial nesta auditoria.
- Plugin `neon-postgres@plugins-cli` habilitado no Codex.
- Servidor MCP `neon` já configurado e habilitado, transporte streamable HTTP, URL https://mcp.neon.tech/mcp. A autenticação OAuth do MCP é independente da autenticação do CLI; `codex mcp list` informou `not_logged_in`. O CLI autenticado foi usado para a implantação. As ferramentas MCP Neon não estão carregadas nesta sessão do chat.
- `.neon` aponta ao projeto fornecido `little-haze-73415000`, organização `org-broad-dust-86756821`, branch `production`.
- `neon.ts` já declara a política Postgres do projeto e foi preservado.

## Alterações e comandos

Na configuração inicial solicitada foram instalados Neon CLI, plugin/skills e MCP pelos comandos oficiais `npm i -g neon@latest` e `neon init -y ... --services postgres`. O init registrou o plugin para Codex/Claude/Cursor e skills/MCP em agentes compatíveis existentes. Não foram adicionadas cópias de configuração por projeto porque o plugin global já fornece as skills e o MCP; essa duplicação é desaconselhada pela própria skill.

Nesta nova auditoria nenhuma skill, servidor ou configuração de agente foi substituída. A skill oficial foi baixada para `private/neon-current-SKILL.md`, fora do Git. A configuração Codex foi lida apenas para inventário sem expor tokens. SHA-256 do config.toml no início da auditoria: `45a758baa72a1b8b343531522b4b635d2cb27a246b3fc2b969dd628c414d187e`.

`neon deploy` concluiu:

```
Applying to branch production (br-shiny-shape-b4w5kx6j)
No changes — branch production already matches the policy.
Utilized services: Postgres
Pulled 3 Neon variables into .env.local
Postgres DATABASE_URL, DATABASE_URL_UNPOOLED
Branch NEON_BRANCH
```

O ambiente local de testes foi preservado antes do pull em arquivo privado separado. As credenciais não são versionadas nem enviadas no bundle do frontend. O driver `@neondatabase/serverless` com WebSocket é usado para transações no Netlify; migrações usam conexão direta.

Uma branch temporária de validação foi criada antes da produção: `escala-validation-20261024` / `br-royal-rice-b4nuc800`, com expiração automática em 25/10/2026 às 10:07 (America/Fortaleza). O banco de produção estava vazio. Migrações e importação foram testadas nessa branch antes de aplicar na produção. Não foi criado outro projeto cloud, nem ativado Auth, Data API, Functions ou Gateway do Neon; a autenticação já implementada na aplicação foi preservada.

## Migração e publicação

Migração e importação completas foram verificadas primeiro na branch temporária e depois aplicadas em `production`: 13 tabelas do schema `escala`, 84 cadastros, 102 grupos de turno e 1.306 participações únicas. O registro de importação guarda SHA-256 e pendências; nova execução com o mesmo arquivo é idempotente. O proprietário autorizou explicitamente o banco/branch, a publicação e o convite inicial para sua conta.

Foi criado o papel `amil_escala_runtime`, sem privilégio de criar tabelas ou alterar a auditoria. Os testes com esse papel confirmaram leitura da escala e recusa PostgreSQL `42501` ao tentar DDL ou UPDATE da auditoria. A conta administrativa é usada somente nas migrações/importação.

O plano Netlify atual recusou escopos granulares de ambiente (API `403`). A autorização do proprietário para os escopos padrão do projeto, incluindo build e Functions, foi obtida antes de guardar a credencial. `DATABASE_URL`, `APP_URL` e `NODE_ENV` foram configurados com valores separados para produção e branch `validacao`, preservando os demais valores. A persistência foi verificada pelo endpoint oficial; os valores não foram impressos. O bundle público foi inspecionado para garantir ausência de URL, senha e endpoint de banco. Essa configuração não equivale à marca `is_secret` nem ao isolamento exclusivo de Functions, recursos não utilizados neste plano.

Falhas corrigidas durante a validação: o CLI `env:set` não persistia a configuração granular recusada; foi utilizado o endpoint oficial de variáveis, com confirmação de leitura após escrita. O alias de preview usa contexto de branch no runtime, portanto recebeu valores específicos de `validacao`. O adaptador serverless-http/Express 5 precisou normalizar explicitamente o JSON bruto nas requisições Lambda; a correção tem testes próprios e foi verificada no preview antes da publicação principal.
