# Incremento: cadastro, vínculo e conferência médica

## Decisões
- Propriedade/administração e participação médica são independentes: owner/admin podem ter doctor_id e seus próprios plantões. Não duplicar a escala de Raul, já existente na fonte.
- Cadastro público pede nome completo, e-mail, senha (10+), CRM e UF (padrão CE visível). Não publicar a lista de médicos no login. Candidatos pelo nome normalizado/CRM são apresentados à administração; a inscrição não toma posse automaticamente de uma identidade apenas por informar dados públicos. Sem convite, a conta aguarda aprovação do vínculo. Nenhum candidato desconhecido ganha acesso à escala.
- Papéis continuam owner/admin/doctor. Campo independente can_manage_schedule, padrão false, permite a médico aprovado editar turnos/alocações; não dá gestão de contas, aprovações, fechamento ou outros privilégios administrativos. Admin/owner podem conceder/revogar essa permissão a médicos.
- Ajustes solicitados por médicos (inclusive nome e CRM) são pendentes até decisão administrativa. Aceite é atômico, registra autor/origem/destino, verifica mês fechado, conflito de horário e alteração posterior à solicitação.
- Dados existentes, acessos e correções já feitas na produção devem ser preservados. Não reimportar PDF.

## Tipos adicionados ao contrato
User: approval_status:'approved'|'pending'|'rejected' (existing defaults approved); can_manage_schedule:boolean. Pending account has doctor_id:null.
Doctor: crm_uf:string|null.
Registration {id,user_id,name,email,crm,crm_uf,status:'pending'|'approved'|'rejected',matched_doctor_id:string|null,matched_doctor_name:string|null,created_at,decided_at,decision_note}
Correction {id,user_id,doctor_id,doctor_name,type:'profile'|'add_assignment'|'remove_assignment'|'change_assignment',status:'pending'|'approved'|'rejected',reason,proposed:object,before:object,created_at,decided_at,decided_by_name,decision_note}

## API
POST /auth/register {name,email,password,crm,crm_uf} -> {user,doctor:null,registration}; creates session with pending approval. Repeated email409, no role escalation; rate limit by IP/email.
GET /auth/me and POST /auth/login -> {user,doctor,registration?}; pending/rejected sessions can only access auth/me/logout/password and registration status. Other routes403 code PENDING_APPROVAL/REGISTRATION_REJECTED.
GET /registrations/me -> {registration} (pending allowed).
GET /registrations?status=pending -> {registrations} (admin; candidates info includes IDs, CRM and current link state; candidate lists may be included in row.candidates array).
POST /registrations/:id/approve {doctor_id?:uuid,create_doctor?:boolean,note?:string,can_manage_schedule?:boolean} -> {ok:true,user_id,doctor_id}; default can_manage false. Known match can be chosen; new doctor created only on explicit create_doctor. Never grant admin/owner here. Cannot take an already linked identity.
POST /registrations/:id/reject {note:string} -> {ok:true}; reason required.
PATCH /team/:id/permissions {can_manage_schedule:boolean} -> {ok:true}; admin/owner on approved doctor only; revokes old sessions when permission changes.
GET /corrections?month=YYYY-MM&status=pending|all -> {corrections}; admin all, linked physicians self only; profile requests included independent of month.
POST /corrections {type,reason,proposed} -> {correction}; author must have active linked doctor. proposed profile:{name?,crm?,crm_uf?}; add_assignment:{date,start_time,end_time,period,unit?}; remove_assignment:{assignment_id}; change_assignment:{assignment_id,date,start_time,end_time,period,unit?}. Never accept another doctor_id/user_id from client.
POST /corrections/:id/approve {note?:string} -> {ok:true}; admin only. A time/date change moves ONLY requesting doctor's participation to a new/matching slot, preserves other doctors, checks overlap and month locks. Cancels affected offers. A profile correction updates linked doctor and display name atomically. Stale before snapshot409, request remains pending.
POST /corrections/:id/reject {note:string} -> {ok:true}; admin only.
POST /corrections/:id/cancel {} -> {ok:true}; requester can cancel own pending request (status cancelled allowed if implemented; notify frontend).

## UI
Login toggle Entrar/Criar conta. Pending/rejected account sees clear status and logout, no staff schedule. Registration admin queue and schedule permission toggle in Equipe. New Conferência section for physicians to review own full name/CRM and turns and submit missing/remove/change/profile request; admin view approves/rejects. Request history shows state and notes. Owner's Meus plantões filter works while preserving global management. Calendar adds Mês/Semana/Dia/List with navigation and date picker; weeks crossing month boundaries must fetch relevant adjacent months and show their data without hiding dates.
