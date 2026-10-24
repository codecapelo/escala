import { createPool } from "../server/db.mjs";
import { hashPassword, randomToken } from "../server/security.mjs";
import { writeFile } from "node:fs/promises";
if (process.env.NEON_BRANCH !== "escala-validation-20261024")
  throw new Error("Validation branch only.");
const pool = createPool();
try {
  const password = randomToken();
  const hash = await hashPassword(password);
  const suffix = Date.now();
  const owner = (
    await pool.query(
      "INSERT INTO escala.users(name,email,password_hash,role) VALUES('Verificação do sistema',$1,$2,'owner') RETURNING id,name,email",
      [`validation-owner-${suffix}@example.test`, hash],
    )
  ).rows[0];
  const doctors = [];
  for (let i = 1; i <= 3; i++) {
    const doctor = (
      await pool.query(
        "INSERT INTO escala.doctors(name,specialty) VALUES($1,'Validação temporária') RETURNING *",
        [`Médico de validação ${i}`],
      )
    ).rows[0];
    const user =
      i < 3
        ? (
            await pool.query(
              "INSERT INTO escala.users(name,email,password_hash,role,doctor_id) VALUES($1,$2,$3,'doctor',$4) RETURNING id,name,email",
              [
                doctor.name,
                `validation-doctor-${i}-${suffix}@example.test`,
                hash,
                doctor.id,
              ],
            )
          ).rows[0]
        : null;
    doctors.push({ ...doctor, user });
  }
  await writeFile(
    "private/validation-accounts.json",
    JSON.stringify({ password, owner, doctors }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    "Temporary validation accounts created; credentials stored privately.",
  );
} finally {
  await pool.end();
}
