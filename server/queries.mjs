import { fail, shiftStart, shiftHours } from "./security.mjs";
export async function audit(
  db,
  user,
  action,
  description,
  metadata = {},
  related = [],
  month = null,
) {
  await db.query(
    "INSERT INTO escala.audit(actor_id,actor_name,action,description,metadata,related_doctors,month) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      user?.id || null,
      user?.name || "Importação do PDF",
      action,
      description,
      metadata,
      related,
      month,
    ],
  );
}
export async function ensureUnlocked(db, date) {
  const month = date.slice(0, 7);
  const { rows } = await db.query(
    "SELECT locked FROM escala.months WHERE month=$1",
    [month],
  );
  if (rows[0]?.locked)
    fail(
      409,
      "Este mês está fechado. Reabra o fechamento antes de alterar a escala.",
      "MONTH_LOCKED",
    );
}
export async function getShift(db, id) {
  const { rows } = await db.query(
    "SELECT *, date::text, to_char(start_time,'HH24:MI') start_time,to_char(end_time,'HH24:MI') end_time FROM escala.shifts WHERE id=$1 AND cancelled_at IS NULL",
    [id],
  );
  if (!rows[0]) fail(404, "Plantão não encontrado.");
  return rows[0];
}
export async function getAssignment(db, id) {
  const { rows } = await db.query(
    "SELECT a.*,d.name doctor_name FROM escala.assignments a JOIN escala.doctors d ON d.id=a.doctor_id JOIN escala.shifts s ON s.id=a.shift_id WHERE a.id=$1 AND a.removed_at IS NULL AND s.cancelled_at IS NULL",
    [id],
  );
  if (!rows[0]) fail(404, "Participação não encontrada.");
  return rows[0];
}
export async function ensureDoctor(db, id) {
  const { rows } = await db.query(
    "SELECT * FROM escala.doctors d WHERE id=$1 AND active AND NOT EXISTS (SELECT 1 FROM escala.doctor_merges m WHERE m.source_doctor_id=d.id)",
    [id],
  );
  if (!rows[0]) fail(400, "Selecione um médico ativo.");
  return rows[0];
}
export async function ensureNoOverlap(db, doctorId, s, excludeId = null) {
  const { rows } = await db.query(
    `SELECT sh.date::text, to_char(sh.start_time,'HH24:MI') start_time FROM escala.assignments a
 JOIN escala.shifts sh ON sh.id=a.shift_id WHERE a.doctor_id=$1 AND a.removed_at IS NULL AND sh.cancelled_at IS NULL
 AND ($5::uuid IS NULL OR a.id<>$5)
 AND (sh.date+sh.start_time) < ($2::date+$4::time+CASE WHEN $4::time<=$3::time THEN interval '1 day' ELSE interval '0 days' END)
 AND (sh.date+sh.end_time+CASE WHEN sh.end_time<=sh.start_time THEN interval '1 day' ELSE interval '0 days' END) > ($2::date+$3::time) LIMIT 1`,
    [doctorId, s.date, s.start_time, s.end_time, excludeId],
  );
  if (rows.length)
    fail(
      409,
      `Este médico já tem um plantão sobreposto em ${rows[0].date.split("-").reverse().join("/")} às ${rows[0].start_time}.`,
      "OVERLAP",
    );
}
export function ensureFuture(s) {
  if (shiftStart(s) <= new Date())
    fail(
      409,
      "Só é possível repassar plantões que ainda não começaram.",
      "PAST_SHIFT",
    );
}
export async function shiftsFor(db, month) {
  const { rows } = await db.query(
    `SELECT s.id,s.date::text,to_char(s.start_time,'HH24:MI') start_time,to_char(s.end_time,'HH24:MI') end_time,
 s.period,s.unit,s.notes,s.source,s.needs_review,
 COALESCE((SELECT json_agg(json_build_object('id',a.id,'doctor_id',d.id,'doctor_name',d.name,'doctor_color',d.color,'offer_id',o.id) ORDER BY d.name)
 FROM escala.assignments a JOIN escala.doctors d ON d.id=a.doctor_id LEFT JOIN escala.offers o ON o.assignment_id=a.id AND o.status='open'
 WHERE a.shift_id=s.id AND a.removed_at IS NULL),'[]') assignments FROM escala.shifts s
 WHERE s.date >= ($1||'-01')::date AND s.date < (($1||'-01')::date+interval '1 month') AND s.cancelled_at IS NULL
 ORDER BY s.date,s.start_time,s.unit`,
    [month],
  );
  return rows;
}
export async function doctorsFor(db) {
  return (
    await db.query(
      "SELECT d.*,u.id user_id FROM escala.doctors d LEFT JOIN escala.users u ON u.doctor_id=d.id ORDER BY d.name",
    )
  ).rows;
}
export async function offersFor(db, month, user) {
  const { rows } = await db.query(
    `SELECT o.id,o.assignment_id,o.from_doctor_id,fd.name from_name,o.to_doctor_id,td.name to_name,o.status,o.created_at,o.accepted_at,
 s.date::text,to_char(s.start_time,'HH24:MI') start_time,to_char(s.end_time,'HH24:MI') end_time,s.period,s.unit,o.note
 FROM escala.offers o JOIN escala.assignments a ON a.id=o.assignment_id JOIN escala.shifts s ON s.id=a.shift_id
 JOIN escala.doctors fd ON fd.id=o.from_doctor_id LEFT JOIN escala.doctors td ON td.id=o.to_doctor_id
 WHERE s.date>=($1||'-01')::date AND s.date<(($1||'-01')::date+interval '1 month')
 AND (o.status <> 'open' OR (s.cancelled_at IS NULL AND a.removed_at IS NULL AND (s.date+s.start_time) AT TIME ZONE 'America/Fortaleza' > now()))
 AND ($2::boolean OR o.status='open' OR o.from_doctor_id=$3 OR o.to_doctor_id=$3) ORDER BY o.created_at DESC`,
    [month, user.role !== "doctor", user.doctor_id],
  );
  return rows;
}
export async function auditFor(db, month, user) {
  return (
    await db.query(
      `SELECT id,action,actor_name,description,created_at,metadata FROM escala.audit WHERE (month=$1 OR month IS NULL)
 AND ($2::boolean OR $3::uuid=ANY(related_doctors)) ORDER BY created_at DESC,id DESC LIMIT 500`,
      [month, user.role !== "doctor", user.doctor_id],
    )
  ).rows;
}
export async function lockedFor(db, month) {
  return (
    (await db.query("SELECT locked FROM escala.months WHERE month=$1", [month]))
      .rows[0]?.locked || false
  );
}
export async function reportFor(db, month, user) {
  const shifts = await shiftsFor(db, month);
  const doctors = await doctorsFor(db);
  const rows = doctors
    .filter((d) => user.role !== "doctor" || d.id === user.doctor_id)
    .map((d) => {
      const entries = shifts.filter((s) =>
        s.assignments.some((a) => a.doctor_id === d.id),
      );
      return {
        doctor_id: d.id,
        name: d.name,
        crm: d.crm,
        turns: entries.length,
        hours:
          Math.round(entries.reduce((a, s) => a + shiftHours(s), 0) * 100) /
          100,
        days: [...new Set(entries.map((s) => s.date))],
        morning: entries.filter((s) => s.period === "morning").length,
        afternoon: entries.filter((s) => s.period === "afternoon").length,
        night: entries.filter((s) => s.period === "night").length,
        dawn: entries.filter((s) => s.period === "dawn").length,
        shifts: entries.map(
          ({ date, start_time, end_time, unit, period, needs_review }) => ({
            date,
            start_time,
            end_time,
            unit,
            period,
            needs_review,
          }),
        ),
      };
    });
  return {
    month,
    locked: await lockedFor(db, month),
    totals: {
      doctors: rows.filter((r) => r.turns > 0).length,
      shifts:
        user.role === "doctor"
          ? rows.reduce((n, r) => n + r.turns, 0)
          : shifts.length,
      assignments: rows.reduce((n, r) => n + r.turns, 0),
      hours: rows.reduce((n, r) => n + r.hours, 0),
    },
    rows,
  };
}
