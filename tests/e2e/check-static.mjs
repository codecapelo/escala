// Read-only check of built public assets. Never prints matched private values.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
const workspace = process.cwd();
const accounts = JSON.parse(
  await readFile(
    path.join(workspace, "private/local-test-accounts.json"),
    "utf8",
  ),
);
const local = parseEnv(
  await readFile(path.join(workspace, "private/local.env"), "utf8"),
);
if (
  !local.DATABASE_URL ||
  !["127.0.0.1", "localhost", "[::1]"].includes(
    new URL(local.DATABASE_URL).hostname,
  )
)
  throw new Error(
    "Static privacy check requires local-only fixture configuration.",
  );
const source = JSON.parse(
  await readFile(path.join(workspace, "data/import-october.json"), "utf8"),
);
const patterns = [
  ...[
    accounts.password,
    ...Object.values(local).filter((v) => /^postgres(?:ql)?:\/\//.test(v)),
  ]
    .filter(Boolean)
    .map((value) => ({ category: "private credential", value })),
  ...[accounts.owner.email, ...accounts.doctors.map((d) => d.email)].map(
    (value) => ({ category: "private fixture email", value }),
  ),
  ...source.doctors.map((d) => ({
    category: "source physician name",
    value: d.name,
  })),
];
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(file)));
    else if (entry.isFile()) result.push(file);
    else throw new Error("Unexpected nonregular static asset.");
  }
  return result;
}
const root = path.join(workspace, "dist");
const files = await walk(root);
const violations = [];
let bytes = 0;
for (const file of files) {
  const buffer = await readFile(file);
  bytes += buffer.length;
  const text = buffer.toString("utf8");
  for (const pattern of patterns)
    if (text.includes(pattern.value))
      violations.push({
        file: path.relative(root, file),
        category: pattern.category,
      });
}
console.log(
  JSON.stringify({
    files: files.length,
    bytes,
    privateValueMatches: violations.length,
    violations,
  }),
);
if (violations.length) process.exitCode = 1;
