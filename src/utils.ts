import type { Period, User, Doctor } from "./types";
export const periods: Record<
  Period,
  { label: string; short: string; time: string; className: string }
> = {
  morning: {
    label: "Manhã",
    short: "Manhã",
    time: "07:00–13:00",
    className: "morning",
  },
  afternoon: {
    label: "Tarde",
    short: "Tarde",
    time: "13:00–19:00",
    className: "afternoon",
  },
  night: {
    label: "Noite",
    short: "Noite",
    time: "19:00–00:00",
    className: "night",
  },
  dawn: {
    label: "Madrugada",
    short: "Madr.",
    time: "00:00–07:00",
    className: "dawn",
  },
};
export const roleLabels = {
  owner: "Proprietário",
  admin: "Administrador",
  doctor: "Médico",
};
export function dateLocal(date: string) {
  return new Date(`${date.slice(0, 10)}T12:00:00`);
}
export function dayLabel(
  date: string,
  opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short" },
) {
  return dateLocal(date).toLocaleDateString("pt-BR", opts);
}
export function monthLabel(month: string) {
  return dateLocal(`${month}-01`).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });
}
export function toISO(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export const timeZone = "America/Fortaleza";
export function todayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
}
export function shiftMonth(month: string, offset: number) {
  const d = dateLocal(`${month}-01`);
  d.setMonth(d.getMonth() + offset);
  return toISO(d).slice(0, 7);
}
export function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}
export function shortName(name: string) {
  const parts = name.replace(/^(Dr\.?|Dra\.?)\s+/i, "").split(" ");
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)}` : parts[0];
}
export function formatNumber(n: number) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(n);
}
export function hours(start: string, end: string) {
  const [s, m] = start.split(":").map(Number),
    [e, n] = end.split(":").map(Number);
  return ((e * 60 + n - s * 60 - m + 1440) % 1440 || 1440) / 60;
}

export function isUpcoming(date: string, time: string) {
  return (
    new Date(`${date.slice(0, 10)}T${time.slice(0, 5)}:00-03:00`).getTime() >
    Date.now()
  );
}

export function isApproved(user: User) {
  return !user.approval_status || user.approval_status === "approved";
}
export function canEditSchedule(user: User) {
  return (
    isApproved(user) &&
    (user.role === "owner" ||
      user.role === "admin" ||
      !!user.can_manage_schedule)
  );
}
export function crmLabel(doctor: Pick<Doctor, "crm" | "crm_uf">) {
  return doctor.crm
    ? `CRM ${doctor.crm}${doctor.crm_uf ? `/${doctor.crm_uf}` : ""}`
    : "CRM não informado";
}
export const brazilStates = [
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
];
export type ShiftOrder = "time" | "period" | "team_desc" | "team_asc";
export const shiftOrders: { id: ShiftOrder; label: string }[] = [
  { id: "time", label: "Horário (padrão)" },
  { id: "period", label: "Turno: manhã → madrugada" },
  { id: "team_desc", label: "Mais médicos primeiro" },
  { id: "team_asc", label: "Menos médicos primeiro" },
];
const periodRank: Record<Period, number> = {
  morning: 0,
  afternoon: 1,
  night: 2,
  dawn: 3,
};
type Orderable = {
  date: string;
  start_time: string;
  period: Period;
  assignments: unknown[];
};
// Days always stay in date order; the choice only reorders shifts within a day.
export function compareShifts(order: ShiftOrder) {
  return (a: Orderable, b: Orderable) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate) return byDate;
    const byTime = a.start_time.localeCompare(b.start_time);
    if (order === "period")
      return periodRank[a.period] - periodRank[b.period] || byTime;
    if (order === "team_desc")
      return b.assignments.length - a.assignments.length || byTime;
    if (order === "team_asc")
      return a.assignments.length - b.assignments.length || byTime;
    return byTime;
  };
}
