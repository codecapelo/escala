import { readFile, readdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import path from "node:path";
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? files(path.join(dir, e.name))
          : [path.join(dir, e.name)],
      ),
    )
  ).flat();
}
const secrets = new Set();
for (const file of [
  ".env.local",
  "private/production.env",
  "private/validation-runtime.env",
]) {
  try {
    const env = parseEnv(await readFile(file, "utf8"));
    for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
      if (env[key]) {
        const url = new URL(env[key]);
        secrets.add(env[key]);
        if (url.password) secrets.add(decodeURIComponent(url.password));
        secrets.add(url.hostname);
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
let count = 0;
for (const file of await files("dist")) {
  const data = await readFile(file, "utf8");
  for (const s of secrets)
    if (s.length > 10 && data.includes(s))
      throw new Error(
        "Sensitive database configuration found in public bundle: " + file,
      );
  count++;
}
console.log(
  `Public bundle checked: ${count} files; no database URL, password or endpoint found.`,
);
