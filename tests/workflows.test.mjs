import {before,beforeEach,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {digest,hashPassword} from '../server/security.mjs';

const url=new URL(process.env.TEST_WORKFLOW_DATABASE_URL||process.env.TEST_DATABASE_URL||process.env.DATABASE_URL||'postgresql://escala_test@127.0.0.1:55432/postgres');
if(!process.env.TEST_WORKFLOW_DATABASE_URL)url.pathname='/escala_tests_workflows';
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/escala_tests_workflows(?:_[a-z0-9_]+)?$/.test(url.pathname))throw Error('Workflow tests require an isolated local escala_tests_workflows database.');
process.env.DATABASE_URL=url.href;delete process.env.DATABASE_URL_UNPOOLED;
process.env.APP_URL='http://escala.test';
const db=new pg.Pool({connectionString:url.href,max:4});
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const password='Workflow-password-2026!';
const month='2099-11';
const slot=(extra={})=>({date:'2099-11-12',start_time:'08:00',end_time:'12:00',period:'morning',unit:'Test Unit',...extra});
let server,base,f,hash;
before(async()=>{
 for(const file of ['schema.sql','review-schema.sql','workflow-schema.sql'])await db.query(await readFile(new URL('../server/'+file,import.meta.url),'utf8'));
 // The additive workflow migration is safe to run twice.
 await db.query(await readFile(new URL('../server/workflow-schema.sql',import.meta.url),'utf8'));
 hash=await hashPassword(password);
 const {app}=await import('../server/app.mjs');server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async()=>{
 await db.query('TRUNCATE escala.corrections,escala.registrations,escala.doctor_merges,escala.import_reviews,escala.sessions,escala.invites,escala.offers,escala.assignments,escala.shifts,escala.audit,escala.doctors,escala.users,escala.imports,escala.months,escala.rate_limits CASCADE');
 f={};
 for(const name of ['a','b','free'])f[name]=await one('INSERT INTO escala.doctors(name,crm,crm_uf) VALUES($1,$2,$3) RETURNING *',[name==='free'?'João Antônio da Silva':'Doctor '+name,name==='free'?'0012345':null,'CE']);
 for(const role of ['owner','admin','a','b']){
  const doctor=f[role];const user=await one('INSERT INTO escala.users(name,email,password_hash,role,doctor_id) VALUES($1,$2,$3,$4,$5) RETURNING *',['User '+role,role+'@workflow.test',hash,['a','b'].includes(role)?'doctor':role,doctor?.id||null]);
  await db.query("INSERT INTO escala.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[digest('workflow-session-'+role),user.id]);
  f[role]={...doctor,user,cookie:'escala_session=workflow-session-'+role};
 }
});
after(async()=>{if(server)await new Promise(r=>server.close(r));await db.end();});
async function api(path,{body,method=body===undefined?'GET':'POST',as='owner',cookie,headers={}}={}){
 const r=await fetch(base+path,{method,headers:{...(as?{Cookie:f[as].cookie}:{}),...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await r.text();return {status:r.status,body:text?JSON.parse(text):null,headers:r.headers};
}
async function register(extra={}){
 const r=await api('/auth/register',{as:null,body:{name:'JOAO ANTONIO DA SILVA',email:'new@workflow.test',password,crm:'12345',crm_uf:'CE',...extra}});
 assert.equal(r.status,201,JSON.stringify(r.body));return {...r,cookie:r.headers.get('set-cookie').split(';')[0]};
}
async function shift(ids=[f.a.id],extra={}){
 const r=await api('/shifts',{body:{...slot(extra),doctor_ids:ids}});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.shifts[0];
}
async function request(type,proposed,as='a'){
 const r=await api('/corrections',{as,body:{type,proposed,reason:'Conferência solicitada pelo próprio médico'}});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.correction;
}
const approve=(id,body={})=>api('/corrections/'+id+'/approve',{body});

test('public registration stays unlinked/pending and discards all forged role, approval and identity claims',async()=>{
 const r=await register({role:'owner',approval_status:'approved',doctor_id:f.owner.user.id,can_manage_schedule:true,user_id:f.owner.user.id});
 assert.equal(r.body.user.role,'doctor');assert.equal(r.body.user.approval_status,'pending');assert.equal(r.body.user.can_manage_schedule,false);assert.equal(r.body.user.doctor_id,null);assert.equal(r.body.doctor,null);assert.equal(r.body.user.password_hash,undefined);
 assert.equal(r.body.registration.status,'pending');assert.equal(r.body.registration.matched_doctor_id,null);assert.equal(r.body.registration.candidates,undefined);
 assert.equal((await one('SELECT count(*)::int n FROM escala.doctors')).n,3);
 const me=await api('/auth/me',{as:null,cookie:r.cookie});assert.equal(me.status,200);assert.equal(me.body.registration.id,r.body.registration.id);
 for(const path of ['/dashboard?month='+month,'/shifts?month='+month,'/doctors','/team','/audit?month='+month,'/corrections?month='+month,'/imports/review','/registrations']){
  const denied=await api(path,{as:null,cookie:r.cookie});assert.equal(denied.status,403,path);assert.equal(denied.body.code,'PENDING_APPROVAL');
 }
 assert.equal((await api('/registrations/me',{as:null,cookie:r.cookie})).status,200);
 assert.equal((await api('/doctors',{as:null})).status,401);
});

test('pending and rejected users may login, change password, view status and logout without gaining roster access',async()=>{
 const r=await register();
 assert.equal((await api('/auth/password',{as:null,cookie:r.cookie,body:{currentPassword:password,newPassword:'New-workflow-password!'}})).status,200);
 assert.equal((await api('/registrations/'+r.body.registration.id+'/reject',{body:{note:'Identidade não confirmada'}})).status,200);
 const login=await api('/auth/login',{as:null,body:{email:'new@workflow.test',password:'New-workflow-password!'}});
 assert.equal(login.status,200);assert.equal(login.body.user.approval_status,'rejected');assert.equal(login.body.registration.decision_note,'Identidade não confirmada');
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const denied=await api('/dashboard',{as:null,cookie});assert.equal(denied.status,403);assert.equal(denied.body.code,'REGISTRATION_REJECTED');
 assert.equal((await api('/auth/logout',{as:null,cookie,body:{}})).status,200);
 assert.equal((await api('/auth/me',{as:null,cookie})).status,401);
});

test('candidate matching is normalized, admin-only, includes current link state and uses CRM with UF',async()=>{
 await register();
 let queue=await api('/registrations?status=pending',{as:'admin'});let candidates=queue.body.registrations[0].candidates;
 assert.equal(candidates.length,1);assert.equal(candidates[0].id,f.free.id);assert.deepEqual(candidates[0].match_reasons,['name','crm']);assert.equal(candidates[0].user_id,null);
 assert.equal((await api('/registrations',{as:'a'})).status,403);
 await db.query("UPDATE escala.registrations SET name='Different applicant',crm_uf='SP'");
 queue=await api('/registrations');assert.equal(queue.body.registrations[0].candidates.length,0);
 await db.query("UPDATE escala.registrations SET crm_uf='CE'");
 await db.query('UPDATE escala.users SET doctor_id=$1 WHERE id=$2',[f.free.id,f.owner.user.id]);
 candidates=(await api('/registrations')).body.registrations[0].candidates;
 assert.equal(candidates[0].user_id,f.owner.user.id);assert.equal(candidates[0].linked_role,'owner');
});

test('approval explicitly links one available identity, preserves its shifts and never changes role',async()=>{
 const s=await shift([f.free.id]);const r=await register();const id=r.body.registration.id;
 assert.equal((await api('/registrations/'+id+'/approve',{body:{}})).status,400);
 const approved=await api('/registrations/'+id+'/approve',{as:'admin',body:{doctor_id:f.free.id}});
 assert.equal(approved.status,200);assert.equal(approved.body.doctor_id,f.free.id);
 const me=await api('/auth/me',{as:null,cookie:r.cookie});assert.equal(me.body.user.approval_status,'approved');assert.equal(me.body.user.role,'doctor');assert.equal(me.body.user.can_manage_schedule,false);assert.equal(me.body.doctor.id,f.free.id);
 assert.equal((await api('/shifts?month='+month,{as:null,cookie:r.cookie})).body.shifts[0].id,s.id);
 assert.equal((await one('SELECT count(*)::int n FROM escala.doctors')).n,3);
 assert.equal((await api('/registrations/'+id+'/approve',{body:{doctor_id:f.free.id}})).status,409);
});

test('a registration cannot steal an existing linked identity or pending superior invitation',async()=>{
 const r=await register();const path='/registrations/'+r.body.registration.id+'/approve';
 assert.equal((await api(path,{body:{doctor_id:f.a.id}})).status,409);
 assert.equal((await one('SELECT doctor_id FROM escala.users WHERE id=$1',[f.a.user.id])).doctor_id,f.a.id);
 await db.query("INSERT INTO escala.invites(token_hash,email,name,role,doctor_id,expires_at) VALUES('reserved','superior@workflow.test','Superior','admin',$1,now()+interval '1 day')",[f.free.id]);
 assert.equal((await api(path,{as:'admin',body:{doctor_id:f.free.id}})).status,403);
 assert.equal((await one('SELECT status FROM escala.registrations')).status,'pending');
 assert.equal((await one('SELECT revoked_at FROM escala.invites')).revoked_at,null);
});

test('public registration cannot reserve an invited owner email or duplicate an existing email',async()=>{
 await db.query("INSERT INTO escala.invites(token_hash,email,name,role,expires_at) VALUES('reserved','invited@workflow.test','Invited owner','owner',now()+interval '1 day')");
 for(const email of ['invited@workflow.test','owner@workflow.test'])assert.equal((await api('/auth/register',{as:null,body:{name:'Applicant',email,password,crm:'12345',crm_uf:'CE'}})).status,409);
 const first=await register();
 assert.equal((await api('/auth/register',{as:null,body:{name:'Applicant',email:'NEW@workflow.test',password,crm:'12345',crm_uf:'CE'}})).status,409);
 assert.equal((await one('SELECT count(*)::int n FROM escala.registrations')).n,1);assert.equal(first.body.user.approval_status,'pending');
});

test('explicit new doctor approval uses submitted CRM/UF and optional schedule permission; rejection requires a reason',async()=>{
 const r=await register({name:'New Unmatched Physician',crm:'98765',crm_uf:'SP'});
 assert.equal((await api('/registrations/'+r.body.registration.id+'/approve',{body:{create_doctor:true,can_manage_schedule:true}})).status,200);
 const me=await api('/auth/me',{as:null,cookie:r.cookie});assert.equal(me.body.doctor.crm,'98765');assert.equal(me.body.doctor.crm_uf,'SP');assert.equal(me.body.user.can_manage_schedule,true);assert.equal(me.body.user.role,'doctor');
 const rejected=await register({email:'rejected@workflow.test'});
 const path='/registrations/'+rejected.body.registration.id+'/reject';
 assert.equal((await api(path,{body:{note:' '}})).status,400);
 assert.equal((await api(path,{as:'a',body:{note:'Reason required'}})).status,403);
 assert.equal((await api(path,{as:'admin',body:{note:'Identity not confirmed'}})).status,200);
 assert.equal((await api('/registrations/'+rejected.body.registration.id+'/approve',{body:{create_doctor:true}})).status,409);
});

test('concurrent approval cannot bind two pending applicants to one doctor',async()=>{
 const a=await register(),b=await register({email:'second@workflow.test'});
 const outcomes=await Promise.all([a,b].map(r=>api('/registrations/'+r.body.registration.id+'/approve',{body:{doctor_id:f.free.id}})));
 assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
 assert.equal((await one("SELECT count(*)::int n FROM escala.registrations WHERE status='approved'")).n,1);
 assert.equal((await one('SELECT count(*)::int n FROM escala.users WHERE doctor_id=$1',[f.free.id])).n,1);
});

test('approval fills missing CRM/UF without renaming the canonical physician, and conflicts remain pending',async()=>{
 await db.query('UPDATE escala.doctors SET crm=NULL,crm_uf=NULL WHERE id=$1',[f.free.id]);
 const r=await register();const canonicalName=f.free.name;
 assert.equal((await api('/registrations/'+r.body.registration.id+'/approve',{body:{doctor_id:f.free.id}})).status,200);
 const saved=await one('SELECT name,crm,crm_uf FROM escala.doctors WHERE id=$1',[f.free.id]);assert.deepEqual(saved,{name:canonicalName,crm:'12345',crm_uf:'CE'});
 const other=await register({email:'other@workflow.test'});
 const target=await one("INSERT INTO escala.doctors(name,crm,crm_uf) VALUES('Another identity','54321','CE') RETURNING id");
 let result=await api('/registrations/'+other.body.registration.id+'/approve',{body:{doctor_id:target.id}});assert.equal(result.status,409);assert.equal(result.body.code,'CRM_CONFLICT');
 await db.query("UPDATE escala.doctors SET crm='12345',crm_uf='SP' WHERE id=$1",[target.id]);
 result=await api('/registrations/'+other.body.registration.id+'/approve',{body:{doctor_id:target.id}});assert.equal(result.status,409);assert.equal(result.body.code,'CRM_CONFLICT');
 assert.equal((await one('SELECT status FROM escala.registrations WHERE id=$1',[other.body.registration.id])).status,'pending');
 assert.equal((await one('SELECT doctor_id FROM escala.users WHERE id=$1',[other.body.user.id])).doctor_id,null);
});

test('public registration rate limiting applies by normalized email before expensive account creation',async()=>{
 await register();
 for(let i=0;i<4;i++)assert.equal((await api('/auth/register',{as:null,body:{name:'Applicant',email:'NEW@workflow.test',password,crm:'12345',crm_uf:'CE'}})).status,409);
 assert.equal((await api('/auth/register',{as:null,body:{name:'Applicant',email:'new@workflow.test',password,crm:'12345',crm_uf:'CE'}})).status,429);
 assert.equal((await one('SELECT count(*)::int n FROM escala.registrations')).n,1);
});

test('migration defaults preserve legacy approval and constraints forbid approved unlinked doctor accounts',async()=>{
 assert.equal(f.a.user.approval_status,'approved');assert.equal(f.a.user.can_manage_schedule,false);
 await db.query('UPDATE escala.users SET can_manage_schedule=true WHERE id=$1',[f.a.user.id]);
 await db.query(await readFile(new URL('../server/workflow-schema.sql',import.meta.url),'utf8'));
 assert.equal((await one('SELECT can_manage_schedule FROM escala.users WHERE id=$1',[f.a.user.id])).can_manage_schedule,true);
 await assert.rejects(db.query("INSERT INTO escala.users(name,email,role,approval_status) VALUES('Unlinked approved','bad@workflow.test','doctor','approved')"),e=>e.code==='23514');
 await assert.rejects(db.query("INSERT INTO escala.users(name,email,role,approval_status) VALUES('Pending owner','bad-owner@workflow.test','owner','pending')"),e=>e.code==='23514');
});

test('schedule permission revokes old sessions and authorizes precisely shift/assignment management',async()=>{
 const p='/team/'+f.a.user.id+'/permissions';
 assert.equal((await api(p,{as:'a',method:'PATCH',body:{can_manage_schedule:true}})).status,403);
 assert.equal((await api(p,{as:'admin',method:'PATCH',body:{can_manage_schedule:true}})).status,200);
 assert.equal((await api('/auth/me',{as:'a'})).status,401);
 const login=await api('/auth/login',{as:null,body:{email:'a@workflow.test',password}});const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal(login.body.user.role,'doctor');assert.equal(login.body.user.can_manage_schedule,true);
 const manager=(path,body,method)=>api(path,{as:null,cookie,body,method});
 const created=await manager('/shifts',{...slot(),doctor_ids:[f.b.id]});assert.equal(created.status,201);const s=created.body.shifts[0];
 assert.equal((await manager('/shifts/'+s.id,{notes:'Changed by schedule manager'},'PATCH')).status,200);
 assert.equal((await manager('/shifts/'+s.id+'/assignments',{doctor_id:f.a.id})).status,200);
 assert.equal((await manager('/assignments/'+s.assignments[0].id,{reason:'Manager correction'},'DELETE')).status,200);
 assert.equal((await manager('/shifts/'+s.id,{reason:'Manager cancellation'},'DELETE')).status,200);
 for(const [path,body] of [['/doctors',{name:'Forbidden Doctor'}],['/months/'+month+'/lock',{locked:true}],['/team/invite',{name:'Invite',email:'forbidden@workflow.test',role:'doctor',doctor_id:f.free.id}],['/registrations/00000000-0000-4000-8000-000000000000/approve',{create_doctor:true}]])assert.equal((await manager(path,body)).status,403,path);
 assert.equal((await manager('/team',undefined)).status,403);
 assert.equal((await api(p,{as:'admin',method:'PATCH',body:{can_manage_schedule:false}})).status,200);
 assert.equal((await manager('/auth/me',undefined)).status,401);
});

test('permission changes reject superior/pending accounts and do not change their roles',async()=>{
 const r=await register();
 for(const id of [f.owner.user.id,f.admin.user.id,r.body.user.id])assert.equal((await api('/team/'+id+'/permissions',{as:'admin',method:'PATCH',body:{can_manage_schedule:true}})).status,400);
 assert.equal((await api('/team/'+r.body.user.id,{method:'PATCH',body:{role:'admin'}})).status,409);
 assert.equal((await one('SELECT role FROM escala.users WHERE id=$1',[r.body.user.id])).role,'doctor');
});

test('profile correction is pending until admin approval and changes doctor/display name atomically',async()=>{
 const c=await request('profile',{name:'Corrected Full Name',crm:'67890',crm_uf:'SP'});
 assert.equal((await one('SELECT name FROM escala.doctors WHERE id=$1',[f.a.id])).name,'Doctor a');
 assert.equal((await api('/corrections/'+c.id+'/approve',{as:'a',body:{}})).status,403);
 assert.equal((await approve(c.id,{note:'Conferido com o registro profissional'})).status,200);
 const doctor=await one('SELECT name,crm,crm_uf FROM escala.doctors WHERE id=$1',[f.a.id]);assert.deepEqual(doctor,{name:'Corrected Full Name',crm:'67890',crm_uf:'SP'});
 assert.equal((await one('SELECT name FROM escala.users WHERE id=$1',[f.a.user.id])).name,doctor.name);
 assert.equal((await one("SELECT count(*)::int n FROM escala.audit WHERE action='correction_approved'")).n,1);
 assert.equal((await approve(c.id)).status,409);
});

test('corrections reject forged identities and other physicians assignments without creating requests',async()=>{
 const s=await shift([f.b.id]);
 for(const [type,proposed] of [['remove_assignment',{assignment_id:s.assignments[0].id}],['change_assignment',{...slot(),assignment_id:s.assignments[0].id}]])assert.equal((await api('/corrections',{as:'a',body:{type,proposed,reason:'Invalid other assignment'}})).status,403);
 assert.equal((await api('/corrections',{as:'a',body:{type:'profile',proposed:{name:'Changed',doctor_id:f.b.id},reason:'Invalid other identity'}})).status,400);
 assert.equal((await one('SELECT count(*)::int n FROM escala.corrections')).n,0);
});

test('changing a shared shift moves only the requester and preserves colleagues, original rows and offer history',async()=>{
 const s=await shift([f.a.id,f.b.id]);const assignment=s.assignments.find(a=>a.doctor_id===f.a.id);
 const o=await api('/offers',{as:'a',body:{assignment_id:assignment.id}});assert.equal(o.status,201);
 const c=await request('change_assignment',{...slot({start_time:'09:00',end_time:'13:00'}),assignment_id:assignment.id});
 assert.equal((await approve(c.id)).status,200);
 const old=await one('SELECT start_time::text,end_time::text FROM escala.shifts WHERE id=$1',[s.id]);assert.deepEqual(old,{start_time:'08:00:00',end_time:'12:00:00'});
 assert.ok((await one('SELECT removed_at FROM escala.assignments WHERE id=$1',[assignment.id])).removed_at);
 assert.equal((await one('SELECT removed_at FROM escala.assignments WHERE id=$1',[s.assignments.find(a=>a.doctor_id===f.b.id).id])).removed_at,null);
 const fresh=await one('SELECT sh.start_time::text,a.id FROM escala.assignments a JOIN escala.shifts sh ON sh.id=a.shift_id WHERE a.doctor_id=$1 AND a.removed_at IS NULL',[f.a.id]);assert.equal(fresh.start_time,'09:00:00');assert.notEqual(fresh.id,assignment.id);
 const offer=await one('SELECT status,from_doctor_id,assignment_id FROM escala.offers WHERE id=$1',[o.body.offer.id]);assert.equal(offer.status,'cancelled');assert.equal(offer.from_doctor_id,f.a.id);assert.equal(offer.assignment_id,assignment.id);
});

test('add correction reuses a matching slot without changing its participants or source metadata',async()=>{
 const s=await shift([f.b.id]);const c=await request('add_assignment',slot());
 assert.equal((await approve(c.id)).status,200);
 assert.equal((await one('SELECT count(*)::int n FROM escala.shifts')).n,1);
 assert.equal((await one('SELECT count(*)::int n FROM escala.assignments WHERE shift_id=$1 AND removed_at IS NULL',[s.id])).n,2);
});

test('remove correction retires only its participation and cancels an associated open offer',async()=>{
 const s=await shift([f.a.id,f.b.id]);const assignment=s.assignments.find(a=>a.doctor_id===f.a.id);
 await api('/offers',{as:'a',body:{assignment_id:assignment.id}});
 const c=await request('remove_assignment',{assignment_id:assignment.id});assert.equal((await approve(c.id)).status,200);
 assert.equal((await one('SELECT count(*)::int n FROM escala.assignments WHERE shift_id=$1 AND removed_at IS NULL',[s.id])).n,1);
 assert.equal((await one('SELECT status FROM escala.offers')).status,'cancelled');
});

test('stale profile and schedule snapshots reject approval and retain pending requests',async()=>{
 const p=await request('profile',{crm:'12345'});
 await api('/doctors/'+f.a.id,{method:'PATCH',body:{name:'Subsequent administrative edit'}});
 assert.equal((await approve(p.id)).body.code,'STALE_CORRECTION');
 const s=await shift();const c=await request('remove_assignment',{assignment_id:s.assignments[0].id});
 await api('/shifts/'+s.id,{method:'PATCH',body:{notes:'Subsequent schedule edit'}});
 const r=await approve(c.id);assert.equal(r.status,409);assert.equal(r.body.code,'STALE_CORRECTION');
 for(const id of [p.id,c.id])assert.equal((await one('SELECT status FROM escala.corrections WHERE id=$1',[id])).status,'pending');
 assert.equal((await one('SELECT removed_at FROM escala.assignments WHERE id=$1',[s.assignments[0].id])).removed_at,null);
});

test('a transferred assignment or changed account link makes a correction stale',async()=>{
 const s=await shift();const c=await request('remove_assignment',{assignment_id:s.assignments[0].id});
 const o=await api('/offers',{as:'a',body:{assignment_id:s.assignments[0].id}});assert.equal((await api('/offers/'+o.body.offer.id+'/accept',{as:'b',body:{}})).status,200);assert.equal((await api('/offers/'+o.body.offer.id+'/approve',{as:'admin',body:{}})).status,200);
 assert.equal((await approve(c.id)).body.code,'STALE_CORRECTION');
 const p=await request('profile',{name:'New profile'});
 await db.query('UPDATE escala.users SET doctor_id=$1 WHERE id=$2',[f.free.id,f.a.user.id]);
 assert.equal((await approve(p.id)).body.code,'STALE_CORRECTION');
 assert.equal((await one('SELECT doctor_id FROM escala.assignments WHERE id=$1',[s.assignments[0].id])).doctor_id,f.b.id);
});

test('correction approval checks source and destination month locks with complete rollback',async()=>{
 const s=await shift();const c=await request('change_assignment',{...slot({date:'2099-12-01'}),assignment_id:s.assignments[0].id});
 await api('/months/2099-12/lock',{body:{locked:true}});
 let r=await approve(c.id);assert.equal(r.status,409);assert.equal(r.body.code,'MONTH_LOCKED');
 await api('/months/2099-12/lock',{body:{locked:false,reason:'Correção de teste'}});await api('/months/'+month+'/lock',{body:{locked:true}});
 r=await approve(c.id);assert.equal(r.status,409);assert.equal(r.body.code,'MONTH_LOCKED');
 assert.equal((await one('SELECT status FROM escala.corrections WHERE id=$1',[c.id])).status,'pending');
 assert.equal((await one('SELECT count(*)::int n FROM escala.shifts')).n,1);assert.equal((await one('SELECT removed_at FROM escala.assignments')).removed_at,null);
});

test('approval uses current true intervals across midnight and rolls back if a new conflict arose',async()=>{
 const c=await request('add_assignment',slot({date:'2099-11-13',start_time:'02:00',end_time:'04:00'}));
 await shift([f.a.id],{start_time:'22:00',end_time:'06:00',period:'night'});
 const r=await approve(c.id);assert.equal(r.status,409);assert.equal(r.body.code,'OVERLAP');
 assert.equal((await one('SELECT status FROM escala.corrections WHERE id=$1',[c.id])).status,'pending');
 assert.equal((await one('SELECT count(*)::int n FROM escala.shifts')).n,1);
});

test('correction lists, rejection and cancellation respect ownership and first decision',async()=>{
 const profile=await request('profile',{name:'My revised profile'});
 const c=await request('add_assignment',slot({date:'2099-12-02'}));
 assert.equal((await api('/corrections?month='+month,{as:'b'})).body.corrections.length,0);
 assert.deepEqual((await api('/corrections?month='+month,{as:'a'})).body.corrections.map(x=>x.id),[profile.id]);
 assert.equal((await api('/corrections/'+profile.id+'/cancel',{as:'b',body:{}})).status,403);
 assert.equal((await api('/corrections/'+profile.id+'/cancel',{as:'a',body:{}})).status,200);
 assert.equal((await approve(profile.id)).status,409);
 assert.equal((await api('/corrections/'+c.id+'/reject',{as:'b',body:{note:'No authority'}})).status,403);
 assert.equal((await api('/corrections/'+c.id+'/reject',{as:'admin',body:{note:'Horário não confirmado'}})).status,200);
 assert.equal((await one('SELECT status FROM escala.corrections WHERE id=$1',[c.id])).status,'rejected');
 assert.equal((await one('SELECT count(*)::int n FROM escala.shifts')).n,0);
});

test('two concurrent decisions apply a correction once and produce one approval audit',async()=>{
 const c=await request('add_assignment',slot());const results=await Promise.all([approve(c.id),approve(c.id)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await one('SELECT count(*)::int n FROM escala.assignments')).n,1);assert.equal((await one("SELECT count(*)::int n FROM escala.audit WHERE action='correction_approved'")).n,1);
});

test('registration and correction input bounds reject malformed CRM, UF, dates and overlong data',async()=>{
 for(const extra of [{crm:''},{crm:'not-a-number'},{crm_uf:'XX'},{password:'short'},{name:'x'.repeat(181)}])assert.equal((await api('/auth/register',{as:null,body:{name:'Applicant',email:'invalid@workflow.test',password,crm:'12345',crm_uf:'CE',...extra}})).status,400);
 for(const proposed of [slot({date:'2099-02-29'}),slot({start_time:'24:00'}),slot({end_time:'08:00'}),slot({doctor_id:f.b.id})])assert.equal((await api('/corrections',{as:'a',body:{type:'add_assignment',reason:'Conferir dados',proposed}})).status,400);
 assert.equal((await one('SELECT count(*)::int n FROM escala.registrations')).n,0);assert.equal((await one('SELECT count(*)::int n FROM escala.corrections')).n,0);
});

test('runtime grant reconciliation works for an existing role without rotating its password or output',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'escala-runtime-test-'));const output=join(directory,'runtime.env');
 try{
  const env={...process.env,DATABASE_URL:url.href};delete env.DATABASE_URL_UNPOOLED;
  const args=[new URL('../scripts/runtime-role.mjs',import.meta.url).pathname,output];
  execFileSync(process.execPath,args,{env,stdio:'pipe'});
  const before=await one("SELECT rolpassword FROM pg_authid WHERE rolname='amil_escala_runtime'");
  await writeFile(output,'preserve-existing-private-output\n',{mode:0o600});
  execFileSync(process.execPath,args,{env,stdio:'pipe'});
  assert.equal((await one("SELECT rolpassword FROM pg_authid WHERE rolname='amil_escala_runtime'")).rolpassword,before.rolpassword);
  assert.equal(await readFile(output,'utf8'),'preserve-existing-private-output\n');
  for(const table of ['registrations','corrections'])for(const privilege of ['SELECT','INSERT','UPDATE'])assert.equal((await one('SELECT has_table_privilege($1,$2,$3) permitted',['amil_escala_runtime','escala.'+table,privilege])).permitted,true);
  assert.equal((await one("SELECT has_table_privilege('amil_escala_runtime','escala.audit','DELETE') permitted")).permitted,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});
