// Deliberately ignores .env.local and refuses remote database URLs.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
const local = parseEnv(
  readFileSync(new URL("../../private/local.env", import.meta.url), "utf8"),
);
if(process.env.E2E_DATABASE_URL){local.DATABASE_URL=process.env.E2E_DATABASE_URL;local.DATABASE_URL_UNPOOLED=process.env.E2E_DATABASE_URL;}
for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"])
  if (
    local[key] &&
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(local[key]).hostname)
  )
    throw new Error(
      "E2E requires a local PostgreSQL database; remote targets are forbidden.",
    );
if (!local.DATABASE_URL)
  throw new Error("private/local.env must declare DATABASE_URL.");
const mode = process.argv[2];
if (!["api", "vite"].includes(mode)) throw new Error("Expected api or vite.");
const env = {
  ...process.env,
  ...local,
  DATABASE_URL_UNPOOLED: local.DATABASE_URL_UNPOOLED || local.DATABASE_URL,
  APP_URL: "http://127.0.0.1:5273,http://localhost:5273",
  PORT: "3101",
  SERVE_DIST: "false",
};
const args =
  mode === "api"
    ? ["server/dev.mjs"]
    : [
        "node_modules/vite/bin/vite.js",
        "--config",
        "tests/e2e/vite.config.ts",
        "--strictPort",
      ];
const child = spawn(process.execPath, args, { env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code || 0));
