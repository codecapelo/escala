import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Plus,
  Users,
} from "lucide-react";
import { api, message } from "./api";
import { PeriodBadge } from "./ui";
import {
  dateLocal,
  dayLabel,
  formatNumber,
  hours,
  periods,
  shortName,
  todayISO,
  toISO,
} from "./utils";
import type { Period, Shift } from "./types";

import { StaffingBadge } from "./Vacancies";
export type ScheduleView = "calendar" | "week" | "day" | "list";
export function addCalendarDays(date: string, offset: number) {
  const value = dateLocal(date);
  value.setDate(value.getDate() + offset);
  return toISO(value);
}
export function weekDates(date: string) {
  const value = dateLocal(date);
  const monday = addCalendarDays(date, -((value.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) =>
    addCalendarDays(monday, index),
  );
}
export function rangeLabel(dates: string[]) {
  if (dates.length === 1)
    return dayLabel(dates[0], {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  return `${dayLabel(dates[0], { day: "numeric", month: "short" })} a ${dayLabel(dates.at(-1)!, { day: "numeric", month: "short", year: "numeric" })}`;
}

type MonthData = { shifts: Shift[]; locked: boolean };
type CachedMonth = MonthData & { fetchedAt: number; primaryVersion: Shift[] };
// Private calendar data stays only in this mounted component's memory. Requests
// are aborted on navigation, and late responses cannot overwrite the new range.
export function useCalendarMonths(
  month: string,
  primaryShifts: Shift[],
  locked: boolean,
  dates: string[],
) {
  const cache = useRef(new Map<string, CachedMonth>());
  const [revision, setRevision] = useState(0),
    [retry, setRetry] = useState(0);
  const [status, setStatus] = useState({ key: "", loading: false, error: "" });
  const key = [...new Set(dates.map((date) => date.slice(0, 7)))]
    .sort()
    .join("|");
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const requested = key.split("|");
    const missing = requested.filter(
      (value) =>
        value !== month &&
        (!cache.current.has(value) ||
          Date.now() - cache.current.get(value)!.fetchedAt > 30000 ||
          cache.current.get(value)!.primaryVersion !== primaryShifts),
    );
    setStatus({ key, loading: missing.length > 0, error: "" });
    if (missing.length) {
      Promise.allSettled(
        missing.map(async (value) => {
          const response = await api<MonthData>(
            `/shifts?month=${encodeURIComponent(value)}`,
            { signal: controller.signal },
          );
          if (live) {
            cache.current.set(value, {
              ...response,
              shifts: response.shifts.map((shift) => ({
                ...shift,
                month_locked: response.locked,
              })),
              fetchedAt: Date.now(),
              primaryVersion: primaryShifts,
            });
          }
        }),
      ).then((results) => {
        if (!live) return;
        const failed = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        // Bound the cache when navigating many months in one session.
        for (const value of cache.current.keys())
          if (cache.current.size > 8 && !requested.includes(value))
            cache.current.delete(value);
        setRevision((value) => value + 1);
        setStatus({
          key,
          loading: false,
          error: failed ? message(failed.reason) : "",
        });
      });
    }
    return () => {
      live = false;
      controller.abort();
    };
  }, [key, month, primaryShifts, retry]);
  const loaded = useMemo(() => {
    const months = key.split("|");
    const shifts: Shift[] = [];
    const locks: Record<string, boolean> = { [month]: locked };
    const ready = new Set<string>([month]);
    for (const value of months) {
      if (value === month)
        shifts.push(
          ...primaryShifts.map((shift) => ({ ...shift, month_locked: locked })),
        );
      else {
        const cached = cache.current.get(value);
        if (cached) {
          shifts.push(...cached.shifts);
          locks[value] = cached.locked;
          ready.add(value);
        }
      }
    }
    return { shifts, locks, ready };
  }, [key, month, primaryShifts, locked, revision]);
  return {
    ...loaded,
    loading: status.key !== key || status.loading,
    error: status.key === key ? status.error : "",
    reload: () => {
      for (const value of key.split("|")) cache.current.delete(value);
      setRetry((value) => value + 1);
    },
  };
}

export function DateRangeControl({
  view,
  date,
  onDate,
}: {
  view: "week" | "day";
  date: string;
  onDate: (date: string) => void;
}) {
  const week = view === "week",
    dates = week ? weekDates(date) : [date];
  return (
    <div className="agenda-range-control">
      <div className="agenda-range-arrows">
        <button
          type="button"
          className="icon-button"
          aria-label={week ? "Semana anterior" : "Dia anterior"}
          onClick={() => onDate(addCalendarDays(date, week ? -7 : -1))}
        >
          <ChevronLeft size={18} />
        </button>
        <span aria-live="polite">{rangeLabel(dates)}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={week ? "Próxima semana" : "Próximo dia"}
          onClick={() => onDate(addCalendarDays(date, week ? 7 : 1))}
        >
          <ChevronRight size={18} />
        </button>
      </div>
      <label className="agenda-date-input">
        <CalendarDays size={15} />
        <span className="sr-only">
          {week ? "Data da semana" : "Data do dia"}
        </span>
        <input
          aria-label={week ? "Data da semana" : "Data do dia"}
          type="date"
          value={date}
          min="2000-01-01"
          max="2099-12-31"
          onChange={(event) => {
            if (/^20\d{2}-\d{2}-\d{2}$/.test(event.target.value))
              onDate(event.target.value);
          }}
        />
      </label>
    </div>
  );
}

function AgendaShift({
  shift,
  onShift,
}: {
  shift: Shift;
  onShift: (shift: Shift) => void;
}) {
  return (
    <button
      type="button"
      className={`agenda-shift-card ${shift.period}`}
      onClick={() => onShift(shift)}
      title={shift.assignments
        .map((assignment) => assignment.doctor_name)
        .join(", ")}
    >
      <div className="agenda-shift-heading">
        <PeriodBadge period={shift.period} />
        {shift.needs_review && (
          <span className="agenda-review-dot" aria-label="Revisão pendente" />
        )}
        {shift.assignments.some((assignment) => assignment.offer_id) && (
          <ArrowUpRight size={14} aria-label="Repasse disponível" />
        )}
      </div>
      <strong className="agenda-shift-time">
        {shift.start_time}
        <span>às</span>
        {shift.end_time}
      </strong>
      {shift.end_time < shift.start_time && (
        <small className="agenda-next-day">Termina no dia seguinte</small>
      )}
      <StaffingBadge shift={shift}/>
      <span className="agenda-shift-unit">{shift.unit}</span>
      <span className="agenda-shift-team">
        <Users size={13} />
        {shift.assignments.length === 1
          ? shortName(shift.assignments[0].doctor_name)
          : `${shift.assignments.length} médicos`}
      </span>
    </button>
  );
}

export function WeekView({
  dates,
  shifts,
  onShift,
  onNew,
  canCreate,
  isReady,
  loading,
  filtered,
}: {
  dates: string[];
  shifts: Shift[];
  onShift: (shift: Shift) => void;
  onNew: (date: string) => void;
  canCreate: (date: string) => boolean;
  isReady: (date: string) => boolean;
  loading: boolean;
  filtered: boolean;
}) {
  return (
    <div
      className="agenda-week"
      aria-label={`Agenda da semana de ${rangeLabel(dates)}`}
    >
      {dates.map((date) => {
        const entries = shifts.filter((shift) => shift.date === date);
        const ready = isReady(date);
        return (
          <section
            className={`agenda-week-day ${date === todayISO() ? "agenda-is-today" : ""}`}
            key={date}
            aria-label={dayLabel(date, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          >
            <header className="agenda-week-day-header">
              <div>
                <span>{dayLabel(date, { weekday: "short" })}</span>
                <h3>
                  {date.slice(8)}
                  <small>{dayLabel(date, { month: "short" })}</small>
                </h3>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={`Adicionar plantão em ${dayLabel(date)}`}
                disabled={!canCreate(date)}
                onClick={() => onNew(date)}
              >
                <Plus size={16} />
              </button>
            </header>
            <div className="agenda-week-day-body">
              {entries.map((shift) => (
                <AgendaShift key={shift.id} shift={shift} onShift={onShift} />
              ))}
              {!entries.length && (
                <div className="agenda-day-empty">
                  <CalendarDays size={20} />
                  <span>
                    {!ready
                      ? loading
                        ? "Carregando este dia…"
                        : "Dados deste dia indisponíveis"
                      : filtered
                        ? "Nenhum plantão com esses filtros"
                        : "Nenhum plantão neste dia"}
                  </span>
                </div>
              )}
            </div>
            <footer className="agenda-week-day-footer">
              {ready
                ? `${entries.length} plant${entries.length === 1 ? "ão" : "ões"}`
                : loading
                  ? "Carregando"
                  : "Mês indisponível"}
            </footer>
          </section>
        );
      })}
    </div>
  );
}

export function DayView({
  date,
  shifts,
  onShift,
  onNew,
  canCreate,
  isReady,
  loading,
  filtered,
}: {
  date: string;
  shifts: Shift[];
  onShift: (shift: Shift) => void;
  onNew: (date: string) => void;
  canCreate: (date: string) => boolean;
  isReady: (date: string) => boolean;
  loading: boolean;
  filtered: boolean;
}) {
  const entries = shifts.filter((shift) => shift.date === date);
  const coverage = entries.reduce(
    (total, shift) =>
      total +
      hours(shift.start_time, shift.end_time) * shift.assignments.length,
    0,
  );
  return (
    <div
      className="agenda-day"
      aria-label={`Agenda de ${dayLabel(date, { day: "numeric", month: "long", year: "numeric" })}`}
    >
      <div className="agenda-day-summary">
        <div>
          <span className="eyebrow">
            {date === todayISO() ? "HOJE, NA ESCALA" : "O CUIDADO DESTE DIA"}
          </span>
          <h3>
            {dayLabel(date, { weekday: "long", day: "numeric", month: "long" })}
          </h3>
          <p>
            {entries.length} plantões <span>·</span>{" "}
            {entries.reduce(
              (count, shift) => count + shift.assignments.length,
              0,
            )}{" "}
            alocações <span>·</span> {formatNumber(coverage)}h de cobertura
          </p>
        </div>
        <button
          className="button button-secondary button-sm"
          disabled={!canCreate(date)}
          onClick={() => onNew(date)}
        >
          <Plus size={15} />
          Adicionar neste dia
        </button>
      </div>
      <div className="agenda-day-periods">
        {(["dawn", "morning", "afternoon", "night"] as Period[]).map(
          (period) => {
            const items = entries.filter((shift) => shift.period === period);
            return (
              <section
                className={`agenda-day-period ${period}`}
                key={period}
                aria-label={`Turno ${periods[period].label}`}
              >
                <header>
                  <PeriodBadge period={period} />
                  <span>
                    <Clock3 size={12} />
                    {periods[period].time}
                  </span>
                </header>
                <div>
                  {items.map((shift) => (
                    <AgendaShift
                      key={shift.id}
                      shift={shift}
                      onShift={onShift}
                    />
                  ))}
                  {!items.length && (
                    <p className="agenda-period-empty">
                      {!isReady(date)
                        ? loading
                          ? "Carregando plantões…"
                          : "Não foi possível carregar o dia"
                        : filtered
                          ? "Nenhum plantão com esses filtros"
                          : "Sem plantão neste turno"}
                    </p>
                  )}
                </div>
              </section>
            );
          },
        )}
      </div>
    </div>
  );
}
