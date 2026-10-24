import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import pg from "pg";
import { reportFor } from "../server/queries.mjs";
import { digest, hashPassword } from "../server/security.mjs";
// A separate database lets node:test execute both suites concurrently.
const url = new URL(
  process.env.TEST_REVIEW_DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://escala_test@127.0.0.1:55432/postgres",
);
if (!process.env.TEST_REVIEW_DATABASE_URL)
  url.pathname = "/escala_tests_review";
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !/^\/escala_tests_review(?:_[a-z0-9_]+)?$/.test(url.pathname)
)
  throw Error(
    "Review tests require an isolated local escala_tests_review database.",
  );
process.env.DATABASE_URL = url.href;
delete process.env.DATABASE_URL_UNPOOLED;
process.env.APP_URL = "http://escala.test";
const db = new pg.Pool({ connectionString: url.href, max: 5 });
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
let server, base, f, passwordHash;
const password = "Review-fixture-password!";
const sha = "a".repeat(64);
before(async () => {
  await db.query(
    await readFile(new URL("../server/schema.sql", import.meta.url), "utf8"),
  );
  await db.query(
    await readFile(
      new URL("../server/review-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  passwordHash = await hashPassword(password);
  const { app } = await import("../server/app.mjs");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async () => {
  await db.query(
    "TRUNCATE escala.doctor_merges,escala.import_reviews,escala.sessions,escala.invites,escala.offers,escala.assignments,escala.shifts,escala.audit,escala.doctors,escala.users,escala.imports,escala.months,escala.rate_limits CASCADE",
  );
  f = {};
  for (const role of ["owner", "admin", "doctor"]) {
    f[role] = await one(
      "INSERT INTO escala.users(name,email,role,doctor_id,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [
        role,
        role + "@test.local",
        role,
        role === "doctor"
          ? (
              await one(
                "INSERT INTO escala.doctors(name) VALUES('Role Doctor') RETURNING id",
              )
            ).id
          : null,
        passwordHash,
      ],
    );
    await db.query(
      "INSERT INTO escala.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [digest("review-fixture-" + role), f[role].id],
    );
  }
  for (const key of ["source", "target", "third"])
    f[key] = await one(
      "INSERT INTO escala.doctors(name) VALUES($1) RETURNING *",
      [key],
    );
  await db.query(
    "INSERT INTO escala.imports(sha256,filename,summary) VALUES($1,$2,$3)",
    [
      sha,
      "test.pdf",
      {
        uncertainties: [
          {
            id: "alias-1",
            doctorIds: [f.source.id, f.target.id],
            description: "Possível alias",
            type: "possible-name-alias",
          },
        ],
      },
    ],
  );
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await db.end();
});
async function api(path, body, role = "owner", method) {
  const r = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      ...(role ? { Cookie: "escala_session=review-fixture-" + role } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function shift(
  doctorIds,
  { date = "2099-10-20", start = "07:00", end = "13:00" } = {},
) {
  const s = await one(
    "INSERT INTO escala.shifts(date,start_time,end_time,period) VALUES($1,$2,$3,'morning') RETURNING *",
    [date, start, end],
  );
  for (const id of doctorIds)
    await db.query(
      "INSERT INTO escala.assignments(doctor_id,shift_id) VALUES($1,$2)",
      [id, s.id],
    );
  return s;
}
const merge = (extra = {}, role = "owner") =>
  api(
    `/doctors/${f.source.id}/merge`,
    {
      target_id: f.target.id,
      reason: "Cadastro confirmado pela administração",
      ...extra,
    },
    role,
  );
test("review admin access, remapped UUIDs, persistent note and idempotent audit", async () => {
  assert.equal((await api("/imports/review", null, "doctor")).status, 403);
  let r = await api("/imports/review");
  assert.equal(r.body.counts.pending, 1);
  assert.equal(r.body.issues[0].id, sha + ":alias-1");
  assert.deepEqual(r.body.issues[0].doctorIds, [f.source.id, f.target.id]);
  assert.equal(
    (await api(`/imports/review/${sha}:alias-1/resolve`, { note: "x" })).status,
    400,
  );
  assert.equal(
    (await api(`/imports/review/${sha}:missing/resolve`, { note: "Revisto" }))
      .status,
    404,
  );
  r = await api(`/imports/review/${sha}:alias-1/resolve`, {
    note: "Identidade confirmada",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.already_resolved, false);
  r = await api(`/imports/review/${sha}:alias-1/resolve`, {
    note: "Outra nota",
  });
  assert.equal(r.body.already_resolved, true);
  assert.equal(r.body.resolution.note, "Identidade confirmada");
  assert.equal(
    (
      await one(
        "SELECT count(*)::int n FROM escala.audit WHERE action='import_issue_resolved'",
      )
    ).n,
    1,
  );
  assert.equal((await api("/imports/review")).body.counts.pending, 0);
});
test("merge denies doctors, identical IDs, inactive target and divergent CRM", async () => {
  assert.equal((await merge({}, "doctor")).status, 403);
  assert.equal((await merge({ target_id: f.source.id })).status, 400);
  await db.query("UPDATE escala.doctors SET active=false WHERE id=$1", [
    f.target.id,
  ]);
  assert.equal((await merge()).body.code, "TARGET_INACTIVE");
  await db.query("UPDATE escala.doctors SET active=true,crm=$2 WHERE id=$1", [
    f.target.id,
    "CRM-2",
  ]);
  await db.query("UPDATE escala.doctors SET crm=$2 WHERE id=$1", [
    f.source.id,
    "CRM-1",
  ]);
  assert.equal((await merge()).body.code, "CRM_MISMATCH");
});
test("same-shift duplicates retire source, preserve old rows and unify report", async () => {
  const s = await shift([f.source.id, f.target.id]);
  const second = await shift([f.source.id], { date: "2099-10-21" });
  const original = (
    await db.query("SELECT * FROM escala.assignments WHERE doctor_id=$1", [
      f.source.id,
    ])
  ).rows;
  const r = await merge();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.affected.assignments_retired, 2);
  assert.equal(r.body.affected.assignments_created, 1);
  assert.equal(r.body.affected.duplicate_memberships_removed, 1);
  for (const a of original) {
    const saved = await one("SELECT * FROM escala.assignments WHERE id=$1", [
      a.id,
    ]);
    assert.equal(saved.doctor_id, f.source.id);
    assert.ok(saved.removed_at);
  }
  assert.equal(
    (await one("SELECT active FROM escala.doctors WHERE id=$1", [f.source.id]))
      .active,
    false,
  );
  const report = await reportFor(db, "2099-10", f.owner);
  assert.equal(report.rows.find((d) => d.doctor_id === f.target.id).turns, 2);
  assert.equal(report.rows.find((d) => d.doctor_id === f.source.id).turns, 0);
  assert.equal(
    (
      await one(
        "SELECT jsonb_array_length(metadata->'assignment_mappings') n FROM escala.doctor_merges WHERE source_doctor_id=$1",
        [f.source.id],
      )
    ).n,
    2,
  );
  assert.equal((await merge()).body.code, "DOCTOR_ALREADY_MERGED");
});
test("source account moves safely, sessions revoked, pending invites revoked, old offers remain historical", async () => {
  await db.query("UPDATE escala.users SET doctor_id=$1 WHERE id=$2", [
    f.source.id,
    f.doctor.id,
  ]);
  await db.query(
    "INSERT INTO escala.sessions(token_hash,user_id,expires_at) VALUES('test-session',$1,now()+interval '1 day')",
    [f.doctor.id],
  );
  await db.query(
    "INSERT INTO escala.invites(token_hash,email,name,role,doctor_id,expires_at) VALUES('inv','test2@test.local','Invite','doctor',$1,now()+interval '1 day')",
    [f.source.id],
  );
  const s = await shift([f.source.id]);
  const a = await one("SELECT id FROM escala.assignments WHERE shift_id=$1", [
    s.id,
  ]);
  const open = await one(
    "INSERT INTO escala.offers(assignment_id,from_doctor_id) VALUES($1,$2) RETURNING id",
    [a.id, f.source.id],
  );
  const historical = await one(
    "INSERT INTO escala.offers(assignment_id,from_doctor_id,to_doctor_id,status,accepted_at) VALUES($1,$2,$3,'accepted',now()) RETURNING id",
    [a.id, f.third.id, f.source.id],
  );
  const r = await merge({}, "admin");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.affected.users_transferred, 1);
  assert.equal(r.body.affected.offers_cancelled, 1);
  assert.equal(r.body.affected.sessions_revoked, 2);
  assert.equal(r.body.affected.invites_revoked, 1);
  assert.equal(
    (await one("SELECT doctor_id FROM escala.users WHERE id=$1", [f.doctor.id]))
      .doctor_id,
    f.target.id,
  );
  assert.equal(
    (await one("SELECT status FROM escala.offers WHERE id=$1", [open.id]))
      .status,
    "cancelled",
  );
  const old = await one("SELECT * FROM escala.offers WHERE id=$1", [
    historical.id,
  ]);
  assert.equal(old.to_doctor_id, f.source.id);
  assert.equal(old.status, "accepted");
  assert.equal(old.assignment_id, a.id);
});
test("two linked users block without side effects", async () => {
  await db.query("UPDATE escala.users SET doctor_id=$1 WHERE id=$2", [
    f.source.id,
    f.admin.id,
  ]);
  await db.query("UPDATE escala.users SET doctor_id=$1 WHERE id=$2", [
    f.target.id,
    f.doctor.id,
  ]);
  assert.equal((await merge()).body.code, "TWO_LINKED_USERS");
  assert.equal(
    (await one("SELECT active FROM escala.doctors WHERE id=$1", [f.source.id]))
      .active,
    true,
  );
  assert.equal(
    (await one("SELECT count(*)::int n FROM escala.doctor_merges")).n,
    0,
  );
});
test("admin cannot touch superior accounts or invitations; owner may preserve owner account role", async () => {
  await db.query("UPDATE escala.users SET doctor_id=$1 WHERE id=$2", [
    f.source.id,
    f.owner.id,
  ]);
  assert.equal((await merge({}, "admin")).body.code, "SUPERIOR_ACCESS");
  const r = await merge();
  assert.equal(r.status, 200);
  assert.equal(r.body.reauthentication_required, true);
  const u = await one("SELECT role,doctor_id FROM escala.users WHERE id=$1", [
    f.owner.id,
  ]);
  assert.equal(u.role, "owner");
  assert.equal(u.doctor_id, f.target.id);
});
test("admin cannot invalidate a pending admin invitation", async () => {
  await db.query(
    "INSERT INTO escala.invites(token_hash,email,name,role,doctor_id,expires_at) VALUES('inv','admin2@test.local','Invite','admin',$1,now()+interval '1 day')",
    [f.source.id],
  );
  assert.equal((await merge({}, "admin")).body.code, "SUPERIOR_ACCESS");
  assert.equal(
    (await one("SELECT revoked_at FROM escala.invites")).revoked_at,
    null,
  );
});
test("closed month blocks all writes and preserves assignments", async () => {
  await shift([f.source.id]);
  await db.query(
    "INSERT INTO escala.months(month,locked) VALUES('2099-10',true)",
  );
  const r = await merge();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "MONTH_LOCKED");
  assert.equal(
    (await one("SELECT removed_at FROM escala.assignments")).removed_at,
    null,
  );
  assert.equal(
    (await one("SELECT count(*)::int n FROM escala.doctor_merges")).n,
    0,
  );
});
test("cross-midnight distinct overlapping shifts reject, adjacent intervals allow", async () => {
  await shift([f.source.id], { start: "22:00", end: "07:00" });
  await shift([f.target.id], {
    date: "2099-10-21",
    start: "06:00",
    end: "12:00",
  });
  assert.equal((await merge()).body.code, "OVERLAP");
  await db.query(
    "UPDATE escala.shifts SET start_time='07:00' WHERE date='2099-10-21'",
  );
  assert.equal((await merge()).status, 200);
});
test("concurrent merges serialize to one winner", async () => {
  await shift([f.source.id]);
  const r = await Promise.all([merge(), merge()]);
  assert.deepEqual(r.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await one("SELECT count(*)::int n FROM escala.doctor_merges")).n,
    1,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int n FROM escala.audit WHERE action='doctors_merged'",
      )
    ).n,
    1,
  );
});

test("integrated review routes require authentication and inherit origin protections", async () => {
  assert.equal((await api("/imports/review", null, null)).status, 401);
  assert.equal(
    (
      await api(
        `/imports/review/${sha}:alias-1/resolve`,
        { note: "Revisão válida" },
        "doctor",
      )
    ).status,
    403,
  );
  const r = await fetch(base + `/doctors/${f.source.id}/merge`, {
    method: "POST",
    headers: {
      Cookie: "escala_session=review-fixture-owner",
      "Content-Type": "application/json",
      Origin: "https://attacker.test",
    },
    body: JSON.stringify({
      target_id: f.target.id,
      reason: "Identity confirmed",
    }),
  });
  assert.equal(r.status, 403);
  assert.equal(
    (await one("SELECT count(*)::int n FROM escala.doctor_merges")).n,
    0,
  );
});

test("import-level unresolved uncertainty blocks closing even without flagged shifts", async () => {
  await db.query(
    "UPDATE escala.imports SET summary=jsonb_set(summary,'{month}','\"2099-10\"'::jsonb) WHERE sha256=$1",
    [sha],
  );
  let r = await api("/months/2099-10/lock", { locked: true }, "admin");
  assert.equal(r.status, 409);
  assert.equal(
    (await one("SELECT count(*)::int n FROM escala.months WHERE locked")).n,
    0,
  );
  assert.equal(
    (
      await api(`/imports/review/${sha}:alias-1/resolve`, {
        note: "Identidades verificadas pela coordenação",
      })
    ).status,
    200,
  );
  r = await api("/months/2099-10/lock", { locked: true }, "admin");
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("resolving an uncertainty preserves source summary and does not implicitly clear shift review or consolidate", async () => {
  const s = await shift([f.source.id]);
  await db.query("UPDATE escala.shifts SET needs_review=true WHERE id=$1", [
    s.id,
  ]);
  const original = (
    await one("SELECT summary FROM escala.imports WHERE sha256=$1", [sha])
  ).summary;
  const r = await api(`/imports/review/${sha}:alias-1/resolve`, {
    note: "Identidade conferida; conferir também os horários",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    (await one("SELECT summary FROM escala.imports WHERE sha256=$1", [sha]))
      .summary,
    original,
  );
  assert.equal(
    (await one("SELECT needs_review FROM escala.shifts WHERE id=$1", [s.id]))
      .needs_review,
    true,
  );
  assert.equal(
    (await one("SELECT active FROM escala.doctors WHERE id=$1", [f.source.id]))
      .active,
    true,
  );
  assert.equal(
    (await one("SELECT count(*)::int n FROM escala.doctor_merges")).n,
    0,
  );
  assert.equal(
    (await api("/months/2099-10/lock", { locked: true })).status,
    409,
  );
});

test("racing resolution notes preserve exactly the first committed decision", async () => {
  const attempts = await Promise.all(
    ["Primeira decisão possível", "Segunda decisão possível"].map((note) =>
      api(`/imports/review/${sha}:alias-1/resolve`, { note }),
    ),
  );
  assert.deepEqual(
    attempts.map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(attempts.map((r) => r.body.already_resolved).sort(), [
    false,
    true,
  ]);
  assert.equal(
    attempts[0].body.resolution.note,
    attempts[1].body.resolution.note,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int n FROM escala.audit WHERE action='import_issue_resolved'",
      )
    ).n,
    1,
  );
});

test("merged source cannot be reactivated, assigned or invited and source provenance remains intact", async () => {
  await db.query("UPDATE escala.doctors SET source_key=$1,crm=$2 WHERE id=$3", [
    "pdf:variant:123",
    "CRM-123",
    f.source.id,
  ]);
  const s = await shift([]);
  assert.equal((await merge()).status, 200);
  const before = await one("SELECT * FROM escala.doctors WHERE id=$1", [
    f.source.id,
  ]);
  const reactivate = await api(
    `/doctors/${f.source.id}`,
    { active: true },
    "owner",
    "PATCH",
  );
  assert.equal(reactivate.status, 409, JSON.stringify(reactivate.body));
  assert.equal(
    (await api(`/shifts/${s.id}/assignments`, { doctor_id: f.source.id }))
      .status,
    400,
  );
  assert.equal(
    (
      await api("/shifts", {
        date: "2099-10-22",
        start_time: "07:00",
        end_time: "13:00",
        period: "morning",
        doctor_ids: [f.source.id],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api("/team/invite", {
        email: "merged@test.local",
        name: "Merged Doctor",
        role: "doctor",
        doctor_id: f.source.id,
      })
    ).status,
    400,
  );
  const saved = await one("SELECT * FROM escala.doctors WHERE id=$1", [
    f.source.id,
  ]);
  assert.equal(saved.active, false);
  assert.equal(saved.name, before.name);
  assert.equal(saved.source_key, "pdf:variant:123");
  assert.equal(saved.crm, "CRM-123");
});

test("account transfer invalidates old HTTP session and next login resolves canonical doctor", async () => {
  await db.query("UPDATE escala.users SET doctor_id=$1 WHERE id=$2", [
    f.source.id,
    f.doctor.id,
  ]);
  assert.equal(
    (await api("/auth/me", null, "doctor")).body.doctor.id,
    f.source.id,
  );
  assert.equal((await merge({}, "admin")).status, 200);
  assert.equal((await api("/auth/me", null, "doctor")).status, 401);
  const login = await api(
    "/auth/login",
    { email: "doctor@test.local", password },
    null,
  );
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "doctor");
  assert.equal(login.body.doctor.id, f.target.id);
});

test("merged identity lookup rejects an inconsistent legacy active flag before new assignment or invitation", async () => {
  const s = await shift([]);
  assert.equal((await merge()).status, 200);
  // Simulate an old/manual repair: merged identities remain invalid even if
  // their active bit is inconsistent with the canonical merge relation.
  await db.query("UPDATE escala.doctors SET active=true WHERE id=$1", [
    f.source.id,
  ]);
  assert.equal(
    (await api(`/shifts/${s.id}/assignments`, { doctor_id: f.source.id }))
      .status,
    400,
  );
  assert.equal(
    (
      await api("/team/invite", {
        email: "legacy-merged@test.local",
        name: "Legacy merged",
        role: "doctor",
        doctor_id: f.source.id,
      })
    ).status,
    400,
  );
  assert.equal(
    (await api(`/doctors/${f.source.id}`, { active: true }, "owner", "PATCH"))
      .status,
    409,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int n FROM escala.assignments WHERE doctor_id=$1 AND removed_at IS NULL",
        [f.source.id],
      )
    ).n,
    0,
  );
});

test("successive consolidation exposes a preserved chain and prevents reuse of both old identities", async () => {
  assert.equal((await merge()).status, 200);
  assert.equal(
    (
      await api(`/doctors/${f.target.id}/merge`, {
        target_id: f.third.id,
        reason: "Identidade canônica verificada",
      })
    ).status,
    200,
  );
  const r = await api("/imports/review");
  assert.equal(
    r.body.doctors.find((d) => d.id === f.source.id).merged_into_id,
    f.target.id,
  );
  assert.equal(
    r.body.doctors.find((d) => d.id === f.target.id).merged_into_id,
    f.third.id,
  );
  assert.equal(r.body.doctors.find((d) => d.id === f.third.id).active, true);
  for (const d of [f.source, f.target])
    assert.equal(
      (await api(`/doctors/${d.id}`, { active: true }, "owner", "PATCH"))
        .status,
      409,
    );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int n FROM escala.audit WHERE action='doctors_merged'",
      )
    ).n,
    2,
  );
});

test("global PDF summary metadata is unavailable to doctors in audit endpoints and dashboard", async () => {
  await db.query(
    "INSERT INTO escala.audit(actor_name,action,description,metadata,month) VALUES('Importador','pdf_imported','Importação de teste',$1,'2099-10')",
    [{ nominal_summary: ["Private imported identity"] }],
  );
  const owner = await api("/audit?month=2099-10");
  assert.ok(owner.body.audit.some((a) => a.action === "pdf_imported"));
  for (const endpoint of ["/audit?month=2099-10", "/dashboard?month=2099-10"]) {
    const r = await api(endpoint, null, "doctor");
    assert.equal(r.status, 200);
    assert.ok(!r.body.audit.some((a) => a.action === "pdf_imported"));
    assert.ok(!JSON.stringify(r.body).includes("Private imported identity"));
  }
});
