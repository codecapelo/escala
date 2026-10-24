# Verificação da interface com Playwright

Data de referência: 24/10/2026. A suíte usa Chromium próprio do Playwright, sem abrir Chrome pessoal, navegador do usuário ou serviços externos. Todos os fluxos passam pela interface React, API Express e PostgreSQL local reais; não há mocks ou interceptação de respostas.

## Execução segura e reproduzível

```sh
npx playwright install chromium
npm run test:e2e
# Depois de npm run build, conferir o conteúdo público:
node tests/e2e/check-static.mjs
```

Pré-requisitos privados, fora do Git:

- `private/local.env` com `DATABASE_URL` apontando para PostgreSQL em `127.0.0.1`, `localhost` ou `[::1]`. O banco deve estar migrado, incluindo o esquema de revisão, e conter a importação de outubro de 2026.
- `private/local-test-accounts.json` com `{password, owner:{id,email}, doctors:[{id,name,email},{id,name,email}]}`. Os IDs de `doctors` são os IDs dos cadastros médicos. A conta owner e as duas contas médicas devem estar ativas; as duas contas médicas usam a senha privada indicada no arquivo.
- Portas locais 3101 e 5273 livres. A suíte inicia e encerra seus próprios servidores nessas portas. Não depende dos processos existentes em 3001/5173.

`tests/e2e/local-server.mjs` lê exclusivamente `private/local.env`, sobrescreve URLs de banco herdadas e recusa banco remoto. Nunca lê `.env.local`, que pode apontar para Neon. A configuração Vite dos testes reutiliza a configuração principal e sua política de bloqueio de arquivos, mudando apenas portas e proxy. O primeiro cenário exige HTTP 403 antes do login para arquivos de `private/`, `data/`, auditoria PDF e variantes absolutas `/@fs/Users/test/escala/...`. Os helpers repetem a validação de host local antes das preparações SQL de pendência sintética e contadores temporários de throttle. Não existe configuração de URL de produção na suíte.

A interface mantém a data do navegador em 24/10/2026 para tornar as capturas e navegação reproduzíveis; timers normais continuam funcionando. Plantões de teste são criados em novembro de 2026. Essa escolha acompanha o snapshot importado e deve ser atualizada quando esse período deixar de ser futuro no servidor. A proteção do backend contra repasses passados continua ativa.

## Cobertura persistida

São sete histórias, executadas em duas configurações: desktop 1440×1000 e celular 390×844. Os projetos usam Chromium; o projeto celular usa emulação de toque e a viewport indicada. Janelas secundárias dos fluxos de convite e repasse também recebem a viewport do projeto.

| História                       | Evidências verificadas                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Importação e escala            | Login real; 102 grupos de turnos e 1.306 participações; lista com 102 itens; filtro de médico e manhã; calendário; mudança de mês; nenhum erro JavaScript não tratado no fluxo; sem overflow global                           |
| Relatório, CSV e perfil        | Totais de 102 turnos/1.306 participações; filtro e expansão de médico; download CSV real com nomes e cabeçalho; perfil; validação de senhas divergentes sem modificar credenciais existentes                                  |
| Gestão de plantões             | Criação pela UI com repetição em duas datas; edição de observação; confirmação com motivo; remoção e inclusão de profissional; trilha de auditoria                                                                            |
| Repasse entre médicos          | Médico de origem oferece pela UI; outro médico entra em contexto separado e aceita; cartão assumido mostra os dois nomes; histórico mostra origem/destino; API confirma a responsabilidade no destino                         |
| Convite e ativação             | Owner gera convite pela UI; nova pessoa define a própria senha no formulário; login/perfil e logout funcionam; reutilizar o mesmo convite é rejeitado                                                                         |
| Navegação e conferência do PDF | Equipe, relatórios, histórico, repasses e conferência; quantidade de pendências comparada com API; origem/SHA-256 exibidos; modal de conferência; sem resolver pendências reais automaticamente                               |
| Consolidação e decisão humana  | Dois médicos fictícios e uma pendência sintética; UI exige motivo e confirmação; fusão mantém destino e inativa origem; participação repetida não duplica relatório; nota de conferência persiste e aparece na aba Conferidas |

As verificações de teclado cobrem foco inicial, Shift+Tab e Tab circulando dentro do modal, Escape, restauração do foco ao acionador e Escape fechando somente a confirmação superior quando há dois modais.

A checagem de overflow compara a largura do documento com a viewport em páginas, calendário, relatórios e formulários. Tabelas e calendário podem ter rolagem interna intencional. A checagem não substitui uma auditoria completa de acessibilidade nem testes em aparelhos físicos.

## Isolamento das fixtures

Cadastros, unidades, notas e e-mails de teste têm prefixo único `E2E-...`. A preparação usa a API administrativa local. O teste de revisão acrescenta apenas uma entrada `imports` sintética identificada pelo mesmo prefixo; nunca altera o resumo importado do PDF real.

Antes da suíte, `global-setup.ts` limpa somente os contadores temporários de throttle das contas de teste e IPs de loopback, no banco local validado. Isso evita que várias reexecuções de QA consumam a janela IP de 120 logins/15 minutos. A proteção do aplicativo não é relaxada, e seu bloqueio 429 foi observado durante a validação.

Ao terminar cada teste de escrita, a fixture cancela logicamente seus turnos, revoga convites pendentes e inativa suas contas/cadastros. Não apaga cadastros, ofertas aceitas ou auditoria. Pendências sintéticas conferidas e registros de auditoria permanecem como evidência local. As 1.306 participações e as seis pendências reais de identidade do PDF são preservadas; nenhum par real é unido por decisão de um teste automatizado.

## Artefatos privados

- Capturas intencionais: `private/screenshots/`, com prefixo do projeto e sufixos `login`, `calendar`, `shift-form`, `reports`, `shift-detail`, `accepted-offer`, `activated-profile`, `pdf-review`, `merge-form` e `review-resolved`.
- Relatório HTML: `private/playwright-report/index.html`.
- Traces, erros e capturas de falha: `private/playwright-results/`.

As capturas podem conter nomes do PDF, e-mails locais e decisões fictícias. Toda a pasta `private/` já é ignorada pelo Git. Screenshots usam scroll zerado e animações desabilitadas. Celular e modais são capturados na viewport para preservar legibilidade; páginas desktop sem modal usam página inteira. Credenciais e links pessoais de ativação não são copiados para os arquivos de teste versionados. Traces e snapshots de falha podem registrar valores digitados, inclusive credenciais das fixtures; esses artefatos permanecem dentro de `private/`.

## Resultado e limites

Execução final consolidada: **14 testes passaram em 1,3 minuto**, sem falhas ou testes ignorados, em 24/10/2026. O relatório privado contém o resultado por história e projeto. Reexecutados após o polimento de fontes, contraste e cartões mobile: todos os 14 fluxos continuaram verdes e as checagens não detectaram novo overflow. Nenhum código de `src/` ou `server/` foi alterado pela implementação dos testes. Não foram testados Safari/WebKit, Firefox, aparelhos físicos, provedores de e-mail, desempenho sob carga nem infraestrutura de produção; a suíte testa o produto local completo nos cenários acima.

Foi identificado e corrigido um vazamento no servidor de desenvolvimento: o Vite inicialmente servia arquivos privados por URL direta. A correção principal foi aplicada fora do escopo dos arquivos de teste e verificada tanto no servidor principal 5173 quanto no servidor E2E 5273; as regressões 403 agora estão persistidas. O teste estático leu 11 arquivos públicos (779.008 bytes) e encontrou zero correspondências da senha local, URLs PostgreSQL locais, e-mails das contas de teste e nomes dos 84 cadastros da fonte. O script não imprime valores privados encontrados; informa somente arquivo/categoria. Essa busca é uma verificação dirigida dos valores conhecidos, não uma prova genérica de ausência de todo segredo possível.

A evidência visual deve ser interpretada na resolução original. As capturas mobile têm 390×844 pixels; desktop mantém largura de 1440 pixels e, quando pertinente, a página completa.
