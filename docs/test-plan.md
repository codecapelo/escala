# Verificação automatizada do backend

Suítes: `tests/backend.test.mjs`, `tests/review.test.mjs` e `tests/adapter.test.mjs`, executadas com `node:test` e PostgreSQL real. Backend e revisão usam a aplicação Express completa e HTTP real em porta efêmera; o adapter invoca diretamente o `handler` exportado em `netlify/functions/api.mjs` com eventos Lambda, passando pelo `serverless-http` real. Não dependem do PDF, do importador ou dos dados da aplicação. Cada caso recebe fixtures próprias de proprietário, administrador e médicos; a suíte de revisão também cria importações sintéticas com pendências.

## Execução e isolamento

```sh
TEST_DATABASE_URL=postgresql://escala_test@127.0.0.1:55432/escala_tests \
TEST_REVIEW_DATABASE_URL=postgresql://escala_test@127.0.0.1:55432/escala_tests_review \
TEST_ADAPTER_DATABASE_URL=postgresql://escala_test@127.0.0.1:55432/escala_tests_adapter \
npm test
```

Os três bancos precisam existir. As suítes aplicam `server/schema.sql` e `server/review-schema.sql` e limpam exclusivamente suas tabelas de fixtures antes de cada caso. O guard inicial aceita somente host local e nomes de banco explicitamente de testes. A revisão usa `escala_tests_review` ou `escala_tests_review_<sufixo>`; o adapter usa `escala_tests_adapter` ou `escala_tests_adapter_<sufixo>`, separadamente do backend (`escala_tests` ou `escala_tests_<sufixo>`), permitindo executar os arquivos em paralelo.

Se `TEST_DATABASE_URL` não for informado, o backend utiliza o endereço local de `DATABASE_URL`, substituindo obrigatoriamente o nome do banco por `escala_tests`. A revisão e o adapter derivam seus nomes de banco do endereço local de `TEST_DATABASE_URL` ou `DATABASE_URL`, a menos que suas URLs próprias sejam explícitas. Sem configuração, usam o host do exemplo. Uma URL remota é recusada antes de abrir conexão; portanto, quando `.env.local` aponta para a aplicação Neon, é obrigatório informar URLs locais como no comando acima. Essa recusa foi observada na validação. `DATABASE_URL_UNPOOLED` é removida dentro dos processos de testes. Não execute duas instâncias contra o mesmo banco de testes simultaneamente.

Na validação de 24/10/2026 foram usados os bancos locais `escala_tests`, `escala_tests_review` e `escala_tests_adapter`. O primeiro foi criado e migrado com `scripts/migrate.mjs`; as suítes também aplicam os dois arquivos SQL de forma idempotente. O banco da aplicação não foi limpo pela suíte.

## Casos cobertos

| Área                       | Evidência automatizada                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autenticação               | Hash de senha real, erro uniforme para e-mail inexistente/senha errada, cookie `HttpOnly`/`SameSite=Lax`, ausência de hash na resposta, logout e limitação após dez falhas                                    |
| Ativação                   | Token armazenado por hash, validade/revogação, uso único sequencial e concorrente, papel forjado no corpo ignorado                                                                                            |
| Papéis                     | Médico impedido de editar escala, médicos, equipe e fechamento; administrador impedido de criar/alterar/revogar acesso superior; proprietário protegido contra desativação e rebaixamento                     |
| Convites                   | Médico inativo ou já vinculado recusado; administrador não substitui convite superior pelo vínculo médico, mesmo usando outro e-mail                                                                          |
| Sessões                    | Troca de senha revoga demais sessões; recuperação revoga todas as antigas; mudança de papel revoga sessões e links de recuperação pendentes; médico inativo perde acesso                                      |
| Escala                     | Criação com múltiplos médicos e repetição, deduplicação, rollback de lote, edição/adicionar participante com checagem de conflitos                                                                            |
| Validação                  | Datas impossíveis, mês inválido, horários inválidos/iguais, UUID inválido, repetição acima do limite, médico inativo e conteúdo diferente de JSON                                                             |
| Intervalos                 | Sobreposição no mesmo dia e após meia-noite; horários adjacentes permitidos; médicos distintos podem ocupar o mesmo intervalo                                                                                 |
| Concorrência               | Duas criações sobrepostas produzem um sucesso; dois médicos disputando oferta produzem exatamente um vencedor e uma auditoria; fechamento competindo com nova oferta preserva o estado consistente            |
| Fechamento                 | Bloqueia criação/edição/cancelamento, participantes e ofertas; verifica mês de origem e destino; revisão importada e ofertas abertas impedem fechar; reabrir exige proprietário e motivo                      |
| Repasses                   | Plantão permanece com origem até aceite; médico não impersona destino; administrador indica destino; duplicidade, autoaceite, passado, médico inativo, conflito e oferta desatualizada recusados              |
| Auditoria                  | Transferência registra origem, destino e ator; `UPDATE` e `DELETE` recusados no PostgreSQL; médico vê somente eventos relacionados a si                                                                       |
| Relatórios                 | Totais de plantões/participações/horas; médico recebe apenas sua linha e seu CSV; CSV neutraliza prefixos de fórmula e escapa aspas                                                                           |
| Origem da requisição       | Origem externa, domínio com sufixo malicioso e `Sec-Fetch-Site: cross-site` recusados; origem configurada aceita                                                                                              |
| Revisão de importação      | Rotas integradas com sessão/cookie real, acesso administrativo, IDs remapeados, nota validada, resolução idempotente e concorrente, resumo original preservado                                                |
| Fechamento após importação | Pendência no `summary.month` bloqueia o mês mesmo sem plantão sinalizado; resolver libera essa pendência, mas não remove `shifts.needs_review` automaticamente                                                |
| Consolidação               | Preserva origem e histórico; deduplica participações iguais; relatório conta somente o canônico; bloqueia CRM divergente, duas contas, destino inativo, acesso superior, mês fechado e intervalos sobrepostos |
| Identidade consolidada     | Bloqueia reativação, novos plantões, atribuições e convites; mantém proteção mesmo simulando por SQL uma flag `active` antiga inconsistente; conserva cadeias de consolidação                                 |
| Acesso após consolidação   | Transfere conta sem mudar papel, revoga sessão/convites antigos e permite novo login com as mesmas credenciais no médico canônico; duas fusões concorrentes têm um único vencedor                             |
| Privacidade da importação  | Médico não acessa revisão nem metadados nominais globais `pdf_imported` pelo audit/dashboard; administrador mantém acesso                                                                                     |
| Adapter Netlify real       | Login JSON simples/base64 em `/api/auth/login` e `/.netlify/functions/api/auth/login`; cookies `Secure`/`HttpOnly`/`SameSite` reutilizados em `/auth/me`; GET com parâmetro de mês e cookie                   |
| Corpo no serverless        | JSON malformado retorna 400; limite de 100 KiB retorna 413 sobre bytes decodificados, inclusive base64 e Unicode; arrays no POST e booleanos no PATCH chegam ao PostgreSQL                                    |
| IP da plataforma           | `NETLIFY=true` usa buckets distintos para o header da plataforma; HTTP fora desse ambiente ignora headers Netlify e `X-Forwarded-For` forjados                                                                |

O teste de mês fechado insere por SQL uma oferta aberta depois do fechamento para verificar a defesa contra registros antigos inconsistentes: o fluxo normal impede fechar com oferta aberta. O teste de origem desatualizada também altera por SQL o participante para verificar a validação no momento do aceite. Esses cenários não representam operações autorizadas pela interface.

## Resultado registrado

Validação inicial: **35 testes passaram, 0 falharam**, em aproximadamente 3,37 s. A primeira execução detectou erro real no SQL de limitação de tentativas (`42P18`, parâmetro sem tipo), que afetava login e ativação. A consulta foi corrigida pelo responsável pelo backend e toda a suíte foi executada novamente.

Após integrar revisão e consolidação, as duas suítes passaram com os bancos locais explícitos: **54 testes, 54 passaram, 0 falharam**, em aproximadamente 3,42 s. O conjunto inclui os dez cenários originais do módulo de revisão, agora executados contra a aplicação autenticada completa, e nove cenários adicionais. O guard recusou corretamente uma execução sem URL de teste quando `.env.local` já apontava para Neon. A limpeza das fixtures de revisão inclui explicitamente os plantões, evitando que revisões pendentes de uma execução interfiram na próxima.

Resultado atual após correção do parsing de `Buffer` no ambiente serverless: **65 testes, 65 passaram, 0 falharam**, em aproximadamente 3,81 s — 36 de backend, 19 de revisão e 10 do adapter. Os eventos de teste passam pelo handler exportado e pelo adaptador instalado, sem simular o parser ou a autenticação. A validação inclui a separação de IP da plataforma e a rejeição de headers forjados fora do Netlify.

## Limites da evidência

Os testes validam este backend e o adaptador instalado no PostgreSQL local. O cookie `Secure` é verificado com `NODE_ENV=production` nos testes do handler; não atestam a implantação real, certificados TLS, configuração da plataforma, restauração de backups, resistência a carga, entrega de e-mail ou comportamento visual do navegador. O isolamento por banco é um guard operacional da suíte; a auditoria append-only protege contra `UPDATE`/`DELETE` comuns, não contra um administrador do banco capaz de alterar o esquema ou desabilitar triggers. A revisão humana do PDF e a conciliação das importações exigem verificações próprias.
