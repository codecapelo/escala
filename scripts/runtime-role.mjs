import { createPool } from "../server/db.mjs";
import { randomToken } from "../server/security.mjs";
import { writeFile, access } from "node:fs/promises";
const role = "amil_escala_runtime";
const output = process.argv[2] || "private/production.env";
const pool = createPool(
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
);
const db = await pool.connect();
try {
  const existing = (
    await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])
  ).rows.length;
  if (existing) {
    await access(output);
    console.log("Runtime role already exists; preserving its credential.");
  } else {
    const password = randomToken();
    await db.query("BEGIN");
    try {
      const command = (
        await db.query(
          "SELECT format('CREATE ROLE amil_escala_runtime LOGIN PASSWORD %L', $1::text)",
          [password],
        )
      ).rows[0].format;
      await db.query(command);
      await db.query("GRANT USAGE ON SCHEMA escala TO amil_escala_runtime");
      await db.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON escala.doctors,escala.users,escala.sessions,escala.invites,escala.months,escala.shifts,escala.assignments,escala.offers,escala.rate_limits TO amil_escala_runtime",
      );
      await db.query(
        "GRANT SELECT,INSERT ON escala.audit,escala.import_reviews,escala.doctor_merges TO amil_escala_runtime",
      );
      await db.query("GRANT SELECT ON escala.imports TO amil_escala_runtime");
      const url = new URL(process.env.DATABASE_URL);
      url.username = role;
      url.password = password;
      await writeFile(
        output,
        `DATABASE_URL=${url.href}\nAPP_URL=https://amil-escala.netlify.app\nNODE_ENV=production\n`,
        { mode: 0o600 },
      );
      await db.query("COMMIT");
      console.log(
        "Restricted runtime role created; credential saved privately.",
      );
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  }
} finally {
  db.release();
  await pool.end();
}
