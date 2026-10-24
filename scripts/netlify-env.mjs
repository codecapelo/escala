import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
const accountId = "codecapelo",
  siteId = "d0f54c82-56f9-49bb-b2b1-4d59c792f831";
const production = parseEnv(
  await readFile(process.argv[2] || "private/production.env", "utf8"),
);
const validation = parseEnv(
  await readFile(process.argv[3] || "private/validation-runtime.env", "utf8"),
);
production.APP_URL = "https://amil-escala.netlify.app";
validation.APP_URL = "https://validacao--amil-escala.netlify.app";
const secrets = [production.DATABASE_URL, validation.DATABASE_URL].filter(
  Boolean,
);
function api(method, payload) {
  const r = spawnSync(
    "netlify",
    ["api", method, "--data", JSON.stringify(payload)],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    let msg = r.stderr || r.stdout;
    for (const s of secrets) msg = msg.replaceAll(s, "[redacted]");
    throw new Error(`Netlify ${method} failed: ${msg}`);
  }
  return JSON.parse(r.stdout);
}
const current = api("getEnvVars", { accountId, siteId });
for (const key of ["DATABASE_URL", "APP_URL", "NODE_ENV"]) {
  if (!production[key] || !validation[key]) throw new Error("Missing " + key);
  const existing = current.find((x) => x.key === key);
  const values = [
    ...(existing?.values || []).filter(
      (v) =>
        v.context !== "production" &&
        !(v.context === "branch" && v.context_parameter === "validacao"),
    ),
    { context: "production", value: production[key] },
    {
      context: "branch",
      context_parameter: "validacao",
      value: validation[key],
    },
  ];
  // Default project scopes were explicitly approved by the owner because the
  // current plan rejects granular scopes. Client exposure is audited separately.
  const body = { key, values };
  if (existing) api("updateEnvVar", { accountId, siteId, key, body });
  else api("createEnvVars", { accountId, siteId, body: [body] });
  console.log(
    `Configured ${key} for production and validation branch (project default scopes).`,
  );
}
const saved = api("getEnvVars", { accountId, siteId });
for (const key of ["DATABASE_URL", "APP_URL", "NODE_ENV"]) {
  const v = saved.find((x) => x.key === key);
  if (
    v?.values.find((x) => x.context === "production")?.value !==
      production[key] ||
    v?.values.find(
      (x) => x.context === "branch" && x.context_parameter === "validacao",
    )?.value !== validation[key]
  )
    throw new Error("Persisted value mismatch for " + key);
}
console.log(
  "Verified all six environment values persisted; credentials not printed.",
);
