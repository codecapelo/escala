import express from "express";
import cookieParser from "cookie-parser";
import { createPool, transaction } from "./db.mjs";
import {
  randomToken,
  digest,
  hashPassword,
  verifyPassword,
  cookieOptions,
  fail,
  shiftHours,
  csvCell,
} from "./security.mjs";
import * as V from "./validation.mjs";
import * as Q from "./queries.mjs";
import { reviewRouter } from "./review.mjs";
import { schedulePdf } from "./pdf.mjs";
import { createGenerateRouter } from "./generate.mjs";
import { sendMail, resetEmail, mailConfigured } from "./mail.mjs";
import { createWorkflowRouters, registrationFor } from "./workflows.mjs";
import { vacancyRouter, ensureCapacity, cancelVacancyRequests, staffing } from './vacancies.mjs';
export const app = express();
app.disable("x-powered-by");
// serverless-http supplies a completed IncomingMessage with a raw Buffer.
// Express 5 intentionally skips body parsing on completed streams, so normalize
// this adapter body explicitly using the same limit as the normal HTTP parser.
app.use((req, res, next) => {
  if (!Buffer.isBuffer(req.body)) return next();
  if (req.body.length > 100 * 1024)
    return next(
      Object.assign(new Error("O envio excede o limite de 100 KB."), {
        status: 413,
      }),
    );
  if (req.is("application/json")) {
    try {
      req.body = req.body.length ? JSON.parse(req.body.toString("utf8")) : {};
    } catch {
      return next(
        Object.assign(new Error("Dados JSON inválidos."), {
          type: "entity.parse.failed",
        }),
      );
    }
  }
  next();
});
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (!req.is("application/json"))
      return res.status(415).json({ error: "Envie os dados em JSON." });
    const origin = req.get("origin");
    const allowed = (process.env.APP_URL || "http://localhost:5173")
      .split(",")
      .map((x) => x.trim());
    if (origin && !allowed.includes(origin))
      return res
        .status(403)
        .json({ error: "Origem da solicitação não autorizada." });
    if (req.get("sec-fetch-site") === "cross-site")
      return res.status(403).json({ error: "Solicitação externa bloqueada." });
  }
  next();
});
app.use(async (req, res, next) => {
  let pool, db;
  try {
    pool = createPool();
    db = await pool.connect();
    req.db = db;
    let released = false;
    const cleanup = () => {
      if (!released) {
        released = true;
        db.release();
        pool.end().catch(() => {});
      }
    };
    res.on("finish", cleanup);
    res.on("close", cleanup);
    next();
  } catch (e) {
    if (pool) await pool.end().catch(() => {});
    next(e);
  }
});
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const currentMonth = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
const monthOf = (req) => V.month.parse(req.query.month || currentMonth());
const admin = (req) => {
  if (!["owner", "admin"].includes(req.user.role))
    fail(403, "Esta ação é exclusiva da administração.");
};
const scheduleManager = (req) => {
  if (!["owner", "admin"].includes(req.user.role) && !(req.user.role === "doctor" && req.user.approval_status === "approved" && req.user.can_manage_schedule))
    fail(403, "Você não tem permissão para editar a escala.");
};
const owner = (req) => {
  if (req.user.role !== "owner")
    fail(403, "Apenas o proprietário pode gerenciar administradores.");
};
const idOf = (req) => V.uuid.parse(req.params.id);
const reasonOf = (req) => V.text(500).parse(req.body.reason);
const clientAddress = (req) =>
  process.env.NETLIFY === "true"
    ? req.get("x-nf-client-connection-ip") ||
      req.socket.remoteAddress ||
      "unknown"
    : req.socket.remoteAddress || "unknown";
async function rateLimit(req, key, max = 10, minutes = 15) {
  const { rows } = await req.db.query(
    `INSERT INTO escala.rate_limits(key,attempts,reset_at) VALUES($1,1,now()+($2||' minutes')::interval)
 ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN escala.rate_limits.reset_at<now() THEN 1 ELSE escala.rate_limits.attempts+1 END,
 reset_at=CASE WHEN escala.rate_limits.reset_at<now() THEN now()+($2||' minutes')::interval ELSE escala.rate_limits.reset_at END RETURNING attempts`,
    [digest(key), minutes],
  );
  if (rows[0].attempts > max)
    fail(429, `Muitas tentativas. Aguarde ${minutes} minutos e tente novamente.`);
}
async function session(req, res, user) {
  const token = randomToken();
  await req.db.query(
    "INSERT INTO escala.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    [digest(token), user.id],
  );
  res.cookie("escala_session", token, cookieOptions());
  const { password_hash, ...safe } = user;
  const doctor = user.doctor_id
    ? (
        await req.db.query("SELECT * FROM escala.doctors WHERE id=$1", [
          user.doctor_id,
        ])
      ).rows[0]
    : null;
  const registration = await registrationFor(req.db, user.id);
  return { user: safe, doctor, ...(registration ? { registration } : {}) };
}
const {publicRouter,workflowRouter}=createWorkflowRouters({session,rateLimit,clientAddress,admin,monthOf});
app.use('/api',publicRouter);
app.get(
  "/api/health",
  route(async (req, res) => {
    await req.db.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  }),
);
app.post(
  "/api/auth/login",
  route(async (req, res) => {
    const body = V.login.parse(req.body);
    await rateLimit(req, "login:" + body.email);
    await rateLimit(req, "ip:" + clientAddress(req), 120);
    const user = (
      await req.db.query("SELECT * FROM escala.users WHERE email=$1", [
        body.email,
      ])
    ).rows[0];
    const valid = await verifyPassword(body.password, user?.password_hash);
    if (!user?.active || !valid) fail(401, "E-mail ou senha incorretos.");
    if (user.role === "doctor" && user.approval_status === 'approved') await Q.ensureDoctor(req.db, user.doctor_id);
    await req.db.query("DELETE FROM escala.rate_limits WHERE key=$1", [
      digest("login:" + body.email),
    ]);
    res.json(await session(req, res, user));
  }),
);
app.post(
  "/api/auth/activate",
  route(async (req, res) => {
    const body = V.activate.parse(req.body);
    await rateLimit(req, "activate:" + clientAddress(req), 40);
    const hashed = await hashPassword(body.password);
    const result = await transaction(req.db, async () => {
      const invite = (
        await req.db.query(
          "SELECT * FROM escala.invites WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
          [digest(body.token)],
        )
      ).rows[0];
      if (!invite)
        fail(
          400,
          "Convite inválido ou expirado. Peça um novo link à administração.",
        );
      if (invite.kind !== "reset" && !body.name)
        fail(400, "Informe seu nome completo.");
      if (invite.doctor_id) await Q.ensureDoctor(req.db, invite.doctor_id);
      let user;
      if (invite.kind === "reset") {
        user = (
          await req.db.query(
            "UPDATE escala.users SET password_hash=$1 WHERE email=$2 AND active RETURNING *",
            [hashed, invite.email],
          )
        ).rows[0];
        if (!user) fail(400, "Conta indisponível. Procure a administração.");
        await req.db.query("DELETE FROM escala.sessions WHERE user_id=$1", [
          user.id,
        ]);
      } else {
        const exists = (
          await req.db.query(
            "SELECT id FROM escala.users WHERE email=$1 OR (doctor_id=$2 AND $2::uuid IS NOT NULL)",
            [invite.email, invite.doctor_id],
          )
        ).rows[0];
        if (exists) fail(409, "Este e-mail ou médico já possui uma conta.");
        user = (
          await req.db.query(
            "INSERT INTO escala.users(name,email,password_hash,role,doctor_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [body.name, invite.email, hashed, invite.role, invite.doctor_id],
          )
        ).rows[0];
      }
      await req.db.query(
        "UPDATE escala.invites SET accepted_at=now() WHERE id=$1",
        [invite.id],
      );
      await Q.audit(
        req.db,
        user,
        invite.kind === "reset" ? "password_reset" : "account_activated",
        invite.kind === "reset"
          ? "Senha redefinida por convite de recuperação."
          : `${user.name} ativou o acesso como ${user.role}.`,
        {},
        user.doctor_id ? [user.doctor_id] : [],
      );
      return session(req, res, user);
    });
    res.json(result);
  }),
);
// Lets the login screen show "Esqueci minha senha" only when e-mail can really be sent.
app.get("/api/auth/options", (req, res) => res.json({ forgot: mailConfigured() }));
app.post(
  "/api/auth/forgot",
  route(async (req, res) => {
    const { email } = V.forgot.parse(req.body);
    await rateLimit(req, "forgot-ip:" + clientAddress(req), 20);
    await rateLimit(req, "forgot:" + email, 3, 60);
    const user = (
      await req.db.query(
        "SELECT id,name,email,role,doctor_id FROM escala.users WHERE email=$1 AND active",
        [email],
      )
    ).rows[0];
    if (user) {
      const url = await transaction(req.db, async () => {
        const link = await createReset(req, user, FORGOT_MINUTES, null);
        await Q.audit(req.db, user, "password_forgot_requested", "Pedido de redefinição de senha por e-mail.", {});
        return link;
      });
      await sendMail({ to: user.email, ...resetEmail({ name: user.name, url, minutes: FORGOT_MINUTES }) });
    }
    // Same answer whether or not the address exists, so the form cannot be used to probe accounts.
    res.json({ ok: true });
  }),
);
app.use("/api", async (req, res, next) => {
  try {
    const token = req.cookies.escala_session;
    if (!token) fail(401, "Entre na sua conta para continuar.");
    const user = (
      await req.db.query(
        `SELECT u.id,u.name,u.email,u.role,u.doctor_id,u.active,u.approval_status,u.can_manage_schedule FROM escala.sessions s JOIN escala.users u ON u.id=s.user_id
   LEFT JOIN escala.doctors d ON d.id=u.doctor_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND (u.approval_status<>'approved' OR u.role<>'doctor' OR d.active)`,
        [digest(token)],
      )
    ).rows[0];
    if (!user) fail(401, "Sua sessão expirou. Entre novamente.");
    req.user = user;
    if(user.approval_status!=='approved'&&!(['GET /auth/me','POST /auth/logout','POST /auth/password','GET /registrations/me'].includes(req.method+' '+req.path)))
      fail(403,user.approval_status==='rejected'?'Seu cadastro não foi aprovado. Consulte a decisão da administração.':'Seu cadastro aguarda aprovação da administração.',user.approval_status==='rejected'?'REGISTRATION_REJECTED':'PENDING_APPROVAL');
    next();
  } catch (e) {
    next(e);
  }
});
// Administrative observations never leave the server for a physician role,
// including physicians with permission to manage the schedule and nested audit snapshots.
app.use('/api', (req,res,next)=>{
 const json=res.json.bind(res);
 res.json=body=>{
  function redact(value){
   if(Array.isArray(value))return value.map(redact);
   if(value&&typeof value==='object'&&!(value instanceof Date))return Object.fromEntries(Object.entries(value).filter(([key])=>!['notes','source'].includes(key)).map(([key,val])=>[key,key==='metadata'?{}:redact(val)]));
   return value;
  }
  return json(req.user?.role==='doctor'?redact(body):body);
 };
 next();
});
app.use('/api',vacancyRouter({admin,monthOf}));
app.get(
  "/api/auth/me",
  route(async (req, res) =>
    res.json({
      user: req.user,
      registration: await registrationFor(req.db,req.user.id),
      doctor: req.user.doctor_id
        ? (
            await req.db.query("SELECT * FROM escala.doctors WHERE id=$1", [
              req.user.doctor_id,
            ])
          ).rows[0]
        : null,
    }),
  ),
);
app.post(
  "/api/auth/logout",
  route(async (req, res) => {
    await req.db.query("DELETE FROM escala.sessions WHERE token_hash=$1", [
      digest(req.cookies.escala_session),
    ]);
    res.clearCookie("escala_session", {
      ...cookieOptions(),
      maxAge: undefined,
    });
    res.json({ ok: true });
  }),
);
app.post(
  "/api/auth/password",
  route(async (req, res) => {
    const body = V.z
      .object({
        currentPassword: V.z.string().max(128),
        newPassword: V.password,
      })
      .parse(req.body);
    await rateLimit(req, "password:" + req.user.id);
    const u = (
      await req.db.query("SELECT password_hash FROM escala.users WHERE id=$1", [
        req.user.id,
      ])
    ).rows[0];
    if (!(await verifyPassword(body.currentPassword, u.password_hash)))
      fail(400, "Senha atual incorreta.");
    const hash = await hashPassword(body.newPassword);
    await transaction(req.db, async () => {
      await req.db.query(
        "UPDATE escala.users SET password_hash=$1 WHERE id=$2",
        [hash, req.user.id],
      );
      await req.db.query(
        "DELETE FROM escala.sessions WHERE user_id=$1 AND token_hash<>$2",
        [req.user.id, digest(req.cookies.escala_session)],
      );
      await Q.audit(
        req.db,
        req.user,
        "password_changed",
        "Senha alterada; outras sessões encerradas.",
      );
    });
    res.json({ ok: true });
  }),
);
app.get(
  "/api/dashboard",
  route(async (req, res) => {
    const month = monthOf(req);
    const shifts = await Q.shiftsFor(req.db, month);
    const doctors = await Q.doctorsFor(req.db);
    const offers = await Q.offersFor(req.db, month, req.user);
    const visible =
      req.user.role === "doctor"
        ? shifts.filter((s) =>
            s.assignments.some((a) => a.doctor_id === req.user.doctor_id),
          )
        : shifts;
    res.json({
      shifts,
      doctors,
      offers,
      audit: await Q.auditFor(req.db, month, req.user),
      locked: await Q.lockedFor(req.db, month),
      user: req.user,
      stats: {
        shifts: visible.reduce(
          (n, s) => n + (req.user.role === "doctor" ? 1 : s.assignments.length),
          0,
        ),
        hours: visible.reduce(
          (n, s) =>
            n +
            shiftHours(s) *
              (req.user.role === "doctor" ? 1 : s.assignments.length),
          0,
        ),
        doctors: doctors.filter((d) => d.active).length,
        openOffers: offers.filter((o) => o.status === "open").length,
        pendingTransfers: offers.filter((o) => o.status === "pending").length,
      },
    });
  }),
);
app.get(
  "/api/shifts",
  route(async (req, res) => {
    const m = monthOf(req);
    res.json({
      shifts: await Q.shiftsFor(req.db, m),
      locked: await Q.lockedFor(req.db, m),
    });
  }),
);
app.post(
  "/api/shifts",
  route(async (req, res) => {
    scheduleManager(req);
    const body = V.shift.parse(req.body);
    if(req.user.role==='doctor'&&(req.body.notes!==undefined||req.body.capacity!==undefined))fail(403,'Observações e capacidade são exclusivas da administração.');
    if(body.capacity!==null&&body.capacity!==undefined&&body.capacity<new Set(body.doctor_ids).size)fail(400,'A capacidade não pode ser menor que a equipe.');
    const dates = [
      ...new Set(body.dates?.length ? body.dates : [body.date]),
    ].sort();
    const doctorIds = [...new Set(body.doctor_ids)];
    const ids = await transaction(req.db, async () => {
      const ids = [];
      for (const date of dates) {
        await Q.ensureUnlocked(req.db, date);
        const s = { ...body, date };
        for (const id of doctorIds) {
          await Q.ensureDoctor(req.db, id);
          await Q.ensureNoOverlap(req.db, id, s);
        }
        const { rows } = await req.db.query(
          "INSERT INTO escala.shifts(date,start_time,end_time,period,unit,notes,capacity) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [
            date,
            body.start_time,
            body.end_time,
            body.period,
            body.unit,
            body.notes,
            body.capacity ?? null,
          ],
        );
        ids.push(rows[0].id);
        for (const id of doctorIds)
          await req.db.query(
            "INSERT INTO escala.assignments(shift_id,doctor_id) VALUES($1,$2)",
            [rows[0].id, id],
          );
        await Q.audit(
          req.db,
          req.user,
          "shift_created",
          `Plantão de ${date.split("-").reverse().join("/")} ${body.start_time}–${body.end_time} criado com ${doctorIds.length} médico(s).`,
          { shift_id: rows[0].id, ...s, doctor_ids: doctorIds },
          doctorIds,
          date.slice(0, 7),
        );
      }
      return ids;
    });
    const all = [];
    for (const m of [...new Set(dates.map((x) => x.slice(0, 7)))])
      all.push(...(await Q.shiftsFor(req.db, m)));
    res.status(201).json({ shifts: all.filter((s) => ids.includes(s.id)) });
  }),
);
app.patch(
  "/api/shifts/:id",
  route(async (req, res) => {
    scheduleManager(req);
    const id = idOf(req);
    const body = V.shiftPatch.parse(req.body);
    if(req.user.role==='doctor'&&(req.body.notes!==undefined||req.body.capacity!==undefined))fail(403,'Observações e capacidade são exclusivas da administração.');
    await transaction(req.db, async () => {
      const old = await Q.getShift(req.db, id);
      const s = { ...old, ...body };
      if(body.capacity!==undefined){const counts=await staffing(req.db,id);if(body.capacity===null&&counts.pending)fail(409,'Decida as solicitações pendentes antes de remover a capacidade.');if(body.capacity!==null&&body.capacity<counts.assigned+counts.pending)fail(409,'A capacidade não pode ser menor que os médicos alocados e as reservas pendentes.');}
      if(['date','start_time','end_time','period','unit'].some(k=>body[k]!==undefined&&body[k]!==old[k]))await cancelVacancyRequests(req.db,id);
      await Q.ensureUnlocked(req.db, old.date);
      await Q.ensureUnlocked(req.db, s.date);
      if (s.start_time === s.end_time)
        fail(400, "Horário inicial e final devem ser diferentes.");
      const assignments = (
        await req.db.query(
          "SELECT * FROM escala.assignments WHERE shift_id=$1 AND removed_at IS NULL",
          [id],
        )
      ).rows;
      if (body.date || body.start_time || body.end_time)
        for (const a of assignments)
          await Q.ensureNoOverlap(req.db, a.doctor_id, s, a.id);
      await req.db.query(
        "UPDATE escala.shifts SET date=$1,start_time=$2,end_time=$3,period=$4,unit=$5,notes=$6,needs_review=$7,capacity=$8 WHERE id=$9",
        [
          s.date,
          s.start_time,
          s.end_time,
          s.period,
          s.unit,
          s.notes,
          s.needs_review,
          s.capacity,
          id,
        ],
      );
      if (body.date || body.start_time || body.end_time)
        await req.db.query(
          "UPDATE escala.offers SET status='cancelled',cancelled_at=now() WHERE assignment_id IN (SELECT id FROM escala.assignments WHERE shift_id=$1) AND status IN ('open','pending')",
          [id],
        );
      await Q.audit(
        req.db,
        req.user,
        "shift_updated",
        `Plantão de ${s.date.split("-").reverse().join("/")} atualizado.`,
        { shift_id: id, before: old, after: s },
        assignments.map((a) => a.doctor_id),
        s.date.slice(0, 7),
      );
    });
    res.json({ ok: true });
  }),
);
app.delete(
  "/api/shifts/:id",
  route(async (req, res) => {
    scheduleManager(req);
    const id = idOf(req);
    const reason = reasonOf(req);
    await transaction(req.db, async () => {
      const s = await Q.getShift(req.db, id);
      await Q.ensureUnlocked(req.db, s.date);
      await cancelVacancyRequests(req.db,id);
      const assigned = (
        await req.db.query(
          "SELECT doctor_id FROM escala.assignments WHERE shift_id=$1 AND removed_at IS NULL",
          [id],
        )
      ).rows.map((x) => x.doctor_id);
      await req.db.query(
        "UPDATE escala.shifts SET cancelled_at=now() WHERE id=$1",
        [id],
      );
      await req.db.query(
        "UPDATE escala.offers SET status='cancelled',cancelled_at=now() WHERE assignment_id IN (SELECT id FROM escala.assignments WHERE shift_id=$1) AND status IN ('open','pending')",
        [id],
      );
      await Q.audit(
        req.db,
        req.user,
        "shift_cancelled",
        `Plantão de ${s.date.split("-").reverse().join("/")} cancelado. Motivo: ${reason}`,
        { shift_id: id, before: s, reason },
        assigned,
        s.date.slice(0, 7),
      );
    });
    res.json({ ok: true });
  }),
);
app.post(
  "/api/shifts/:id/assignments",
  route(async (req, res) => {
    scheduleManager(req);
    const id = idOf(req);
    const { doctor_id } = V.z.object({ doctor_id: V.uuid }).parse(req.body);
    await transaction(req.db, async () => {
      const s = await Q.getShift(req.db, id);
      await Q.ensureUnlocked(req.db, s.date);
      await ensureCapacity(req.db,id);
      const d = await Q.ensureDoctor(req.db, doctor_id);
      await Q.ensureNoOverlap(req.db, doctor_id, s);
      await req.db.query(
        "INSERT INTO escala.assignments(shift_id,doctor_id) VALUES($1,$2)",
        [id, doctor_id],
      );
      await Q.audit(
        req.db,
        req.user,
        "doctor_assigned",
        `${d.name} adicionado ao plantão de ${s.date.split("-").reverse().join("/")} ${s.start_time}.`,
        { shift_id: id, doctor_id },
        [doctor_id],
        s.date.slice(0, 7),
      );
    });
    res.json({ ok: true });
  }),
);
app.delete(
  "/api/assignments/:id",
  route(async (req, res) => {
    scheduleManager(req);
    const id = idOf(req);
    const reason = reasonOf(req);
    await transaction(req.db, async () => {
      const a = await Q.getAssignment(req.db, id);
      const s = await Q.getShift(req.db, a.shift_id);
      await Q.ensureUnlocked(req.db, s.date);
      await req.db.query(
        "UPDATE escala.assignments SET removed_at=now() WHERE id=$1",
        [id],
      );
      await req.db.query(
        "UPDATE escala.offers SET status='cancelled',cancelled_at=now() WHERE assignment_id=$1 AND status IN ('open','pending')",
        [id],
      );
      await Q.audit(
        req.db,
        req.user,
        "doctor_removed",
        `${a.doctor_name} retirado do plantão de ${s.date.split("-").reverse().join("/")} ${s.start_time}. Motivo: ${reason}`,
        { assignment_id: id, shift_id: s.id, doctor_id: a.doctor_id, reason },
        [a.doctor_id],
        s.date.slice(0, 7),
      );
    });
    res.json({ ok: true });
  }),
);
app.post(
  "/api/offers",
  route(async (req, res) => {
    const { assignment_id, note } = V.z
      .object({
        assignment_id: V.uuid,
        note: V.z.string().trim().max(1000).default(""),
      })
      .parse(req.body);
    const offer = await transaction(req.db, async () => {
      const a = await Q.getAssignment(req.db, assignment_id);
      if (a.doctor_id !== req.user.doctor_id)
        fail(403, "Você só pode disponibilizar seus próprios plantões.");
      const s = await Q.getShift(req.db, a.shift_id);
      await Q.ensureUnlocked(req.db, s.date);
      Q.ensureFuture(s);
      const offer = (
        await req.db.query(
          "INSERT INTO escala.offers(assignment_id,from_doctor_id,note,created_by) VALUES($1,$2,$3,$4) RETURNING *",
          [a.id, a.doctor_id, note, req.user.id],
        )
      ).rows[0];
      await Q.audit(
        req.db,
        req.user,
        "offer_created",
        `${a.doctor_name} disponibilizou o plantão de ${s.date.split("-").reverse().join("/")} ${s.start_time}.`,
        { offer_id: offer.id, shift_id: s.id, from_doctor_id: a.doctor_id },
        [a.doctor_id],
        s.date.slice(0, 7),
      );
      return offer;
    });
    res.status(201).json({ offer });
  }),
);
app.post(
  "/api/offers/:id/accept",
  route(async (req, res) => {
    const id = idOf(req);
    const body = V.z.object({ doctor_id: V.uuid.optional() }).parse(req.body);
    if(body.doctor_id && body.doctor_id !== req.user.doctor_id)
      fail(403,'Você só pode assumir plantões para seu próprio cadastro médico.');
    const target = req.user.doctor_id;
    if (!target) fail(400, "Selecione o médico que assumirá o plantão.");
    await transaction(req.db, async () => {
      const o = (
        await req.db.query(
          "SELECT * FROM escala.offers WHERE id=$1 AND status='open' FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!o)
        fail(409, "Este plantão já foi assumido, está em análise ou a oferta foi cancelada.");
      const a = await Q.getAssignment(req.db, o.assignment_id);
      if (a.doctor_id !== o.from_doctor_id)
        fail(
          409,
          "O responsável por este plantão já mudou. Atualize a página.",
        );
      if (target === a.doctor_id)
        fail(400, "Você já é responsável por este plantão.");
      const s = await Q.getShift(req.db, a.shift_id);
      await Q.ensureUnlocked(req.db, s.date);
      Q.ensureFuture(s);
      const d = await Q.ensureDoctor(req.db, target);
      await Q.ensureNoOverlap(req.db, target, s);
      await req.db.query(
        "UPDATE escala.offers SET status='pending',requested_doctor_id=$1,requested_by=$2,requested_at=now() WHERE id=$3",
        [target, req.user.id, id],
      );
      await Q.audit(
        req.db,
        req.user,
        "offer_requested",
        `${d.name} pediu para assumir o plantão de ${a.doctor_name} em ${s.date.split("-").reverse().join("/")} ${s.start_time}–${s.end_time}. Aguardando aprovação da administração.`,
        { offer_id: id, assignment_id: a.id, shift_id: s.id, from_doctor_id: a.doctor_id, to_doctor_id: target },
        [a.doctor_id, target],
        s.date.slice(0, 7),
      );
    });
    res.json({ ok: true, status: "pending" });
  }),
);
app.post(
  "/api/offers/:id/approve",
  route(async (req, res) => {
    admin(req);
    const id = idOf(req);
    const b = V.z.object({ note: V.z.string().trim().max(1000).optional() }).strict().parse(req.body);
    await transaction(req.db, async () => {
      const o = (
        await req.db.query(
          "SELECT * FROM escala.offers WHERE id=$1 AND status='pending' FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!o) fail(409, "Este repasse não está aguardando aprovação.");
      if (o.requested_by === req.user.id && req.user.role !== "owner")
        fail(403, "Outro administrador precisa aprovar o seu pedido de repasse.");
      const a = await Q.getAssignment(req.db, o.assignment_id);
      if (a.doctor_id !== o.from_doctor_id)
        fail(409, "O responsável por este plantão já mudou. Recuse o pedido.");
      const s = await Q.getShift(req.db, a.shift_id);
      await Q.ensureUnlocked(req.db, s.date);
      Q.ensureFuture(s);
      const d = await Q.ensureDoctor(req.db, o.requested_doctor_id);
      await Q.ensureNoOverlap(req.db, o.requested_doctor_id, s);
      await req.db.query(
        "UPDATE escala.assignments SET doctor_id=$1 WHERE id=$2",
        [o.requested_doctor_id, a.id],
      );
      await req.db.query(
        "UPDATE escala.offers SET status='accepted',to_doctor_id=$1,accepted_by=$2,accepted_at=now(),approved_by=$3,approved_at=now(),decision_note=$4 WHERE id=$5",
        [o.requested_doctor_id, o.requested_by, req.user.id, b.note || null, id],
      );
      await Q.audit(
        req.db,
        req.user,
        "offer_approved",
        `${req.user.name} aprovou o repasse: ${d.name} assumiu o plantão de ${a.doctor_name} em ${s.date.split("-").reverse().join("/")} ${s.start_time}–${s.end_time}.`,
        {
          offer_id: id, assignment_id: a.id, shift_id: s.id,
          from_doctor_id: a.doctor_id, from_name: a.doctor_name,
          to_doctor_id: o.requested_doctor_id, to_name: d.name,
          requested_by: o.requested_by, approved_by: req.user.id, note: b.note || null,
        },
        [a.doctor_id, o.requested_doctor_id],
        s.date.slice(0, 7),
      );
    });
    res.json({ ok: true });
  }),
);
app.post(
  "/api/offers/:id/reject",
  route(async (req, res) => {
    admin(req);
    const id = idOf(req);
    const b = V.z.object({ note: V.z.string().trim().min(3).max(1000) }).strict().parse(req.body);
    await transaction(req.db, async () => {
      const o = (
        await req.db.query(
          "SELECT * FROM escala.offers WHERE id=$1 AND status='pending' FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!o) fail(409, "Este repasse não está aguardando aprovação.");
      const a = await Q.getAssignment(req.db, o.assignment_id);
      const s = await Q.getShift(req.db, a.shift_id);
      await Q.ensureUnlocked(req.db, s.date);
      const d = await Q.ensureDoctor(req.db, o.requested_doctor_id).catch(() => ({ name: "Médico" }));
      await req.db.query(
        "UPDATE escala.offers SET status='open',requested_doctor_id=NULL,requested_by=NULL,requested_at=NULL,decision_note=$1 WHERE id=$2",
        [b.note, id],
      );
      await Q.audit(
        req.db,
        req.user,
        "offer_rejected",
        `${req.user.name} recusou o pedido de ${d.name} para assumir o plantão de ${a.doctor_name} em ${s.date.split("-").reverse().join("/")} ${s.start_time}. O plantão voltou a ficar disponível. Motivo: ${b.note}`,
        { offer_id: id, shift_id: s.id, requested_doctor_id: o.requested_doctor_id, note: b.note },
        [a.doctor_id, o.requested_doctor_id],
        s.date.slice(0, 7),
      );
    });
    res.json({ ok: true });
  }),
);
app.post(
  "/api/offers/:id/cancel",
  route(async (req, res) => {
    const id = idOf(req);
    await transaction(req.db, async () => {
      const o = (
        await req.db.query(
          "SELECT * FROM escala.offers WHERE id=$1 AND status IN ('open','pending') FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!o) fail(409, "Esta oferta não está mais aberta.");
      if (req.user.role === "doctor" && o.from_doctor_id !== req.user.doctor_id)
        fail(403, "Você só pode cancelar suas próprias ofertas.");
      const a = await Q.getAssignment(req.db, o.assignment_id);
      const s = await Q.getShift(req.db, a.shift_id);
      await Q.ensureUnlocked(req.db, s.date);
      await req.db.query(
        "UPDATE escala.offers SET status='cancelled',cancelled_at=now() WHERE id=$1",
        [id],
      );
      await Q.audit(
        req.db,
        req.user,
        "offer_cancelled",
        `Oferta do plantão de ${a.doctor_name} em ${s.date.split("-").reverse().join("/")} cancelada.`,
        { offer_id: id, shift_id: s.id },
        [a.doctor_id],
        s.date.slice(0, 7),
      );
    });
    res.json({ ok: true });
  }),
);
app.get(
  "/api/doctors",
  route(async (req, res) => res.json({ doctors: await Q.doctorsFor(req.db) })),
);
app.post(
  "/api/doctors",
  route(async (req, res) => {
    admin(req);
    const b = V.doctor.parse(req.body);
    const doctor = await transaction(req.db, async () => {
      const d = (
        await req.db.query(
          "INSERT INTO escala.doctors(name,crm,specialty,color,crm_uf) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [b.name, b.crm || null, b.specialty, b.color, b.crm_uf || null],
        )
      ).rows[0];
      await Q.audit(
        req.db,
        req.user,
        "doctor_created",
        `${d.name} cadastrado na equipe.`,
        { doctor_id: d.id },
        [d.id],
      );
      return { ...d, user_id: null };
    });
    res.status(201).json({ doctor });
  }),
);
app.patch(
  "/api/doctors/:id",
  route(async (req, res) => {
    admin(req);
    const id = idOf(req);
    const b = V.doctor
      .partial()
      .extend({ active: V.z.boolean().optional() })
      .parse(req.body);
    const doctor = await transaction(req.db, async () => {
      const d = (
        await req.db.query("SELECT * FROM escala.doctors WHERE id=$1", [id])
      ).rows[0];
      if (!d) fail(404, "Médico não encontrado.");
      if (
        b.active === true &&
        (
          await req.db.query(
            "SELECT 1 FROM escala.doctor_merges WHERE source_doctor_id=$1",
            [id],
          )
        ).rows.length
      )
        fail(
          409,
          "Este cadastro foi consolidado em outro médico e não pode ser reativado.",
        );
      const linked = (
        await req.db.query("SELECT role FROM escala.users WHERE doctor_id=$1", [
          id,
        ])
      ).rows[0];
      if (linked?.role === "owner" && b.active === false)
        fail(403, "O perfil médico do proprietário não pode ser desativado.");
      if (
        linked?.role === "admin" &&
        req.user.role !== "owner" &&
        b.active === false
      )
        fail(403, "Apenas o proprietário pode desativar um administrador.");
      if (b.active === false) {
        const pending = await Q.upcomingFor(req.db, id);
        if (pending.length)
          fail(
            409,
            `Este médico tem ${pending.length} plantão(ões) futuro(s). Redistribua antes de desativar.`,
            "HAS_FUTURE_SHIFTS",
            pending,
          );
        await req.db.query(
          "DELETE FROM escala.sessions WHERE user_id IN (SELECT id FROM escala.users WHERE doctor_id=$1)",
          [id],
        );
      }
      const next = { ...d, ...b };
      const result = (
        await req.db.query(
          "UPDATE escala.doctors SET name=$1,crm=$2,specialty=$3,color=$4,active=$5,crm_uf=$7 WHERE id=$6 RETURNING *",
          [next.name, next.crm, next.specialty, next.color, next.active, id,next.crm_uf],
        )
      ).rows[0];
      await Q.audit(
        req.db,
        req.user,
        "doctor_updated",
        `Cadastro de ${result.name} atualizado${result.active ? "" : "; médico inativado"}.`,
        { doctor_id: id, before: d, after: result },
        [id],
      );
      return result;
    });
    res.json({ doctor });
  }),
);
app.get(
  "/api/doctors/:id/upcoming",
  route(async (req, res) => {
    admin(req);
    res.json({ shifts: await Q.upcomingFor(req.db, idOf(req)) });
  }),
);
app.get(
  "/api/team",
  route(async (req, res) => {
    admin(req);
    const users = (
      await req.db.query(
        "SELECT id,name,email,role,doctor_id,active,approval_status,can_manage_schedule FROM escala.users ORDER BY name",
      )
    ).rows;
    const invites = (
      await req.db.query(
        "SELECT id,email,name,role,doctor_id,expires_at,accepted_at,revoked_at,kind FROM escala.invites ORDER BY created_at DESC LIMIT 200",
      )
    ).rows;
    res.json({ users, invites, mail_configured: mailConfigured() });
  }),
);
function inviteUrl(token, kind = "invite") {
  return `${(process.env.APP_URL || "http://localhost:5173").split(",")[0].replace(/\/$/, "")}/${kind === "reset" ? "redefinir" : "ativar"}?token=${encodeURIComponent(token)}`;
}
app.post(
  "/api/team/invite",
  route(async (req, res) => {
    admin(req);
    const b = V.invite.parse(req.body);
    if (b.role === "admin") owner(req);
    if (b.role === "doctor" && !b.doctor_id)
      fail(400, "Vincule a conta a um médico cadastrado.");
    const token = randomToken();
    const result = await transaction(req.db, async () => {
      if (b.doctor_id) await Q.ensureDoctor(req.db, b.doctor_id);
      if (
        (
          await req.db.query(
            "SELECT id FROM escala.users WHERE email=$1 OR (doctor_id=$2 AND $2::uuid IS NOT NULL)",
            [b.email, b.doctor_id || null],
          )
        ).rows.length
      )
        fail(
          409,
          "Este e-mail ou médico já tem acesso. Use a recuperação de senha.",
        );
      const prior = (
        await req.db.query(
          "SELECT role FROM escala.invites WHERE (email=$1 OR (doctor_id=$2 AND $2::uuid IS NOT NULL)) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()",
          [b.email, b.doctor_id || null],
        )
      ).rows;
      if (req.user.role !== "owner" && prior.some((x) => x.role !== "doctor"))
        fail(403, "Apenas o proprietário pode substituir esse convite.");
      await req.db.query(
        "UPDATE escala.invites SET revoked_at=now() WHERE (email=$1 OR (doctor_id=$2 AND $2::uuid IS NOT NULL)) AND accepted_at IS NULL AND revoked_at IS NULL",
        [b.email, b.doctor_id || null],
      );
      const inv = (
        await req.db.query(
          "INSERT INTO escala.invites(token_hash,email,name,role,doctor_id,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days') RETURNING expires_at",
          [
            digest(token),
            b.email,
            b.name,
            b.role,
            b.doctor_id || null,
            req.user.id,
          ],
        )
      ).rows[0];
      await Q.audit(
        req.db,
        req.user,
        "invite_created",
        `Convite de ${b.role === "admin" ? "administrador" : "médico"} criado para ${b.name}.`,
        { email: b.email, role: b.role, doctor_id: b.doctor_id },
      );
      return inv;
    });
    res
      .status(201)
      .json({ inviteUrl: inviteUrl(token), expires_at: result.expires_at });
  }),
);
app.post(
  "/api/team/invites/:id/revoke",
  route(async (req, res) => {
    admin(req);
    const id = idOf(req);
    await transaction(req.db, async () => {
      const i = (
        await req.db.query("SELECT * FROM escala.invites WHERE id=$1", [id])
      ).rows[0];
      if (!i) fail(404, "Convite não encontrado.");
      if (i.role !== "doctor") owner(req);
      if (i.accepted_at)
        fail(409, "O convite já foi utilizado. Gerencie o acesso pela equipe.");
      await req.db.query(
        "UPDATE escala.invites SET revoked_at=now() WHERE id=$1",
        [id],
      );
      await Q.audit(
        req.db,
        req.user,
        "invite_revoked",
        `Convite de ${i.name} revogado.`,
        { invite_id: id },
      );
    });
    res.json({ ok: true });
  }),
);
app.patch(
  "/api/team/:id",
  route(async (req, res) => {
    owner(req);
    const id = idOf(req);
    const b = V.z
      .object({
        role: V.z.enum(["admin", "doctor"]).optional(),
        active: V.z.boolean().optional(),
        doctor_id: V.uuid.nullable().optional(),
      })
      .parse(req.body);
    await transaction(req.db, async () => {
      const u = (
        await req.db.query(
          "SELECT id,name,role,active,doctor_id,approval_status,can_manage_schedule FROM escala.users WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!u) fail(404, "Conta não encontrada.");
      if(u.approval_status!=='approved')fail(409,'Confira o cadastro pela fila de inscrições antes de alterar o acesso.');
      if (u.role === "owner" || u.id === req.user.id)
        fail(
          403,
          "O acesso do proprietário não pode ser alterado por esta tela.",
        );
      const n = { ...u, ...b };
      if (n.role === "doctor" && !n.doctor_id)
        fail(
          400,
          "Uma conta de médico deve estar vinculada a um médico cadastrado.",
        );
      if (n.doctor_id) await Q.ensureDoctor(req.db, n.doctor_id);
      await req.db.query(
        "UPDATE escala.users SET role=$1,active=$2,doctor_id=$3 WHERE id=$4",
        [n.role, n.active, n.doctor_id, id],
      );
      await req.db.query("DELETE FROM escala.sessions WHERE user_id=$1", [id]);
      await req.db.query(
        "UPDATE escala.invites SET revoked_at=now() WHERE email=(SELECT email FROM escala.users WHERE id=$1) AND accepted_at IS NULL AND revoked_at IS NULL",
        [id],
      );
      await Q.audit(
        req.db,
        req.user,
        "access_updated",
        `Permissões de ${u.name} atualizadas; sessões anteriores encerradas.`,
        { user_id: id, before: u, after: n },
      );
    });
    res.json({ ok: true });
  }),
);
app.post(
  "/api/team/:id/reset",
  route(async (req, res) => {
    admin(req);
    const id = idOf(req);
    const token = randomToken();
    const result = await transaction(req.db, async () => {
      const u = (
        await req.db.query(
          "SELECT * FROM escala.users WHERE id=$1 AND active",
          [id],
        )
      ).rows[0];
      if (!u) fail(404, "Conta ativa não encontrada.");
      if (u.role !== "doctor") owner(req);
      await req.db.query(
        "UPDATE escala.invites SET revoked_at=now() WHERE email=$1 AND accepted_at IS NULL AND revoked_at IS NULL",
        [u.email],
      );
      const i = (
        await req.db.query(
          "INSERT INTO escala.invites(token_hash,email,name,role,doctor_id,created_by,kind,expires_at) VALUES($1,$2,$3,$4,$5,$6,'reset',now()+interval '24 hours') RETURNING expires_at",
          [digest(token), u.email, u.name, u.role, u.doctor_id, req.user.id],
        )
      ).rows[0];
      await Q.audit(
        req.db,
        req.user,
        "recovery_created",
        `Link de recuperação criado para ${u.name}.`,
        { user_id: id },
      );
      return i;
    });
    res.json({
      inviteUrl: inviteUrl(token, "reset"),
      expires_at: result.expires_at,
    });
  }),
);
// Creates a one-use recovery link; returns what is needed to e-mail it.
async function createReset(req, u, minutes, actor) {
  const token = randomToken();
  await req.db.query(
    "UPDATE escala.invites SET revoked_at=now() WHERE email=$1 AND kind='reset' AND accepted_at IS NULL AND revoked_at IS NULL",
    [u.email],
  );
  await req.db.query(
    "INSERT INTO escala.invites(token_hash,email,name,role,doctor_id,created_by,kind,expires_at) VALUES($1,$2,$3,$4,$5,$6,'reset',now()+($7||' minutes')::interval)",
    [digest(token), u.email, u.name, u.role, u.doctor_id, actor || null, String(minutes)],
  );
  return inviteUrl(token, "reset");
}
const FORGOT_MINUTES = 60;
app.post(
  "/api/team/:id/send-reset",
  route(async (req, res) => {
    admin(req);
    const id = idOf(req);
    if (!mailConfigured())
      fail(503, "O envio de e-mail ainda não está configurado.", "MAIL_NOT_CONFIGURED");
    const u = (
      await req.db.query("SELECT * FROM escala.users WHERE id=$1 AND active", [id])
    ).rows[0];
    if (!u) fail(404, "Conta ativa não encontrada.");
    if (u.role !== "doctor") owner(req);
    const url = await transaction(req.db, async () => {
      const link = await createReset(req, u, FORGOT_MINUTES, req.user.id);
      await Q.audit(req.db, req.user, "recovery_emailed", `Link de recuperação enviado por e-mail para ${u.name}.`, { user_id: id });
      return link;
    });
    const result = await sendMail({ to: u.email, ...resetEmail({ name: u.name, url, minutes: FORGOT_MINUTES }) });
    if (!result.sent)
      fail(502, "Não foi possível enviar o e-mail agora. Tente novamente ou copie o link de recuperação.", "MAIL_FAILED");
    res.json({ ok: true, email: u.email });
  }),
);
app.post(
  "/api/team/:id/password",
  route(async (req, res) => {
    admin(req);
    const id = idOf(req);
    const b = V.z.object({ password: V.password }).strict().parse(req.body);
    if (id === req.user.id)
      fail(400, "Para trocar a sua própria senha, use o seu perfil.");
    const hash = await hashPassword(b.password);
    await transaction(req.db, async () => {
      const u = (
        await req.db.query("SELECT * FROM escala.users WHERE id=$1 AND active", [id])
      ).rows[0];
      if (!u) fail(404, "Conta ativa não encontrada.");
      if (u.role !== "doctor") owner(req);
      await req.db.query("UPDATE escala.users SET password_hash=$1 WHERE id=$2", [hash, id]);
      await req.db.query("DELETE FROM escala.sessions WHERE user_id=$1", [id]);
      await req.db.query(
        "UPDATE escala.invites SET revoked_at=now() WHERE email=$1 AND kind='reset' AND accepted_at IS NULL AND revoked_at IS NULL",
        [u.email],
      );
      await Q.audit(
        req.db,
        req.user,
        "password_set_by_admin",
        `${req.user.name} definiu uma nova senha para ${u.name}; sessões anteriores encerradas.`,
        { user_id: id },
        u.doctor_id ? [u.doctor_id] : [],
      );
    });
    res.json({ ok: true });
  }),
);
app.get(
  "/api/reports",
  route(async (req, res) =>
    res.json(await Q.reportFor(req.db, monthOf(req), req.user)),
  ),
);
app.get(
  "/api/schedule/export",
  route(async (req, res) => {
    const m = monthOf(req);
    if (req.user.role === "doctor" && req.query.scope === "all")
      fail(403, "A exportação geral é exclusiva da administração.");
    // Doctors receive only their own participations, in the same layout as the full schedule.
    const individual = req.user.role === "doctor";
    let shifts = await Q.shiftsFor(req.db, m);
    if (individual)
      shifts = shifts
        .filter((s) => s.assignments.some((a) => a.doctor_id === req.user.doctor_id))
        .map((s) => ({
          ...s,
          assignments: s.assignments.filter((a) => a.doctor_id === req.user.doctor_id),
        }));
    const pdf = await schedulePdf(m, shifts, individual ? { subtitle: `Escala individual · ${req.user.name}` } : {});
    res
      .type("application/pdf")
      .attachment(`escala-${m}${individual ? "-individual" : ""}.pdf`)
      .send(pdf);
  }),
);
app.get(
  "/api/reports/export",
  route(async (req, res) => {
    const m = monthOf(req);
    if(req.user.role==='doctor'&&req.query.scope==='all')fail(403,'A exportação geral é exclusiva da administração.');
    const report = await Q.reportFor(req.db, m, req.user);
    const lines = [
      [
        "Médico",
        "CRM",
        "Mês",
        "Turnos",
        "Horas",
        "Dias de plantão",
        "Manhã",
        "Tarde",
        "Noite",
        "Madrugada",
        "Situação",
      ],
      ...report.rows.map((r) => [
        r.name,
        r.crm,
        m,
        r.turns,
        r.hours,
        r.days.map((d) => d.split("-").reverse().join("/")).join(" • "),
        r.morning,
        r.afternoon,
        r.night,
        r.dawn,
        report.locked ? "Fechado" : "Em aberto",
      ]),
    ];
    res
      .type("text/csv; charset=utf-8")
      .attachment(`escala-${m}.csv`)
      .send(
        "\uFEFF" + lines.map((row) => row.map(csvCell).join(";")).join("\r\n"),
      );
  }),
);
app.post(
  "/api/months/:month/lock",
  route(async (req, res) => {
    admin(req);
    const m = V.month.parse(req.params.month);
    const b = V.z
      .object({
        locked: V.z.boolean(),
        reason: V.z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    if (!b.locked) {
      owner(req);
      if (!b.reason || b.reason.length < 3)
        fail(400, "Informe o motivo da reabertura.");
    }
    await transaction(req.db, async () => {
      if (b.locked) {
        const reservations=(await req.db.query("SELECT count(*)::int n FROM escala.vacancy_requests r JOIN escala.shifts s ON s.id=r.shift_id WHERE r.status='pending' AND to_char(s.date,'YYYY-MM')=$1 AND s.cancelled_at IS NULL",[m])).rows[0].n;
        if(reservations)fail(409,`Há ${reservations} solicitação(ões) de vaga pendente(s). Decida antes de fechar o mês.`);
        const unresolved = (
          await req.db.query(
            `SELECT count(*)::int count FROM escala.imports i,
    jsonb_array_elements(COALESCE(i.summary->'uncertainties','[]'::jsonb)) issue
    WHERE i.summary->>'month'=$1 AND NOT EXISTS (SELECT 1 FROM escala.import_reviews r WHERE r.issue_id=i.sha256||':'||(issue->>'id'))`,
            [m],
          )
        ).rows[0].count;
        if (unresolved)
          fail(
            409,
            `Há ${unresolved} pendência(s) na conferência do PDF. Resolva na página Equipe antes de fechar o mês.`,
          );
        const pending = (
          await req.db.query(
            "SELECT count(*)::int count FROM escala.shifts WHERE to_char(date,'YYYY-MM')=$1 AND needs_review AND cancelled_at IS NULL",
            [m],
          )
        ).rows[0].count;
        if (pending)
          fail(
            409,
            `Há ${pending} plantão(ões) com revisão pendente. Confira os dados importados antes de fechar o mês.`,
          );
        const open = (
          await req.db.query(
            "SELECT count(*)::int count FROM escala.offers o JOIN escala.assignments a ON a.id=o.assignment_id JOIN escala.shifts s ON s.id=a.shift_id WHERE to_char(s.date,'YYYY-MM')=$1 AND o.status IN ('open','pending')",
            [m],
          )
        ).rows[0].count;
        if (open)
          fail(
            409,
            `Há ${open} oferta(s) aberta(s). Resolva ou cancele antes de fechar o mês.`,
          );
      }
      await req.db.query(
        "INSERT INTO escala.months(month,locked,locked_by) VALUES($1,$2,$3) ON CONFLICT(month) DO UPDATE SET locked=$2,locked_by=$3,updated_at=now()",
        [m, b.locked, req.user.id],
      );
      await Q.audit(
        req.db,
        req.user,
        b.locked ? "month_closed" : "month_reopened",
        `Mês ${m} ${b.locked ? "fechado" : "reaberto"}${b.reason ? ". Motivo: " + b.reason : "."}`,
        { month: m, reason: b.reason },
        [],
        m,
      );
    });
    res.json({ ok: true });
  }),
);
app.get(
  "/api/audit",
  route(async (req, res) =>
    res.json({ audit: await Q.auditFor(req.db, monthOf(req), req.user) }),
  ),
);
app.use("/api", reviewRouter);
app.use("/api", workflowRouter);
app.use("/api", createGenerateRouter({ admin, scheduleManager }));
app.use("/api", (req, res) =>
  res.status(404).json({ error: "Rota não encontrada." }),
);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof V.z.ZodError)
    return res
      .status(400)
      .json({
        error: err.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(" "),
        code: "VALIDATION",
      });
  if (err.code === "23505")
    return res
      .status(409)
      .json({
        error: "Este registro já existe ou esta oferta já está aberta.",
        code: "CONFLICT",
      });
  if (err.code === "23503")
    return res
      .status(400)
      .json({ error: "Um dos registros informados não existe." });
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ error: "Dados JSON inválidos." });
  const status = err.status || 503;
  if (status >= 500)
    console.error(
      "API error",
      err.code || err.name,
      err.message?.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[redacted]"),
    );
  res
    .status(status)
    .json({
      error:
        status >= 500
          ? "Não foi possível conectar ao serviço. Tente novamente em instantes."
          : err.message,
      code: err.status ? err.code : undefined,
      details: err.status ? err.details : undefined,
    });
});
