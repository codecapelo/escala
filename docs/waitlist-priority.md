# Prioridade administrativa na disponibilidade

Cada inscrição de disponibilidade pode receber uma prioridade administrativa em
`escala.waitlist.priority` (0 a 100; padrão 0). A ordem é prioridade decrescente,
data original de entrada crescente e ID como desempate estável. Médicos com a
mesma prioridade mantêm a ordem de chegada entre si.

A prioridade pertence à inscrição naquele turno. Não cria inscrições, não altera
datas, não concede plantões e não muda a capacidade. Uma nova inscrição começa
com prioridade zero. A operação administrativa deve registrar na auditoria o
turno, o médico, o valor anterior e o valor novo.

A mesma ordem é usada na lista de disponibilidade, nas sugestões dos repasses
existentes e na seleção do destinatário ao oferecer um plantão. As regras de
privacidade permanecem iguais: a administração e os integrantes do turno veem a
lista; outros médicos recebem apenas a própria posição e o total.

O cadastro público de disponibilidade não aceita `priority`. Neste incremento,
a atribuição de prioridade é uma operação administrativa auditada, sem nova
permissão ou controle exposto ao médico.

Publicação: aplicar primeiro a migração aditiva da coluna e depois publicar o
código. A versão anterior ignora a coluna, permitindo a atualização nessa ordem.
