import { mkdir, writeFile } from "node:fs/promises";
import { createPool, transaction } from "../server/db.mjs";
import { randomToken, digest } from "../server/security.mjs";
const email = process.argv[2];
const name = process.argv[3] || "Proprietário";
if (!email || !email.includes("@"))
  throw new Error("Usage: node scripts/bootstrap-owner.mjs owner@email Name");
const pool = createPool();
const db = await pool.connect();
try {
  const token = randomToken();
  await transaction(db, async () => {
    if (
      (
        await db.query(
          "SELECT id FROM escala.users WHERE role='owner' UNION ALL SELECT id FROM escala.invites WHERE role='owner' AND kind='invite' AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>now() LIMIT 1",
        )
      ).rows.length
    )
      throw new Error("Owner or active owner invitation already exists.");
    await db.query(
      "INSERT INTO escala.invites(token_hash,email,name,role,expires_at) VALUES($1,$2,$3,'owner',now()+interval '7 days')",
      [digest(token), email.toLowerCase(), name],
    );
  });
  const url =
    (process.env.APP_URL || "http://localhost:5173") + "/ativar?token=" + token;
  await mkdir("private", { recursive: true });
  await writeFile(
    "private/owner-access.txt",
    `Acesso inicial do proprietário\nE-mail: ${email}\nValidade: 7 dias; uso único.\nAbra o link e escolha sua própria senha:\n${url}\n`,
    { mode: 0o600 },
  );
  console.log(
    "Owner activation link created in private/owner-access.txt (not printed).",
  );
} finally {
  db.release();
  await pool.end();
}
