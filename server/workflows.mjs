import {Router} from 'express';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from './db.mjs';
import {fail,hashPassword} from './security.mjs';
import * as V from './validation.mjs';
import * as Q from './queries.mjs';
import {ensureCapacity} from './vacancies.mjs';

const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const note=V.z.string().trim().min(3).max(1000);
const decision=V.z.object({note:V.z.string().trim().max(1000).optional()}).strict();
const uf=V.doctor.shape.crm_uf.unwrap().unwrap();
const crm=V.z.string().trim().regex(/^\d{1,12}$/,'Informe apenas os números do CRM.');
const registrationBody=V.z.object({name:V.text(180),email:V.z.string().trim().toLowerCase().email().max(254),password:V.password,crm,crm_uf:uf.default('CE')});
const slot=V.z.object({date:V.date,start_time:V.time,end_time:V.time,period:V.z.enum(['morning','afternoon','night','dawn']),unit:V.text(120).default('Amil • Telemedicina')}).strict();
const proposal={
 profile:V.z.object({name:V.text(180).optional(),crm:crm.optional(),crm_uf:uf.optional()}).strict().refine(x=>Object.keys(x).length>0,'Informe uma alteração.'),
 add_assignment:slot,
 remove_assignment:V.z.object({assignment_id:V.uuid}).strict(),
 change_assignment:slot.extend({assignment_id:V.uuid}),
};
const normalizeName=v=>String(v||'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const normalizeCrm=v=>String(v||'').replace(/\D/g,'').replace(/^0+(?=\d)/,'');
export async function registrationFor(db,userId) {
 return (await db.query(`SELECT r.id,r.user_id,r.name,r.email,r.crm,r.crm_uf,r.status,r.matched_doctor_id,
 d.name matched_doctor_name,r.created_at,r.decided_at,r.decision_note FROM escala.registrations r
 LEFT JOIN escala.doctors d ON d.id=r.matched_doctor_id WHERE r.user_id=$1`,[userId])).rows[0]||null;
}
async function candidatesFor(db,registration) {
 const doctors=(await db.query(`SELECT d.id,d.name,d.crm,d.crm_uf,d.active,u.id user_id,u.role linked_role
 FROM escala.doctors d LEFT JOIN escala.users u ON u.doctor_id=d.id
 WHERE NOT EXISTS(SELECT 1 FROM escala.doctor_merges m WHERE m.source_doctor_id=d.id) ORDER BY d.name,d.id`)).rows;
 return doctors.flatMap(d=>{
  const reasons=[];
  if(normalizeName(d.name)===normalizeName(registration.name))reasons.push('name');
  if(normalizeCrm(d.crm)&&normalizeCrm(d.crm)===normalizeCrm(registration.crm)&&(!d.crm_uf||d.crm_uf===registration.crm_uf))reasons.push('crm');
  return reasons.length?[{...d,match_reasons:reasons}]:[];
 });
}
async function activeRequester(db,request) {
 const user=(await db.query('SELECT id,name,doctor_id,active,approval_status FROM escala.users WHERE id=$1',[request.user_id])).rows[0];
 if(!user?.active||user.approval_status!=='approved'||user.doctor_id!==request.doctor_id)fail(409,'O vínculo do solicitante mudou. Envie uma nova solicitação.','STALE_CORRECTION');
 try {return {user,doctor:await Q.ensureDoctor(db,request.doctor_id)};}
 catch(e){if(e.status===400)fail(409,'O cadastro do solicitante mudou. Envie uma nova solicitação.','STALE_CORRECTION');throw e;}
}
async function snapshot(db,user,doctor,type,proposed) {
 if(type==='profile')return {doctor_id:doctor.id,name:doctor.name,crm:doctor.crm,crm_uf:doctor.crm_uf,user_name:user.name};
 if(type==='add_assignment')return {doctor_id:doctor.id};
 const a=await Q.getAssignment(db,proposed.assignment_id);
 if(a.doctor_id!==doctor.id)fail(403,'Você só pode solicitar correções dos seus próprios plantões.');
 const s=await Q.getShift(db,a.shift_id);
 return {assignment_id:a.id,doctor_id:a.doctor_id,shift_id:s.id,date:s.date,start_time:s.start_time,end_time:s.end_time,period:s.period,unit:s.unit,notes:s.notes,needs_review:s.needs_review};
}
async function correctionFor(db,id) {
 return (await db.query(`SELECT c.*,d.name doctor_name,u.name decided_by_name FROM escala.corrections c
 JOIN escala.doctors d ON d.id=c.doctor_id LEFT JOIN escala.users u ON u.id=c.decided_by WHERE c.id=$1`,[id])).rows[0];
}
async function pendingCorrection(db,id) {
 const request=(await db.query('SELECT * FROM escala.corrections WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!request)fail(404,'Solicitação não encontrada.');
 if(request.status!=='pending')fail(409,'Esta solicitação já recebeu uma decisão.','REQUEST_DECIDED');
 return request;
}
async function assignSlot(db,doctorId,s,notes='') {
 let target=(await db.query(`SELECT id FROM escala.shifts WHERE date=$1 AND start_time=$2 AND end_time=$3 AND period=$4 AND unit=$5 AND cancelled_at IS NULL ORDER BY created_at,id LIMIT 1`,[s.date,s.start_time,s.end_time,s.period,s.unit])).rows[0];
 if(!target)target=(await db.query(`INSERT INTO escala.shifts(date,start_time,end_time,period,unit,notes,source) VALUES($1,$2,$3,$4,$5,$6,'Conferência médica') RETURNING id`,[s.date,s.start_time,s.end_time,s.period,s.unit,notes])).rows[0];
 await ensureCapacity(db,target.id);
 const a=(await db.query('INSERT INTO escala.assignments(shift_id,doctor_id) VALUES($1,$2) RETURNING id',[target.id,doctorId])).rows[0];
 return {shift_id:target.id,assignment_id:a.id};
}

export function createWorkflowRouters({session,rateLimit,clientAddress,admin,monthOf}) {
 const publicRouter=Router(),workflowRouter=Router();
 publicRouter.post('/auth/register',route(async(req,res)=>{
  const b=registrationBody.parse(req.body);
  await rateLimit(req,'register-ip:'+clientAddress(req),20);
  await rateLimit(req,'register-email:'+b.email,5);
  const hash=await hashPassword(b.password);
  const result=await transaction(req.db,async()=>{
   if((await req.db.query('SELECT 1 FROM escala.users WHERE email=$1',[b.email])).rowCount||(await req.db.query('SELECT 1 FROM escala.invites WHERE email=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()',[b.email])).rowCount)fail(409,'Este e-mail já possui cadastro ou convite. Use seu acesso ou o link de convite.');
   const user=(await req.db.query("INSERT INTO escala.users(name,email,password_hash,role,approval_status) VALUES($1,$2,$3,'doctor','pending') RETURNING *",[b.name,b.email,hash])).rows[0];
   await req.db.query('INSERT INTO escala.registrations(user_id,name,email,crm,crm_uf) VALUES($1,$2,$3,$4,$5)',[user.id,b.name,b.email,b.crm,b.crm_uf]);
   await Q.audit(req.db,user,'registration_created','Cadastro público recebido; aguardando conferência administrativa.',{user_id:user.id});
   return session(req,res,user);
  });
  res.status(201).json(result);
 }));
 workflowRouter.get('/registrations/me',route(async(req,res)=>res.json({registration:await registrationFor(req.db,req.user.id)})));
 workflowRouter.get('/registrations',route(async(req,res)=>{
  admin(req);const status=V.z.enum(['pending','approved','rejected','all']).parse(req.query.status||'pending');
  const rows=(await req.db.query(`SELECT r.*,d.name matched_doctor_name FROM escala.registrations r LEFT JOIN escala.doctors d ON d.id=r.matched_doctor_id WHERE ($1='all' OR r.status=$1) ORDER BY r.created_at,r.id`,[status])).rows;
  for(const r of rows)r.candidates=await candidatesFor(req.db,r);
  res.json({registrations:rows});
 }));
 workflowRouter.post('/registrations/:id/approve',route(async(req,res)=>{
  admin(req);const id=V.uuid.parse(req.params.id);
  const b=V.z.object({doctor_id:V.uuid.optional(),create_doctor:V.z.boolean().optional(),note:V.z.string().trim().max(1000).optional(),can_manage_schedule:V.z.boolean().default(false)}).strict().parse(req.body);
  if(!!b.doctor_id===!!b.create_doctor)fail(400,'Escolha um médico existente ou confirme a criação de um novo cadastro.');
  const result=await transaction(req.db,async()=>{
   const r=(await req.db.query('SELECT * FROM escala.registrations WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!r)fail(404,'Cadastro pendente não encontrado.');
   if(r.status!=='pending')fail(409,'Este cadastro já recebeu uma decisão.');
   const user=(await req.db.query('SELECT * FROM escala.users WHERE id=$1 FOR UPDATE',[r.user_id])).rows[0];
   if(!user?.active||user.role!=='doctor'||user.approval_status!=='pending'||user.doctor_id)fail(409,'O acesso do solicitante mudou. Atualize a fila.');
   let doctor;
   if(b.doctor_id) {
    doctor=await Q.ensureDoctor(req.db,b.doctor_id);
    if((await req.db.query('SELECT 1 FROM escala.users WHERE doctor_id=$1',[doctor.id])).rowCount)fail(409,'Este médico já possui uma conta vinculada.','IDENTITY_LINKED');
    if((doctor.crm&&normalizeCrm(doctor.crm)!==normalizeCrm(r.crm))||(doctor.crm_uf&&doctor.crm_uf!==r.crm_uf))fail(409,'O CRM ou a UF divergem do cadastro escolhido. Confira a identidade antes de aprovar.','CRM_CONFLICT');
    const reserved=(await req.db.query('SELECT role FROM escala.invites WHERE doctor_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL',[doctor.id])).rows;
    if(req.user.role!=='owner'&&reserved.some(i=>i.role!=='doctor'))fail(403,'Apenas o proprietário pode alterar um vínculo reservado à administração.');
   } else doctor=(await req.db.query('INSERT INTO escala.doctors(name,crm,crm_uf) VALUES($1,$2,$3) RETURNING *',[r.name,r.crm,r.crm_uf])).rows[0];
   if(b.doctor_id)doctor=(await req.db.query('UPDATE escala.doctors SET crm=COALESCE(NULLIF(btrim(crm),\'\'),$1),crm_uf=COALESCE(crm_uf,$2) WHERE id=$3 RETURNING *',[r.crm,r.crm_uf,doctor.id])).rows[0];
   // Identifying information is a suggestion, never evidence of account ownership.
   await req.db.query("UPDATE escala.users SET approval_status='approved',doctor_id=$1,name=$2,can_manage_schedule=$3 WHERE id=$4",[doctor.id,doctor.name,b.can_manage_schedule,user.id]);
   await req.db.query("UPDATE escala.registrations SET status='approved',matched_doctor_id=$1,decided_at=now(),decided_by=$2,decision_note=$3 WHERE id=$4",[doctor.id,req.user.id,b.note||null,id]);
   await req.db.query('UPDATE escala.invites SET revoked_at=now() WHERE (doctor_id=$1 OR email=$2) AND accepted_at IS NULL AND revoked_at IS NULL',[doctor.id,user.email]);
   await Q.audit(req.db,req.user,'registration_approved',`Cadastro de ${user.name} aprovado com vínculo conferido.`,{registration_id:id,user_id:user.id,doctor_id:doctor.id,can_manage_schedule:b.can_manage_schedule,note:b.note||null},[doctor.id]);
   return {user_id:user.id,doctor_id:doctor.id};
  });res.json({ok:true,...result});
 }));
 workflowRouter.post('/registrations/:id/reject',route(async(req,res)=>{
  admin(req);const id=V.uuid.parse(req.params.id);const b=V.z.object({note}).strict().parse(req.body);
  await transaction(req.db,async()=>{
   const r=(await req.db.query('SELECT * FROM escala.registrations WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!r)fail(404,'Cadastro não encontrado.');if(r.status!=='pending')fail(409,'Este cadastro já recebeu uma decisão.');
   const u=(await req.db.query("UPDATE escala.users SET approval_status='rejected',can_manage_schedule=false WHERE id=$1 AND approval_status='pending' AND doctor_id IS NULL RETURNING id",[r.user_id])).rows[0];
   if(!u)fail(409,'O vínculo do solicitante mudou.');
   await req.db.query("UPDATE escala.registrations SET status='rejected',decided_at=now(),decided_by=$1,decision_note=$2 WHERE id=$3",[req.user.id,b.note,id]);
   await Q.audit(req.db,req.user,'registration_rejected',`Cadastro de ${r.name} recusado.`,{registration_id:id,user_id:r.user_id,note:b.note});
  });res.json({ok:true});
 }));
 workflowRouter.patch('/team/:id/permissions',route(async(req,res)=>{
  admin(req);const id=V.uuid.parse(req.params.id);const b=V.z.object({can_manage_schedule:V.z.boolean()}).strict().parse(req.body);
  await transaction(req.db,async()=>{
   const u=(await req.db.query('SELECT id,name,role,doctor_id,active,approval_status,can_manage_schedule FROM escala.users WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!u)fail(404,'Conta não encontrada.');
   if(u.role!=='doctor'||u.approval_status!=='approved'||!u.active)fail(400,'Essa permissão é exclusiva de contas médicas aprovadas e ativas.');
   await Q.ensureDoctor(req.db,u.doctor_id);
   if(u.can_manage_schedule!==b.can_manage_schedule){
    await req.db.query('UPDATE escala.users SET can_manage_schedule=$1 WHERE id=$2',[b.can_manage_schedule,id]);
    await req.db.query('DELETE FROM escala.sessions WHERE user_id=$1',[id]);
    await Q.audit(req.db,req.user,'schedule_permission_updated',`Permissão de editar escala de ${u.name} ${b.can_manage_schedule?'concedida':'revogada'}.`,{user_id:id,before:u.can_manage_schedule,after:b.can_manage_schedule},[u.doctor_id]);
   }
  });res.json({ok:true});
 }));
 workflowRouter.get('/corrections',route(async(req,res)=>{
  const month=monthOf(req);const status=V.z.enum(['pending','all']).parse(req.query.status||'all');
  const {rows}=await req.db.query(`SELECT c.*,d.name doctor_name,u.name decided_by_name FROM escala.corrections c JOIN escala.doctors d ON d.id=c.doctor_id LEFT JOIN escala.users u ON u.id=c.decided_by
   WHERE ($1::boolean OR c.user_id=$2) AND ($3='all' OR c.status=$3)
   AND (c.type='profile' OR ($1::boolean AND c.status='pending') OR left(c.proposed->>'date',7)=$4 OR left(c.before->>'date',7)=$4) ORDER BY c.created_at DESC,c.id`,[req.user.role!=='doctor',req.user.id,status,month]);
  res.json({corrections:rows});
 }));
 workflowRouter.post('/corrections',route(async(req,res)=>{
  const b=V.z.object({type:V.z.enum(['profile','add_assignment','remove_assignment','change_assignment']),reason:note,proposed:V.z.unknown()}).strict().parse(req.body);
  const proposed=proposal[b.type].parse(b.proposed);
  if(proposed.start_time&&proposed.start_time===proposed.end_time)fail(400,'Horário inicial e final devem ser diferentes.');
  const id=await transaction(req.db,async()=>{
   const user=(await req.db.query('SELECT id,name,doctor_id,active,approval_status FROM escala.users WHERE id=$1',[req.user.id])).rows[0];
   if(!user?.doctor_id||!user.active||user.approval_status!=='approved')fail(403,'Vincule seu acesso a um médico ativo para solicitar correções.');
   const doctor=await Q.ensureDoctor(req.db,user.doctor_id);const before=await snapshot(req.db,user,doctor,b.type,proposed);
   const c=(await req.db.query('INSERT INTO escala.corrections(user_id,doctor_id,type,reason,proposed,before) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[user.id,doctor.id,b.type,b.reason,proposed,before])).rows[0];
   await Q.audit(req.db,user,'correction_requested',`${user.name} solicitou uma correção para conferência.`,{correction_id:c.id,type:b.type,reason:b.reason,proposed,before},[doctor.id],(proposed.date||before.date)?.slice(0,7)||null);
   return c.id;
  });res.status(201).json({correction:await correctionFor(req.db,id)});
 }));
 workflowRouter.post('/corrections/:id/approve',route(async(req,res)=>{
  admin(req);const id=V.uuid.parse(req.params.id);const b=decision.parse(req.body);
  await transaction(req.db,async()=>{
   const c=await pendingCorrection(req.db,id);const {user,doctor}=await activeRequester(req.db,c);
   let current;
   try{current=await snapshot(req.db,user,doctor,c.type,c.proposed);}
   catch(e){if([403,404].includes(e.status))fail(409,'O plantão ou responsável mudou. Envie uma nova solicitação.','STALE_CORRECTION');throw e;}
   if(!isDeepStrictEqual(current,c.before))fail(409,'Os dados mudaram após a solicitação. Confira e solicite novamente.','STALE_CORRECTION');
   let after;
   if(c.type==='profile'){
    const n={...doctor,...c.proposed};
    await req.db.query('UPDATE escala.doctors SET name=$1,crm=$2,crm_uf=$3 WHERE id=$4',[n.name,n.crm,n.crm_uf,doctor.id]);
    await req.db.query('UPDATE escala.users SET name=$1 WHERE id=$2 AND doctor_id=$3',[n.name,user.id,doctor.id]);
    after={doctor_id:doctor.id,name:n.name,crm:n.crm,crm_uf:n.crm_uf,user_name:n.name};
   }else{
    if(c.before.date)await Q.ensureUnlocked(req.db,c.before.date);
    if(c.proposed.date)await Q.ensureUnlocked(req.db,c.proposed.date);
    if(c.type!=='remove_assignment')await Q.ensureNoOverlap(req.db,doctor.id,c.proposed,c.before.assignment_id||null);
    if(c.before.assignment_id){
     await req.db.query('UPDATE escala.assignments SET removed_at=now() WHERE id=$1',[c.before.assignment_id]);
     await req.db.query("UPDATE escala.offers SET status='cancelled',cancelled_at=now() WHERE assignment_id=$1 AND status IN ('open','pending')",[c.before.assignment_id]);
    }
    after=c.type==='remove_assignment'?{removed_assignment_id:c.before.assignment_id}:await assignSlot(req.db,doctor.id,c.proposed,c.before.notes||'');
   }
   await req.db.query("UPDATE escala.corrections SET status='approved',decided_at=now(),decided_by=$1,decision_note=$2 WHERE id=$3",[req.user.id,b.note||null,id]);
   await Q.audit(req.db,req.user,'correction_approved',`Correção solicitada por ${user.name} aprovada.`,{correction_id:id,requester_id:user.id,doctor_id:doctor.id,type:c.type,before:c.before,proposed:c.proposed,after,note:b.note||null},[doctor.id],(c.proposed.date||c.before.date)?.slice(0,7)||null);
  });res.json({ok:true});
 }));
 for(const action of ['reject','cancel'])workflowRouter.post(`/corrections/:id/${action}`,route(async(req,res)=>{
  if(action==='reject')admin(req);const id=V.uuid.parse(req.params.id);const b=action==='reject'?V.z.object({note}).strict().parse(req.body):V.z.object({}).strict().parse(req.body);
  await transaction(req.db,async()=>{
   const c=await pendingCorrection(req.db,id);
   if(action==='cancel'&&c.user_id!==req.user.id)fail(403,'Você só pode cancelar suas próprias solicitações.');
   const status=action==='reject'?'rejected':'cancelled';
   await req.db.query('UPDATE escala.corrections SET status=$1,decided_at=now(),decided_by=$2,decision_note=$3 WHERE id=$4',[status,req.user.id,b.note||null,id]);
   await Q.audit(req.db,req.user,`correction_${status}`,`Solicitação de correção ${action==='reject'?'recusada':'cancelada'}.`,{correction_id:id,note:b.note||null},[c.doctor_id],(c.proposed.date||c.before.date)?.slice(0,7)||null);
  });res.json({ok:true});
 }));
 return {publicRouter,workflowRouter};
}
