# Evidências de entrega — 24/10/2026

## Build e integração

`npm run build` passou em TypeScript e Vite, sem warnings. O bundle público foi auditado por `scripts/check-public-bundle.mjs` e `tests/e2e/check-static.mjs`: 11 arquivos, sem URL, senha ou endpoint de banco, e sem os nomes da escala nominal.

Suíte de integração: **65/65 passaram**, 0 falhas, em cerca de 3,81 s. Inclui 36 testes backend, 19 de revisão/consolidação e 10 do handler Netlify real. O comando e a matriz estão em `docs/test-plan.md`. Os três bancos são locais e isolados; URLs remotas são recusadas pelos testes.

Navegador: **14/14 passaram**, 0 skips, em cerca de 1,3 minuto. Foram testados Chromium desktop e viewport móvel de 390×844, com 20 capturas privadas inspecionadas. O plano e os fluxos estão em `docs/ui-test-plan.md`.

## Neon e Netlify reais

A migração de 13 tabelas e a importação foram testadas na branch Neon `escala-validation-20261024` antes da produção. A produção recebeu os mesmos 84 cadastros conservadores, 102 grupos de turno e 1.306 participações únicas. Cinco linhas duplicadas não contam duas vezes. Total de horas planejadas: 7.657.

O papel `amil_escala_runtime` foi testado: SELECT da escala permitido; CREATE TABLE e UPDATE da auditoria recusados com `42501`. Migrações usam conexão administrativa direta. O runtime usa conexão pooled com transações WebSocket.

O script `scripts/verify-deployment.mjs` passou em **17 verificações** pela URL de validação Netlify, usando banco e credencial de runtime reais:

```
PASS Neon connection through Netlify Function
PASS Anonymous schedule access denied
PASS HTTPS frontend and security headers
PASS Owner and doctor login with secure session cookies
PASS Imported schedule counts: 102 groups / 1306 assignments
PASS Doctor administrative mutation denied
PASS Shift creation through restricted runtime DB role
PASS Offer transfer and repeated acceptance protection
PASS Doctor report counts transferred shift and date
PASS Transfer origin, destination and actor persisted
PASS Monthly CSV export
PASS Closed month blocks changes
PASS Owner reopening with audit reason
PASS Import review is administrative
PASS Invitation activation end to end; single use enforced
PASS Existing linked doctor cannot receive a duplicate account
PASS Logout invalidates server session
```

As contas e os plantões fictícios existem somente na validação temporária. O acesso inicial do proprietário em produção permanece como convite pessoal de uso único, para escolha de sua própria senha. O convite não é ativado pelos testes.

## Falhas encontradas e corrigidas

- Parâmetro SQL sem tipo no rate-limit, que impedia login/ativação.
- Corpo JSON do adaptador serverless-http ignorado pelo parser do Express 5 em streams já finalizados. Normalização explícita, limite de 100 KiB e regressão nos eventos Lambda JSON/base64.
- Escopos granulares de variáveis recusados pelo plano Netlify. A configuração padrão do projeto foi autorizada pelo proprietário e persistida pelo endpoint oficial, com verificação posterior.
- Contexto do alias Netlify de validação resolvido como branch-deploy: valores específicos da branch foram configurados.
- Arquivos privados acessíveis pelo servidor Vite de desenvolvimento. A configuração agora bloqueia esses caminhos e preserva as regras padrão; sete URLs privadas recebem 403 em regressão automatizada.
- Textos com baixo contraste e tamanho reduzido. Fontes e cores ajustadas, depois revalidadas em desktop e celular.
- Testes repetidos atingiram o rate-limit local; o setup da suíte limpa somente as chaves das fixtures em banco local, sem reduzir a proteção da aplicação.

## Limites e pendências da fonte

A escala importada tem 15 turnos sinalizados e 13 questões de conferência: seis pares de nomes, cinco duplicatas, horário de reforço e cobertura de 14/10 à noite. Foram preservados para decisão humana. O fechamento fica bloqueado até a conferência. Nenhuma identidade foi fundida automaticamente.

Relatórios expressam escala vigente; não comprovam comparecimento ou pagamento. Convites/recuperação geram link para compartilhamento manual, sem envio automático de e-mail. A sessão interna Soffia foi disponibilizada pelo usuário, mas a navegação via captura do Chrome encontrou falha do serviço de captura; a referência utilizada incluiu a tela fornecida e o material público consultado.

A configuração do MCP Neon está instalada/habilitada, com OAuth independente ainda não autenticado nesta sessão; todas as operações de infraestrutura foram concluídas pelo CLI autenticado. Consulte `docs/neon-setup.md` para o inventário e o registro das alterações.

## Verificação do site principal

Após a publicação, `node scripts/verify-deployment.mjs https://amil-escala.netlify.app` passou: Function conectada ao Neon, escala protegida sem autenticação e frontend HTTPS com os cabeçalhos de segurança esperados. O convite de proprietário foi conferido no banco por hash: papel `owner`, destinatário confirmado pelo usuário, validade até 31/10/2026 às 14:40 (America/Fortaleza) e ainda não utilizado. Não há contas fictícias em produção.

O repositório inclui workflow de CI para compilar e executar as 65 verificações de integração com três bancos PostgreSQL isolados. Testes de navegador permanecem reproduzíveis localmente com os arquivos privados descritos no plano de UI.
