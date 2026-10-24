import pg from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
neonConfig.webSocketConstructor = ws;
export function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not configured");
  const neon = new URL(url).hostname.endsWith(".neon.tech");
  const Pool = neon ? NeonPool : pg.Pool;
  return new Pool({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 10000,
  });
}
export async function transaction(db, fn) {
  await db.query("BEGIN");
  try {
    // Serialize mutations for this organization, including overlap checks and monthly closure.
    await db.query("SELECT pg_advisory_xact_lock(716294023)");
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
