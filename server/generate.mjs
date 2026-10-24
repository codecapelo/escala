import { Router } from "express";
import { randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { fail } from "./security.mjs";
import * as V from "./validation.mjs";
import * as Q from "./queries.mjs";
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const MAX_SHIFTS = 600;
const addDays = (date, n) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
export const monthDates = (month) => {
  const out = [];
  for (let d = `${month}-01`; d.slice(0, 7) === month; d = addDays(d, 1))
    out.push(d);
  return out;
};
const sunday = (date) => addDays(date, -weekdayOf(date));
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const interval = (date, start, end) => {
  const base = Date.parse(`${date}T00:00:00Z`) / 60000;
  const s = base + minutes(start);
  return [s, base + minutes(end) + (minutes(end) <= minutes(start) ? 1440 : 0)];
};
// Live shifts between two dates, with the doctors currently assigned.
async function shiftsBetween(db, from, to) {
  return (
    await db.query(
      `SELECT s.id,s.date::text,to_char(s.start_time,'HH24:MI') start_time,to_char(s.end_time,'HH24:MI') end_time,
 s.period,s.unit,s.notes,
 COALESCE((SELECT json_agg(a.doctor_id ORDER BY a.created_at,a.id) FROM escala.assignments a WHERE a.shift_id=s.id AND a.removed_at IS NULL),'[]') doctor_ids
 FROM escala.shifts s WHERE s.date BETWEEN $1 AND $2 AND s.cancelled_at IS NULL ORDER BY s.date,s.start_time,s.unit`,
      [from, to],
    )
  ).rows;
}
const slotOf = (s) => ({
  date: s.date,
  weekday: weekdayOf(s.date),
  start_time: s.start_time,
  end_time: s.end_time,
  period: s.period,
  unit: s.unit,
  notes: s.notes || "",
  doctor_ids: s.doctor_ids,
});
// The n-th weekday of the target month maps to the n-th same weekday of the source month,
// falling back to the last one, so weekdays are always preserved.
function monthMapper(slots, sourceMonth, targetMonth) {
  const sourceDates = monthDates(sourceMonth);
  const byDate = new Map();
  for (const s of slots) byDate.set(s.date, [...(byDate.get(s.date) || []), s]);
  return (date) => {
    const wd = weekdayOf(date);
    const nth = Math.floor((Number(date.slice(8)) - 1) / 7);
    const same = sourceDates.filter((d) => weekdayOf(d) === wd);
    return byDate.get(same[Math.min(nth, same.length - 1)]) || [];
  };
}
async function resolvePlan(db, targetMonth, source) {
  let slots, label, mapper;
  if (source.type === "month" || source.type === "previous_month") {
    const m =
      source.type === "month" ? source.month : shiftMonthStr(targetMonth, -1);
    if (m === targetMonth)
      fail(400, "Escolha um mês de origem diferente do mês de destino.");
    const first = `${m}-01`,
      last = monthDates(m).at(-1);
    slots = (await shiftsBetween(db, first, last)).map(slotOf);
    label = `mês ${m}`;
    mapper = monthMapper(slots, m, targetMonth);
  } else if (source.type === "week") {
    const start = sunday(source.date);
    slots = (await shiftsBetween(db, start, addDays(start, 6))).map(slotOf);
    label = `semana de ${start}`;
    mapper = (date) => slots.filter((s) => s.weekday === weekdayOf(date));
  } else {
    const t = (
      await db.query("SELECT * FROM escala.schedule_templates WHERE id=$1", [
        source.template_id,
      ])
    ).rows[0];
    if (!t) fail(404, "Modelo não encontrado.");
    slots = t.slots;
    label = `modelo “${t.name}”`;
    mapper =
      t.kind === "week"
        ? (date) => slots.filter((s) => s.weekday === weekdayOf(date))
        : monthMapper(slots, t.source_ref, targetMonth);
  }
  if (!slots.length)
    fail(
      409,
      "A origem escolhida não tem plantões para copiar.",
      "EMPTY_SOURCE",
    );
  const planned = [];
  for (const date of monthDates(targetMonth))
    for (const s of mapper(date)) planned.push({ ...s, date });
  return { planned, label };
}
function shiftMonthStr(month, delta) {
  const d = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + delta, 1),
  );
  return d.toISOString().slice(0, 7);
}
const sourceSchema = V.z.discriminatedUnion("type", [
  V.z.object({ type: V.z.literal("previous_month") }).strict(),
  V.z.object({ type: V.z.literal("month"), month: V.month }).strict(),
  V.z.object({ type: V.z.literal("week"), date: V.date }).strict(),
  V.z.object({ type: V.z.literal("template"), template_id: V.uuid }).strict(),
]);
export function createGenerateRouter({ admin, scheduleManager }) {
  const router = Router();
  router.get(
    "/templates",
    route(async (req, res) => {
      const { rows } = await req.db.query(
        `SELECT t.id,t.name,t.kind,t.source_ref,t.created_at,u.name created_by_name,
 jsonb_array_length(t.slots) shifts FROM escala.schedule_templates t LEFT JOIN escala.users u ON u.id=t.created_by ORDER BY lower(t.name)`,
      );
      res.json({ templates: rows });
    }),
  );
  router.post(
    "/templates",
    route(async (req, res) => {
      scheduleManager(req);
      const b = V.z
        .discriminatedUnion("kind", [
          V.z
            .object({
              name: V.text(80),
              kind: V.z.literal("week"),
              date: V.date,
            })
            .strict(),
          V.z
            .object({
              name: V.text(80),
              kind: V.z.literal("month"),
              month: V.month,
            })
            .strict(),
        ])
        .parse(req.body);
      const template = await transaction(req.db, async () => {
        let ref, shifts;
        if (b.kind === "week") {
          ref = sunday(b.date);
          shifts = await shiftsBetween(req.db, ref, addDays(ref, 6));
        } else {
          ref = b.month;
          shifts = await shiftsBetween(
            req.db,
            `${b.month}-01`,
            monthDates(b.month).at(-1),
          );
        }
        if (!shifts.length)
          fail(
            409,
            "Não há plantões nesse período para salvar como modelo.",
            "EMPTY_SOURCE",
          );
        const t = (
          await req.db.query(
            "INSERT INTO escala.schedule_templates(name,kind,source_ref,slots,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,kind,source_ref,created_at",
            [
              b.name,
              b.kind,
              ref,
              JSON.stringify(shifts.map(slotOf)),
              req.user.id,
            ],
          )
        ).rows[0];
        await Q.audit(
          req.db,
          req.user,
          "template_saved",
          `Modelo de escala “${t.name}” salvo (${b.kind === "week" ? "semana" : "mês"} ${ref}, ${shifts.length} plantões).`,
          { template_id: t.id, kind: b.kind, source_ref: ref },
        );
        return { ...t, shifts: shifts.length };
      });
      res.status(201).json({ template });
    }),
  );
  router.delete(
    "/templates/:id",
    route(async (req, res) => {
      admin(req);
      const id = V.uuid.parse(req.params.id);
      await transaction(req.db, async () => {
        const t = (
          await req.db.query(
            "DELETE FROM escala.schedule_templates WHERE id=$1 RETURNING name",
            [id],
          )
        ).rows[0];
        if (!t) fail(404, "Modelo não encontrado.");
        await Q.audit(
          req.db,
          req.user,
          "template_deleted",
          `Modelo de escala “${t.name}” excluído.`,
          { template_id: id },
        );
      });
      res.json({ ok: true });
    }),
  );
  router.post(
    "/schedule/generate",
    route(async (req, res) => {
      scheduleManager(req);
      const b = V.z
        .object({
          target_month: V.month,
          source: sourceSchema,
          dry_run: V.z.boolean().default(false),
          allow_existing: V.z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
      const result = await transaction(req.db, async () => {
        const month = b.target_month,
          first = `${month}-01`,
          last = monthDates(month).at(-1);
        await Q.ensureUnlocked(req.db, first);
        const existing = await shiftsBetween(
          req.db,
          addDays(first, -1),
          addDays(last, 1),
        );
        const inMonth = existing.filter((s) => s.date.slice(0, 7) === month);
        if (inMonth.length && !b.allow_existing)
          fail(
            409,
            `${month} já tem ${inMonth.length} plantão(ões). Confirme para adicionar mesmo assim.`,
            "MONTH_NOT_EMPTY",
            { shifts: inMonth.length },
          );
        const { planned, label } = await resolvePlan(req.db, month, b.source);
        if (planned.length > MAX_SHIFTS)
          fail(
            400,
            `A geração criaria ${planned.length} plantões; o limite é ${MAX_SHIFTS}.`,
          );
        const doctorIds = [...new Set(planned.flatMap((s) => s.doctor_ids))];
        const doctors = new Map(
          (
            await req.db.query(
              `SELECT d.id,d.name,d.active,EXISTS(SELECT 1 FROM escala.doctor_merges m WHERE m.source_doctor_id=d.id) merged
 FROM escala.doctors d WHERE d.id=ANY($1::uuid[])`,
              [doctorIds],
            )
          ).rows.map((d) => [d.id, d]),
        );
        // Busy intervals per doctor, from live assignments around the target month.
        const busy = new Map();
        const addBusy = (doctor, iv) =>
          busy.set(doctor, [...(busy.get(doctor) || []), iv]);
        for (const s of existing)
          for (const id of s.doctor_ids)
            addBusy(id, interval(s.date, s.start_time, s.end_time));
        const keyOf = (s) =>
          [s.date, s.start_time, s.end_time, s.period, s.unit].join("|");
        const reuse = new Map(existing.map((s) => [keyOf(s), s]));
        const skipped = [];
        const newShifts = [],
          newAssignments = [];
        const shiftIdByKey = new Map();
        for (const s of planned) {
          const key = keyOf(s);
          const live = reuse.get(key);
          const iv = interval(s.date, s.start_time, s.end_time);
          const ok = [];
          for (const id of s.doctor_ids) {
            if (live?.doctor_ids.includes(id)) continue;
            const d = doctors.get(id);
            const why =
              !d || !d.active || d.merged
                ? "cadastro inativo ou consolidado"
                : (busy.get(id) || []).some(([a, z]) => a < iv[1] && z > iv[0])
                  ? "já tem plantão sobreposto"
                  : null;
            if (why)
              skipped.push({
                date: s.date,
                start_time: s.start_time,
                doctor: d?.name || "Médico removido",
                reason: why,
              });
            else {
              ok.push(id);
              addBusy(id, iv);
            }
          }
          if (!ok.length && s.doctor_ids.length) continue;
          let shiftId = live?.id || shiftIdByKey.get(key);
          if (!shiftId) {
            shiftId = randomUUID();
            shiftIdByKey.set(key, shiftId);
            newShifts.push({ id: shiftId, ...s });
          }
          for (const id of ok) newAssignments.push([shiftId, id]);
        }
        const summary = {
          shifts: newShifts.length,
          assignments: newAssignments.length,
          skipped: skipped.length,
          source: label,
        };
        if (b.dry_run)
          return {
            ...summary,
            skipped_details: skipped.slice(0, 50),
            dry_run: true,
          };
        if (newShifts.length) {
          await req.db.query(
            `INSERT INTO escala.shifts(id,date,start_time,end_time,period,unit,notes,source)
 SELECT * FROM unnest($1::uuid[],$2::date[],$3::time[],$4::time[],$5::text[],$6::text[],$7::text[],$8::text[])`,
            [
              newShifts.map((s) => s.id),
              newShifts.map((s) => s.date),
              newShifts.map((s) => s.start_time),
              newShifts.map((s) => s.end_time),
              newShifts.map((s) => s.period),
              newShifts.map((s) => s.unit),
              newShifts.map((s) => s.notes || ""),
              newShifts.map(() => `Geração: ${label}`),
            ],
          );
        }
        if (newAssignments.length)
          await req.db.query(
            "INSERT INTO escala.assignments(shift_id,doctor_id) SELECT * FROM unnest($1::uuid[],$2::uuid[])",
            [newAssignments.map((x) => x[0]), newAssignments.map((x) => x[1])],
          );
        await Q.audit(
          req.db,
          req.user,
          "schedule_generated",
          `Escala de ${month} gerada a partir de ${label}: ${summary.shifts} plantões, ${summary.assignments} alocações, ${skipped.length} ignoradas.`,
          {
            month,
            source: b.source,
            ...summary,
            skipped: skipped.slice(0, 100),
          },
          [...new Set(newAssignments.map((x) => x[1]))],
          month,
        );
        return {
          ...summary,
          skipped_details: skipped.slice(0, 50),
          dry_run: false,
        };
      });
      res.status(result.dry_run ? 200 : 201).json(result);
    }),
  );
  return router;
}
