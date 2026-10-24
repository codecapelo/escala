import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const base = process.argv[2];
if (!base?.startsWith("https://"))
  throw new Error("Supply HTTPS deployment origin.");
const credentials = process.argv[3]
  ? JSON.parse(await readFile(process.argv[3], "utf8"))
  : null;
const evidence = { origin: base, date: new Date().toISOString(), checks: [] };
const check = (name, detail) => {
  evidence.checks.push({ name, detail });
  console.log("PASS", name, detail || "");
};
async function request(
  path,
  { method = "GET", body, cookie, raw = false } = {},
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Origin: base,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers, text };
}
async function login(email) {
  const r = await request("/auth/login", {
    method: "POST",
    body: { email, password: credentials.password },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  return { cookie: cookie.split(";")[0], user: r.data.user };
}
try {
  const h = await request("/health");
  assert.equal(h.status, 200);
  assert.equal(h.data.database, "connected");
  check("Neon connection through Netlify Function");
  const anon = await request("/dashboard?month=2026-10");
  assert.equal(anon.status, 401);
  check("Anonymous schedule access denied");
  const shell = await fetch(base, { signal: AbortSignal.timeout(30000) });
  assert.equal(shell.status, 200);
  assert.match(
    shell.headers.get("content-security-policy") || "",
    /frame-ancestors 'none'/,
  );
  check("HTTPS frontend and security headers");
  if (credentials) {
    const owner = await login(credentials.owner.email),
      one = await login(credentials.doctors[0].user.email),
      two = await login(credentials.doctors[1].user.email);
    check("Owner and doctor login with secure session cookies");
    const dashboard = await request("/dashboard?month=2026-10", {
      cookie: owner.cookie,
    });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.data.shifts.length, 102);
    assert.equal(dashboard.data.stats.shifts, 1306);
    check("Imported schedule counts", "102 groups / 1306 assignments");
    const denied = await request("/doctors", {
      method: "POST",
      cookie: one.cookie,
      body: { name: "Denied" },
    });
    assert.equal(denied.status, 403);
    check("Doctor administrative mutation denied");
    const date = "2099-11-12";
    const create = await request("/shifts", {
      method: "POST",
      cookie: owner.cookie,
      body: {
        date,
        start_time: "07:00",
        end_time: "13:00",
        period: "morning",
        unit: "Verificação temporária",
        doctor_ids: [credentials.doctors[0].id],
      },
    });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    const shift = create.data.shifts[0];
    check("Shift creation through restricted runtime DB role");
    const open = await request("/offers", {
      method: "POST",
      cookie: one.cookie,
      body: {
        assignment_id: shift.assignments[0].id,
        note: "Teste de implantação em branch temporária",
      },
    });
    assert.equal(open.status, 201, JSON.stringify(open.data));
    const accept = await request("/offers/" + open.data.offer.id + "/accept", {
      method: "POST",
      cookie: two.cookie,
      body: {},
    });
    assert.equal(accept.status, 200, JSON.stringify(accept.data));
    const stale = await request("/offers/" + open.data.offer.id + "/accept", {
      method: "POST",
      cookie: one.cookie,
      body: {},
    });
    assert.equal(stale.status, 409);
    check("Offer transfer and repeated acceptance protection");
    const report = await request("/reports?month=2099-11", {
      cookie: two.cookie,
    });
    assert.equal(report.status, 200);
    assert.equal(report.data.rows.length, 1);
    assert.equal(report.data.rows[0].turns, 1);
    assert.equal(report.data.rows[0].hours, 6);
    assert.deepEqual(report.data.rows[0].days, [date]);
    check("Doctor report counts transferred shift and date");
    const audit = await request("/audit?month=2099-11", {
      cookie: owner.cookie,
    });
    assert.ok(
      audit.data.audit.some(
        (a) =>
          a.action === "offer_accepted" &&
          a.metadata.from_doctor_id === credentials.doctors[0].id &&
          a.metadata.to_doctor_id === credentials.doctors[1].id,
      ),
    );
    check("Transfer origin, destination and actor persisted");
    const csv = await request("/reports/export?month=2099-11", {
      cookie: two.cookie,
    });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    check("Monthly CSV export");
    const close = await request("/months/2099-11/lock", {
      method: "POST",
      cookie: owner.cookie,
      body: { locked: true },
    });
    assert.equal(close.status, 200, JSON.stringify(close.data));
    const blocked = await request("/shifts/" + shift.id, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { notes: "blocked" },
    });
    assert.equal(blocked.status, 409);
    check("Closed month blocks changes");
    const reopen = await request("/months/2099-11/lock", {
      method: "POST",
      cookie: owner.cookie,
      body: { locked: false, reason: "Teste completo em branch de validação" },
    });
    assert.equal(reopen.status, 200);
    check("Owner reopening with audit reason");
    const review = await request("/imports/review", { cookie: owner.cookie });
    assert.equal(review.status, 200, JSON.stringify(review.data));
    assert.ok(review.data.counts.pending > 0);
    assert.equal(
      (await request("/imports/review", { cookie: one.cookie })).status,
      403,
    );
    check("Import review is administrative");
    const invite = await request("/team/invite", {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "Nova médica de validação",
        email: `activation-${Date.now()}@example.test`,
        role: "doctor",
        doctor_id: credentials.doctors[2].id,
      },
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.data));
    const token = new URL(invite.data.inviteUrl).searchParams.get("token");
    const activated = await request("/auth/activate", {
      method: "POST",
      body: {
        token,
        name: "Nova médica de validação",
        password: "Validation-activation-password-2026!",
      },
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.data));
    assert.equal(activated.data.user.role, "doctor");
    assert.equal(
      (
        await request("/auth/activate", {
          method: "POST",
          body: {
            token,
            name: "Tentativa repetida",
            password: "Validation-activation-password-2026!",
          },
        })
      ).status,
      400,
    );
    check("Invitation activation end to end; single use enforced");
    const duplicate = await request("/team/invite", {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "Duplicado",
        email: `duplicate-${Date.now()}@example.test`,
        role: "doctor",
        doctor_id: credentials.doctors[0].id,
      },
    });
    assert.equal(duplicate.status, 409);
    check("Existing linked doctor cannot receive a duplicate account");
    await request("/auth/logout", {
      method: "POST",
      cookie: one.cookie,
      body: {},
    });
    assert.equal(
      (await request("/auth/me", { cookie: one.cookie })).status,
      401,
    );
    check("Logout invalidates server session");
  }
  evidence.passed = true;
} catch (e) {
  evidence.passed = false;
  evidence.error = e.message;
  console.error("FAIL", e.message);
  process.exitCode = 1;
}
await writeFile(
  credentials
    ? "private/staging-verification.json"
    : "private/production-verification.json",
  JSON.stringify(evidence, null, 2),
);
