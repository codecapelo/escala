import {
  randomBytes,
  createHash,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCb);
export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (v) => createHash("sha256").update(v).digest("hex");
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password, hash) {
  const [, n, salt, key] = String(hash || "").split("$");
  if (!salt || !key) {
    await scrypt(password, "invalid-account-dummy-salt", 64, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return false;
  }
  const candidate = await scrypt(password, salt, 64, {
    N: Number(n),
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const expected = Buffer.from(key, "hex");
  return (
    expected.length === candidate.length && timingSafeEqual(expected, candidate)
  );
}
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}
export function fail(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  throw e;
}
export function shiftStart(shift) {
  return new Date(
    `${shift.date.slice(0, 10)}T${shift.start_time.slice(0, 5)}:00-03:00`,
  );
}
export function shiftHours(s) {
  const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return ((minutes(s.end_time) - minutes(s.start_time) + 1440) % 1440) / 60;
}
export function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+@\-\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
