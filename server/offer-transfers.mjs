import * as Q from "./queries.mjs";
import { fail } from "./security.mjs";

// Call inside the organization mutation transaction, with the offer row locked.
// Direct acceptance and approval of existing requests use the same safety checks.
export async function completeTransfer(
  db,
  offer,
  actor,
  { approval = false, note = null } = {},
) {
  const a = await Q.getAssignment(db, offer.assignment_id);
  if (a.doctor_id !== offer.from_doctor_id)
    fail(409, "O responsável por este plantão já mudou. Atualize a página.");
  const s = await Q.getShift(db, a.shift_id);
  await Q.ensureUnlocked(db, s.date);
  const target = approval ? offer.requested_doctor_id : actor.doctor_id;
  const acceptedBy = approval ? offer.requested_by : actor.id;
  if (target === a.doctor_id)
    fail(400, "Você já é responsável por este plantão.");
  if (offer.target_doctor_id && offer.target_doctor_id !== target)
    fail(403, "Este repasse foi direcionado a outro médico.");
  const account = (
    await db.query(
      "SELECT 1 FROM escala.users WHERE id=$1 AND doctor_id=$2 AND active AND approval_status='approved'",
      [acceptedBy, target],
    )
  ).rowCount;
  if (!account)
    fail(
      409,
      "O solicitante precisa ter uma conta ativa vinculada ao médico que assumirá.",
      "RECIPIENT_UNAVAILABLE",
    );
  const d = await Q.ensureDoctor(db, target);
  await Q.ensureNoOverlap(db, target, s);
  await db.query("UPDATE escala.assignments SET doctor_id=$1 WHERE id=$2", [
    target,
    a.id,
  ]);
  await db.query(
    `UPDATE escala.offers SET status='accepted',to_doctor_id=$1,accepted_by=$2,accepted_at=now(),
    requested_doctor_id=COALESCE(requested_doctor_id,$1),requested_by=COALESCE(requested_by,$2),requested_at=COALESCE(requested_at,now()),
    approved_by=$3,approved_at=CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END,decision_note=$4 WHERE id=$5`,
    [target, acceptedBy, approval ? actor.id : null, note, offer.id],
  );
  await db.query(
    "UPDATE escala.offer_queue_entries SET status='accepted',finished_at=now() WHERE offer_id=$1 AND doctor_id=$2 AND status IN ('invited','requested')",
    [offer.id, target],
  );
  await Q.audit(
    db,
    actor,
    approval ? "offer_approved" : "offer_accepted",
    `${approval ? actor.name + " aprovou o repasse: " : ""}${d.name} assumiu o plantão de ${a.doctor_name} em ${s.date.split("-").reverse().join("/")} ${s.start_time}–${s.end_time}.${approval ? "" : " Transferência concluída no aceite, sem aprovação administrativa."}`,
    {
      offer_id: offer.id,
      assignment_id: a.id,
      shift_id: s.id,
      from_doctor_id: a.doctor_id,
      from_name: a.doctor_name,
      to_doctor_id: target,
      to_name: d.name,
      requested_by: acceptedBy,
      accepted_by: acceptedBy,
      approved_by: approval ? actor.id : null,
      requires_approval: approval,
      note,
    },
    [a.doctor_id, target],
    s.date.slice(0, 7),
  );
}
