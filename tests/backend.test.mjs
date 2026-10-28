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
  await pool.query(await readFile(new URL("../server/vacancy-schema.sql", import.meta.url), "utf8"));
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

test("offers work for shifts that already started or ended, up to administrator approval; closed months still block", async () => {
  const s = await createShift({ date: "2020-01-01", doctor_ids: [f.a.id] });
  const created = await post("/offers", { assignment_id: s.assignments[0].id }, "a");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const offerId = created.body.offer.id;
  assert.equal((await api("/dashboard?month=2020-01", { as: "b" })).body.offers.length, 1, "past open offers stay listed");
  assert.equal((await post(`/offers/${offerId}/accept`, {}, "b")).status, 200);
  assert.equal((await post(`/offers/${offerId}/approve`, {}, "admin")).status, 200);
  assert.equal((await row("SELECT doctor_id FROM escala.assignments WHERE id=$1", [s.assignments[0].id])).doctor_id, f.b.id);
  await post("/months/2020-01/lock", { locked: true });
  assert.equal((await post("/offers", { assignment_id: s.assignments[0].id }, "b")).body.code, "MONTH_LOCKED");
});

test("an offer directed at one doctor is invisible to the others, only that doctor can take it, administrators see it", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  assert.equal((await post("/offers", { assignment_id: s.assignments[0].id, target_doctor_id: f.a.id }, "a")).status, 400, "not to yourself");
  assert.equal((await post("/offers", { assignment_id: s.assignments[0].id, target_doctor_id: f.inactive.id }, "a")).status, 400, "inactive doctor");
  assert.equal((await post("/offers", { assignment_id: s.assignments[0].id, target_doctor_id: f.free.id }, "a")).body.code, "TARGET_WITHOUT_ACCOUNT");
  const made = await post("/offers", { assignment_id: s.assignments[0].id, target_doctor_id: f.b.id }, "a");
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.offer.id;
  const view = async (as) => (await api(`/dashboard?month=${month}`, { as })).body;
  const mine = await view("b");
  assert.equal(mine.offers.length, 1);
  assert.equal(mine.offers[0].target_name, "Doctor b");
  assert.ok(mine.shifts[0].assignments[0].offer_id, "the target sees the repasse tag");
  assert.equal((await view("a")).offers.length, 1);
  assert.equal((await view("owner")).offers.length, 1);
  const other = await view("c");
  assert.equal(other.offers.length, 0, "others do not see the offer");
  assert.equal(other.shifts[0].assignments[0].offer_id, null, "nor the repasse tag in the calendar");
  assert.ok(!JSON.stringify(other).includes("offer_target"));
  assert.equal((await api(`/shifts?month=${month}`, { as: "c" })).body.shifts[0].assignments[0].offer_id, null);
  assert.equal((await post(`/offers/${id}/accept`, {}, "c")).status, 403);
  assert.equal((await post(`/offers/${id}/accept`, {}, "b")).status, 200);
  assert.equal((await post(`/offers/${id}/approve`, {}, "admin")).status, 200);
  assert.ok(await row("SELECT 1 x FROM escala.audit WHERE action='offer_created' AND description LIKE '%ofereceu a Doctor b%'"));
  const audit = await api(`/audit?month=${month}`, { as: "c" });
  assert.ok(!audit.body.audit.some((e) => e.action === "offer_created"), "unrelated doctors do not see the directed audit entry");
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
  const res = await fetch(base + "/api/schedule/export?month=" + month, { headers: { Cookie: f.owner.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/pdf/);
  assert.match(res.headers.get("content-disposition"), /escala-2099-11\.pdf/);
  // Doctors get the same layout, limited to their own participations.
  const own = await fetch(base + "/api/schedule/export?month=" + month, { headers: { Cookie: f.a.cookie } });
  assert.equal(own.status, 200);
  assert.match(own.headers.get("content-disposition"), /escala-2099-11-individual\.pdf/);
  assert.equal((await api(`/schedule/export?month=${month}&scope=all`, { as: "a" })).status, 403);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const { sectionsFor } = await import("../server/pdf.mjs");
  const sections = sectionsFor((await api(`/shifts?month=${month}`)).body.shifts);
  assert.equal(sections[0].label, "MT");
  assert.equal(sections[0].date, "2099-11-12");
  assert.deepEqual(sections[0].left, ["M Doctor a", "M Doctor b"]);
});

test("inactivating a doctor lists future shifts with ids so the UI can link to each one", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const list = await api(`/doctors/${f.a.id}/upcoming`);
  assert.equal(list.status, 200);
  assert.equal(list.body.shifts.length, 1);
  assert.equal(list.body.shifts[0].shift_id, s.id);
  assert.equal(list.body.shifts[0].date, "2099-11-12");
  assert.equal((await api(`/doctors/${f.a.id}/upcoming`, { as: "b" })).status, 403);
  const blocked = await api(`/doctors/${f.a.id}`, { method: "PATCH", body: { active: false } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "HAS_FUTURE_SHIFTS");
  assert.equal(blocked.body.details[0].shift_id, s.id);
});

test("schedule generation copies a month by weekday, previews without writing, and reports skipped doctors", async () => {
  const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
  await createShift({ date: "2099-11-03", doctor_ids: [f.a.id, f.b.id] });
  await createShift({ date: "2099-11-12", doctor_ids: [f.c.id], start_time: "19:00", end_time: "01:00", period: "night" });
  await pool.query("UPDATE escala.doctors SET active=false WHERE id=$1", [f.b.id]);
  const body = { target_month: "2099-12", source: { type: "month", month: "2099-11" } };
  const preview = await post("/schedule/generate", { ...body, dry_run: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.dry_run, true);
  assert.equal(await count("shifts"), 2, "dry run must not write");
  assert.equal(preview.body.skipped_details[0].doctor, "Doctor b");
  assert.equal((await post("/schedule/generate", body, "a")).status, 403);
  const made = await post("/schedule/generate", body);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const dec = (await api(`/shifts?month=2099-12`)).body.shifts;
  // Each weekday occurrence maps to the same-numbered occurrence of that weekday in the source.
  assert.equal(dec.length, 2);
  for (const s of dec) assert.ok(["Doctor a", "Doctor c"].includes(s.assignments[0].doctor_name));
  assert.deepEqual(dec.map((s) => weekday(s.date)).sort(), [weekday("2099-11-03"), weekday("2099-11-12")].sort());
  assert.ok(dec.some((s) => s.start_time === "19:00" && s.end_time === "01:00"));
  const audit = await row("SELECT * FROM escala.audit WHERE action='schedule_generated'");
  assert.equal(audit.actor_id, f.owner.user.id);
  const again = await post("/schedule/generate", body);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "MONTH_NOT_EMPTY");
  const add = await post("/schedule/generate", { ...body, allow_existing: true });
  assert.equal(add.status, 201);
  assert.equal(add.body.assignments, 0, "re-running adds nothing already scheduled");
  assert.equal((await api(`/shifts?month=2099-12`)).body.shifts.length, dec.length);
  await post("/months/2099-12/lock", { locked: true }, "admin");
  assert.equal((await post("/schedule/generate", { ...body, allow_existing: true })).body.code, "MONTH_LOCKED");
});

test("a saved week model repeats through the whole month and can be listed and deleted", async () => {
  const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
  await createShift({ date: "2099-11-03", doctor_ids: [f.a.id] });
  await createShift({ date: "2099-11-05", doctor_ids: [f.c.id], start_time: "13:00", end_time: "19:00", period: "afternoon" });
  const saved = await post("/templates", { name: "Semana padrao", kind: "week", date: "2099-11-04" });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.template.shifts, 2);
  assert.equal((await post("/templates", { name: "semana PADRAO", kind: "week", date: "2099-11-04" })).status, 409);
  assert.equal((await post("/templates", { name: "Vazio", kind: "week", date: "2099-10-04" })).body.code, "EMPTY_SOURCE");
  assert.equal((await api("/templates", { as: "a" })).body.templates.length, 1);
  const t = saved.body.template;
  const made = await post("/schedule/generate", { target_month: "2099-12", source: { type: "template", template_id: t.id } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const dec = (await api("/shifts?month=2099-12")).body.shifts;
  const days = new Set(dec.map((s) => weekday(s.date)));
  assert.deepEqual([...days].sort(), [weekday("2099-11-03"), weekday("2099-11-05")].sort());
  assert.ok(dec.length >= 8);
  const week = await post("/schedule/generate", { target_month: "2099-10", source: { type: "week", date: "2099-11-04" }, dry_run: true });
  assert.equal(week.status, 200);
  assert.ok(week.body.shifts >= 8);
  assert.equal((await api(`/templates/${t.id}`, { method: "DELETE", as: "a", body: {} })).status, 403);
  assert.equal((await api(`/templates/${t.id}`, { method: "DELETE", body: {} })).status, 200);
  assert.equal((await api("/templates")).body.templates.length, 0);
});

// Resend is intercepted in-process; every other request goes through untouched.
function captureMail(t) {
  const sent = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.MAIL_FROM = "Escala <escala@example.test>";
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      sent.push({ url: String(url), auth: init.headers.Authorization, ...JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "mail_1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_FROM;
  });
  return sent;
}
const tokenIn = (mail) => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");

test("forgot password e-mails a one-use link, answers identically for unknown addresses and throttles abuse", async (t) => {
  const sent = captureMail(t);
  const unknown = await post("/auth/forgot", { email: "nobody@example.test" }, null);
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { ok: true });
  assert.equal(sent.length, 0);
  const known = await post("/auth/forgot", { email: "A@example.test" }, null);
  assert.deepEqual(known.body, unknown.body);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["a@example.test"]);
  assert.equal(sent[0].auth, "Bearer re_test_key");
  assert.match(sent[0].text, /\/redefinir\?token=/);
  assert.ok(!JSON.stringify(sent[0]).includes("password_hash"));
  const token = tokenIn(sent[0]);
  const stored = await row("SELECT * FROM escala.invites WHERE email='a@example.test' AND kind='reset'");
  assert.notEqual(stored.token_hash, token, "only a hash of the token is stored");
  const bad = await post("/auth/activate", { token, password: "short" }, null);
  assert.equal(bad.status, 400);
  const ok = await post("/auth/activate", { token, password: "Nova-senha-2026!" }, null);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await post("/auth/login", { email: "a@example.test", password }, null)).status, 401);
  assert.equal((await post("/auth/login", { email: "a@example.test", password: "Nova-senha-2026!" }, null)).status, 200);
  assert.equal((await post("/auth/activate", { token, password: "Outra-senha-2026!" }, null)).status, 400);
  assert.equal((await api("/auth/me", { cookie: f.a.cookie, as: null })).status, 401, "old sessions end");
  await post("/auth/forgot", { email: "b@example.test" }, null);
  await post("/auth/forgot", { email: "b@example.test" }, null);
  await post("/auth/forgot", { email: "b@example.test" }, null);
  assert.equal((await post("/auth/forgot", { email: "b@example.test" }, null)).status, 429);
  assert.equal((await post("/auth/forgot", { email: "not-an-email" }, null)).status, 400);
});

test("forgot password never fails loudly when mail is not configured or the provider rejects it", async () => {
  const r = await post("/auth/forgot", { email: "a@example.test" }, null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test("administrators set a doctor's password directly; owner-only for staff accounts; everything is audited", async () => {
  const set = (id, pw, as = "admin") => post(`/team/${id}/password`, { password: pw }, as);
  assert.equal((await set(f.a.user.id, "Senha-definida-2026!", "b")).status, 403);
  assert.equal((await set(f.a.user.id, "curta")).status, 400);
  assert.equal((await set(f.admin.user.id, "Senha-definida-2026!")).status, 400, "own password uses the profile");
  assert.equal((await set(f.owner.user.id, "Senha-definida-2026!")).status, 403, "staff accounts are owner-only");
  assert.equal((await set(f.a.user.id, "Senha-definida-2026!")).status, 200);
  assert.equal((await api("/auth/me", { as: "a" })).status, 401, "sessions are revoked");
  assert.equal((await post("/auth/login", { email: "a@example.test", password }, null)).status, 401);
  assert.equal((await post("/auth/login", { email: "a@example.test", password: "Senha-definida-2026!" }, null)).status, 200);
  const audit = await row("SELECT * FROM escala.audit WHERE action='password_set_by_admin'");
  assert.equal(audit.actor_id, f.admin.user.id);
  assert.ok(!JSON.stringify(audit).includes("Senha-definida"));
  assert.equal((await set(f.admin.user.id, "Senha-do-admin-2026!", "owner")).status, 200);
});

test("administrators can e-mail a recovery link; without mail configuration they get a clear error", async (t) => {
  assert.equal((await post(`/team/${f.a.user.id}/send-reset`, {}, "admin")).body.code, "MAIL_NOT_CONFIGURED");
  const sent = captureMail(t);
  assert.equal((await post(`/team/${f.a.user.id}/send-reset`, {}, "b")).status, 403);
  assert.equal((await post(`/team/${f.owner.user.id}/send-reset`, {}, "admin")).status, 403);
  const ok = await post(`/team/${f.a.user.id}/send-reset`, {}, "admin");
  assert.equal(ok.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["a@example.test"]);
  assert.equal((await post("/auth/activate", { token: tokenIn(sent[0]), password: "Nova-senha-2026!" }, null)).status, 200);
  assert.ok(await row("SELECT 1 x FROM escala.audit WHERE action='recovery_emailed'"));
});

test("the UI only offers e-mail recovery when e-mail sending is configured", async (t) => {
  assert.deepEqual((await api("/auth/options", { as: null })).body, { forgot: false });
  assert.equal((await api("/team")).body.mail_configured, false);
  captureMail(t);
  assert.deepEqual((await api("/auth/options", { as: null })).body, { forgot: true });
  assert.equal((await api("/team")).body.mail_configured, true);
});

test("both sides can back out: the requester withdraws a pending request, the chosen doctor declines a directed offer", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const offer = await createOffer(s);
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, "b")).status, 200);
  assert.equal((await post(`/offers/${offer.id}/withdraw`, {}, "c")).status, 403);
  assert.equal((await post(`/offers/${offer.id}/withdraw`, {}, "b")).status, 200);
  const reopened = await row("SELECT status,requested_doctor_id FROM escala.offers WHERE id=$1", [offer.id]);
  assert.deepEqual([reopened.status, reopened.requested_doctor_id], ["open", null]);
  assert.equal((await post(`/offers/${offer.id}/withdraw`, {}, "b")).status, 409, "nothing left to withdraw");
  assert.equal((await post(`/offers/${offer.id}/accept`, {}, "c")).status, 200, "the offer is open again for others");
  assert.equal((await post(`/offers/${offer.id}/cancel`, {}, "a")).status, 200, "the offerer can still cancel a pending one");
  assert.ok(await row("SELECT 1 x FROM escala.audit WHERE action='offer_request_withdrawn'"));
  const s2 = await createShift({ date: "2099-11-13", doctor_ids: [f.a.id] });
  const directed = (await post("/offers", { assignment_id: s2.assignments[0].id, target_doctor_id: f.b.id }, "a")).body.offer;
  assert.equal((await post(`/offers/${directed.id}/decline`, {}, "c")).status, 403);
  assert.equal((await post(`/offers/${directed.id}/decline`, {}, "a")).status, 403, "the offerer cancels instead");
  assert.equal((await post(`/offers/${directed.id}/decline`, {}, "b")).status, 200);
  assert.equal((await row("SELECT status FROM escala.offers WHERE id=$1", [directed.id])).status, "cancelled");
  assert.ok(await row("SELECT 1 x FROM escala.audit WHERE action='offer_declined'"));
  const open = await createOffer(await createShift({ date: "2099-11-14", doctor_ids: [f.a.id] }));
  assert.equal((await post(`/offers/${open.id}/decline`, {}, "b")).status, 409, "only directed offers can be declined");
});

test("waiting list: only full shifts, ordered, visible to teammates and admins, ends when the doctor gets a place", async () => {
  const s = await createShift({ doctor_ids: [f.a.id] });
  const join = (id, as, body = {}) => post(`/shifts/${id}/waitlist`, body, as);
  assert.equal((await join(s.id, "b")).body.code, "NO_CAPACITY");
  await pool.query("UPDATE escala.shifts SET capacity=2 WHERE id=$1", [s.id]);
  assert.equal((await join(s.id, "b")).body.code, "VACANCY_AVAILABLE", "free vacancies go through the request flow");
  await pool.query("UPDATE escala.shifts SET capacity=1 WHERE id=$1", [s.id]);
  assert.equal((await join(s.id, "a")).body.code, "ALREADY_ASSIGNED");
  assert.equal((await join(s.id, "owner")).status, 403, "needs a linked doctor");
  const first = await join(s.id, "b");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal((await join(s.id, "b")).status, 409, "no duplicates");
  assert.equal((await join(s.id, "c")).status, 201);
  const mine = (await api(`/dashboard?month=${month}`, { as: "b" })).body.shifts.find((x) => x.id === s.id);
  assert.equal(mine.waitlist_count, 2);
  assert.equal(mine.my_waitlist_id, first.body.entry.id);
  const teammate = (await api(`/shifts/${s.id}/waitlist`, { as: "a" })).body;
  assert.deepEqual(teammate.entries.map((e) => [e.doctor_name, e.position]), [["Doctor b", 1], ["Doctor c", 2]]);
  const outsider = (await api(`/shifts/${s.id}/waitlist`, { as: "b" })).body;
  assert.deepEqual(outsider.entries.map((e) => e.doctor_name), ["Doctor b"], "others only see themselves");
  assert.equal(outsider.count, 2);
  // an overlapping commitment keeps a doctor off the list
  await createShift({ doctor_ids: [f.free.id] });
  const offer = (await post("/offers", { assignment_id: s.assignments[0].id }, "a")).body.offer;
  const seenByOfferer = (await api(`/dashboard?month=${month}`, { as: "a" })).body.offers.find((o) => o.id === offer.id);
  assert.deepEqual(seenByOfferer.waiting.map((w) => w.name), ["Doctor b", "Doctor c"]);
  const seenByB = (await api(`/dashboard?month=${month}`, { as: "b" })).body.offers.find((o) => o.id === offer.id);
  assert.deepEqual([seenByB.waiting.length, seenByB.waiting_count, seenByB.i_am_waiting], [0, 2, true]);
  assert.equal((await post(`/waitlist/${first.body.entry.id}/cancel`, {}, "c")).status, 403);
  assert.equal((await post(`/waitlist/${first.body.entry.id}/cancel`, {}, "admin")).status, 200);
  assert.equal((await post(`/waitlist/${first.body.entry.id}/cancel`, {}, "b")).status, 409);
  assert.equal((await api(`/shifts/${s.id}/waitlist`, { as: "a" })).body.entries.length, 1);
  // getting a place in the shift ends the waiting
  await pool.query("UPDATE escala.shifts SET capacity=2 WHERE id=$1", [s.id]);
  assert.equal((await post(`/shifts/${s.id}/assignments`, { doctor_id: f.c.id })).status, 200);
  assert.equal((await api(`/shifts/${s.id}/waitlist`, { as: "a" })).body.entries.length, 0);
  await post("/months/2099-11/lock", { locked: true });
  assert.equal((await post(`/shifts/${s.id}/waitlist`, {}, "admin")).status, 403, "admin without a linked doctor cannot");
});

test("waiting list is open during the shift but closed once it ended", async () => {
  const live = new Date(Date.now() - 3600000);
  const d = (x) => x.toLocaleDateString("en-CA", { timeZone: "America/Fortaleza" });
  const t = (x) => x.toLocaleTimeString("en-GB", { timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit" });
  const ongoing = await createShift({ date: d(live), start_time: t(live), end_time: t(new Date(live.getTime() + 4 * 3600000)), doctor_ids: [f.a.id] });
  await pool.query("UPDATE escala.shifts SET capacity=1 WHERE id=$1", [ongoing.id]);
  assert.equal((await post(`/shifts/${ongoing.id}/waitlist`, {}, "b")).status, 201, "a shift in progress accepts volunteers");
  const ended = await createShift({ date: "2020-01-01", doctor_ids: [f.a.id] });
  await pool.query("UPDATE escala.shifts SET capacity=1 WHERE id=$1", [ended.id]);
  assert.equal((await post(`/shifts/${ended.id}/waitlist`, {}, "b")).body.code, "SHIFT_ENDED");
});

test("waiting list priority is scoped to an entry, preserves arrival order on ties and applies to offers without exposing other doctors", async () => {
  const s = await createShift({ capacity: 1, doctor_ids: [f.a.id] });
  assert.equal((await post(`/shifts/${s.id}/waitlist`, { priority: 100 }, "b")).status, 400, "a doctor cannot choose administrative priority");
  const b = (await post(`/shifts/${s.id}/waitlist`, {}, "b")).body.entry;
  const c = (await post(`/shifts/${s.id}/waitlist`, {}, "c")).body.entry;
  await pool.query("UPDATE escala.waitlist SET created_at='2026-01-01T00:00:00Z' WHERE id=$1", [b.id]);
  await pool.query("UPDATE escala.waitlist SET created_at='2026-01-02T00:00:00Z',priority=10 WHERE id=$1", [c.id]);
  const timestamps = (await pool.query("SELECT id,created_at FROM escala.waitlist ORDER BY id")).rows;
  const list = (await api(`/shifts/${s.id}/waitlist`)).body;
  assert.deepEqual(list.entries.map((e) => [e.doctor_id, e.position]), [[f.c.id, 1], [f.b.id, 2]]);
  const own = (await api(`/shifts/${s.id}/waitlist`, { as: "b" })).body;
  assert.deepEqual(own.entries.map((e) => [e.doctor_id, e.position]), [[f.b.id, 2]]);
  assert.equal(own.count, 2);
  const offer = await createOffer(s);
  const offers = (await api(`/dashboard?month=${month}`, { as: "a" })).body.offers;
  assert.deepEqual(offers.find((o) => o.id === offer.id).waiting.map((w) => w.doctor_id), [f.c.id, f.b.id]);
  await pool.query("UPDATE escala.waitlist SET priority=10 WHERE id=$1", [b.id]);
  const tied = (await api(`/shifts/${s.id}/waitlist`)).body;
  assert.deepEqual(tied.entries.map((e) => e.doctor_id), [f.b.id, f.c.id]);
  assert.deepEqual((await pool.query("SELECT id,created_at FROM escala.waitlist ORDER BY id")).rows, timestamps);
  const another = await createShift({ date: "2099-11-13", capacity: 1, doctor_ids: [f.a.id] });
  assert.equal((await post(`/shifts/${another.id}/waitlist`, {}, "b")).status, 201);
  assert.equal((await post(`/shifts/${another.id}/waitlist`, {}, "c")).status, 201);
  const normal = (await api(`/shifts/${another.id}/waitlist`)).body;
  assert.deepEqual(normal.entries.map((e) => e.doctor_id), [f.b.id, f.c.id], "priority in one shift must not affect another");
});
