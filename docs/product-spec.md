# Escala • Amil Telemedicina

## Escopo entregue

Aplicativo privado por convite para coordenação de escala e repasse de plantões, em português e adaptado ao celular. Hospedagem Netlify; PostgreSQL Neon no projeto informado pelo proprietário. O sistema não representa integração oficial com sistemas da operadora.

## Papéis

- Proprietário: administra contas e administradores, reabre meses, opera todos os recursos.
- Administrador: gerencia médicos, plantões e convites de médicos; fecha meses e acompanha relatórios.
- Médico: consulta a escala da equipe, disponibiliza próprios plantões, assume ofertas disponíveis e consulta o próprio fechamento.

## Regras da operação

Uma oferta mantém a responsabilidade original até que outro médico aceite. O aceite é atômico e registra origem, destino, autor e instante. Ações concorrentes são serializadas por transação PostgreSQL. Intervalos sobrepostos são rejeitados, inclusive ao atravessar meia-noite. Todas as datas e horários operacionais usam America/Fortaleza (UTC−03). Intervalos adjacentes são permitidos.

Gestores podem corrigir a escala histórica, sempre com registro. Cancelamentos e retiradas são lógicos. Mês fechado impede mudanças; reabertura exige proprietário e motivo. Pendências de revisão e ofertas abertas impedem fechamento. Relatórios refletem a escala vigente, não prova de comparecimento, pagamento ou produtividade clínica.

## Fonte inicial

PDF do usuário: outubro de 2026, 28 páginas. Extração reproduzível de 1.311 linhas, 1.306 participações únicas, 102 grupos de turno e 84 cadastros conservadores. Cinco duplicatas exatas excluídas da contagem; dados originais mantidos localmente. Nomes semelhantes não foram fundidos sem confirmação. Quinze turnos demandam conferência de horário/cobertura/duplicata. O PDF e os dados nominais não são publicados no GitHub nem no bundle do navegador; acesso somente após autenticação.

## Segurança

Senhas scrypt com salt individual. Sessões opacas aleatórias com hash no banco, cookie HttpOnly/SameSite e Secure em produção. Convites de uso único expiram em 7 dias; recuperação em 24h. Rotas validam autorização no servidor. Alteração de acesso e de senha invalida sessões. Rate limit persistido em PostgreSQL. CSRF protegido por validação de Origin/Fetch Metadata e JSON. Auditoria append-only com trigger que rejeita edição/exclusão via aplicação. A credencial administrativa do banco pode tecnicamente alterar schema; auditoria não é armazenamento WORM externo.

Convites e recuperação geram links para compartilhamento manual; não há envio automático de e-mail. A criação de contas públicas é desabilitada. Não há dados de pacientes no produto.

## Referências de produto

- Soffia: https://soffia.co/ — escala centralizada, trocas oficializadas, relatórios por profissional.
- Escala Plantões: https://escala.app/wp-content/uploads/2025/10/Escala-Plantoes.pdf — experiência móvel de escalas e negociações.

A identidade visual e a implementação são próprias. Funcionalidades de biometria, geolocalização, pagamentos, prontuário e integração corporativa não fazem parte desta versão.
