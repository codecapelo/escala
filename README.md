# Amil • Escala

Portal privado da equipe de telemedicina: calendário, gestão de médicos e acessos, repasses rastreáveis e fechamento mensal por profissional. Interface em português, adaptada ao celular.

## Funcionalidades

- Proprietário, administrador e médico, com autorização em cada rota do servidor.
- Plantões com múltiplos médicos, repetição por dias da semana, filtros e lista diária.
- Repasses com aceite atômico, verificação de sobreposição e trilha de origem/destino.
- Cadastro/inativação de médicos; convites individuais de uso único e recuperação de acesso.
- Conferência da escala importada e consolidação auditada de variantes de nome.
- Relatório mensal com turnos, horas, datas e períodos por médico; exportação CSV.
- Fechamento que congela o mês e reabertura exclusiva do proprietário.
- Histórico de alterações; cancelamentos e retiradas preservam os registros.

## Stack

React 19 + TypeScript + Vite, Express em Netlify Functions, PostgreSQL Neon, driver serverless com WebSocket para transações. Credenciais ficam exclusivamente no servidor. Senhas scrypt, sessões HttpOnly e convites por hash. Em produção, o banco é acessado por papel de aplicação sem privilégios de DDL ou edição de auditoria.

## Desenvolvimento

Requer Node 22+ e PostgreSQL. Instale com `npm ci`; configure `.env.local` usando `.env.example`. Para desenvolvimento, use uma branch Neon separada da produção ou banco local. Migre com `npm run db:migrate` (conexão direta). Inicie API com `npm run dev` e frontend com `npx vite`. O Vite encaminha `/api` para a API local na porta 3001.

`npm run build` compila o frontend. O deploy Netlify usa `netlify.toml`, publica `dist` e inclui `netlify/functions/api.mjs`. Configure `DATABASE_URL` (papel de runtime), `APP_URL` (origem HTTPS do site) e `NODE_ENV=production` no ambiente de Functions.

## Importação e primeiro acesso

O PDF nominal e o JSON extraído são privados e não integram este repositório. `docs/import-october.py` reproduz a extração com Poppler. O resultado é fornecido a `scripts/import.mjs`, que importa em transação, verifica SHA-256 e evita executar a mesma importação duas vezes. O mês precisa estar vazio para uma nova importação; ambiguidades permanecem sinalizadas para conferência humana.

O operador executa `node --env-file=.env.local scripts/bootstrap-owner.mjs email nome` para gerar um convite inicial privado de proprietário. O link de uso único é escrito em `private/owner-access.txt`; a senha é escolhida pelo usuário. Não existe conta/senha padrão nem cadastro público. Convites e links de recuperação devem ser compartilhados manualmente; a aplicação não envia e-mails.

Depois de migrar o schema e antes de publicar, `scripts/runtime-role.mjs` cria o papel restrito de execução e grava o ambiente em arquivo privado. Migrações/importação continuam usando a conexão administrativa, nunca exposta ao navegador.

## Testes

`npm test` roda testes de integração com HTTP e PostgreSQL reais. Exige bancos locais isolados; URLs remotas são recusadas. Consulte [a matriz de testes](docs/test-plan.md) e [o contrato da API](docs/api-contract.md). Testes de navegador usam Playwright, com dados próprios e screenshots privadas.

## Limites operacionais

O relatório representa a escala vigente; não comprova presença, pagamento ou atendimento. Horários operacionais seguem America/Fortaleza. A importação conserva grafias não confirmadas e bloqueia o fechamento até resolver as pendências. O log é protegido contra alteração pela aplicação, mas não é um arquivo WORM independente do administrador do banco.

Não há integração oficial com a operadora, biometria, geolocalização, pagamento ou dados de pacientes. Consulte [especificação do produto](docs/product-spec.md), [auditoria Neon](docs/neon-setup.md) e [revisão de importação](docs/review-api.md).

No plano Netlify usado nesta implantação, as variáveis usam os escopos padrão do projeto, autorizados pelo proprietário. O build também pode lê-las, mas somente variáveis `VITE_` são expostas pelo Vite e nenhuma credencial recebe esse prefixo. `node scripts/check-public-bundle.mjs` verifica que os arquivos públicos não contêm a configuração do banco. O servidor Vite de desenvolvimento também bloqueia acesso HTTP a `private/`, `data/` e arquivos de ambiente.
