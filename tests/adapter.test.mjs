import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { digest, hashPassword } from "../server/security.mjs";

// Exercise the actual exported Netlify handler, never the application database.
const url = new URL(
  process.env.TEST_ADAPTER_DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://escala_test@127.0.0.1:55432/postgres",
);
if (!process.env.TEST_ADAPTER_DATABASE_URL)
  url.pathname = "/escala_tests_adapter";
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !/^\/escala_tests_adapter(?:_[a-z0-9_]+)?$/.test(url.pathname)
)
  throw Error(
    "Adapter tests require an isolated local escala_tests_adapter database.",
  );
process.env.DATABASE_URL = url.href;
delete process.env.DATABASE_URL_UNPOOLED;
process.env.APP_URL = "https://escala.test";
process.env.NODE_ENV = "production";
const pool = new pg.Pool({ connectionString: url.href, max: 3 });
const password = "Adapter-fixture-password!";
const fixtureCookie = "escala_session=adapter-owner-session";
let handler, hash, doctor;
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];

before(async () => {
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
  await pool.query(await readFile(new URL("../server/vacancy-schema.sql", import.meta.url), "utf8"));
  hash = await hashPassword(password);
  ({ handler } = await import("../netlify/functions/api.mjs"));
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE escala.doctor_merges,escala.import_reviews,escala.sessions,escala.invites,escala.offers,escala.assignments,escala.shifts,escala.audit,escala.doctors,escala.users,escala.imports,escala.months,escala.rate_limits CASCADE",
  );
  const owner = await one(
    "INSERT INTO escala.users(name,email,role,password_hash) VALUES('Adapter owner','adapter@example.test','owner',$1) RETURNING id",
    [hash],
  );
  doctor = await one(
    "INSERT INTO escala.doctors(name) VALUES('Adapter Doctor') RETURNING *",
  );
  await pool.query(
    "INSERT INTO escala.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [digest("adapter-owner-session"), owner.id],
  );
});
after(async () => {
  await pool.end();
});

async function invoke(
  path,
  {
    method = "GET",
    body,
    raw,
    base64 = false,
    headers = {},
    query = null,
    authenticated = false,
  } = {},
) {
  const payload = raw ?? (body === undefined ? "" : JSON.stringify(body));
  const result = await handler(
    {
      path,
      httpMethod: method,
      headers: {
        Host: "escala.test",
        ...(body !== undefined || raw !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(authenticated ? { Cookie: fixtureCookie } : {}),
        ...headers,
      },
      multiValueHeaders: {},
      queryStringParameters: query,
      multiValueQueryStringParameters: null,
      body: base64 ? Buffer.from(payload).toString("base64") : payload,
      isBase64Encoded: base64,
      requestContext: {
        identity: { sourceIp: "127.0.0.1" },
        requestId: "adapter-integration",
      },
    },
    { callbackWaitsForEmptyEventLoop: false },
  );
  const text = result.isBase64Encoded
    ? Buffer.from(result.body, "base64").toString("utf8")
    : result.body;
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ...result, json };
}

for (const path of ["/api/auth/login", "/.netlify/functions/api/auth/login"]) {
  for (const base64 of [false, true]) {
    test(`actual Netlify handler accepts ${base64 ? "base64" : "plain"} JSON login at ${path}`, async () => {
      const r = await invoke(path, {
        method: "POST",
        body: { email: "adapter@example.test", password },
        base64,
      });
      assert.equal(r.statusCode, 200, JSON.stringify(r.json));
      assert.equal(r.json.user.role, "owner");
      assert.equal(r.json.user.password_hash, undefined);
      const cookies = r.multiValueHeaders?.["set-cookie"] ||
        r.multiValueHeaders?.["Set-Cookie"] || [r.headers?.["set-cookie"]];
      const cookie = cookies.find((c) => c?.startsWith("escala_session="));
      assert.ok(cookie, JSON.stringify(r));
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /Secure/i);
      assert.match(cookie, /SameSite=Lax/i);
      const me = await invoke("/.netlify/functions/api/auth/me", {
        headers: { Cookie: cookie.split(";")[0] },
      });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json.user.email, "adapter@example.test");
    });
  }
}

test("actual handler rejects malformed JSON with 400 for plain and base64 events", async () => {
  for (const base64 of [false, true]) {
    const r = await invoke("/api/auth/login", {
      method: "POST",
      raw: '{"email":',
      base64,
    });
    assert.equal(r.statusCode, 400, JSON.stringify(r.json));
    assert.equal(typeof r.json.error, "string");
  }
});

test("actual handler enforces 100 KiB on decoded bytes including base64 and multibyte Unicode", async () => {
  for (const [padding, base64] of [
    ["a".repeat(103000), false],
    ["a".repeat(103000), true],
    ["é".repeat(52000), true],
  ]) {
    const raw = JSON.stringify({
      email: "adapter@example.test",
      password,
      padding,
    });
    assert.ok(Buffer.byteLength(raw) > 102400);
    const r = await invoke("/.netlify/functions/api/auth/login", {
      method: "POST",
      raw,
      base64,
    });
    assert.equal(r.statusCode, 413, JSON.stringify(r.json));
  }
});

test("actual handler preserves origin and JSON MIME protection", async () => {
  const body = { email: "adapter@example.test", password };
  assert.equal(
    (
      await invoke("/api/auth/login", {
        method: "POST",
        body,
        headers: { Origin: "https://attacker.test" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await invoke("/api/auth/login", {
        method: "POST",
        body,
        headers: { "Content-Type": "text/plain" },
      })
    ).statusCode,
    415,
  );
  assert.equal(
    (
      await invoke("/api/auth/login", {
        method: "POST",
        body,
        headers: { Origin: "https://escala.test" },
      })
    ).statusCode,
    200,
  );
});

test("actual handler forwards GET month parameters and cookies on both URL forms", async () => {
  for (const date of ["2099-11-10", "2099-12-10"])
    await pool.query(
      "INSERT INTO escala.shifts(date,start_time,end_time,period) VALUES($1,'08:00','12:00','morning')",
      [date],
    );
  for (const path of ["/api/shifts", "/.netlify/functions/api/shifts"]) {
    const r = await invoke(path, {
      query: { month: "2099-11" },
      authenticated: true,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json.shifts.length, 1);
    assert.equal(r.json.shifts[0].date, "2099-11-10");
    assert.equal(
      (await invoke(path, { query: { month: "2099-13" }, authenticated: true }))
        .statusCode,
      400,
    );
    assert.equal(
      (await invoke(path, { query: { month: "2099-11" } })).statusCode,
      401,
    );
  }
});

test("actual handler parses arrays in POST and booleans in PATCH through a complete schedule mutation", async () => {
  const created = await invoke("/.netlify/functions/api/shifts", {
    method: "POST",
    authenticated: true,
    base64: true,
    body: {
      date: "2099-11-12",
      dates: ["2099-11-12", "2099-11-14"],
      start_time: "08:00",
      end_time: "12:00",
      period: "morning",
      doctor_ids: [doctor.id],
    },
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.json));
  assert.equal(created.json.shifts.length, 2);
  const id = created.json.shifts[0].id;
  const patched = await invoke(`/api/shifts/${id}`, {
    method: "PATCH",
    authenticated: true,
    body: { needs_review: true },
  });
  assert.equal(patched.statusCode, 200, JSON.stringify(patched.json));
  assert.equal(
    (await one("SELECT needs_review FROM escala.shifts WHERE id=$1", [id]))
      .needs_review,
    true,
  );
  assert.equal(
    (await one("SELECT count(*)::int n FROM escala.assignments")).n,
    2,
  );
});

test("actual handler uses platform client IP buckets only when NETLIFY is enabled", async () => {
  const saved = process.env.NETLIFY;
  process.env.NETLIFY = "true";
  try {
    for (const suffix of [1, 2]) {
      const r = await invoke("/api/auth/login", {
        method: "POST",
        body: { email: "missing@example.test", password },
        headers: { "X-Nf-Client-Connection-Ip": `198.51.100.${suffix}` },
      });
      assert.equal(r.statusCode, 401);
    }
    const buckets = (
      await pool.query(
        "SELECT key,attempts FROM escala.rate_limits WHERE key<>$1",
        [digest("login:missing@example.test")],
      )
    ).rows;
    assert.equal(buckets.length, 2);
    assert.deepEqual(
      buckets.map((r) => r.key).sort(),
      [digest("ip:198.51.100.1"), digest("ip:198.51.100.2")].sort(),
    );
    assert.ok(buckets.every((r) => r.attempts === 1));
  } finally {
    if (saved === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = saved;
  }
});


test("actual Netlify handler returns a valid binary PDF without UTF-8 corruption", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const r = await invoke("/api/schedule/export", {query:{month:"2099-11"},authenticated:true});
  assert.equal(r.statusCode,200);
  assert.equal(r.isBase64Encoded,true);
  const bytes=Buffer.from(r.body,"base64");
  assert.equal(bytes.subarray(0,5).toString(),"%PDF-");
  const pdf=await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(),1);
});
