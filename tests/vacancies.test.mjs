import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { digest, hashPassword } from "../server/security.mjs";
const url = new URL(
  process.env.TEST_VACANCY_DATABASE_URL ||
    "postgresql://escala_test@127.0.0.1:55432/escala_tests_vacancies",
);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  !/^\/escala_tests_vacancies/.test(url.pathname)
)
  throw Error("Isolated local vacancy database required");
process.env.DATABASE_URL = url.href;
delete process.env.DATABASE_URL_UNPOOLED;
process.env.APP_URL = "http://vacancy.test";
const db = new pg.Pool({ connectionString: url.href });
let server, base, f;
const one = async (q, v = []) => (await db.query(q, v)).rows[0];
before(async () => {
  await mkdir("private", { recursive: true });
  for (const file of [
    "schema.sql",
    "review-schema.sql",
    "workflow-schema.sql",
    "vacancy-schema.sql",
    "vacancy-schema.sql",
  ])
    await db.query(
      await readFile(new URL("../server/" + file, import.meta.url), "utf8"),
    );
  const { app } = await import("../server/app.mjs");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async () => {
  await db.query(
    "TRUNCATE escala.users,escala.doctors,escala.shifts,escala.audit,escala.months,escala.rate_limits CASCADE",
  );
  f = {};
  for (const role of ["owner", "admin", "a", "b", "manager"]) {
    const doctor = await one(
      "INSERT INTO escala.doctors(name) VALUES($1) RETURNING *",
      ["Physician " + role],
    );
    const user = await one(
      "INSERT INTO escala.users(name,email,role,doctor_id,can_manage_schedule) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [
        doctor.name,
        role + "@vacancy.test",
        ["owner", "admin"].includes(role) ? role : "doctor",
        doctor.id,
        role === "manager",
      ],
    );
    await db.query(
      "INSERT INTO escala.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [digest("vacancy-" + role), user.id],
    );
    f[role] = { doctor, user, cookie: "escala_session=vacancy-" + role };
  }
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await db.end();
});
async function api(
  endpoint,
  { as = "owner", body, method = body === undefined ? "GET" : "POST" } = {},
) {
  const r = await fetch(base + endpoint, {
    method,
    headers: {
      Cookie: f[as].cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: r.status,
    body: r.headers.get("content-type")?.includes("json")
      ? await r.json()
      : Buffer.from(await r.arrayBuffer()),
    headers: r.headers,
  };
}
async function shift(extra = {}) {
  const r = await api("/shifts", {
    body: {
      date: "2099-11-02",
      start_time: "07:00",
      end_time: "13:00",
      period: "morning",
      notes: "PRIVATE ADMIN NOTES secret",
      capacity: 1,
      ...extra,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.shifts[0];
}
const request = (id, as = "a") =>
  api(`/shifts/${id}/vacancy-requests`, { as, body: {} });
const decide = (id, action = "approve", as = "admin") =>
  api(`/vacancy-requests/${id}/${action}`, { as, body: {} });
const shifts = async (as) =>
  (await api("/shifts?month=2099-11", { as })).body.shifts;
test("a request reserves the last vacancy atomically without assigning; admin approval assigns once", async () => {
  const s = await shift();
  const results = await Promise.all([request(s.id, "a"), request(s.id, "b")]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const winner = results.find((r) => r.status === 201).body.request;
  let current = (await shifts("owner"))[0];
  assert.equal(current.available_vacancies, 0);
  assert.equal(current.pending_vacancies, 1);
  assert.equal(current.assignments.length, 0);
  assert.equal((await decide(winner.id, "approve", "manager")).status, 403);
  assert.equal((await decide(winner.id)).status, 200);
  assert.equal((await decide(winner.id)).status, 409);
  current = (await shifts("owner"))[0];
  assert.equal(current.assignments.length, 1);
  assert.equal(current.pending_vacancies, 0);
  assert.equal(current.available_vacancies, 0);
  assert.equal(
    (
      await one(
        "SELECT count(*)::int n FROM escala.audit WHERE action='vacancy_approved'",
      )
    ).n,
    1,
  );
});
test("rejection and own cancellation release the reservation; doctors see only their requests", async () => {
  const s = await shift({ capacity: 2 });
  const a = (await request(s.id)).body.request,
    b = (await request(s.id, "b")).body.request;
  assert.equal(
    (await api("/vacancy-requests?month=2099-11", { as: "a" })).body.requests
      .length,
    1,
  );
  assert.equal(
    (await api("/vacancy-requests?month=2099-11", { as: "admin" })).body
      .requests.length,
    2,
  );
  assert.equal((await decide(b.id, "cancel", "a")).status, 403);
  assert.equal((await decide(a.id, "reject", "admin")).status, 200);
  assert.equal((await decide(b.id, "cancel", "b")).status, 200);
  assert.equal((await shifts("owner"))[0].available_vacancies, 2);
  assert.equal((await request(s.id)).status, 201);
});
test("duplicate, already assigned, overlapping and closed or past requests cannot reserve", async () => {
  const s = await shift({ capacity: 3, doctor_ids: [f.b.doctor.id] });
  assert.equal((await request(s.id, "b")).status, 409);
  assert.equal((await request(s.id)).status, 201);
  assert.equal((await request(s.id)).status, 409);
  const other = await shift({ start_time: "09:00", end_time: "15:00" });
  assert.equal((await request(other.id)).status, 409);
  assert.equal((await request(other.id, "b")).status, 409);
  await db.query(
    "INSERT INTO escala.months(month,locked)VALUES('2099-11',true)",
  );
  assert.equal((await request(s.id, "manager")).status, 409);
  const past = await shift({ date: "2020-01-01" });
  assert.equal((await request(past.id, "manager")).status, 409);
});
test("manual allocation and capacity reductions cannot consume a reserved vacancy", async () => {
  const s = await shift();
  await request(s.id);
  assert.equal(
    (
      await api(`/shifts/${s.id}/assignments`, {
        body: { doctor_id: f.b.doctor.id },
      })
    ).status,
    409,
  );
  assert.equal(
    (await api(`/shifts/${s.id}`, { method: "PATCH", body: { capacity: 0 } }))
      .status,
    409,
  );
  assert.equal(
    (
      await api(`/shifts/${s.id}`, {
        method: "PATCH",
        body: { capacity: null },
      })
    ).status,
    409,
  );
  assert.equal(
    (await api(`/shifts/${s.id}`, { method: "PATCH", body: { capacity: 2 } }))
      .status,
    200,
  );
  assert.equal(
    (
      await api(`/shifts/${s.id}/assignments`, {
        body: { doctor_id: f.b.doctor.id },
      })
    ).status,
    200,
  );
});
test("changes or cancellation cancel pending requests and do not create assignments", async () => {
  const s = await shift();
  const r = (await request(s.id)).body.request;
  assert.equal(
    (
      await api(`/shifts/${s.id}`, {
        method: "PATCH",
        body: { start_time: "08:00" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await one("SELECT status FROM escala.vacancy_requests WHERE id=$1", [
        r.id,
      ])
    ).status,
    "cancelled",
  );
  assert.equal((await decide(r.id)).status, 409);
  await request(s.id, "b");
  assert.equal(
    (
      await api(`/shifts/${s.id}`, {
        method: "DELETE",
        body: { reason: "Cancelamento de teste" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int n FROM escala.vacancy_requests WHERE status='pending'",
      )
    ).n,
    0,
  );
});
test("approval rechecks active identity, overlap and month closure", async () => {
  const s = await shift();
  const r = (await request(s.id)).body.request;
  await db.query("UPDATE escala.doctors SET active=false WHERE id=$1", [
    f.a.doctor.id,
  ]);
  assert.equal((await decide(r.id)).status, 400);
  await db.query("UPDATE escala.doctors SET active=true WHERE id=$1", [
    f.a.doctor.id,
  ]);
  await shift({
    start_time: "08:00",
    end_time: "11:00",
    doctor_ids: [f.a.doctor.id],
  });
  assert.equal((await decide(r.id)).status, 409);
  assert.equal(
    (
      await one("SELECT status FROM escala.vacancy_requests WHERE id=$1", [
        r.id,
      ])
    ).status,
    "pending",
  );
  await db.query(
    "INSERT INTO escala.months(month,locked)VALUES('2099-11',true)",
  );
  assert.equal((await decide(r.id)).status, 409);
});
test("notes and provenance are private in direct reads, dashboard, corrections, audit and manager writes", async () => {
  const s = await shift({ doctor_ids: [f.a.doctor.id], capacity: 2 });
  await db.query(
    "UPDATE escala.shifts SET source='PRIVATE SOURCE' WHERE id=$1",
    [s.id],
  );
  for (const as of ["a", "manager"])
    for (const endpoint of [
      "/shifts?month=2099-11",
      "/dashboard?month=2099-11",
      "/audit?month=2099-11",
    ]) {
      const r = await api(endpoint, { as });
      assert.equal(r.status, 200);
      assert(!JSON.stringify(r.body).includes("PRIVATE"));
      assert(!JSON.stringify(r.body).includes('"notes"'));
    }
  const admin = (await shifts("admin"))[0];
  assert.match(admin.notes, /PRIVATE/);
  assert.equal(admin.source, "PRIVATE SOURCE");
  const c = await api("/corrections", {
    as: "a",
    body: {
      type: "remove_assignment",
      proposed: { assignment_id: s.assignments[0].id },
      reason: "Corrigir participação",
    },
  });
  assert.equal(c.status, 201);
  assert(!JSON.stringify(c.body).includes("PRIVATE"));
  assert.equal(
    (
      await api(`/shifts/${s.id}`, {
        as: "manager",
        method: "PATCH",
        body: { notes: "overwrite" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(`/shifts/${s.id}`, {
        as: "manager",
        method: "PATCH",
        body: { capacity: 99 },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(`/shifts/${s.id}`, {
        as: "manager",
        method: "PATCH",
        body: { unit: "Nova unidade" },
      })
    ).status,
    200,
  );
  assert.match((await shifts("admin"))[0].notes, /PRIVATE/);
});
test("PDF and CSV export are individual for physicians including managers, and general only for admin", async () => {
  await shift({
    capacity: 3,
    doctor_ids: [f.a.doctor.id, f.b.doctor.id, f.manager.doctor.id],
  });
  const second = await shift({
    date: "2099-11-03",
    doctor_ids: [f.b.doctor.id],
  });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vacancy-pdf-"));
  try {
    for (const as of ["a", "manager", "admin"]) {
      const csv = await api("/reports/export?month=2099-11", { as });
      assert.equal(csv.status, 200);
      const text = csv.body.toString();
      assert(text.includes(f[as === "admin" ? "a" : as].doctor.name));
      if (as !== "admin") assert(!text.includes(f.b.doctor.name));
      const pdf = await api("/schedule/export?month=2099-11", { as });
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get("content-type"), "application/pdf");
      const file = path.join(tmp, as + ".pdf");
      await writeFile(file, pdf.body);
      const content = execFileSync("pdftotext", [file, "-"], {
        encoding: "utf8",
      });
      assert(content.includes(f[as === "admin" ? "a" : as].doctor.name));
      assert(!content.includes("PRIVATE"));
      if (as !== "admin") {
        assert(!content.includes(f.b.doctor.name));
        assert(!content.includes("03/11/2099"));
      } else assert(content.includes("03/11/2099"));
      if (as === "admin")
        await writeFile("private/vacancy-admin-test.pdf", pdf.body);
      else if (as === "a")
        await writeFile("private/vacancy-doctor-test.pdf", pdf.body);
    }
    for (const endpoint of ["/schedule/export", "/reports/export"])
      assert.equal(
        (await api(endpoint + "?month=2099-11&scope=all", { as: "a" })).status,
        403,
      );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
