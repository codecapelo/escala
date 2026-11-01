import { Router } from "express";
import { transaction } from "./db.mjs";
import { fail, shiftStart, shiftHours } from "./security.mjs";
import * as Q from "./queries.mjs";
import * as V from "./validation.mjs";
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
// Waiting entries whose doctor already got a place in the shift are no longer waiting.
export const WAITING = `w.status='waiting' AND NOT EXISTS(SELECT 1 FROM escala.assignments x WHERE x.shift_id=w.shift_id AND x.doctor_id=w.doctor_id AND x.removed_at IS NULL)
 AND EXISTS(SELECT 1 FROM escala.doctors dd WHERE dd.id=w.doctor_id AND dd.active)`;
const shiftEnd = (s) => new Date(shiftStart(s).getTime() + shiftHours(s) * 3600000);
export function waitlistRouter({ admin }) {
  const router = Router();
  router.get(
    "/shifts/:id/waitlist",
    route(async (req, res) => {
      const id = V.uuid.parse(req.params.id);
      await Q.getShift(req.db, id);
      const entries = (
        await req.db.query(
          `SELECT w.id,w.doctor_id,d.name doctor_name,w.note,w.created_at FROM escala.waitlist w
 JOIN escala.doctors d ON d.id=w.doctor_id WHERE w.shift_id=$1 AND ${WAITING} ORDER BY w.priority DESC,w.created_at,w.id`,
          [id],
        )
      ).rows.map((e, i) => ({ ...e, position: i + 1 }));
      const assigned =
        !!req.user.doctor_id &&
        (
          await req.db.query(
            "SELECT 1 FROM escala.assignments WHERE shift_id=$1 AND doctor_id=$2 AND removed_at IS NULL",
            [id, req.user.doctor_id],
          )
        ).rows.length > 0;
      const visible =
        req.user.role !== "doctor" || assigned
          ? entries
          : entries.filter((e) => e.doctor_id === req.user.doctor_id);
      res.json({ entries: visible, count: entries.length });
    }),
  );
  router.post(
    "/shifts/:id/waitlist",
    route(async (req, res) => {
      const id = V.uuid.parse(req.params.id);
      const { note } = V.z
        .object({ note: V.z.string().trim().max(500).default("") })
        .strict()
        .parse(req.body);
      if (!req.user.doctor_id)
        fail(403, "Vincule seu cadastro médico antes de entrar na lista de espera.");
      const entry = await transaction(req.db, async () => {
        const s = await Q.getShift(req.db, id);
        await Q.ensureUnlocked(req.db, s.date);
        const d = await Q.ensureDoctor(req.db, req.user.doctor_id);
        if (shiftEnd(s) <= new Date())
          fail(409, "Este plantão já terminou.", "SHIFT_ENDED");
        if (s.capacity === null || s.capacity === undefined)
          fail(409, "Este plantão não tem número de vagas definido.", "NO_CAPACITY");
        if (
          (
            await req.db.query(
              "SELECT 1 FROM escala.assignments WHERE shift_id=$1 AND doctor_id=$2 AND removed_at IS NULL",
              [id, d.id],
            )
          ).rows.length
        )
          fail(409, "Você já está neste plantão.", "ALREADY_ASSIGNED");
        const staffing = (
          await req.db.query(
            `SELECT (SELECT count(*)::int FROM escala.assignments a WHERE a.shift_id=$1 AND a.removed_at IS NULL) assigned,
 (SELECT count(*)::int FROM escala.vacancy_requests r WHERE r.shift_id=$1 AND r.status='pending') pending`,
            [id],
          )
        ).rows[0];
        if (staffing.assigned + staffing.pending < s.capacity)
          fail(409, "Este plantão ainda tem vaga livre. Solicite a vaga em vez de entrar na espera.", "VACANCY_AVAILABLE");
        await Q.ensureNoOverlap(req.db, d.id, s);
        const w = (
          await req.db.query(
            "INSERT INTO escala.waitlist(shift_id,doctor_id,user_id,note) VALUES($1,$2,$3,$4) RETURNING id,created_at",
            [id, d.id, req.user.id, note],
          )
        ).rows[0];
        await Q.audit(
          req.db,
          req.user,
          "waitlist_joined",
          `${d.name} entrou na lista de espera do plantão de ${s.date.split("-").reverse().join("/")} ${s.start_time}.`,
          { waitlist_id: w.id, shift_id: id },
          [d.id],
          s.date.slice(0, 7),
        );
        return w;
      });
      res.status(201).json({ entry });
    }),
  );
  router.post(
    "/waitlist/:id/cancel",
    route(async (req, res) => {
      const id = V.uuid.parse(req.params.id);
      V.z.object({}).strict().parse(req.body);
      await transaction(req.db, async () => {
        const w = (
          await req.db.query(
            "SELECT * FROM escala.waitlist WHERE id=$1 AND status='waiting' FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!w) fail(409, "Esta entrada já não está na lista de espera.");
        if (req.user.role === "doctor" && w.user_id !== req.user.id)
          fail(403, "Você só pode sair da sua própria entrada.");
        const s = await Q.getShift(req.db, w.shift_id);
        await Q.ensureUnlocked(req.db, s.date);
        await req.db.query(
          "UPDATE escala.waitlist SET status='cancelled',cancelled_at=now() WHERE id=$1",
          [id],
        );
        await Q.audit(
          req.db,
          req.user,
          "waitlist_left",
          `Saída da lista de espera do plantão de ${s.date.split("-").reverse().join("/")} ${s.start_time}.`,
          { waitlist_id: id, shift_id: s.id },
          [w.doctor_id],
          s.date.slice(0, 7),
        );
      });
      res.json({ ok: true });
    }),
  );
  void admin;
  return router;
}
