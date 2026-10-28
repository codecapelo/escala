# Fila automática dos repasses

Repasses direcionados não têm fila. Somente o destinatário pode pedir para assumir;
nem nomes, contagem, posição própria nem temporizador de disponibilidade são enviados
no cartão direcionado, inclusive para a administração.

Repasses abertos congelam a lista de inscritos no momento da publicação, ordenada
por prioridade administrativa, data original de entrada e ID. A prioridade de uma
inscrição alterada depois não muda um repasse já publicado; novos inscritos podem
concorrer quando essa fila se esgotar e a oferta for liberada para a equipe.

Apenas o médico da vez pode pedir para assumir. Os prazos são definidos quando cada
vez começa, conforme o tempo até o início do plantão:

- Mais de 24 horas: 2 horas.
- Mais de 2 horas até 24 horas: 30 minutos.
- Até 2 horas, plantão iniciado ou encerrado: 5 minutos.

O prazo começa quando o sistema libera a vez. O aviso é responsabilidade do canal
externo estabelecido pela equipe; esta entrega não envia mensagens nem espera
confirmação de leitura. Após indisponibilidade do serviço, o próximo médico recebe
um prazo novo contado da liberação efetiva, sem convites vencidos retroativamente.

A tarefa Netlify `offer-queue` executa a cada minuto, inclusive sem navegadores abertos.
O painel e a tentativa de aceite também conferem prazos. O relógio e o bloqueio são
do servidor; clicar atrasado não toma a vez do próximo. O painel atualiza a cada 30
segundos e ao terminar o contador. A tarefa processa até 40 repasses devidos por rodada,
com limite interno de tempo para respeitar o prazo da função; eventual excedente
permanece devido e é processado na rodada seguinte.

Contas inativas, vínculos divergentes, cadastros consolidados, retirada da disponibilidade
e conflitos de horário tornam o médico inelegível. Esses casos passam para o próximo.
Passar a vez não altera a inscrição geral de disponibilidade, só aquela oferta.
A administração pode avançar a fila com motivo obrigatório e auditado.

Aceitar deixa o repasse pendente de autorização administrativa e suspende a fila.
O plantão continua com o titular até a aprovação. Retirada do pedido ou recusa da
administração encerra a vez daquele solicitante e chama o próximo. A fila esgotada
libera a oferta para a equipe. Cancelar encerra a oferta e permite criar outra,
inclusive direcionada para agilizar. Meses fechados bloqueiam alterações e avanço;
ao reabrir, os prazos são reavaliados.

A migração é aditiva. Repasses já pendentes de autorização continuam com o solicitante
e o estado que tinham. Repasses abertos existentes iniciam a fila na ativação desta
regra, com prazo novo. Nenhuma alocação ou inscrição de disponibilidade é modificada
pela migração. O runtime recebe SELECT/INSERT/UPDATE na nova tabela, sem DDL e sem
permissão de editar a auditoria.

Publicar somente após migrar a coluna e a tabela, reconciliar grants e verificar no
preview. A agenda da função só roda automaticamente no deploy de produção. A invocação
direta da função nos testes valida o mesmo worker sem esperar minutos reais.
