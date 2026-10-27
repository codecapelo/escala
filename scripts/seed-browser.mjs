import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createPool } from "../server/db.mjs";
import { hashPassword, randomToken } from "../server/security.mjs";
const u = new URL(process.env.DATABASE_URL || "");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
  !u.pathname.startsWith("/escala_tests_browser")
)
  throw Error("Only a fresh isolated local browser database is allowed");
const pool = createPool();
try {
  if (
    (
      await pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='escala' AND table_name='doctors'",
      )
    ).rowCount
  )
    throw Error("Browser seed requires a fresh database");
} finally {
  await pool.end();
}
execFileSync(process.execPath, ["scripts/migrate.mjs"], {
  env: process.env,
  stdio: "inherit",
});
const previous = fs.existsSync("private/import-result.json")
  ? fs.readFileSync("private/import-result.json")
  : null;
try {
  execFileSync(process.execPath, ["scripts/import.mjs"], {
    env: process.env,
    stdio: "ignore",
  });
} finally {
  if (previous) fs.writeFileSync("private/import-result.json", previous);
}
const db = createPool();
try {
  const password = randomToken();
  const hash = await hashPassword(password);
  const owner = (
    await db.query(
      "INSERT INTO escala.users(name,email,password_hash,role) VALUES('Coordenação de teste','owner@teste.local',$1,'owner') RETURNING id,email",
      [hash],
    )
  ).rows[0];
  const doctors = [];
  for (const [i, name] of [
    "Alessandra Jespersen de Athayde Rocha",
    "Amanda Araújo de Oliveira",
  ].entries()) {
    const d = (
      await db.query("SELECT * FROM escala.doctors WHERE name=$1", [name])
    ).rows[0];
    const email = `medico${i + 1}@teste.local`;
    await db.query(
      "INSERT INTO escala.users(name,email,password_hash,role,doctor_id) VALUES($1,$2,$3,'doctor',$4)",
      [name, email, hash, d.id],
    );
    doctors.push({ id: d.id, name, email });
  }
  fs.writeFileSync(
    "private/browser-accounts.json",
    JSON.stringify({ password, owner, doctors }, null, 2),
    { mode: 0o600 },
  );
  console.log("Browser fixtures seeded in isolated local database.");
} finally {
  await db.end();
}
