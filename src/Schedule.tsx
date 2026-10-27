import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  List,
  Calendar,
  SlidersHorizontal,
  ArrowUpRight,
  Users,
  Clock3,
  ArrowRightLeft,
  ArrowRight,
  LockKeyhole,
  CircleCheck,
  X,
  AlertCircle,
  CalendarRange,
  Loader2,
  ArrowDownUp,
  CalendarPlus,
} from "lucide-react";
import { Avatar, Empty, ErrorBox, PeriodBadge, PeriodIcon } from "./ui";
import {
  DateRangeControl,
  DayView,
  WeekView,
  useCalendarMonths,
  weekDates,
} from "./CalendarViews";
import type { ScheduleView } from "./CalendarViews";
import { previewProps, ShiftPreviewHost } from "./ShiftPreview";
import GenerateSchedule from "./GenerateSchedule";
import "./calendar.css";
import {
  dateLocal,
  dayLabel,
  formatNumber,
  hours,
  monthLabel,
  periods,
  shiftMonth,
  shortName,
  todayISO,
  toISO,
  canEditSchedule,
  isUpcoming,
  compareShifts,
  shiftOrders,
} from "./utils";
import type { ShiftOrder } from "./utils";
import type { Dashboard, Period, Shift, User } from "./types";
import { StaffingBadge } from "./Vacancies";
export function MonthControl({
  month,
  onMonth,
}: {
  month: string;
  onMonth: (m: string) => void;
}) {
  return (
    <div className="month-control">
      <button
        aria-label="Mês anterior"
        title="Mês anterior"
        className="icon-button"
        onClick={() => onMonth(shiftMonth(month, -1))}
      >
        <ChevronLeft size={18} />
      </button>
      <span>{monthLabel(month)}</span>
      <button
        aria-label="Próximo mês"
        className="icon-button"
        onClick={() => onMonth(shiftMonth(month, 1))}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
export default function Schedule({
  data,
  user,
  month,
  onMonth,
  onNew,
  onShift,
  onDay,
  onOffers,
  onGenerated,
}: {
  data: Dashboard;
  user: User;
  month: string;
  onMonth: (month: string) => void;
  onNew: (date?: string) => void;
  onShift: (s: Shift) => void;
  onDay: (date: string) => void;
  onOffers: () => void;
  onGenerated: (month: string, summary: string) => void;
}) {
  const [view, setView] = useState<ScheduleView>(() =>
    window.innerWidth < 700 ? "list" : "calendar",
  );
  const [focusDate, setFocusDate] = useState(() =>
    month === todayISO().slice(0, 7) ? todayISO() : `${month}-01`,
  );
  const [generating, setGenerating] = useState(false),
    [order, setOrder] = useState<ShiftOrder>("time"),
    [doctor, setDoctor] = useState(""),
    [period, setPeriod] = useState(""),
    [reviewOnly, setReviewOnly] = useState(false);
  useEffect(() => {
    setFocusDate((current) =>
      current.slice(0, 7) === month
        ? current
        : month === todayISO().slice(0, 7)
          ? todayISO()
          : `${month}-01`,
    );
  }, [month]);
  const agenda = view === "week" || view === "day";
  const dates =
    view === "week"
      ? weekDates(focusDate)
      : view === "day"
        ? [focusDate]
        : [`${month}-01`];
  const calendar = useCalendarMonths(month, data.shifts, data.locked, dates);
  const sourceShifts = agenda
    ? calendar.shifts.filter(
        (shift) => shift.date >= dates[0] && shift.date <= dates.at(-1)!,
      )
    : data.shifts;
  const shifts = useMemo(
    () =>
      sourceShifts
        .filter(
          (shift) =>
            (!doctor ||
              shift.assignments.some(
                (assignment) => assignment.doctor_id === doctor,
              )) &&
            (!period || shift.period === period) &&
            (!reviewOnly || shift.needs_review),
        )
        .sort(compareShifts(order)),
    [sourceShifts, doctor, period, reviewOnly, order],
  );
  const ownShifts = user.doctor_id
    ? data.shifts.filter((shift) =>
        shift.assignments.some(
          (assignment) => assignment.doctor_id === user.doctor_id,
        ),
      )
    : data.shifts;
  const ownHours = ownShifts.reduce(
    (total, shift) => total + hours(shift.start_time, shift.end_time),
    0,
  );
  const ownDays = new Set(ownShifts.map((shift) => shift.date)).size;
  const next = ownShifts
    .filter((shift) => isUpcoming(shift.date, shift.start_time))
    .sort((left, right) =>
      `${left.date}${left.start_time}`.localeCompare(
        `${right.date}${right.start_time}`,
      ),
    )[0];
  const activeOffers = data.offers.filter(
    (offer) => offer.status === "open",
  ).length;
  const admin = user.role !== "doctor",
    canCreate = canEditSchedule(user);
  const canCreateDate = (date: string) =>
    canCreate &&
    calendar.ready.has(date.slice(0, 7)) &&
    calendar.locks[date.slice(0, 7)] === false;
  const pending = sourceShifts.filter((shift) => shift.needs_review).length;
  const filtered = !!(doctor || period || reviewOnly);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ORGANIZAÇÃO QUE CUIDA</span>
          <h1>
            A sua equipe, em sintonia<span>.</span>
          </h1>
          <p>
            {user.role === "doctor"
              ? "Acompanhe sua escala, encontre oportunidades e organize seu tempo."
              : "Uma visão clara dos plantões para um cuidado que não para."}
          </p>
        </div>
        {canCreate && (
          <div className="button-row">
            <button
              className="button button-secondary"
              onClick={() => setGenerating(true)}
            >
              <CalendarPlus size={18} />
              Gerar escala
            </button>
            <button
              className="button button-primary"
              onClick={() => onNew(agenda ? focusDate : undefined)}
              disabled={agenda ? !canCreateDate(focusDate) : data.locked}
            >
              <Plus size={18} />
              Novo plantão
            </button>
          </div>
        )}
      </div>
      <div className="stats-grid">
        <Stat
          icon={<CalendarDays size={20} />}
          value={user.role === "doctor" ? ownShifts.length : data.stats.shifts}
          label={user.role === "doctor" ? "Meus plantões" : "Plantões médicos"}
          note={
            user.role === "doctor"
              ? "Escala do período"
              : `Escala de ${monthLabel(month)}`
          }
        />
        <Stat
          icon={<Clock3 size={20} />}
          value={`${formatNumber(user.role === "doctor" ? ownHours : data.stats.hours)}h`}
          label={user.role === "doctor" ? "Minhas horas" : "Horas de cobertura"}
          note={
            admin ? `Escala de ${monthLabel(month)}` : "Distribuídas na escala"
          }
        />
        <Stat
          icon={<Users size={20} />}
          value={data.stats.doctors}
          label="Médicos na equipe"
          note="Uma equipe conectada"
        />
        <Stat
          icon={<ArrowRightLeft size={20} />}
          value={activeOffers}
          label="Repasses disponíveis"
          note="Explore as oportunidades"
          action={onOffers}
          warm
        />
      </div>
      {admin && user.doctor_id && (
        <section
          className="personal-schedule-card"
          aria-label="Meu resumo mensal"
        >
          <div className="personal-schedule-identity">
            <Avatar name={user.name} />
            <div>
              <span className="eyebrow">VOCÊ TAMBÉM NA ESCALA</span>
              <h2>Seus plantões em {monthLabel(month)}</h2>
              <p>
                {next ? (
                  <>
                    Próximo: {dayLabel(next.date)} · {next.start_time} às{" "}
                    {next.end_time}
                  </>
                ) : (
                  "Nenhum próximo plantão neste mês."
                )}
              </p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Plantões</dt>
              <dd>{ownShifts.length}</dd>
            </div>
            <div>
              <dt>Horas</dt>
              <dd>{formatNumber(ownHours)}h</dd>
            </div>
            <div>
              <dt>Dias</dt>
              <dd>{ownDays}</dd>
            </div>
          </dl>
          <button
            className={`button ${doctor === user.doctor_id ? "button-primary" : "button-secondary"}`}
            aria-pressed={doctor === user.doctor_id}
            onClick={() =>
              setDoctor(doctor === user.doctor_id ? "" : user.doctor_id!)
            }
          >
            <CalendarDays size={16} />
            Meus plantões
          </button>
          {next && (
            <button
              className="text-button personal-next-button"
              onClick={() => onShift(next)}
            >
              Ver próximo
              <ArrowRight size={14} />
            </button>
          )}
        </section>
      )}
      <div className="schedule-banner">
        <div className="banner-icon">
          {data.locked ? <LockKeyhole size={20} /> : <CircleCheck size={20} />}
        </div>
        <div>
          <strong>
            {data.locked
              ? "Escala do mês fechada"
              : next
                ? user.role === "doctor"
                  ? "Seu próximo cuidado já tem hora marcada."
                  : "Tudo à vista. Tudo conectado."
                : "Seu mês começa por aqui."}
          </strong>
          <p>
            {data.locked
              ? "Os plantões deste período estão protegidos para consulta e conferência."
              : next
                ? user.role === "doctor"
                  ? `${dayLabel(next.date, { weekday: "short", day: "numeric", month: "long" })} · ${next.start_time} às ${next.end_time} · ${next.unit}`
                  : "Confira a escala, organize a equipe e acompanhe cada mudança."
                : "Selecione um período para acompanhar a equipe ou crie um novo plantão."}
          </p>
        </div>
        {next && user.role === "doctor" && !data.locked && (
          <button className="text-button" onClick={() => onShift(next)}>
            Ver plantão <ArrowRight size={16} />
          </button>
        )}
        <span
          className={`status-pill ${data.locked ? "status-muted" : "status-success"}`}
        >
          <span />
          {data.locked ? "Mês fechado" : "Escala aberta"}
        </span>
      </div>
      {canCreate && pending > 0 && (
        <div className="review-callout">
          <AlertCircle size={16} />
          <p>
            <strong>{pending} plantões aguardam conferência.</strong> Verifique
            os dados importados antes do fechamento do mês.
          </p>
          <button
            className="text-button"
            onClick={() => setReviewOnly(!reviewOnly)}
          >
            {reviewOnly ? "Ver toda a escala" : "Conferir plantões"}
            <ArrowRight size={13} />
          </button>
        </div>
      )}
      <section className={`schedule-card schedule-card--${view}`}>
        <div className="schedule-toolbar">
          <div className="calendar-title">
            <CalendarDays size={20} />
            <h2>Escala de plantões</h2>
          </div>
          <div className="schedule-controls">
            {agenda ? (
              <DateRangeControl
                view={view}
                date={focusDate}
                onDate={setFocusDate}
              />
            ) : (
              <MonthControl month={month} onMonth={onMonth} />
            )}
            <button
              className="button button-secondary button-sm today-button"
              onClick={() => {
                setFocusDate(todayISO());
                if (!agenda) onMonth(todayISO().slice(0, 7));
              }}
            >
              Hoje
            </button>
            <div className="view-toggle" aria-label="Visualização da escala">
              <button
                className={view === "calendar" ? "selected" : ""}
                aria-label="Visualização em calendário"
                aria-pressed={view === "calendar"}
                onClick={() => setView("calendar")}
              >
                <Calendar size={16} />
                <span>Mês</span>
              </button>
              <button
                className={view === "week" ? "selected" : ""}
                aria-label="Visualização em semana"
                aria-pressed={view === "week"}
                onClick={() => setView("week")}
              >
                <CalendarRange size={16} />
                <span>Semana</span>
              </button>
              <button
                className={view === "day" ? "selected" : ""}
                aria-label="Visualização em dia"
                aria-pressed={view === "day"}
                onClick={() => setView("day")}
              >
                <CalendarDays size={16} />
                <span>Dia</span>
              </button>
              <button
                className={view === "list" ? "selected" : ""}
                aria-label="Visualização em lista"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <List size={16} />
                <span>Lista</span>
              </button>
            </div>
          </div>
        </div>
        <div className="filter-bar">
          <div className="filter-select">
            <Users size={15} />
            <select
              aria-label="Filtrar por médico"
              value={doctor}
              onChange={(e) => setDoctor(e.target.value)}
            >
              <option value="">Toda a equipe</option>
              {user.doctor_id && (
                <option value={user.doctor_id}>Meus plantões</option>
              )}
              {data.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {!d.active ? " (inativo)" : ""}
                </option>
              ))}
            </select>
          </div>
          {!admin && user.doctor_id && (
            <button
              className={`agenda-own-filter ${doctor === user.doctor_id ? "active" : ""}`}
              aria-pressed={doctor === user.doctor_id}
              onClick={() =>
                setDoctor(doctor === user.doctor_id ? "" : user.doctor_id!)
              }
            >
              Meus plantões
            </button>
          )}
          <span className="filter-divider" />
          <div className="period-filters">
            <button
              className={!period ? "active" : ""}
              onClick={() => setPeriod("")}
            >
              Todos os turnos
            </button>
            {(Object.keys(periods) as Period[]).map((p) => (
              <button
                key={p}
                className={period === p ? `active ${p}` : ""}
                onClick={() => setPeriod(period === p ? "" : p)}
              >
                <PeriodIcon period={p} />
                {periods[p].label}
              </button>
            ))}
          </div>
          {(doctor || period || reviewOnly) && (
            <button
              className="clear-filter"
              onClick={() => {
                setDoctor("");
                setPeriod("");
                setReviewOnly(false);
              }}
              title="Limpar filtros"
            >
              <X size={14} />
              <span>Limpar</span>
            </button>
          )}
          <label className="filter-select order-select">
            <ArrowDownUp size={15} />
            <select
              aria-label="Ordem de visualização"
              value={order}
              onChange={(e) => setOrder(e.target.value as ShiftOrder)}
            >
              {shiftOrders.map((o) => (
                <option key={o.id} value={o.id}>
                  Ordem: {o.label}
                </option>
              ))}
            </select>
          </label>
          <span className="filter-count">{shifts.length} plantões</span>
        </div>
        {agenda && calendar.loading && (
          <div className="agenda-fetch-status" role="status">
            <Loader2 size={16} className="spin" />
            Carregando plantões do período…
          </div>
        )}
        {agenda && calendar.error && (
          <div className="agenda-fetch-error">
            <ErrorBox retry={calendar.reload}>{calendar.error}</ErrorBox>
          </div>
        )}
        {view === "week" ? (
          <WeekView
            dates={dates}
            shifts={shifts}
            onShift={onShift}
            onNew={onNew}
            canCreate={canCreateDate}
            isReady={(date) => calendar.ready.has(date.slice(0, 7))}
            loading={calendar.loading}
            filtered={filtered}
          />
        ) : view === "day" ? (
          <DayView
            date={focusDate}
            shifts={shifts}
            onShift={onShift}
            onNew={onNew}
            canCreate={canCreateDate}
            isReady={(date) => calendar.ready.has(date.slice(0, 7))}
            loading={calendar.loading}
            filtered={filtered}
          />
        ) : !shifts.length ? (
          <Empty
            title={
              doctor || period || reviewOnly
                ? "Nenhum plantão com esses filtros"
                : "Um mês cheio de possibilidades"
            }
            description={
              doctor || period || reviewOnly
                ? "Experimente outro médico ou turno para encontrar os plantões."
                : canCreate
                  ? "Comece a organizar a escala adicionando o primeiro plantão."
                  : "Ainda não há plantões cadastrados para este mês."
            }
            action={
              canCreate && !data.locked && !doctor && !period && !reviewOnly ? (
                <button
                  className="button button-primary"
                  onClick={() => onNew()}
                >
                  <Plus size={16} />
                  Criar primeiro plantão
                </button>
              ) : undefined
            }
          />
        ) : view === "calendar" ? (
          <CalendarGrid
            month={month}
            shifts={shifts}
            onShift={onShift}
            onNew={canCreate && !data.locked ? onNew : undefined}
            onDay={onDay}
          />
        ) : (
          <ShiftList shifts={shifts} onShift={onShift} order={order} />
        )}
        <div className="calendar-footer">
          <div className="calendar-legend">
            {(Object.keys(periods) as Period[]).map((p) => (
              <span key={p}>
                <i className={`legend-dot ${p}`} />
                {periods[p].label}
              </span>
            ))}
          </div>
          <span>
            <SlidersHorizontal size={13} />
            America/Fortaleza (UTC−3)
          </span>
        </div>
      </section>
      <ShiftPreviewHost ownDoctorId={user.doctor_id} />
      {generating && (
        <GenerateSchedule
          month={month}
          user={user}
          onClose={() => setGenerating(false)}
          onDone={(target, r) =>
            onGenerated(
              target,
              `Escala gerada: ${r.shifts} plantões e ${r.assignments} alocações${r.skipped ? `; ${r.skipped} ficaram de fora (veja o histórico)` : ""}.`,
            )
          }
        />
      )}
      <div className="page-footnote">
        <span>Escalas bem organizadas. Pessoas bem cuidadas.</span>
        <span>
          Amil Telemedicina <span className="tiny-cross">+</span>
        </span>
      </div>
    </>
  );
}
function Stat({
  icon,
  value,
  label,
  note,
  action,
  warm = false,
}: {
  icon: React.ReactNode;
  value: string | number;
  label: string;
  note: string;
  action?: () => void;
  warm?: boolean;
}) {
  const content = (
    <>
      <div className="stat-top">
        <span className={`stat-icon ${warm ? "warm" : ""}`}>{icon}</span>
        {action && <ArrowUpRight size={17} className="stat-arrow" />}
      </div>
      <div className="stat-value">{value}</div>
      <h3>{label}</h3>
      <p>{note}</p>
    </>
  );
  return action ? (
    <button className="stat-card stat-clickable" onClick={action}>
      {content}
    </button>
  ) : (
    <div className="stat-card">{content}</div>
  );
}
function CalendarGrid({
  month,
  shifts,
  onShift,
  onNew,
  onDay,
}: {
  month: string;
  shifts: Shift[];
  onShift: (s: Shift) => void;
  onNew?: (date: string) => void;
  onDay: (date: string) => void;
}) {
  const cells = useMemo(() => {
    const first = dateLocal(`${month}-01`);
    const offset = first.getDay();
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const count = Math.ceil((offset + last.getDate()) / 7) * 7;
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(first);
      d.setDate(i - offset + 1);
      return {
        date: toISO(d),
        day: d.getDate(),
        outside: toISO(d).slice(0, 7) !== month,
      };
    });
  }, [month]);
  const grouped = new Map<string, Shift[]>();
  for (const s of shifts) {
    grouped.set(s.date, [...(grouped.get(s.date) || []), s]);
  }
  return (
    <div className="calendar-scroll">
      <div
        className="calendar-grid"
        role="grid"
        aria-label={`Escala de ${monthLabel(month)}`}
      >
        <div className="calendar-weekdays" role="row">
          {[
            "Domingo",
            "Segunda",
            "Terça",
            "Quarta",
            "Quinta",
            "Sexta",
            "Sábado",
          ].map((day, i) => (
            <div
              key={day}
              role="columnheader"
              className={i === 0 || i === 6 ? "weekend" : ""}
            >
              <span>{day}</span>
              <abbr>{day.slice(0, 3)}</abbr>
            </div>
          ))}
        </div>
        <div className="calendar-days">
          {cells.map((c) => {
            const ds = grouped.get(c.date) || [];
            return (
              <div
                className={`calendar-day ${c.outside ? "outside" : ""} ${c.date === todayISO() ? "is-today" : ""}`}
                role="gridcell"
                key={c.date}
                aria-label={dayLabel(c.date, { day: "numeric", month: "long" })}
              >
                <div className="day-header">
                  <span className="day-number">
                    {String(c.day).padStart(2, "0")}
                  </span>
                  {!c.outside && !!ds.length && (
                    <span className="day-shift-count">{ds.length}</span>
                  )}
                  {!c.outside && onNew && (
                    <button
                      onClick={() => onNew(c.date)}
                      aria-label={`Adicionar plantão em ${dayLabel(c.date)}`}
                      className="day-add"
                    >
                      <Plus size={13} />
                    </button>
                  )}
                </div>
                {!c.outside && (
                  <div className="day-shifts">
                    {ds.slice(0, 3).map((s) => (
                      <button
                        className={`calendar-shift ${s.period} ${s.needs_review ? "needs-review" : ""}`}
                        onClick={() => onShift(s)}
                        key={s.id}
                        {...previewProps(s)}
                      >
                        <span className="calendar-shift-time">
                          {s.needs_review && (
                            <i
                              className="review-dot"
                              aria-label="Revisão pendente"
                            />
                          )}
                          <PeriodIcon period={s.period} size={11} />
                          {s.start_time}
                          <span>–{s.end_time}</span>
                          <StaffingBadge shift={s}/>
                {s.assignments.some((a) => a.offer_id) && (
                            <ArrowUpRight size={10} />
                          )}
                        </span>
                        <StaffingBadge shift={s}/>
                        <span className="calendar-shift-doctors">
                          {s.assignments[0]
                            ? shortName(s.assignments[0].doctor_name)
                            : "Equipe a definir"}
                          {s.assignments.length > 1 && (
                            <b>+{s.assignments.length - 1}</b>
                          )}
                        </span>
                      </button>
                    ))}
                    {ds.length > 3 && (
                      <button
                        className="more-shifts"
                        onClick={() => onDay(c.date)}
                      >
                        + {ds.length - 3} plantões <ArrowRight size={11} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
export function ShiftList({
  shifts,
  onShift,
  order = "time",
}: {
  shifts: Shift[];
  onShift: (s: Shift) => void;
  order?: ShiftOrder;
}) {
  const grouped = new Map<string, Shift[]>();
  for (const s of [...shifts].sort(compareShifts(order))) {
    grouped.set(s.date, [...(grouped.get(s.date) || []), s]);
  }
  return (
    <div className="shift-list">
      {Array.from(grouped.entries()).map(([date, items]) => (
        <section
          className={`shift-day-group ${date === todayISO() ? "today-group" : ""}`}
          key={date}
        >
          <div className="shift-day-label">
            <strong>{date.slice(8)}</strong>
            <div>
              <span>{dayLabel(date, { weekday: "long" })}</span>
              <small>
                {dayLabel(date, { month: "long" })}
                {date === todayISO() ? " · Hoje" : ""}
              </small>
            </div>
            <span className="day-item-count">{items.length} plantões</span>
          </div>
          <div className="shift-day-items">
            {items.map((s) => (
              <button
                className="shift-list-row"
                key={s.id}
                onClick={() => onShift(s)}
              >
                <div className="shift-row-period">
                  <PeriodBadge period={s.period} />
                  <strong>
                    {s.start_time} <span>—</span> {s.end_time}
                  </strong>
                </div>
                <div className="shift-row-unit">
                  <span>{s.unit}</span>
                  <small>
                    {formatNumber(hours(s.start_time, s.end_time))} horas de
                    cobertura
                  </small>
                </div>
                <div className="shift-row-doctors">
                  <div className="avatar-stack">
                    {s.assignments.slice(0, 3).map((a) => (
                      <Avatar
                        key={a.id}
                        name={a.doctor_name}
                        color={a.doctor_color}
                        small
                      />
                    ))}
                  </div>
                  <span>
                    {s.assignments.length === 1
                      ? shortName(s.assignments[0].doctor_name)
                      : `${s.assignments.length} médicos`}
                  </span>
                </div>
                <StaffingBadge shift={s}/>
                {s.assignments.some((a) => a.offer_id) && (
                  <span className="repasse-tag">
                    <ArrowUpRight size={13} />
                    Repasse
                  </span>
                )}
                <ChevronRight size={17} className="row-chevron" />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
