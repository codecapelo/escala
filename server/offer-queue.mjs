import { transaction } from "./db.mjs";
import { audit, getShift } from "./queries.mjs";
import { shiftStart } from "./security.mjs";

const system = { id: null, name: "Fila automática de repasses" };
// These aliases are shared by the candidate and due-work queries below.
const eligible = `COALESCE(w.status='waiting' AND d.active AND u.active AND u.approval_status='approved'
 AND u.doctor_id=q.doctor_id AND q.doctor_id<>o.from_doctor_id
 AND NOT EXISTS(SELECT 1 FROM escala.doctor_merges m WHERE m.source_doctor_id=q.doctor_id)
 AND NOT EXISTS(SELECT 1 FROM escala.assignments x JOIN escala.shifts xs ON xs.id=x.shift_id
 WHERE x.doctor_id=q.doctor_id AND x.removed_at IS NULL AND xs.cancelled_at IS NULL
 AND xs.date+xs.start_time < s.date+s.end_time+CASE WHEN s.end_time<=s.start_time THEN interval '1 day' ELSE interval '0 days' END
 AND s.date+s.start_time < xs.date+xs.end_time+CASE WHEN xs.end_time<=xs.start_time THEN interval '1 day' ELSE interval '0 days' END),false)`;

export function responseWindowMs(shift, now = new Date()) {
  const until = shiftStart(shift).getTime() - now.getTime();
  return until > 24 * 3600000
    ? 2 * 3600000
    : until > 2 * 3600000
      ? 30 * 60000
      : 5 * 60000;
}

export async function initializeQueue(
  db,
  offer,
  actor = system,
  now = new Date(),
) {
  if (offer.target_doctor_id || offer.queue_initialized_at) return;
  // For legacy open offers the clock starts on activation, never retroactively.
  await db.query(
    "UPDATE escala.offers SET queue_initialized_at=$2 WHERE id=$1",
    [offer.id, now],
  );
  await db.query(
    `INSERT INTO escala.offer_queue_entries(offer_id,waitlist_id,doctor_id,user_id,position,priority_snapshot)
 SELECT $1,w.id,w.doctor_id,w.user_id,row_number() OVER(ORDER BY w.priority DESC,w.created_at,w.id),w.priority
 FROM escala.waitlist w JOIN escala.doctors d ON d.id=w.doctor_id JOIN escala.users u ON u.id=w.user_id
 JOIN escala.assignments a ON a.id=$2
 WHERE w.shift_id=a.shift_id AND w.status='waiting' AND w.created_at<=$3 AND d.active AND u.active AND u.approval_status='approved'
 AND u.doctor_id=w.doctor_id AND w.doctor_id<>$4
 AND NOT EXISTS(SELECT 1 FROM escala.assignments x WHERE x.shift_id=w.shift_id AND x.doctor_id=w.doctor_id AND x.removed_at IS NULL)`,
    [offer.id, offer.assignment_id, now, offer.from_doctor_id],
  );
  offer.queue_initialized_at = now;
  const shift = await getShift(
    db,
    (
      await db.query("SELECT shift_id FROM escala.assignments WHERE id=$1", [
        offer.assignment_id,
      ])
    ).rows[0].shift_id,
  );
  await audit(
    db,
    actor,
    "offer_queue_started",
    `Fila automática iniciada para o repasse de ${shift.date} ${shift.start_time}.`,
    {
      offer_id: offer.id,
      shift_id: shift.id,
      clock_started_at: now.toISOString(),
      notification_channel: "Canal externo estabelecido pela equipe",
    },
    [offer.from_doctor_id],
    shift.date.slice(0, 7),
  );
}

export async function advanceQueue(
  db,
  offer,
  { now = new Date(), actor = system } = {},
) {
  if (offer.status !== "open" || offer.target_doctor_id) return null;
  const assignment = (
    await db.query(
      "SELECT shift_id,doctor_id,removed_at FROM escala.assignments WHERE id=$1",
      [offer.assignment_id],
    )
  ).rows[0];
  if (
    !assignment ||
    assignment.removed_at ||
    assignment.doctor_id !== offer.from_doctor_id
  )
    return null;
  const shift = await getShift(db, assignment.shift_id);
  if (
    (
      await db.query("SELECT 1 FROM escala.months WHERE month=$1 AND locked", [
        shift.date.slice(0, 7),
      ])
    ).rowCount
  )
    return null;
  await initializeQueue(db, offer, actor, now);
  if (offer.queue_public_at) return null;
  const candidates = (
    await db.query(
      `SELECT q.*,d.name doctor_name,${eligible} eligible
 FROM escala.offer_queue_entries q JOIN escala.offers o ON o.id=q.offer_id JOIN escala.assignments a ON a.id=o.assignment_id
 JOIN escala.shifts s ON s.id=a.shift_id JOIN escala.waitlist w ON w.id=q.waitlist_id JOIN escala.doctors d ON d.id=q.doctor_id
 JOIN escala.users u ON u.id=q.user_id WHERE q.offer_id=$1 AND q.status IN ('waiting','invited') ORDER BY q.position`,
      [offer.id],
    )
  ).rows;
  const finished = [];
  let next = null;
  for (const entry of candidates) {
    const expired =
      entry.status === "invited" && entry.expires_at.getTime() <= now.getTime();
    if (!entry.eligible || expired) {
      finished.push({
        id: entry.id,
        doctor_id: entry.doctor_id,
        status: expired ? "expired" : "skipped",
        description: `${entry.doctor_name}: vez encerrada neste repasse. ${expired ? "Prazo de resposta encerrado." : "Disponibilidade ou horário incompatível."}`,
        reason: expired
          ? "Prazo de resposta encerrado."
          : "Médico sem disponibilidade válida, conta ativa ou horário compatível.",
      });
    } else {
      next = entry;
      break;
    }
  }
  if (finished.length) {
    await db.query(
      `UPDATE escala.offer_queue_entries q SET status=x.status,finished_at=$2,reason=x.reason
      FROM jsonb_to_recordset($1::jsonb) AS x(id text,status text,reason text) WHERE q.id=x.id::uuid`,
      [JSON.stringify(finished), now],
    );
    await db.query(
      `INSERT INTO escala.audit(actor_name,action,description,metadata,related_doctors,month)
      SELECT $2,'offer_queue_'||x.status,x.description,
      jsonb_build_object('offer_id',$3::text,'shift_id',$4::text,'queue_entry_id',x.id,'doctor_id',x.doctor_id,'reason',x.reason),
      ARRAY[$5::uuid,x.doctor_id::uuid],$6
      FROM jsonb_to_recordset($1::jsonb) AS x(id text,doctor_id text,status text,description text,reason text)`,
      [
        JSON.stringify(finished),
        system.name,
        offer.id,
        shift.id,
        offer.from_doctor_id,
        shift.date.slice(0, 7),
      ],
    );
  }
  if (next) {
    const entry = next;
    if (entry.status === "invited") return entry;
    const expires = new Date(now.getTime() + responseWindowMs(shift, now));
    await db.query(
      "UPDATE escala.offer_queue_entries SET status='invited',invited_at=$2,expires_at=$3 WHERE id=$1",
      [entry.id, now, expires],
    );
    await audit(
      db,
      system,
      "offer_queue_invited",
      `${entry.doctor_name} tem a vez para pedir o repasse de ${shift.date} ${shift.start_time}.`,
      {
        offer_id: offer.id,
        shift_id: shift.id,
        queue_entry_id: entry.id,
        doctor_id: entry.doctor_id,
        position: entry.position,
        invited_at: now.toISOString(),
        expires_at: expires.toISOString(),
        notification_channel: "Canal externo estabelecido pela equipe",
      },
      [offer.from_doctor_id, entry.doctor_id],
      shift.date.slice(0, 7),
    );
    return {
      ...entry,
      status: "invited",
      invited_at: now,
      expires_at: expires,
    };
  }
  await db.query("UPDATE escala.offers SET queue_public_at=$2 WHERE id=$1", [
    offer.id,
    now,
  ]);
  offer.queue_public_at = now;
  await audit(
    db,
    system,
    "offer_queue_public",
    `Fila encerrada: repasse de ${shift.date} ${shift.start_time} liberado para a equipe.`,
    { offer_id: offer.id, shift_id: shift.id, public_at: now.toISOString() },
    [offer.from_doctor_id],
    shift.date.slice(0, 7),
  );
  return null;
}

export async function passQueueEntry(
  db,
  offer,
  entry,
  actor,
  reason,
  now = new Date(),
) {
  await db.query(
    "UPDATE escala.offer_queue_entries SET status='passed',finished_at=$2,reason=$3 WHERE id=$1 AND status='invited'",
    [entry.id, now, reason],
  );
  const shift = await getShift(
    db,
    (
      await db.query("SELECT shift_id FROM escala.assignments WHERE id=$1", [
        offer.assignment_id,
      ])
    ).rows[0].shift_id,
  );
  await audit(
    db,
    actor,
    "offer_queue_passed",
    `${entry.doctor_name}: vez passada neste repasse. ${reason}`,
    {
      offer_id: offer.id,
      shift_id: shift.id,
      doctor_id: entry.doctor_id,
      queue_entry_id: entry.id,
      reason,
    },
    [offer.from_doctor_id, entry.doctor_id],
    shift.date.slice(0, 7),
  );
  return advanceQueue(db, offer, { now });
}

export async function releaseRequestedEntry(
  db,
  offer,
  actor,
  reason,
  now = new Date(),
) {
  if (offer.target_doctor_id) return;
  await initializeQueue(db, offer, actor, now);
  await db.query(
    "UPDATE escala.offer_queue_entries SET status='passed',finished_at=$3,reason=$4 WHERE offer_id=$1 AND doctor_id=$2 AND status IN ('requested','waiting','invited')",
    [offer.id, offer.requested_doctor_id, now, reason],
  );
}

// Called every minute by Netlify and on dashboard reads. A database transaction
// serializes workers and acceptance, so a late click cannot take another's turn.
export async function refreshOfferQueues(
  db,
  { month = null, limit = 40, now = new Date(), maxRuntimeMs = 18000 } = {},
) {
  const due = (
    await db.query(
      `SELECT o.id FROM escala.offers o JOIN escala.assignments a ON a.id=o.assignment_id
 JOIN escala.shifts s ON s.id=a.shift_id LEFT JOIN escala.offer_queue_entries q ON q.offer_id=o.id AND q.status='invited'
 LEFT JOIN escala.waitlist w ON w.id=q.waitlist_id LEFT JOIN escala.doctors d ON d.id=q.doctor_id LEFT JOIN escala.users u ON u.id=q.user_id
 WHERE o.status='open' AND o.target_doctor_id IS NULL AND o.queue_public_at IS NULL AND a.removed_at IS NULL AND s.cancelled_at IS NULL AND a.doctor_id=o.from_doctor_id
 AND ($1::text IS NULL OR to_char(s.date,'YYYY-MM')=$1) AND NOT EXISTS(SELECT 1 FROM escala.months m WHERE m.month=to_char(s.date,'YYYY-MM') AND m.locked)
 AND (o.queue_initialized_at IS NULL OR q.id IS NULL OR q.expires_at<=$2 OR NOT(${eligible}))
 ORDER BY o.queue_initialized_at NULLS FIRST,q.expires_at NULLS FIRST,o.created_at,o.id LIMIT $3`,
      [month, now, limit],
    )
  ).rows;
  let processed = 0;
  const stopAt = Date.now() + maxRuntimeMs;
  for (const row of due) {
    if (Date.now() >= stopAt) break;
    await transaction(db, async () => {
      const offer = (
        await db.query("SELECT * FROM escala.offers WHERE id=$1 FOR UPDATE", [
          row.id,
        ])
      ).rows[0];
      if (offer?.status === "open") {
        await advanceQueue(db, offer, { now });
        processed++;
      }
    });
  }
  return processed;
}
