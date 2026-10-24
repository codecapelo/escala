# Revisão de importação e consolidação de cadastros

Este módulo acrescenta três rotas administrativas, sem substituir autenticação, proteções de origem/JSON ou tratamento de erros do servidor. Não edita `server/app.mjs` nem `server/schema.sql`.

## Integração

1. Executar `server/review-schema.sql` depois de `server/schema.sql`, na mesma migração transacional. O migrador atual precisa incluir o novo arquivo; importar o router sozinho não cria tabelas.
2. Em `server/app.mjs`, importar `reviewRouter` de `./review.mjs` e executar `app.use('/api',reviewRouter)` depois do middleware autenticado que preenche `req.user` e antes do handler 404 de `/api`.
3. `req.db` deve ser uma conexão PostgreSQL dedicada à requisição. O router usa o helper `transaction` e o mesmo advisory lock das outras mutações; não deve receber apenas um pool compartilhado como conexão transacional.
4. A interface deve recarregar dashboard, lista de médicos, revisão e relatório depois da consolidação. Se `reauthentication_required` for verdadeiro, voltar ao login.

Exportações: `reviewRouter` e `default` apontam para o mesmo Express Router. Dependências: Express, Zod e os helpers locais existentes.

## GET `/api/imports/review`

Acesso: `owner` ou `admin`; médico recebe 403. Retorna:

```ts
{
 imports: Array<{
  sha256: string, filename: string, imported_at: string,
  summary: object // resumo original, exceto uncertainties
 }>,
 issues: Array<{
  ...originalIssue,
  id: string, // sha256 + ':' + id original da pendência
  source_issue_id: string,
  sha256: string, filename: string, imported_at: string,
  resolved: boolean,
  resolution: null | {
   issue_id: string, resolved_at: string,
   resolved_by: string, resolved_by_name: string, note: string
  }
 }>,
 doctors: Array<{
  id: string, name: string, active: boolean, crm: string | null,
  user_id: string | null, merged_into_id: string | null
 }>,
 counts: {total: number, pending: number, resolved: number}
}
```

As pendências vêm de `escala.imports.summary.uncertainties`; `doctorIds` e `doctorId` já devem conter os UUIDs remapeados pelo importador. A leitura não modifica o resumo original. `merged_into_id` permite mostrar ao administrador que uma variante foi consolidada; consolidações sucessivas podem formar uma cadeia, que deve ser seguida até o cadastro ativo. A origem permanece na lista como inativa para manter a referência documental.

## POST `/api/imports/review/:id/resolve`

Acesso: `owner` ou `admin`. `:id` é o identificador composto retornado pelo GET, com codificação de componente de URL quando necessário.

Corpo: `{ "note": "Conferido com o cadastro e validado pela coordenação." }`.

A nota deve ter de 3 a 1.000 caracteres após remover espaços externos. A pendência deve existir no resumo da importação indicada. Retorna 200:

```ts
{
 ok: true,
 already_resolved: boolean,
 resolution: {
  issue_id: string, resolved_at: string, resolved_by: string, note: string
 }
}
```

A primeira decisão é persistida em `escala.import_reviews` e gera evento append-only `import_issue_resolved`. Repetições retornam a primeira decisão, sem alterar nota, autoria ou data e sem duplicar o evento. Uma nota diferente em tentativa repetida também não substitui a primeira.

Resolver registra uma decisão humana sobre a pendência; não funde médicos nem altera horários, participações ou `shifts.needs_review`. O administrador deve corrigir os cadastros/plantões necessários e liberar a revisão dos plantões pelo fluxo existente. Não há atualização ou exclusão de resoluções nesta versão.

## POST `/api/doctors/:id/merge`

Acesso: `owner` ou `admin`. O parâmetro identifica o cadastro de origem que será inativado; `target_id` identifica o cadastro canônico que permanecerá ativo.

```json
{
  "target_id": "UUID do cadastro canônico",
  "reason": "Mesma médica, identidade confirmada no cadastro."
}
```

`reason` exige de 3 a 1.000 caracteres. O nome, CRM, especialidade e cor do destino são preservados. Caso seja preciso corrigir o nome ou acrescentar CRM, usar também o endpoint existente de edição do cadastro. Valores diferentes e preenchidos de CRM bloqueiam a consolidação até que a identidade seja conferida e corrigida.

A operação é atômica e usa o mesmo lock de mutação da escala. Aplica estas regras:

- Dois UUIDs diferentes e existentes; destino ativo e ainda não consolidado; origem ainda não consolidada. Uma origem previamente inativada por outro motivo pode ser consolidada.
- Administradores somente podem tocar contas e convites de médicos. Se qualquer uma das duas identidades estiver vinculada a conta ou convite administrativo/proprietário, apenas o proprietário pode prosseguir. A função da conta vinculada nunca muda.
- Duas contas vinculadas, mesmo inativas, bloqueiam a operação. O proprietário deve resolver os vínculos pelo gerenciamento de acessos antes de consolidar.
- Com apenas uma conta vinculada à origem, transfere `users.doctor_id` para o destino e encerra todas as sessões dessa conta. A conta pode entrar novamente com as mesmas credenciais. Conta já vinculada ao destino permanece como está.
- Revoga convites pendentes ainda não usados dos dois cadastros, inclusive recuperação de senha, evitando ativação tardia da identidade antiga ou um segundo vínculo. Convites expirados e ainda não revogados também são encerrados. Novos convites podem ser gerados depois.
- Qualquer mês fechado contendo participação a transferir ou oferta aberta a cancelar impede toda a operação com `MONTH_LOCKED`. Não existe bypass por função: o proprietário precisa reabrir o mês pelo fluxo de fechamento existente.
- Intervalos de turnos distintos da união das duas agendas não podem sobrepor, inclusive ao atravessar meia-noite. Horários apenas adjacentes são permitidos. O mesmo `shift_id` em ambos os cadastros é uma única participação e pode ser deduplicado. Uma sobreposição já existente dentro de uma das agendas também exige correção antes da fusão.
- Cada participação ativa da origem recebe `removed_at`; uma nova participação é criada para o destino, exceto quando ele já participa do mesmo turno. Participações removidas anteriormente permanecem intactas. Turnos cancelados não causam conflito de horários; suas participações ainda ativas são consolidadas e seus meses continuam sujeitos ao fechamento.
- Cancela ofertas abertas da origem, dirigidas à origem ou vinculadas a participação atualmente da origem. Ofertas aceitas/canceladas, seus `from_doctor_id`, `to_doctor_id` e participações antigas não são reescritos.
- Inativa a origem, preservando seu registro, nome, CRM e `source_key`. Guarda a relação origem/destino em `escala.doctor_merges` e um evento append-only `doctors_merged`, com snapshots, motivo, mapeamento de participações, IDs de ofertas/convites e contagens.

Retorna 200:

```ts
{
 ok: true,
 merge: {
  source_doctor_id: string, target_doctor_id: string,
  source_name: string, target_name: string, reason: string,
  merged_by: string, merged_at: string
 },
 affected: {
  assignments_retired: number,
  assignments_created: number,
  duplicate_memberships_removed: number,
  offers_cancelled: number,
  invites_revoked: number,
  users_transferred: number,
  sessions_revoked: number
 },
 affected_months: string[],
 reauthentication_required: boolean
}
```

O relatório existente passa a contar as participações transferidas no destino porque lê somente participações ativas. A origem passa a ter zero participações ativas, sem duplicar horas. Eventos históricos de trocas continuam citando as identidades originais; o novo evento de consolidação explica a relação e inclui as duas identidades em `related_doctors`. A consolidação não marca automaticamente a pendência de importação como resolvida: o administrador registra também a nota de revisão.

Não há exclusão de cadastro ou reescrita dos logs. Não há desfazer automático: o mapeamento de IDs e snapshots permite uma eventual correção administrativa transacional após revisar eventos posteriores. Não se deve simplesmente reativar a origem sem redistribuir participações e revisar acessos.

## Erros

Formato do servidor: `{error: string, code?: string}`. Validação de corpo/UUID: 400; sem sessão: 401; função insuficiente: 403; inexistente: 404; conflito de estado/agenda: 409. O tratamento global existente converte erros Zod e de integridade.

| Código                  | Significado                                              |
| ----------------------- | -------------------------------------------------------- |
| `ISSUE_NOT_FOUND`       | Pendência não pertence à importação indicada             |
| `SAME_DOCTOR`           | Origem e destino iguais                                  |
| `DOCTOR_NOT_FOUND`      | Cadastro inexistente                                     |
| `DOCTOR_ALREADY_MERGED` | Origem já consolidada                                    |
| `TARGET_INACTIVE`       | Destino inativo                                          |
| `TARGET_ALREADY_MERGED` | Destino já aponta para outro cadastro                    |
| `CRM_MISMATCH`          | CRMs preenchidos e diferentes                            |
| `SUPERIOR_ACCESS`       | Administrador tentou modificar vínculo/convite protegido |
| `TWO_LINKED_USERS`      | Duas contas vinculadas                                   |
| `MONTH_LOCKED`          | Um mês afetado está fechado                              |
| `OVERLAP`               | Turnos distintos sobrepostos na agenda combinada         |

## Verificação realizada

Dez testes de integração passaram em PostgreSQL local isolado `escala_tests_review`, sem usar o banco da aplicação: acesso administrativo, notas e persistência idempotente; validação/CRM; deduplicação e relatório; transferência de conta e revogação de sessões/convites; preservação de trocas históricas; duas contas; proteção de proprietário/administrador; convite superior; fechamento mensal com rollback; conflito cruzando meia-noite/intervalos adjacentes; e duas requisições de consolidação concorrentes. A sintaxe do módulo foi conferida com `node --check`.
