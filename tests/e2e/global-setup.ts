import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import pg from "pg";
export default async function setup() {
  const local = parseEnv(readFileSync("private/local.env", "utf8"));
  if(process.env.E2E_DATABASE_URL)local.DATABASE_URL=process.env.E2E_DATABASE_URL;
  if (
    !local.DATABASE_URL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(local.DATABASE_URL).hostname,
    )
  )
    throw new Error(
      "E2E throttle reset is permitted only on the configured local database.",
    );
  const accounts = JSON.parse(
    readFileSync(process.env.E2E_ACCOUNTS_FILE || "private/local-test-accounts.json", "utf8"),
  );
  const db = new pg.Client({ connectionString: local.DATABASE_URL });
  await db.connect();
  try {
    // Repeated suites must start from isolated fixture counters. Production rate
    // limits and application code stay intact; only known localhost/test keys reset.
    const emails = [
      accounts.owner.email,
      ...accounts.doctors.map((d: any) => d.email),
    ];
    const users = (
      await db.query(
        "SELECT id FROM escala.users WHERE email=ANY($1::text[])",
        [emails],
      )
    ).rows;
    const keys = [
      ...["127.0.0.1", "::1", "::ffff:127.0.0.1"].flatMap((ip) => [
        "ip:" + ip,
        "activate:" + ip,
      ]),
      ...emails.map((email) => "login:" + email.toLowerCase().trim()),
      ...users.map((u) => "password:" + u.id),
    ];
    const hashes = keys.map((key) =>
      createHash("sha256").update(key).digest("hex"),
    );
    const result = await db.query(
      "DELETE FROM escala.rate_limits WHERE key=ANY($1::text[])",
      [hashes],
    );
    console.log(`Reset ${result.rowCount} local fixture throttle counter(s).`);
  } finally {
    await db.end();
  }
}
