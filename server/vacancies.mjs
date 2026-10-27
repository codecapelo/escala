import { Router } from "express";
import { transaction } from "./db.mjs";
import { fail, shiftStart } from "./security.mjs";
import * as Q from "./queries.mjs";
import * as V from "./validation.mjs";
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const snapshot = (s) => ({
  date: s.date,
  start_time: s.start_time,
  end_time: s.end_time,
  period: s.period,
  unit: s.unit,
});
export async function staffing(db, shiftId) {
  const { rows } = await db.query(
    `SELECT s.capacity,
 (SELECT count(*)::int FROM escala.assignments a WHERE a.shift_id=s.id AND a.removed_at IS NULL) assigned,
 (SELECT count(*)::int FROM escala.vacancy_requests r WHERE r.shift_id=s.id AND r.status='pending') pending
 FROM escala.shifts s WHERE s.id=$1`,
    [shiftId],
  );
  const s = rows[0];
  return {
    ...s,
    available:
      s.capacity === null
        ? 0
        : Math.max(0, s.capacity - s.assigned - s.pending),
  };
}
export async function ensureCapacity(db, shiftId, excludeRequest = null) {
  const s = await staffing(db, shiftId);
  if (
    s.capacity !== null &&
    s.assigned + s.pending - (excludeRequest ? 1 : 0) >= s.capacity
  )
    fail(
      409,
      "Este plantão não tem vaga disponível. Confira as solicitações pendentes.",
      "NO_VACANCY",
    );
}
export async function cancelVacancyRequests(db, shiftId) {
  await db.query(
    "UPDATE escala.vacancy_requests SET status='cancelled',decided_at=now(),decision_note='Plantão alterado ou cancelado; solicite novamente.' WHERE shift_id=$1 AND status='pending'",
    [shiftId],
  );
}
export function vacancyRouter({ admin, monthOf }) {
  const router = Router();
  router.get(
    "/vacancy-requests",
    route(async (req, res) => {
      const month = monthOf(req);
      const id = req.query.shift_id ? V.uuid.parse(req.query.shift_id) : null;
      const rows = (
        await req.db.query(
          `SELECT r.id,r.shift_id,r.doctor_id,r.user_id,r.status,r.created_at,r.decided_at,r.decision_note,
 d.name doctor_name,s.date::text,to_char(s.start_time,'HH24:MI') start_time,to_char(s.end_time,'HH24:MI') end_time,s.period,s.unit
 FROM escala.vacancy_requests r JOIN escala.doctors d ON d.id=r.doctor_id JOIN escala.shifts s ON s.id=r.shift_id
 WHERE ($1::boolean OR r.user_id=$2) AND ($3::uuid IS NULL OR s.id=$3)
 AND s.date>=($4||'-01')::date AND s.date<(($4||'-01')::date+interval '1 month') ORDER BY r.created_at DESC`,
          [req.user.role !== "doctor", req.user.id, id, month],
        )
      ).rows;
      res.json({ requests: rows });
    }),
  );
  router.post(
    "/shifts/:id/vacancy-requests",
    route(async (req, res) => {
      const id = V.uuid.parse(req.params.id);
      if (!req.user.doctor_id)
        fail(403, "Vincule seu cadastro médico antes de solicitar uma vaga.");
      const request = await transaction(req.db, async () => {
        const s = await Q.getShift(req.db, id);
        await Q.ensureUnlocked(req.db, s.date);
        if (shiftStart(s) <= new Date())
          fail(409, "Só é possível solicitar vagas de plantões futuros.");
        await Q.ensureDoctor(req.db, req.user.doctor_id);
        if (
          (
            await req.db.query(
              "SELECT 1 FROM escala.assignments WHERE shift_id=$1 AND doctor_id=$2 AND removed_at IS NULL",
              [id, req.user.doctor_id],
            )
          ).rowCount
        )
          fail(409, "Você já está neste plantão.");
        if (
          (
            await req.db.query(
              "SELECT 1 FROM escala.vacancy_requests WHERE shift_id=$1 AND doctor_id=$2 AND status='pending'",
              [id, req.user.doctor_id],
            )
          ).rowCount
        )
          fail(409, "Sua solicitação já está pendente.");
        const counts = await staffing(req.db, id);
        if (counts.available < 1)
          fail(409, "Não há vagas disponíveis neste plantão.", "NO_VACANCY");
        await Q.ensureNoOverlap(req.db, req.user.doctor_id, s);
        const conflicting = (
          await req.db.query(
            `SELECT 1 FROM escala.vacancy_requests r JOIN escala.shifts sh ON sh.id=r.shift_id WHERE r.doctor_id=$1 AND r.status='pending' AND sh.cancelled_at IS NULL
   AND sh.date+sh.start_time < $2::date+$4::time+CASE WHEN $4::time<=$3::time THEN interval '1 day' ELSE interval '0 days' END
   AND sh.date+sh.end_time+CASE WHEN sh.end_time<=sh.start_time THEN interval '1 day' ELSE interval '0 days' END > $2::date+$3::time`,
            [req.user.doctor_id, s.date, s.start_time, s.end_time],
          )
        ).rowCount;
        if (conflicting)
          fail(
            409,
            "Você já tem uma solicitação pendente nesse horário.",
            "OVERLAP",
          );
        const r = (
          await req.db.query(
            "INSERT INTO escala.vacancy_requests(shift_id,doctor_id,user_id,snapshot) VALUES($1,$2,$3,$4) RETURNING id,status",
            [id, req.user.doctor_id, req.user.id, snapshot(s)],
          )
        ).rows[0];
        await Q.audit(
          req.db,
          req.user,
          "vacancy_requested",
          `${req.user.name} solicitou uma vaga em ${s.date} às ${s.start_time}; aguardando aprovação administrativa.`,
          { request_id: r.id, shift_id: id },
          [req.user.doctor_id],
          s.date.slice(0, 7),
        );
        return r;
      });
      res.status(201).json({ request });
    }),
  );
  for (const action of ["approve", "reject", "cancel"])
    router.post(
      `/vacancy-requests/:id/${action}`,
      route(async (req, res) => {
        const id = V.uuid.parse(req.params.id);
        if (action !== "cancel") admin(req);
        const b = V.z
          .object({ note: V.z.string().trim().max(1000).optional() })
          .strict()
          .parse(req.body);
        await transaction(req.db, async () => {
          const r = (
            await req.db.query(
              "SELECT * FROM escala.vacancy_requests WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
          if (!r) fail(404, "Solicitação não encontrada.");
          if (action === "cancel" && r.user_id !== req.user.id)
            fail(403, "Você só pode cancelar sua própria solicitação.");
          if (r.status !== "pending")
            fail(409, "Esta solicitação já foi decidida.");
          const s = await Q.getShift(req.db, r.shift_id);
          await Q.ensureUnlocked(req.db, s.date);
          let assignment = null;
          if (action === "approve") {
            if (shiftStart(s) <= new Date())
              fail(409, "Este plantão já começou.");
            if (
              Object.entries(snapshot(s)).some(([k, v]) => r.snapshot[k] !== v)
            )
              fail(
                409,
                "O plantão mudou; cancele a solicitação e peça uma nova.",
                "STALE_REQUEST",
              );
            const u = (
              await req.db.query("SELECT * FROM escala.users WHERE id=$1", [
                r.user_id,
              ])
            ).rows[0];
            if (
              !u?.active ||
              u.approval_status !== "approved" ||
              u.doctor_id !== r.doctor_id
            )
              fail(409, "O cadastro do solicitante mudou.");
            await Q.ensureDoctor(req.db, r.doctor_id);
            await Q.ensureNoOverlap(req.db, r.doctor_id, s);
            await ensureCapacity(req.db, s.id, r.id);
            assignment = (
              await req.db.query(
                "INSERT INTO escala.assignments(shift_id,doctor_id) VALUES($1,$2) RETURNING id",
                [s.id, r.doctor_id],
              )
            ).rows[0].id;
          }
          const status = {
            approve: "approved",
            reject: "rejected",
            cancel: "cancelled",
          }[action];
          await req.db.query(
            "UPDATE escala.vacancy_requests SET status=$1,decided_at=now(),decided_by=$2,decision_note=$3,assignment_id=$4 WHERE id=$5",
            [status, req.user.id, b.note || null, assignment, id],
          );
          await Q.audit(
            req.db,
            req.user,
            `vacancy_${status}`,
            `Solicitação de vaga ${action === "approve" ? "aprovada" : action === "reject" ? "recusada" : "cancelada"}.`,
            { request_id: id, shift_id: s.id, assignment_id: assignment },
            [r.doctor_id],
            s.date.slice(0, 7),
          );
        });
        res.json({ ok: true });
      }),
    );
  return router;
}
