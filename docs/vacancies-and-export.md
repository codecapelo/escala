# Cobertura, solicitações de vaga e exportação

Observações e procedência de plantões são administrativas: somente `owner` e `admin` as recebem. Médicos com `can_manage_schedule` continuam sem acesso a esses campos e não podem sobrescrevê-los. A proteção vale para JSON aninhado, conferência e auditoria, além da interface.

`shifts.capacity` guarda o total necessário por turno. A migração aditiva preenche os turnos cujo texto anterior contém a capacidade de referência. Nos demais, o valor permanece indefinido até a administração configurá-lo no formulário. Capacidade não pode ser menor que alocações ativas mais reservas pendentes.

A cobertura mostra médicos confirmados, quantos faltam, quantas vagas continuam disponíveis e quantas estão reservadas. Solicitar uma vaga ainda não inclui o médico na escala: cria uma reserva pendente. A administração abre o plantão e usa **Autorizar** ou **Recusar**; o próprio solicitante pode cancelar. Recusa e cancelamento liberam a reserva. Aprovação cria uma única alocação e mantém o histórico da solicitação.

Solicitações e decisões usam a mesma transação e trava organizacional das demais mudanças na escala. Verificam identidade ativa, capacidade, plantão futuro, fechamento, duplicidade e sobreposição. Alterar data, horário, período ou unidade cancela reservas pendentes para evitar autorização sobre informações antigas. Exclusão lógica do plantão também as cancela. O fechamento mensal exige decidir os pedidos de vaga pendentes.

O repasse de uma participação já existente continua sendo titular oferecendo e outro médico aceitando, sem aprovação administrativa. A aprovação descrita aqui se aplica às vagas ainda desocupadas.

PDF (`GET /api/schedule/export`) e CSV (`GET /api/reports/export`) usam a identidade autenticada. Perfil `doctor`, inclusive com edição de escala permitida, recebe somente suas participações. Parâmetros não permitem trocar de identidade; `scope=all` é recusado para médicos. Proprietário e administração podem exportar a escala geral. O adaptador Netlify envia PDFs como resposta binária em base64 para preservar o arquivo.

## Validação

- Integração com PostgreSQL local isolado: concorrência pela última vaga, decisão única, autorização administrativa, reabertura da vaga por recusa/cancelamento, capacidade, conflitos, fechamento, dados privados e arquivos PDF/CSV individuais.
- Adaptador Netlify real: PDF binário válido, além dos cenários existentes de sessão e requisições.
- Navegador em desktop e 390×844: solicitação, cancelamento, aprovação, cobertura, notas privadas e download individual.
- Preview Netlify com banco de validação e papel restrito: operação completa e extração do conteúdo dos PDFs recebidos por HTTPS.

Os dados e evidências nominais ficam em `private/`, fora do Git. A migração de produção registra hash comparativo para verificar preservação dos plantões, alocações, cadastros, contas, meses e repasses.
