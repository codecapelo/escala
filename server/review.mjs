import { Router } from "express";
import { transaction } from "./db.mjs";
import { fail } from "./security.mjs";
import { audit, ensureUnlocked } from "./queries.mjs";
import { z, uuid } from "./validation.mjs";

// Mount after the authenticated /api middleware, before the /api 404 handler.
export const reviewRouter = Router();
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const admin = (req) => {
  if (!req.user) fail(401, "Entre na sua conta para continuar.");
  if (!["owner", "admin"].includes(req.user.role))
    fail(403, "Esta ação é exclusiva da administração.");
};
const note = z
  .string()
  .trim()
  .min(3, "Informe uma justificativa com pelo menos 3 caracteres.")
  .max(1000);
const issueId = z
  .string()
  .max(265)
  .regex(
    /^[a-f0-9]{64}:[a-zA-Z0-9_-]{1,200}$/,
    "Identificador de pendência inválido.",
  );
const mergeBody = z.object({ target_id: uuid, reason: note }).strict();
const issuesOf = (summary) =>
  Array.isArray(summary?.uncertainties) ? summary.uncertainties : [];

reviewRouter.get(
  "/imports/review",
  route(async (req, res) => {
    admin(req);
    const imports = (
      await req.db.query(
        "SELECT sha256,filename,imported_at,summary FROM escala.imports ORDER BY imported_at DESC,sha256",
      )
    ).rows;
    const reviews = (
      await req.db.query(
        "SELECT r.issue_id,r.resolved_at,r.resolved_by,r.note,u.name resolved_by_name FROM escala.import_reviews r JOIN escala.users u ON u.id=r.resolved_by",
      )
    ).rows;
    const resolutions = new Map(reviews.map((r) => [r.issue_id, r]));
    const doctors = (
      await req.db.query(`SELECT d.id,d.name,d.active,d.crm,u.id user_id,
  m.target_doctor_id merged_into_id FROM escala.doctors d LEFT JOIN escala.users u ON u.doctor_id=d.id
  LEFT JOIN escala.doctor_merges m ON m.source_doctor_id=d.id ORDER BY d.name,d.id`)
    ).rows;
    const issues = imports.flatMap((i) =>
      issuesOf(i.summary).map((issue) => {
        const id = `${i.sha256}:${issue.id}`;
        const resolution = resolutions.get(id) || null;
        return {
          ...issue,
          source_issue_id: issue.id,
          id,
          sha256: i.sha256,
          filename: i.filename,
          imported_at: i.imported_at,
          resolved: !!resolution,
          resolution,
        };
      }),
    );
    res.json({
      imports: imports.map(({ summary, ...i }) => ({
        ...i,
        summary: Object.fromEntries(
          Object.entries(summary || {}).filter(
            ([key]) => key !== "uncertainties",
          ),
        ),
      })),
      issues,
      doctors,
      counts: {
        total: issues.length,
        pending: issues.filter((i) => !i.resolved).length,
        resolved: issues.filter((i) => i.resolved).length,
      },
    });
  }),
);

reviewRouter.post(
  "/imports/review/:id/resolve",
  route(async (req, res) => {
    admin(req);
    const id = issueId.parse(req.params.id);
    const body = z.object({ note }).strict().parse(req.body);
    const sha = id.slice(0, 64);
    const sourceId = id.slice(65);
    const result = await transaction(req.db, async () => {
      const imported = (
        await req.db.query(
          "SELECT summary FROM escala.imports WHERE sha256=$1",
          [sha],
        )
      ).rows[0];
      const issue = issuesOf(imported?.summary).find((i) => i.id === sourceId);
      if (!issue)
        fail(404, "Pendência de importação não encontrada.", "ISSUE_NOT_FOUND");
      const existing = (
        await req.db.query(
          "SELECT issue_id,resolved_at,resolved_by,note FROM escala.import_reviews WHERE issue_id=$1",
          [id],
        )
      ).rows[0];
      // A retry preserves the first decision and creates no duplicate audit event.
      if (existing) return { resolution: existing, already_resolved: true };
      const resolution = (
        await req.db.query(
          "INSERT INTO escala.import_reviews(issue_id,resolved_by,note) VALUES($1,$2,$3) RETURNING issue_id,resolved_at,resolved_by,note",
          [id, req.user.id, body.note],
        )
      ).rows[0];
      const related = [
        ...new Set([
          ...(issue.doctorIds || []),
          ...(issue.doctorId ? [issue.doctorId] : []),
        ]),
      ];
      await audit(
        req.db,
        req.user,
        "import_issue_resolved",
        `Pendência de importação ${sourceId} revisada. ${body.note}`,
        {
          issue_id: id,
          source_issue_id: sourceId,
          sha256: sha,
          note: body.note,
          issue,
        },
        related,
        issue.date?.slice(0, 7) || null,
      );
      return { resolution, already_resolved: false };
    });
    res.json({ ok: true, ...result });
  }),
);

reviewRouter.post(
  "/doctors/:id/merge",
  route(async (req, res) => {
    admin(req);
    const sourceId = uuid.parse(req.params.id).toLowerCase();
    const body = mergeBody.parse(req.body);
    const targetId = body.target_id.toLowerCase();
    if (sourceId === targetId)
      fail(400, "Escolha dois cadastros diferentes.", "SAME_DOCTOR");
    const result = await transaction(req.db, async () => {
      // Shared application transaction lock serializes merges with assignments,
      // offers, activation and month closure. Row locks also guard the two identities.
      const doctors = (
        await req.db.query(
          "SELECT * FROM escala.doctors WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [[sourceId, targetId]],
        )
      ).rows;
      const source = doctors.find((d) => d.id === sourceId);
      const target = doctors.find((d) => d.id === targetId);
      if (!source || !target)
        fail(
          404,
          "Um dos cadastros médicos não foi encontrado.",
          "DOCTOR_NOT_FOUND",
        );
      const existing = (
        await req.db.query(
          "SELECT target_doctor_id FROM escala.doctor_merges WHERE source_doctor_id=$1",
          [sourceId],
        )
      ).rows[0];
      if (existing)
        fail(
          409,
          "Este cadastro já foi consolidado. Atualize a lista de médicos.",
          "DOCTOR_ALREADY_MERGED",
        );
      if (!target.active)
        fail(
          409,
          "O cadastro de destino precisa estar ativo.",
          "TARGET_INACTIVE",
        );
      if (
        (
          await req.db.query(
            "SELECT 1 FROM escala.doctor_merges WHERE source_doctor_id=$1",
            [targetId],
          )
        ).rows.length
      )
        fail(
          409,
          "O destino já foi consolidado em outro cadastro.",
          "TARGET_ALREADY_MERGED",
        );
      if (
        source.crm &&
        target.crm &&
        source.crm.trim().toLowerCase() !== target.crm.trim().toLowerCase()
      )
        fail(
          409,
          "Os cadastros possuem CRMs diferentes. Confira a identidade antes de consolidar.",
          "CRM_MISMATCH",
        );
      const users = (
        await req.db.query(
          "SELECT id,name,role,doctor_id,active FROM escala.users WHERE doctor_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [[sourceId, targetId]],
        )
      ).rows;
      if (req.user.role !== "owner" && users.some((u) => u.role !== "doctor"))
        fail(
          403,
          "Apenas o proprietário pode consolidar um cadastro vinculado a administrador ou proprietário.",
          "SUPERIOR_ACCESS",
        );
      if (users.length > 1)
        fail(
          409,
          "Os dois cadastros possuem contas vinculadas. O proprietário deve resolver os acessos antes de consolidar.",
          "TWO_LINKED_USERS",
        );
      const pendingInvites = (
        await req.db.query(
          `SELECT id,role FROM escala.invites WHERE doctor_id=ANY($1::uuid[])
   AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
          [[sourceId, targetId]],
        )
      ).rows;
      if (
        req.user.role !== "owner" &&
        pendingInvites.some((i) => i.role !== "doctor")
      )
        fail(
          403,
          "Apenas o proprietário pode invalidar os convites administrativos destes cadastros.",
          "SUPERIOR_ACCESS",
        );
      const memberships = (
        await req.db.query(
          `SELECT a.id,a.shift_id,a.created_at,s.date::text,
   to_char(s.start_time,'HH24:MI') start_time,to_char(s.end_time,'HH24:MI') end_time,s.cancelled_at
   FROM escala.assignments a JOIN escala.shifts s ON s.id=a.shift_id
   WHERE a.doctor_id=$1 AND a.removed_at IS NULL ORDER BY s.date,s.start_time,a.id FOR UPDATE OF a`,
          [sourceId],
        )
      ).rows;
      const openOffers = (
        await req.db.query(
          `SELECT o.id,s.date::text FROM escala.offers o JOIN escala.assignments a ON a.id=o.assignment_id
   JOIN escala.shifts s ON s.id=a.shift_id WHERE o.status IN ('open','pending')
   AND (o.from_doctor_id=$1 OR o.to_doctor_id=$1 OR a.doctor_id=$1) FOR UPDATE OF o`,
          [sourceId],
        )
      ).rows;
      const affectedMonths = [
        ...new Set(
          [...memberships, ...openOffers].map((s) => s.date.slice(0, 7)),
        ),
      ].sort();
      for (const month of affectedMonths)
        await ensureUnlocked(req.db, `${month}-01`);
      // Distinct shift IDs may not overlap in the combined schedule; identical
      // shift IDs are the same membership and will be deduplicated below.
      const conflicts = (
        await req.db.query(
          `WITH combined AS (
   SELECT DISTINCT s.id,s.date,s.start_time,s.end_time FROM escala.assignments a JOIN escala.shifts s ON s.id=a.shift_id
   WHERE a.doctor_id=ANY($1::uuid[]) AND a.removed_at IS NULL AND s.cancelled_at IS NULL
  ) SELECT a.id source_shift_id,b.id target_shift_id,a.date::text date,to_char(a.start_time,'HH24:MI') start_time
   FROM combined a JOIN combined b ON a.id<b.id
   AND (a.date+a.start_time)<(b.date+b.end_time+CASE WHEN b.end_time<=b.start_time THEN interval '1 day' ELSE interval '0 days' END)
   AND (b.date+b.start_time)<(a.date+a.end_time+CASE WHEN a.end_time<=a.start_time THEN interval '1 day' ELSE interval '0 days' END)
   LIMIT 1`,
          [[sourceId, targetId]],
        )
      ).rows;
      if (conflicts.length)
        fail(
          409,
          `A agenda consolidada teria plantões distintos sobrepostos em ${conflicts[0].date.split("-").reverse().join("/")} às ${conflicts[0].start_time}. Ajuste os plantões antes de consolidar.`,
          "OVERLAP",
        );
      const targetMemberships = (
        await req.db.query(
          "SELECT id,shift_id FROM escala.assignments WHERE doctor_id=$1 AND removed_at IS NULL FOR UPDATE",
          [targetId],
        )
      ).rows;
      const targetByShift = new Map(
        targetMemberships.map((a) => [a.shift_id, a.id]),
      );
      const mappings = [];
      let deduplicated = 0;
      for (const membership of memberships) {
        let replacementId = targetByShift.get(membership.shift_id);
        const duplicate = !!replacementId;
        if (duplicate) deduplicated++;
        else {
          replacementId = (
            await req.db.query(
              "INSERT INTO escala.assignments(shift_id,doctor_id) VALUES($1,$2) RETURNING id",
              [membership.shift_id, targetId],
            )
          ).rows[0].id;
          targetByShift.set(membership.shift_id, replacementId);
        }
        await req.db.query(
          "UPDATE escala.assignments SET removed_at=now() WHERE id=$1",
          [membership.id],
        );
        mappings.push({
          source_assignment_id: membership.id,
          target_assignment_id: replacementId,
          shift_id: membership.shift_id,
          deduplicated: duplicate,
        });
      }
      const cancelledOffers = (
        await req.db.query(
          "UPDATE escala.offers SET status='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[]) AND status IN ('open','pending') RETURNING id",
          [openOffers.map((o) => o.id)],
        )
      ).rows;
      const sourceUser = users.find((u) => u.doctor_id === sourceId);
      let sessionsRevoked = 0;
      if (sourceUser) {
        await req.db.query("UPDATE escala.users SET doctor_id=$1 WHERE id=$2", [
          targetId,
          sourceUser.id,
        ]);
        sessionsRevoked = (
          await req.db.query("DELETE FROM escala.sessions WHERE user_id=$1", [
            sourceUser.id,
          ])
        ).rowCount;
      }
      const revokedInvites = (
        await req.db.query(
          "UPDATE escala.invites SET revoked_at=now() WHERE id=ANY($1::uuid[]) AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id",
          [pendingInvites.map((i) => i.id)],
        )
      ).rows;
      // Preserve source row/source_key and every historical offer/audit reference.
      await req.db.query("UPDATE escala.doctors SET active=false WHERE id=$1", [
        sourceId,
      ]);
      const metadata = {
        source_before: source,
        target_before: target,
        linked_users_before: users,
        assignment_mappings: mappings,
        cancelled_offer_ids: cancelledOffers.map((o) => o.id),
        revoked_invite_ids: revokedInvites.map((i) => i.id),
        transferred_user_id: sourceUser?.id || null,
        affected_months: affectedMonths,
        counts: {
          assignments_retired: memberships.length,
          assignments_created: memberships.length - deduplicated,
          duplicate_memberships_removed: deduplicated,
          offers_cancelled: cancelledOffers.length,
          invites_revoked: revokedInvites.length,
          users_transferred: sourceUser ? 1 : 0,
          sessions_revoked: sessionsRevoked,
        },
      };
      const merge = (
        await req.db.query(
          `INSERT INTO escala.doctor_merges(source_doctor_id,target_doctor_id,source_name,target_name,reason,merged_by,metadata)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING source_doctor_id,target_doctor_id,source_name,target_name,reason,merged_by,merged_at`,
          [
            sourceId,
            targetId,
            source.name,
            target.name,
            body.reason,
            req.user.id,
            metadata,
          ],
        )
      ).rows[0];
      await audit(
        req.db,
        req.user,
        "doctors_merged",
        `Cadastro ${source.name} consolidado em ${target.name}; origem inativada. Motivo: ${body.reason}`,
        { merge, ...metadata },
        [sourceId, targetId],
      );
      return {
        merge,
        affected: metadata.counts,
        affected_months: affectedMonths,
        reauthentication_required: sourceUser?.id === req.user.id,
      };
    });
    res.json({ ok: true, ...result });
  }),
);

export default reviewRouter;
