import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import pg from "pg";
import { digest, hashPassword, csvCell } from "../server/security.mjs";

// Never use the app database itself. Even an explicitly supplied test URL must
// point at a visibly named, local test database before destructive fixture setup.
const testUrl = new URL(
  process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://escala_test@127.0.0.1:55432/postgres",
);
if (!process.env.TEST_DATABASE_URL) testUrl.pathname = "/escala_tests";
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(testUrl.hostname) ||
  !/^\/escala_tests(?:_[a-z0-9_]+)?$/.test(testUrl.pathname)
) {
  throw new Error(
    "Tests require an isolated local database named escala_tests or escala_tests_<suffix>.",
  );
}
process.env.DATABASE_URL = testUrl.href;
delete process.env.DATABASE_URL_UNPOOLED;
process.env.APP_URL = "http://escala.test";
const password = "Fixture-password-2026!";
const pool = new pg.Pool({ connectionString: testUrl.href, max: 4 });
let server, base, passwordHash, f;
const month = "2099-11";
const shiftBody = (extra = {}) => ({
  date: "2099-11-12",
  start_time: "08:00",
  end_time: "12:00",
  period: "morning",
  unit: "Unidade Teste",
  doctor_ids: [],
  ...extra,
});

async function api(
  path,
  { as = "owner", method = "GET", body, headers = {}, cookie } = {},
) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      ...(as && f?.[as]?.cookie ? { Cookie: f[as].cookie } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: response.headers.get("content-type")?.includes("application/json")
      ? JSON.parse(text)
      : text,
    headers: response.headers,
  };
}
async function post(path, body = {}, as = "owner") {
  return api(path, { method: "POST", body, as });
}
async function createShift(extra = {}) {
  const r = await post("/shifts", shiftBody(extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.shifts[0];
}
async function createOffer(shift, as = "a") {
  const r = await post(
    "/offers",
    { assignment_id: shift.assignments[0].id },
    as,
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.offer;
}
async function row(sql, values = []) {
  return (await pool.query(sql, values)).rows[0];
}
async function count(table) {
  return Number((await row(`SELECT count(*) n FROM escala.${table}`)).n);
}
async function invite(extra = {}, as = "owner") {
  const r = await post(
    "/team/invite",
    {
      name: "New Doctor",
      email: "new@example.test",
      role: "doctor",
      doctor_id: f.free.id,
      ...extra,
    },
    as,
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return {
    response: r,
    token: new URL(r.body.inviteUrl).searchParams.get("token"),
  };
}

before(async () => {
  // Schema setup is idempotent and runs only after the URL guard above.
  await pool.query(
    await readFile(new URL("../server/schema.sql", import.meta.url), "utf8"),
  );
  await pool.query(
    await readFile(
      new URL("../server/review-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(await readFile(new URL('../server/workflow-schema.sql', import.meta.url), 'utf8'));
  passwordHash = await hashPassword(password);
  const { app } = await import("../server/app.mjs");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE escala.sessions,escala.invites,escala.offers,escala.assignments,escala.shifts,escala.months,escala.audit,escala.rate_limits,escala.users,escala.doctors,escala.imports CASCADE",
  );
  f = {};
  for (const name of ["a", "b", "c", "free", "inactive"]) {
    f[name] = await row(
      "INSERT INTO escala.doctors(name,active) VALUES($1,$2) RETURNING *",
      [`Doctor ${name}`, name !== "inactive"],
    );
  }
  for (const name of ["owner", "admin", "a", "b", "c"]) {
    const doctor = f[name];
    const role = ["owner", "admin"].includes(name) ? name : "doctor";
    const user = await row(
      "INSERT INTO escala.users(name,email,password_hash,role,doctor_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [
        `User ${name}`,
        `${name}@example.test`,
        passwordHash,
        role,
        doctor?.id || null,
      ],
    );
    const token = `fixture-session-${name}`;
    await pool.query(
      "INSERT INTO escala.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [digest(token), user.id],
    );
    f[name] = { ...doctor, user, cookie: `escala_session=${token}` };
  }
});
after(async () => {
  if (server)
    await new Promise((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  await pool.end();
});

test("health verifies a real PostgreSQL connection; anonymous reads require authentication", async () => {
  assert.deepEqual((await api("/health", { as: null })).body, {
    status: "ok",
    database: "connected",
  });
  for (const path of ["/auth/me", "/dashboard", "/team", "/reports", "/audit"])
    assert.equal((await api(path, { as: null })).status, 401, path);
});

test("login verifies hashes and sets an HttpOnly SameSite cookie; logout invalidates it", async () => {
  assert.equal(
    (
      await post(
        "/auth/login",
        { email: "owner@example.test", password: "wrong" },
        null,
      )
    ).status,
    401,
  );
  const r = await post(
    "/auth/login",
    { email: "OWNER@example.test", password },
    null,
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, "owner");
  assert.equal(r.body.user.password_hash, undefined);
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//);
  assert.match(r.headers.get("cache-control"), /no-store/);
  const sessionCookie = cookie.split(";")[0];
  assert.equal(
    (await api("/auth/me", { as: null, cookie: sessionCookie })).status,
    200,
  );
  assert.equal(
    (
      await api("/auth/logout", {
        as: null,
        cookie: sessionCookie,
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await api("/auth/me", { as: null, cookie: sessionCookie })).status,
    401,
  );
  const stored = await row(
    "SELECT token_hash FROM escala.sessions WHERE token_hash=$1",
    [digest(sessionCookie.split("=")[1])],
  );
  assert.equal(stored, undefined);
});

test("activation consumes a hashed invitation exactly once and does not leak the password", async () => {
  const { token } = await invite();
  const invitation = await row("SELECT * FROM escala.invites WHERE email=$1", [
    "new@example.test",
  ]);
  assert.equal(invitation.token_hash, digest(token));
  assert.notEqual(invitation.token_hash, token);
  const body = { token, name: "Activated Doctor", password };
  const activated = await post("/auth/activate", body, null);
  assert.equal(activated.status, 200);
  assert.equal(activated.body.user.role, "doctor");
  assert.equal(activated.body.user.doctor_id, f.free.id);
  assert.equal(activated.body.user.password_hash, undefined);
  assert.equal((await post("/auth/activate", body, null)).status, 400);
  assert.ok(
    (
      await row("SELECT accepted_at FROM escala.invites WHERE id=$1", [
        invitation.id,
      ])
    ).accepted_at,
  );
  assert.equal(
    (
      await pool.query("SELECT * FROM escala.users WHERE email=$1", [
        "new@example.test",
      ])
    ).rowCount,
    1,
  );
});

test("expired, revoked and malformed activation tokens cannot create accounts", async () => {
  const { token } = await invite();
  await pool.query(
    "UPDATE escala.invites SET expires_at=now()-interval '1 second' WHERE email='new@example.test'",
  );
  assert.equal(
    (
      await post(
        "/auth/activate",
        { token, name: "Activated Doctor", password },
        null,
      )
    ).status,
    400,
  );
  await pool.query(
    "UPDATE escala.invites SET expires_at=now()+interval '1 day',revoked_at=now() WHERE email='new@example.test'",
  );
  assert.equal(
    (
      await post(
        "/auth/activate",
        { token, name: "Activated Doctor", password },
        null,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await post(
        "/auth/activate",
        { token: "short", name: "Activated Doctor", password },
        null,
      )
    ).status,
    400,
  );
  assert.equal(await count("users"), 5);
});

test("doctor RBAC denies administrative endpoints and impersonation of another offer origin", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  for (const [path, method, body] of [
    ["/shifts", "POST", shiftBody()],
    [`/shifts/${s.id}`, "PATCH", { notes: "changed" }],
    [`/shifts/${s.id}`, "DELETE", { reason: "test reason" }],
    ["/doctors", "POST", { name: "Other Doctor" }],
    [`/doctors/${f.a.id}`, "PATCH", { name: "Changed Doctor" }],
    ["/team", "GET"],
    [
      "/team/invite",
      "POST",
      {
        email: "bad@example.test",
        name: "Bad Doctor",
        role: "doctor",
        doctor_id: f.free.id,
      },
    ],
    [`/months/${month}/lock`, "POST", { locked: true }],
  ])
    assert.equal(
      (await api(path, { as: "a", method, body })).status,
      403,
      path,
    );
  assert.equal(
    (await post("/offers", { assignment_id: s.assignments[0].id }, "b")).status,
    403,
  );
  const offer = await createOffer(s);
  assert.equal((await post(`/offers/${offer.id}/cancel`, {}, "b")).status, 403);
});

test("only owner creates administrators; admin may invite doctors but cannot escalate accounts", async () => {
  const b = { email: "admin2@example.test", name: "New Admin", role: "admin" };
  assert.equal((await post("/team/invite", b, "admin")).status, 403);
  assert.equal(
    (await post("/team/invite", { ...b, role: "owner" })).status,
    400,
  );
  assert.equal((await post("/team/invite", b)).status, 201);
  await invite({}, "admin");
  assert.equal(
    (
      await api(`/team/${f.a.user.id}`, {
        as: "admin",
        method: "PATCH",
        body: { role: "admin" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(`/team/${f.owner.user.id}`, {
        method: "PATCH",
        body: { active: false },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(`/team/${f.owner.user.id}`, {
        method: "PATCH",
        body: { role: "doctor", doctor_id: f.free.id },
      })
    ).status,
    403,
  );
});

test("an invitation cannot bind a doctor account to an inactive or already linked doctor", async () => {
  for (const doctor_id of [f.inactive.id, f.a.id]) {
    const r = await post(
      "/team/invite",
      {
        email: "other@example.test",
        name: "Other Doctor",
        role: "doctor",
        doctor_id,
      },
      "admin",
    );
    assert.ok([400, 409].includes(r.status), JSON.stringify(r.body));
  }
  assert.equal(await count("invites"), 0);
});

test("admin cannot reset or revoke owner/admin credentials", async () => {
  for (const name of ["owner", "admin"])
    assert.equal(
      (await post(`/team/${f[name].user.id}/reset`, {}, "admin")).status,
      403,
    );
  const { response } = await invite({
    email: "admin2@example.test",
    role: "admin",
    doctor_id: null,
  });
  const i = await row("SELECT id FROM escala.invites WHERE email=$1", [
    "admin2@example.test",
  ]);
  assert.ok(response.body.inviteUrl);
  assert.equal(
    (await post(`/team/invites/${i.id}/revoke`, {}, "admin")).status,
    403,
  );
  assert.equal((await post(`/team/invites/${i.id}/revoke`)).status, 200);
});

test("an administrator cannot replace a pending superior invitation through a shared doctor binding", async () => {
  await invite({ email: "superior@example.test", role: "admin" });
  const pending = await row("SELECT * FROM escala.invites WHERE email=$1", [
    "superior@example.test",
  ]);
  const r = await post(
    "/team/invite",
    {
      email: "different@example.test",
      name: "Different User",
      role: "doctor",
      doctor_id: f.free.id,
    },
    "admin",
  );
  assert.equal(r.status, 403);
  assert.equal(
    (
      await row("SELECT revoked_at FROM escala.invites WHERE id=$1", [
        pending.id,
      ])
    ).revoked_at,
    null,
  );
  assert.equal(await count("invites"), 1);
});

test("concurrent activation consumes the token once and ignores a forged owner role", async () => {
  const { token } = await invite();
  const body = { token, name: "New Doctor", password, role: "owner" };
  const attempts = await Promise.all([
    post("/auth/activate", body, null),
    post("/auth/activate", body, null),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 400]);
  assert.equal(attempts.find((r) => r.status === 200).body.user.role, "doctor");
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM escala.users WHERE email='new@example.test'",
      )
    ).rowCount,
    1,
  );
});

test("owner access changes revoke prior sessions and pending recovery tokens", async () => {
  const recovery = await post(`/team/${f.a.user.id}/reset`, {}, "admin");
  assert.equal(recovery.status, 200);
  const token = new URL(recovery.body.inviteUrl).searchParams.get("token");
  const changed = await api(`/team/${f.a.user.id}`, {
    method: "PATCH",
    body: { role: "admin" },
  });
  assert.equal(changed.status, 200);
  assert.equal((await api("/auth/me", { as: "a" })).status, 401);
  assert.equal(
    (await post("/auth/activate", { token, name: "User a", password }, null))
      .status,
    400,
  );
  const login = await post(
    "/auth/login",
    { email: "a@example.test", password },
    null,
  );
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "admin");
});

test("create repeated shifts assigns multiple doctors once and reports weighted hours", async () => {
  const r = await post(
    "/shifts",
    shiftBody({
      doctor_ids: [f.a.id, f.b.id, f.a.id],
      dates: ["2099-11-12", "2099-11-14", "2099-11-12"],
    }),
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.shifts.length, 2);
  for (const s of r.body.shifts)
    assert.deepEqual(
      s.assignments.map((a) => a.doctor_id).sort(),
      [f.a.id, f.b.id].sort(),
    );
  assert.equal(await count("shifts"), 2);
  assert.equal(await count("assignments"), 4);
  const report = await api(`/reports?month=${month}`);
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.totals, {
    doctors: 2,
    shifts: 2,
    assignments: 4,
    hours: 16,
  });
  const personal = await api(`/reports?month=${month}`, { as: "a" });
  assert.equal(personal.body.rows.length, 1);
  assert.equal(personal.body.rows[0].doctor_id, f.a.id);
  assert.equal(personal.body.totals.hours, 8);
});

test("repeat creation is all-or-nothing when any date conflicts", async () => {
  await createShift({ date: "2099-11-14", doctor_ids: [f.a.id] });
  const r = await post(
    "/shifts",
    shiftBody({ doctor_ids: [f.a.id], dates: ["2099-11-12", "2099-11-14"] }),
  );
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "OVERLAP");
  assert.equal(await count("shifts"), 1);
  assert.equal(await count("assignments"), 1);
  assert.equal(
    (
      await row(
        "SELECT count(*) n FROM escala.audit WHERE action='shift_created'",
      )
    ).n,
    "1",
  );
});

test("validation rejects impossible dates, invalid times/months, UUIDs and oversized repeats", async () => {
  for (const body of [
    { date: "2099-02-29" },
    { date: "2099-11-31" },
    { date: "2099-13-01" },
    { date: "2099-00-01" },
    { start_time: "24:00" },
    { end_time: "12:60" },
    { end_time: "08:00" },
    { doctor_ids: ["not-a-uuid"] },
    { dates: Array(63).fill("2099-11-12") },
    { doctor_ids: [f.inactive.id] },
  ])
    assert.equal(
      (await post("/shifts", shiftBody(body))).status,
      400,
      JSON.stringify(body),
    );
  for (const bad of ["2099-13", "2026-1", "x", "2099-11%27%20OR%201%3D1--"])
    assert.equal((await api(`/shifts?month=${bad}`)).status, 400, bad);
  assert.equal(
    (
      await api("/shifts/not-a-uuid", {
        method: "PATCH",
        body: { notes: "test" },
      })
    ).status,
    400,
  );
  assert.equal(await count("shifts"), 0);
});

test("same-origin protection rejects spoofed origins and cross-site requests", async () => {
  for (const headers of [
    { Origin: "https://attacker.test" },
    { Origin: "http://escala.test.attacker.test" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    assert.equal(
      (await api("/shifts", { method: "POST", body: shiftBody(), headers }))
        .status,
      403,
    );
  }
  assert.equal(
    (
      await api("/shifts", {
        method: "POST",
        body: shiftBody(),
        headers: { Origin: "http://escala.test" },
      })
    ).status,
    201,
  );
  const r = await fetch(base + "/api/shifts", {
    method: "POST",
    headers: { Cookie: f.owner.cookie, "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(r.status, 415);
});

test("overlap uses actual intervals, rejects same/adjacent-date intersections and allows touching endpoints", async () => {
  await createShift({
    doctor_ids: [f.a.id],
    start_time: "22:00",
    end_time: "06:00",
    period: "night",
  });
  for (const body of [
    { start_time: "23:00", end_time: "23:30" },
    { date: "2099-11-13", start_time: "00:00", end_time: "03:00" },
    { date: "2099-11-13", start_time: "05:59", end_time: "07:00" },
    { start_time: "21:00", end_time: "23:00" },
  ]) {
    const r = await post(
      "/shifts",
      shiftBody({ ...body, doctor_ids: [f.a.id] }),
    );
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(r.body.code, "OVERLAP");
  }
  await createShift({
    doctor_ids: [f.a.id],
    start_time: "20:00",
    end_time: "22:00",
  });
  await createShift({
    doctor_ids: [f.a.id],
    date: "2099-11-13",
    start_time: "06:00",
    end_time: "08:00",
  });
  await createShift({
    doctor_ids: [f.b.id],
    start_time: "22:00",
    end_time: "06:00",
  });
  assert.equal(await count("shifts"), 4);
});

test("shift edits and assignment addition enforce overlap and reject zero-duration edits", async () => {
  const first = await createShift({ doctor_ids: [f.a.id] });
  const other = await createShift({
    doctor_ids: [f.a.id],
    start_time: "13:00",
    end_time: "17:00",
  });
  assert.equal(
    (
      await api(`/shifts/${other.id}`, {
        method: "PATCH",
        body: { start_time: "11:00" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api(`/shifts/${first.id}`, {
        method: "PATCH",
        body: { end_time: "08:00" },
      })
    ).status,
    400,
  );
  const empty = await createShift({ start_time: "11:00", end_time: "13:00" });
  assert.equal(
    (await post(`/shifts/${empty.id}/assignments`, { doctor_id: f.a.id }))
      .status,
    409,
  );
  assert.equal(
    (
      await post(`/shifts/${empty.id}/assignments`, {
        doctor_id: f.inactive.id,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await row("SELECT start_time::text FROM escala.shifts WHERE id=$1", [
        other.id,
      ])
    ).start_time,
    "13:00:00",
  );
});

test("two concurrent overlapping creations serialize so only one succeeds", async () => {
  const results = await Promise.all([
    post("/shifts", shiftBody({ doctor_ids: [f.a.id] })),
    post("/shifts", shiftBody({ doctor_ids: [f.a.id] })),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await count("shifts"), 1);
  assert.equal(await count("assignments"), 1);
});

test("month lock freezes edits, assignments and offers; only owner may unlock", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const offer = await createOffer(s);
  assert.equal(
    (await post(`/months/${month}/lock`, { locked: true }, "admin")).status,
    409,
  );
  await post(`/offers/${offer.id}/cancel`, {}, "a");
  assert.equal(
    (await post(`/months/${month}/lock`, { locked: true }, "admin")).status,
    200,
  );
  // Simulate a stale imported offer to exercise the locked-month acceptance guard.
  await pool.query(
    "UPDATE escala.offers SET status='open',cancelled_at=NULL WHERE id=$1",
    [offer.id],
  );
  const actions = [
    post("/shifts", shiftBody()),
    api(`/shifts/${s.id}`, { method: "PATCH", body: { notes: "blocked" } }),
    api(`/shifts/${s.id}`, {
      method: "DELETE",
      body: { reason: "blocked deletion" },
    }),
    post(`/shifts/${s.id}/assignments`, { doctor_id: f.b.id }),
    api(`/assignments/${s.assignments[0].id}`, {
      method: "DELETE",
      body: { reason: "blocked removal" },
    }),
    post("/offers", { assignment_id: s.assignments[0].id }, "a"),
    post(`/offers/${offer.id}/accept`, {}, "b"),
    post(`/offers/${offer.id}/cancel`, {}, "a"),
  ];
  for (const r of await Promise.all(actions)) {
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "MONTH_LOCKED");
  }
  assert.equal(
    (await post(`/months/${month}/lock`, { locked: false }, "admin")).status,
    403,
  );
  assert.equal((await api(`/shifts?month=${month}`)).body.locked, true);
  assert.equal(
    (
      await post(`/months/${month}/lock`, {
        locked: false,
        reason: "Correção autorizada",
      })
    ).status,
    200,
  );
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, "b")).status, 200);
});

test("moving a shift checks both source and destination month locks", async () => {
  const s = await createShift();
  await post("/months/2099-12/lock", { locked: true }, "admin");
  const r = await api(`/shifts/${s.id}`, {
    method: "PATCH",
    body: { date: "2099-12-01" },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "MONTH_LOCKED");
  assert.equal(
    (await row("SELECT date::text FROM escala.shifts WHERE id=$1", [s.id]))
      .date,
    "2099-11-12",
  );
});

test("month closing rejects pending import review; a repeated creation rolls back on a locked date", async () => {
  const s = await createShift();
  await api(`/shifts/${s.id}`, {
    method: "PATCH",
    body: { needs_review: true },
  });
  assert.equal(
    (await post(`/months/${month}/lock`, { locked: true }, "admin")).status,
    409,
  );
  await api(`/shifts/${s.id}`, {
    method: "PATCH",
    body: { needs_review: false },
  });
  assert.equal(
    (await post(`/months/${month}/lock`, { locked: true }, "admin")).status,
    200,
  );
  const r = await post(
    "/shifts",
    shiftBody({ dates: ["2099-10-31", "2099-11-01"] }),
  );
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "MONTH_LOCKED");
  assert.equal(await count("shifts"), 1);
  assert.equal(
    (await post(`/months/${month}/lock`, { locked: false })).status,
    400,
  );
});

test("month closing races an offer creation without committing a locked month with an open offer", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const outcomes = await Promise.all([
    post("/offers", { assignment_id: s.assignments[0].id }, "a"),
    post(`/months/${month}/lock`, { locked: true }, "admin"),
  ]);
  assert.equal(
    outcomes.filter((r) => r.status === 409).length,
    1,
    JSON.stringify(outcomes),
  );
  const locked =
    (await row("SELECT locked FROM escala.months WHERE month=$1", [month]))
      ?.locked || false;
  const open = Number(
    (await row("SELECT count(*) n FROM escala.offers WHERE status='open'")).n,
  );
  assert.ok(!(locked && open > 0));
});

test("offer remains assigned to origin until accepted; acceptance records both people and immutable audit", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const offer = await createOffer(s);
  assert.equal(
    (
      await row("SELECT doctor_id FROM escala.assignments WHERE id=$1", [
        s.assignments[0].id,
      ])
    ).doctor_id,
    f.a.id,
  );
  // A doctor-supplied doctor_id cannot impersonate the target.
  assert.equal(
    (await post(`/offers/${offer.id}/accept`, { doctor_id: f.c.id }, "b"))
      .status,
    403,
  );
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, 'b')).status,200);
  // The acceptance only requests the transfer; the origin keeps responsibility.
  const owner = async () => (await row("SELECT doctor_id FROM escala.assignments WHERE id=$1", [s.assignments[0].id])).doctor_id;
  assert.equal(await owner(), f.a.id);
  assert.equal((await row("SELECT status FROM escala.offers WHERE id=$1", [offer.id])).status, "pending");
  assert.equal((await post(`/offers/${offer.id}/approve`, {}, "a")).status, 403);
  assert.equal((await post(`/offers/${offer.id}/approve`, {}, "b")).status, 403);
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, "c")).status, 409);
  assert.equal((await post(`/offers/${offer.id}/approve`, { note: "Conferido" }, "admin")).status, 200);
  assert.equal(await owner(), f.b.id);
  const saved = await row("SELECT * FROM escala.offers WHERE id=$1", [offer.id]);
  assert.equal(saved.status, "accepted");
  assert.equal(saved.from_doctor_id, f.a.id);
  assert.equal(saved.to_doctor_id, f.b.id);
  assert.equal(saved.accepted_by, f.b.user.id);
  assert.equal(saved.approved_by, f.admin.user.id);
  assert.ok(saved.accepted_at && saved.approved_at);
  assert.equal((await row("SELECT count(*) n FROM escala.audit WHERE action='offer_requested'")).n, "1");
  const audit = await row(
    "SELECT * FROM escala.audit WHERE action='offer_approved'",
  );
  assert.equal(audit.actor_id, f.admin.user.id);
  assert.equal(audit.metadata.approved_by, f.admin.user.id);
  assert.equal(audit.metadata.from_doctor_id, f.a.id);
  assert.equal(audit.metadata.to_doctor_id, f.b.id);
  assert.deepEqual(audit.related_doctors.sort(), [f.a.id, f.b.id].sort());
  await assert.rejects(
    pool.query("UPDATE escala.audit SET description=$1 WHERE id=$2", [
      "tamper",
      audit.id,
    ]),
    /append-only/,
  );
  await assert.rejects(
    pool.query("DELETE FROM escala.audit WHERE id=$1", [audit.id]),
    /append-only/,
  );
});

test("two doctors racing for one offer have exactly one committed winner and one acceptance audit", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const offer = await createOffer(s);
  const results = await Promise.all(
    ["b", "c"].map((as) => post(`/offers/${offer.id}/accept`, {}, as)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? f.b : f.c;
  assert.equal((await post(`/offers/${offer.id}/approve`, {}, "admin")).status, 200);
  assert.equal(
    (
      await row("SELECT doctor_id FROM escala.assignments WHERE id=$1", [
        s.assignments[0].id,
      ])
    ).doctor_id,
    winner.id,
  );
  const stored = await row("SELECT * FROM escala.offers WHERE id=$1", [
    offer.id,
  ]);
  assert.equal(stored.status, "accepted");
  assert.equal(stored.to_doctor_id, winner.id);
  assert.equal(
    (
      await row(
        "SELECT count(*) n FROM escala.audit WHERE action IN ('offer_requested','offer_approved')",
      )
    ).n,
    "2",
  );
});

test("a rejected transfer request reopens the offer; the approver is recorded and cannot approve their own request", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const offer = await createOffer(s);
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, "b")).status, 200);
  assert.equal((await post(`/offers/${offer.id}/reject`, {}, "admin")).status, 400);
  assert.equal((await post(`/offers/${offer.id}/reject`, { note: "Sem cobertura" }, "a")).status, 403);
  assert.equal((await post(`/offers/${offer.id}/reject`, { note: "Sem cobertura" }, "admin")).status, 200);
  const reopened = await row("SELECT * FROM escala.offers WHERE id=$1", [offer.id]);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.requested_doctor_id, null);
  assert.equal((await row("SELECT doctor_id FROM escala.assignments WHERE id=$1", [s.assignments[0].id])).doctor_id, f.a.id);
  assert.ok((await row("SELECT 1 x FROM escala.audit WHERE action='offer_rejected' AND actor_id=$1", [f.admin.user.id])));
  // An administrator-doctor cannot approve their own pending request, but the owner can.
  await pool.query("UPDATE escala.users SET doctor_id=$1 WHERE id=$2", [f.free.id, f.admin.user.id]);
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, "admin")).status, 200);
  assert.equal((await post(`/offers/${offer.id}/approve`, {}, "admin")).status, 403);
  assert.equal((await post(`/offers/${offer.id}/approve`, {}, "owner")).status, 200);
  assert.equal((await row("SELECT doctor_id FROM escala.assignments WHERE id=$1", [s.assignments[0].id])).doctor_id, f.free.id);
});

test("duplicate offers conflict; administrators cannot offer or accept on behalf of another physician", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const offer = await createOffer(s);
  assert.equal(
    (await post("/offers", { assignment_id: s.assignments[0].id }, "a")).status,
    409,
  );
  assert.equal(
    (await post(`/offers/${offer.id}/accept`, {}, "admin")).status,
    400,
  );
  assert.equal(
    (await post(`/offers/${offer.id}/accept`, { doctor_id: f.c.id }, "admin"))
      .status,
    403,
  );
  for(const as of ['owner','admin'])assert.equal((await post('/offers',{assignment_id:s.assignments[0].id},as)).status,403);
  await pool.query('UPDATE escala.users SET doctor_id=$1 WHERE id=$2',[f.free.id,f.owner.user.id]);
  assert.equal((await post(`/offers/${offer.id}/accept`,{},'owner')).status,200);
  assert.equal((await post(`/offers/${offer.id}/approve`,{},'admin')).status,200);
  assert.equal(
    (
      await row("SELECT doctor_id FROM escala.assignments WHERE id=$1", [
        s.assignments[0].id,
      ])
    ).doctor_id,
    f.free.id,
  );
});

test("offer acceptance rejects overlapping target intervals, self acceptance and inactive doctors", async () => {
  const s = await createShift({
    doctor_ids: [f.a.id],
    start_time: "22:00",
    end_time: "06:00",
  });
  const offer = await createOffer(s);
  await createShift({
    doctor_ids: [f.b.id],
    date: "2099-11-13",
    start_time: "02:00",
    end_time: "04:00",
  });
  const r = await post(`/offers/${offer.id}/accept`, {}, "b");
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "OVERLAP");
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, "a")).status, 400);
  await pool.query('UPDATE escala.users SET doctor_id=$1 WHERE id=$2',[f.inactive.id,f.owner.user.id]);
  assert.equal(
    (await post(`/offers/${offer.id}/accept`, { doctor_id: f.inactive.id }))
      .status,
    400,
  );
  assert.equal(
    (await row("SELECT status FROM escala.offers WHERE id=$1", [offer.id]))
      .status,
    "open",
  );
});

test("edited, removed or cancelled shifts invalidate stale open offers", async () => {
  for (const action of ["edit", "remove", "cancel"]) {
    const s = await createShift({
      doctor_ids: [f.a.id],
      date: { edit: "2099-11-12", remove: "2099-11-14", cancel: "2099-11-16" }[
        action
      ],
    });
    const offer = await createOffer(s);
    const r =
      action === "edit"
        ? await api(`/shifts/${s.id}`, {
            method: "PATCH",
            body: { start_time: "09:00" },
          })
        : action === "remove"
          ? await api(`/assignments/${s.assignments[0].id}`, {
              method: "DELETE",
              body: { reason: "Correction fixture" },
            })
          : await api(`/shifts/${s.id}`, {
              method: "DELETE",
              body: { reason: "Correction fixture" },
            });
    assert.equal(r.status, 200);
    assert.equal(
      (await post(`/offers/${offer.id}/accept`, {}, "b")).status,
      409,
    );
    assert.equal(
      (await row("SELECT status FROM escala.offers WHERE id=$1", [offer.id]))
        .status,
      "cancelled",
    );
  }
});

test("stale origin ownership is checked at acceptance even if changed outside application", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const offer = await createOffer(s);
  await pool.query("UPDATE escala.assignments SET doctor_id=$1 WHERE id=$2", [
    f.c.id,
    s.assignments[0].id,
  ]);
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, "b")).status, 409);
  assert.equal(
    (
      await row("SELECT doctor_id FROM escala.assignments WHERE id=$1", [
        s.assignments[0].id,
      ])
    ).doctor_id,
    f.c.id,
  );
});

test("past offers cannot be created or accepted, and past stale offers disappear from listings", async () => {
  const s = await createShift({ date: "2020-01-01", doctor_ids: [f.a.id] });
  const created = await post(
    "/offers",
    { assignment_id: s.assignments[0].id },
    "a",
  );
  assert.equal(created.status, 409);
  assert.equal(created.body.code, "PAST_SHIFT");
  const o = await row(
    "INSERT INTO escala.offers(assignment_id,from_doctor_id,created_by) VALUES($1,$2,$3) RETURNING id",
    [s.assignments[0].id, f.a.id, f.a.user.id],
  );
  const accepted = await post(`/offers/${o.id}/accept`, {}, "b");
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.code, "PAST_SHIFT");
  assert.equal((await api("/dashboard?month=2020-01")).body.offers.length, 0);
});

test("inactive doctors lose existing sessions and cannot login or receive assignments", async () => {
  await pool.query("UPDATE escala.doctors SET active=false WHERE id=$1", [
    f.a.id,
  ]);
  assert.equal((await api("/auth/me", { as: "a" })).status, 401);
  assert.equal(
    (await post("/auth/login", { email: "a@example.test", password }, null))
      .status,
    400,
  );
  assert.equal(
    (await post("/shifts", shiftBody({ doctor_ids: [f.a.id] }))).status,
    400,
  );
  assert.equal(
    (
      await post("/team/invite", {
        name: "Inactive",
        email: "inactive@example.test",
        role: "doctor",
        doctor_id: f.a.id,
      })
    ).status,
    400,
  );
});

test("changing password revokes other sessions but preserves current session", async () => {
  const extra = await post(
    "/auth/login",
    { email: "a@example.test", password },
    null,
  );
  assert.equal(extra.status, 200);
  const extraCookie = extra.headers.get("set-cookie").split(";")[0];
  const updatedPassword = "A-new-long-password!";
  assert.equal(
    (
      await post(
        "/auth/password",
        { currentPassword: "wrong", newPassword: updatedPassword },
        "a",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await post(
        "/auth/password",
        { currentPassword: password, newPassword: updatedPassword },
        "a",
      )
    ).status,
    200,
  );
  assert.equal((await api("/auth/me", { as: "a" })).status, 200);
  assert.equal(
    (await api("/auth/me", { as: null, cookie: extraCookie })).status,
    401,
  );
  assert.equal(
    (await post("/auth/login", { email: "a@example.test", password }, null))
      .status,
    401,
  );
  assert.equal(
    (
      await post(
        "/auth/login",
        { email: "a@example.test", password: updatedPassword },
        null,
      )
    ).status,
    200,
  );
});

test("password recovery is one-use, revokes all old sessions and authenticates the new password", async () => {
  const reset = await post(`/team/${f.a.user.id}/reset`, {}, "admin");
  assert.equal(reset.status, 200);
  const token = new URL(reset.body.inviteUrl).searchParams.get("token");
  const newPassword = "Recovered-password-2026!";
  const body = { token, name: "User a", password: newPassword };
  assert.equal((await post("/auth/activate", body, null)).status, 200);
  assert.equal((await api("/auth/me", { as: "a" })).status, 401);
  assert.equal((await post("/auth/activate", body, null)).status, 400);
  assert.equal(
    (await post("/auth/login", { email: "a@example.test", password }, null))
      .status,
    401,
  );
  assert.equal(
    (
      await post(
        "/auth/login",
        { email: "a@example.test", password: newPassword },
        null,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await row(
        "SELECT count(*) n FROM escala.audit WHERE action='password_reset'",
      )
    ).n,
    "1",
  );
});

test("CSV export prevents formula injection and personal exports do not expose colleagues", async () => {
  const names = [
    "=SUM(1+1)",
    "+cmd",
    "-cmd",
    "@cmd",
    "\tcmd",
    "\rcmd",
    "\ncmd",
  ];
  for (const name of names)
    assert.ok(csvCell(name).startsWith("\"'"), JSON.stringify(name));
  assert.equal(csvCell('quoted " value'), '"quoted "" value"');
  await pool.query("UPDATE escala.doctors SET name=$1,crm=$2 WHERE id=$3", [
    '=HYPERLINK("https://attacker.test")',
    "+123",
    f.a.id,
  ]);
  await createShift({ doctor_ids: [f.a.id, f.b.id] });
  const r = await api(`/reports/export?month=${month}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /attachment/);
  assert.ok(r.body.includes("\"'=HYPERLINK("));
  assert.ok(r.body.includes('"\'+123"'));
  const personal = await api(`/reports/export?month=${month}`, { as: "a" });
  assert.equal(personal.status, 200);
  assert.ok(!personal.body.includes("Doctor b"));
});

test("audit access exposes events related to a doctor and no unrelated administrative events", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const offer = await createOffer(s);
  await post(`/offers/${offer.id}/accept`, {}, "b");
  await post(`/offers/${offer.id}/approve`, {}, "admin");
  const unrelated = await api(`/audit?month=${month}`, { as: "c" });
  assert.equal(unrelated.status, 200);
  assert.equal(unrelated.body.audit.length, 0);
  const related = await api(`/audit?month=${month}`, { as: "b" });
  assert.ok(related.body.audit.some((a) => a.action === "offer_approved"));
  assert.ok(!related.body.audit.some((a) => a.action === "shift_created"));
  assert.ok(
    (await api(`/audit?month=${month}`)).body.audit.length >
      related.body.audit.length,
  );
});

test("unknown login emails share the same response and repeated bad credentials are throttled", async () => {
  const missing = await post(
    "/auth/login",
    { email: "missing@example.test", password },
    null,
  );
  const bad = await post(
    "/auth/login",
    { email: "a@example.test", password: "wrong-password" },
    null,
  );
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, bad.body);
  for (let i = 1; i < 10; i++)
    assert.equal(
      (
        await post(
          "/auth/login",
          { email: "a@example.test", password: "wrong-password" },
          null,
        )
      ).status,
      401,
    );
  assert.equal(
    (await post("/auth/login", { email: "a@example.test", password }, null))
      .status,
    429,
  );
});

test("ordinary HTTP login ignores spoofed Netlify and forwarding headers for IP throttling", async () => {
  const saved = process.env.NETLIFY;
  delete process.env.NETLIFY;
  try {
    for (const suffix of [1, 2, 3]) {
      const r = await api("/auth/login", {
        as: null,
        method: "POST",
        body: { email: "missing@example.test", password },
        headers: {
          "X-Nf-Client-Connection-Ip": `198.51.100.${suffix}`,
          "X-Forwarded-For": `203.0.113.${suffix}`,
        },
      });
      assert.equal(r.status, 401);
    }
    const buckets = (
      await pool.query(
        "SELECT attempts FROM escala.rate_limits WHERE key<>$1",
        [digest("login:missing@example.test")],
      )
    ).rows;
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].attempts, 3);
  } finally {
    if (saved === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = saved;
  }
});

test("schedule PDF export follows the original layout and is available to authenticated users only", async () => {
  await createShift({ doctor_ids: [f.a.id, f.b.id] });
  assert.equal((await api(`/schedule/export?month=${month}`, { as: null })).status, 401);
  const res = await fetch(base + "/api/schedule/export?month=" + month, { headers: { Cookie: f.a.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/pdf/);
  assert.match(res.headers.get("content-disposition"), /escala-2099-11\.pdf/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const { sectionsFor } = await import("../server/pdf.mjs");
  const sections = sectionsFor((await api(`/shifts?month=${month}`)).body.shifts);
  assert.equal(sections[0].label, "MT");
  assert.equal(sections[0].date, "2099-11-12");
  assert.deepEqual(sections[0].left, ["M Doctor a", "M Doctor b"]);
});
