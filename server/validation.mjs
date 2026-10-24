import { z } from "zod";
export const uuid = z.string().uuid();
export const month = z
  .string()
  .regex(/^20\d{2}-(0[1-9]|1[0-2])$/, "Mês inválido.");
export const date = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s,
    "Data inválida.",
  );
export const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido.");
export const password = z
  .string()
  .min(10, "Use pelo menos 10 caracteres.")
  .max(128);
export const text = (n = 200) => z.string().trim().min(2).max(n);
export const login = z.object({
  email: z
    .email()
    .max(254)
    .transform((x) => x.toLowerCase().trim()),
  password: z.string().min(1).max(128),
});
export const activate = z.object({
  token: z.string().min(32).max(128),
  name: text(180),
  password,
});
export const shift = z
  .object({
    date,
    start_time: time,
    end_time: time,
    period: z.enum(["morning", "afternoon", "night", "dawn"]),
    unit: text(120).default("Amil • Telemedicina"),
    notes: z.string().trim().max(2000).default(""),
    doctor_ids: z.array(uuid).max(150).default([]),
    dates: z.array(date).max(62).optional(),
  })
  .refine(
    (x) => x.start_time !== x.end_time,
    "Horário inicial e final devem ser diferentes.",
  );
export const shiftPatch = z.object({
  date: date.optional(),
  start_time: time.optional(),
  end_time: time.optional(),
  period: z.enum(["morning", "afternoon", "night", "dawn"]).optional(),
  unit: text(120).optional(),
  notes: z.string().trim().max(2000).optional(),
  needs_review: z.boolean().optional(),
});
export const doctor = z.object({
  name: text(180),
  crm: z.string().trim().max(40).nullable().optional(),
  specialty: text(120).default("Telemedicina"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#147d83"),
});
export const invite = z.object({
  email: z
    .email()
    .max(254)
    .transform((x) => x.toLowerCase().trim()),
  name: text(180),
  role: z.enum(["admin", "doctor"]),
  doctor_id: uuid.nullable().optional(),
});
export { z };
