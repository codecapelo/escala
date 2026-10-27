import { readFile } from "node:fs/promises";
import { createPool } from "../server/db.mjs";
const pool = createPool(
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
);
const db = await pool.connect();
try {
  await db.query("BEGIN");
  await db.query(
    await readFile(new URL("../server/schema.sql", import.meta.url), "utf8"),
  );
  await db.query(
    await readFile(
      new URL("../server/review-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.query(await readFile(new URL("../server/workflow-schema.sql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../server/vacancy-schema.sql", import.meta.url), "utf8"));
  await db.query("COMMIT");
  console.log("Migration successful: escala schema and 16 tables ready.");
} catch (e) {
  await db.query("ROLLBACK");
  console.error(e.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
