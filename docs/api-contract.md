# Escala API contract

All calls /api, JSON and same-origin credentials. Errors {error:string,code?:string}. Dates YYYY-MM-DD, times HH:mm, month YYYY-MM. Role owner/admin/doctor. Timestamps ISO. IDs UUID.
GET /auth/me -> {user:{id,name,email,role,doctor_id},doctor:null|Doctor}. 401 unauthenticated.
POST /auth/login {email,password} -> {user,doctor}; POST /auth/logout -> {ok:true}
POST /auth/activate {token,name,password} -> {user,doctor}. invite token URL /ativar?token=...; owner bootstrap handled same way.
POST /auth/password {currentPassword,newPassword} -> {ok:true}
GET /dashboard?month=2026-10 -> {shifts:Shift[],doctors:Doctor[],offers:Offer[],audit:Audit[],locked:boolean,user,stats:{shifts,hours,doctors,openOffers}}
Doctor {id,name,crm:string|null,specialty:string,active:boolean,user_id:string|null,color:string}
Shift {id,date,start_time,end_time,period:'morning'|'afternoon'|'night'|'dawn',unit:string,notes:string,source:string|null,needs_review:boolean,assignments:Assignment[]}
Assignment {id,doctor_id,doctor_name,doctor_color,offer_id:string|null}
Offer {id,assignment_id,from_doctor_id,from_name,to_doctor_id:string|null,to_name:string|null,status:'open'|'accepted'|'cancelled',created_at,accepted_at,date,start_time,end_time,period,unit,note}
Audit {id,action,actor_name,description,created_at,metadata}
GET /shifts?month=... -> {shifts,locked}
POST /shifts {date,start_time,end_time,period,unit,notes,doctor_ids:string[],dates?:string[]} -> {shifts:Shift[]} (admin; dates optional repeat dates up to 62)
PATCH /shifts/:id {date?,start_time?,end_time?,period?,unit?,notes?,needs_review?} -> {ok:true} (admin)
DELETE /shifts/:id {reason} -> {ok:true} (admin soft cancel)
POST /shifts/:id/assignments {doctor_id} -> {ok:true} (admin)
DELETE /assignments/:id {reason} -> {ok:true} (admin)
POST /offers {assignment_id,note?} -> {offer} (own assignment; admin any)
POST /offers/:id/accept {} -> {ok:true} (doctor own or admin with {doctor_id}); atomic, no overlaps, no past shifts/locked months. A pass stays with origin until someone accepts.
POST /offers/:id/cancel {} -> {ok:true} (origin/admin)
GET /doctors -> {doctors}
POST /doctors {name,crm?,specialty?,color?} -> {doctor} (admin)
PATCH /doctors/:id {name?,crm?,specialty?,active?,color?} -> {doctor} (admin)
GET /team -> {users:[{id,name,email,role,doctor_id,active}],invites:[{id,email,name,role,doctor_id,expires_at,accepted_at,revoked_at}]} (admin)
POST /team/invite {email,name,role:'admin'|'doctor',doctor_id?:string} -> {inviteUrl,expires_at} (owner creates admins; admin creates doctors; URL displayed with copy, no email sent)
PATCH /team/:id {role?,active?,doctor_id?} -> {ok:true} (owner, cannot demote/disable self or owner)
POST /team/invites/:id/revoke {} -> {ok:true} (owner/admin scope)
POST /team/:id/reset {} -> {inviteUrl,expires_at} (owner/admin scope; invitation to reset password, manual share)
GET /reports?month=... -> {month,locked,totals:{doctors,shifts,assignments,hours},rows:[{doctor_id,name,crm,turns,hours,days:string[],morning,afternoon,night,dawn,shifts:[{date,start_time,end_time,unit,period}]}]}
GET /reports/export?month=... -> CSV download (admin all, doctor self)
POST /months/:month/lock {locked:boolean,reason?} -> {ok:true} (admin; lock freezes edits/offer acceptance; unlock owner only)
GET /audit?month=... -> {audit} (admin full, doctors only events related to their shifts)
GET /health -> {status:'ok',database:'connected'}
