import { useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  ArrowRightLeft,
  CalendarDays,
  Clock3,
  Users,
  Download,
  LockKeyhole,
  UnlockKeyhole,
  ChevronDown,
  ChevronRight,
  Search,
  Activity,
  ShieldCheck,
  Check,
  ArrowRight,
  LogOut,
  KeyRound,
  FileCheck2,
  Info,
} from "lucide-react";
import {
  Avatar,
  Empty,
  PeriodBadge,
  Modal,
  Field,
  ErrorBox,
  Submit,
  Spinner,
} from "./ui";
import { post, message, exportReport } from "./api";
import { useResource } from "./hooks";
import { MonthControl } from "./Schedule";
import {
  dayLabel,
  formatNumber,
  hours,
  monthLabel,
  roleLabels,
  isUpcoming,
  crmLabel,
} from "./utils";
import type { Offer, Doctor, User, Report, Audit, ReportRow } from "./types";
export function OffersView({
  offers,
  user,
  doctors,
  locked,
  month,
  onMonth,
  onAccept,
  onCancel,
  onApprove,
  onReject,
  onSchedule,
}: {
  offers: Offer[];
  user: User;
  doctors: Doctor[];
  locked: boolean;
  month: string;
  onMonth: (m: string) => void;
  onAccept: (o: Offer) => void;
  onCancel: (o: Offer) => void;
  onApprove: (o: Offer) => void;
  onReject: (o: Offer) => void;
  onSchedule: () => void;
}) {
  const [tab, setTab] = useState<
    "open" | "pending" | "mine" | "accepted" | "cancelled"
  >("open");
  const canApprove = user.role !== "doctor";
  const filtered = offers
    .filter((o) =>
      tab === "mine" ? o.from_doctor_id === user.doctor_id : tab === o.status,
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const open = offers.filter((o) => o.status === "open");
  const pendingCount = offers.filter((o) => o.status === "pending").length;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">FLEXIBILIDADE PARA A EQUIPE</span>
          <h1>
            Novas oportunidades de cuidar<span>.</span>
          </h1>
          <p>Encontre plantões disponíveis e acompanhe seus repasses.</p>
        </div>
        <MonthControl month={month} onMonth={onMonth} />
      </div>
      <div className="offers-intro">
        <div className="offers-intro-art">
          <ArrowRightLeft size={30} />
          <span />
        </div>
        <div>
          <span className="eyebrow">CONECTANDO DISPONIBILIDADES</span>
          <h2>Um plantão. Uma nova possibilidade.</h2>
          <p>
            Ao assumir uma oferta, o plantão passa a fazer parte da sua escala.
            Tudo registrado, com clareza para toda a equipe.
          </p>
        </div>
        <div className="offers-intro-count">
          <strong>{open.length.toString().padStart(2, "0")}</strong>
          <span>
            repasses disponíveis
            <br />
            em {monthLabel(month).split(" de ")[0]}
          </span>
        </div>
      </div>
      {locked && (
        <div className="notice">
          <LockKeyhole size={17} />
          Este mês está fechado. Novos repasses só podem ser assumidos após a
          reabertura.
        </div>
      )}
      <div className="section-tabs offers-tabs">
        <button
          className={tab === "open" ? "active" : ""}
          onClick={() => setTab("open")}
        >
          Disponíveis <span>{open.length}</span>
        </button>
        <button
          className={tab === "pending" ? "active" : ""}
          onClick={() => setTab("pending")}
        >
          Em aprovação <span>{pendingCount}</span>
        </button>
        {user.doctor_id && (
          <button
            className={tab === "mine" ? "active" : ""}
            onClick={() => setTab("mine")}
          >
            Meus repasses
          </button>
        )}
        <button
          className={tab === "accepted" ? "active" : ""}
          onClick={() => setTab("accepted")}
        >
          Assumidos
        </button>
        <button
          className={tab === "cancelled" ? "active" : ""}
          onClick={() => setTab("cancelled")}
        >
          Cancelados
        </button>
      </div>
      {!filtered.length ? (
        <div className="content-card">
          <Empty
            icon={<ArrowRightLeft size={28} />}
            title={
              tab === "open"
                ? "A equipe está em sintonia"
                : tab === "pending"
                  ? "Nenhum repasse aguardando aprovação"
                  : tab === "mine"
                  ? "Você ainda não fez um repasse"
                  : "Nenhum repasse por aqui"
            }
            description={
              tab === "open"
                ? "Não há repasses disponíveis neste mês. Novas oportunidades aparecerão aqui."
                : tab === "mine"
                  ? "Na escala, abra um dos seus plantões e selecione “Ofertar”."
                  : "Os repasses deste período aparecerão aqui assim que houver uma atualização."
            }
            action={
              <button className="button button-secondary" onClick={onSchedule}>
                Ver minha escala <ArrowRight size={16} />
              </button>
            }
          />
        </div>
      ) : (
        <div className="offer-cards">
          {filtered.map((o) => {
            const own = o.from_doctor_id === user.doctor_id;
            const canCancel =
              (o.status === "open" || o.status === "pending") &&
              !locked &&
              (own || canApprove);
            return (
              <article
                className={`offer-card ${o.status !== "open" && o.status !== "pending" ? "offer-finished" : ""}`}
                key={o.id}
              >
                <div className="offer-top">
                  <PeriodBadge period={o.period} />
                  <span
                    className={`status-pill ${o.status === "open" || o.status === "pending" ? "status-warm" : o.status === "accepted" ? "status-success" : "status-muted"}`}
                  >
                    <span />
                    {o.status === "open"
                      ? "Disponível"
                      : o.status === "pending"
                        ? "Em aprovação"
                        : o.status === "accepted"
                        ? "Assumido"
                        : "Cancelado"}
                  </span>
                </div>
                <div className="offer-date">
                  <span>{o.date.slice(8)}</span>
                  <div>
                    <strong>{dayLabel(o.date, { month: "long" })}</strong>
                    <small>{dayLabel(o.date, { weekday: "long" })}</small>
                  </div>
                </div>
                <div className="offer-time">
                  <Clock3 size={16} />
                  <strong>
                    {o.start_time} <span>às</span> {o.end_time}
                  </strong>
                  <span>{formatNumber(hours(o.start_time, o.end_time))}h</span>
                </div>
                <p className="offer-unit">{o.unit}</p>
                {o.note && <p className="offer-note">“{o.note}”</p>}
                <div className="offer-origin">
                  <Avatar
                    name={o.from_name}
                    color={
                      doctors.find((d) => d.id === o.from_doctor_id)?.color
                    }
                    small
                  />
                  <span>
                    <small>Disponibilizado por{own ? " você" : ""}</small>
                    <strong>{o.from_name}</strong>
                  </span>
                </div>
                {o.status === "accepted" && o.to_name && (
                  <div className="offer-accepted">
                    <Check size={15} />
                    <span>
                      Assumido por <strong>{o.to_name}</strong>
                      {o.approved_by_name && (
                        <>
                          {" "}
                          · autorizado por <strong>{o.approved_by_name}</strong>
                        </>
                      )}
                    </span>
                  </div>
                )}
                {o.status === "pending" && (
                  <>
                    <div className="offer-accepted">
                      <Clock3 size={15} />
                      <span>
                        <strong>{o.requested_name}</strong> pediu para assumir.
                        Aguardando autorização da administração.
                      </span>
                    </div>
                    <div className="offer-actions">
                      {canApprove && (
                        <>
                          <button
                            className="button button-primary"
                            disabled={locked}
                            onClick={() => onApprove(o)}
                          >
                            Autorizar repasse <Check size={16} />
                          </button>
                          <button
                            className="button button-secondary button-sm"
                            disabled={locked}
                            onClick={() => onReject(o)}
                          >
                            Recusar
                          </button>
                        </>
                      )}
                      {canCancel && (
                        <button
                          className="button button-ghost button-sm"
                          onClick={() => onCancel(o)}
                        >
                          Cancelar repasse
                        </button>
                      )}
                    </div>
                  </>
                )}
                {o.status === "open" && (
                  <div className="offer-actions">
                    {!!user.doctor_id && !own && (
                      <button
                        className="button button-primary"
                        disabled={locked || !isUpcoming(o.date, o.start_time)}
                        onClick={() => onAccept(o)}
                      >
                        {locked
                          ? "Mês fechado"
                          : !isUpcoming(o.date, o.start_time)
                            ? "Plantão encerrado"
                            : "Assumir plantão"}
                        <ArrowUpRight size={16} />
                      </button>
                    )}
                    {own && (
                      <span className="own-offer-label">
                        <Info size={15} />
                        Você está oferecendo este plantão
                      </span>
                    )}
                    {canCancel && (
                      <button
                        className="button button-ghost button-sm"
                        onClick={() => onCancel(o)}
                      >
                        Cancelar repasse
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <p className="privacy-note">
        <ShieldCheck size={14} />O plantão permanece com o médico de origem até
        a autorização da administração.
      </p>
    </>
  );
}
export function ReportsView({
  month,
  onMonth,
  version,
  user,
  onLock,
  notify,
}: {
  month: string;
  onMonth: (m: string) => void;
  version: number;
  user: User;
  onLock: (locked: boolean) => void;
  notify: (s: string) => void;
}) {
  const { data, loading, error, reload } = useResource<Report>(
    `/reports?month=${month}`,
    version,
  );
  const [search, setSearch] = useState(""),
    [expanded, setExpanded] = useState<string | null>(null),
    [exporting, setExporting] = useState(false),
    [sort, setSort] = useState<"name" | "hours" | "turns" | "days">("name");
  async function download() {
    setExporting(true);
    try {
      await exportReport(month);
      notify("Escala exportada em PDF.");
    } catch (e) {
      notify(message(e));
    } finally {
      setExporting(false);
    }
  }
  const filtered =
    data?.rows.filter((r) =>
      `${r.name} ${r.crm}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    ).sort((a, b) =>
      sort === "hours"
        ? b.hours - a.hours || a.name.localeCompare(b.name, "pt-BR")
        : sort === "turns"
          ? b.turns - a.turns || a.name.localeCompare(b.name, "pt-BR")
          : sort === "days"
            ? b.days.length - a.days.length ||
              a.name.localeCompare(b.name, "pt-BR")
            : a.name.localeCompare(b.name, "pt-BR"),
    ) || [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CLAREZA PARA CADA DECISÃO</span>
          <h1>
            O mês, em perspectiva<span>.</span>
          </h1>
          <p>
            {user.role === "doctor"
              ? "Confira seus plantões e a distribuição das suas horas."
              : "Acompanhe a cobertura da equipe e prepare o fechamento do mês."}
          </p>
        </div>
        <button
          className="button button-secondary"
          onClick={download}
          disabled={exporting || !data}
        >
          <Download size={17} />
          {exporting ? "Gerando PDF…" : "Exportar PDF"}
        </button>
      </div>
      <div className="report-topbar">
        <MonthControl month={month} onMonth={onMonth} />
        {data && (
          <div className="button-row">
            <span
              className={`status-pill ${data.locked ? "status-muted" : "status-success"}`}
            >
              <span />
              {data.locked ? "Mês fechado" : "Escala aberta"}
            </span>
            {user.role !== "doctor" &&
              (!data.locked || user.role === "owner") && (
                <button
                  className={`button ${data.locked ? "button-secondary" : "button-primary"} button-sm`}
                  onClick={() => onLock(!data.locked)}
                >
                  {data.locked ? (
                    <UnlockKeyhole size={15} />
                  ) : (
                    <LockKeyhole size={15} />
                  )}{" "}
                  {data.locked ? "Reabrir mês" : "Fechar mês"}
                </button>
              )}
          </div>
        )}
      </div>
      {loading && !data ? (
        <Spinner label="Consolidando os dados do mês…" />
      ) : error ? (
        <ErrorBox retry={reload}>{error}</ErrorBox>
      ) : data ? (
        <>
          <div className="stats-grid reports-stats">
            <ReportStat
              value={formatNumber(data.totals.hours) + "h"}
              label="Horas de plantão"
              icon={<Clock3 size={20} />}
            />
            <ReportStat
              value={data.totals.shifts}
              label="Plantões no período"
              icon={<CalendarDays size={20} />}
            />
            <ReportStat
              value={data.totals.assignments}
              label="Alocações médicas"
              icon={<FileCheck2 size={20} />}
            />
            <ReportStat
              value={data.totals.doctors}
              label="Médicos na escala"
              icon={<Users size={20} />}
            />
          </div>
          <section className="content-card">
            <div className="section-heading card-heading">
              <div>
                <h2>
                  {user.role === "doctor"
                    ? "Meu resumo mensal"
                    : "Distribuição por médico"}
                </h2>
                <p>
                  Dias trabalhados, turnos e horas, em uma visão consolidada.
                </p>
              </div>
              <select
                className="report-sort"
                aria-label="Ordem do relatório"
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
              >
                <option value="name">Ordem: nome A–Z</option>
                <option value="hours">Ordem: mais horas</option>
                <option value="turns">Ordem: mais plantões</option>
                <option value="days">Ordem: mais dias</option>
              </select>
              <div className="input-icon compact-search">
                <Search size={16} />
                <input
                  placeholder="Buscar médico"
                  aria-label="Buscar médico no relatório"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            {!filtered.length ? (
              <Empty
                icon={<FileCheck2 size={27} />}
                title="Nenhum registro neste período"
                description="As horas e os plantões aparecerão aqui quando a escala estiver preenchida."
              />
            ) : (
              <div className="table-scroll">
                <table className="data-table report-table">
                  <thead>
                    <tr>
                      <th>Médico</th>
                      <th>Dias</th>
                      <th>Manhã</th>
                      <th>Tarde</th>
                      <th>Noite</th>
                      <th>Madrugada</th>
                      <th>Plantões</th>
                      <th>Horas totais</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <ReportRows
                        key={r.doctor_id}
                        row={r}
                        expanded={expanded === r.doctor_id}
                        onToggle={() =>
                          setExpanded(
                            expanded === r.doctor_id ? null : r.doctor_id,
                          )
                        }
                      />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total no período</td>
                      <td />
                      <td>{filtered.reduce((n, r) => n + r.morning, 0)}</td>
                      <td>{filtered.reduce((n, r) => n + r.afternoon, 0)}</td>
                      <td>{filtered.reduce((n, r) => n + r.night, 0)}</td>
                      <td>{filtered.reduce((n, r) => n + r.dawn, 0)}</td>
                      <td>{filtered.reduce((n, r) => n + r.turns, 0)}</td>
                      <td>
                        {formatNumber(
                          filtered.reduce((n, r) => n + r.hours, 0),
                        )}
                        h
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
          <div className="report-disclaimer">
            <Info size={18} />
            <p>
              As horas consideram a duração de cada plantão por médico alocado,
              incluindo turnos que terminam no dia seguinte.{" "}
              {data.locked
                ? "Este mês foi fechado e está disponível para conferência."
                : "Os dados acompanham as alterações da escala até o fechamento do mês."}
            </p>
          </div>
        </>
      ) : null}
    </>
  );
}
function ReportStat({
  value,
  label,
  icon,
}: {
  value: string | number;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat-card">
      <span className="stat-icon">{icon}</span>
      <div className="stat-value">{value}</div>
      <h3>{label}</h3>
    </div>
  );
}
function ReportRows({
  row: r,
  expanded,
  onToggle,
}: {
  row: ReportRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={expanded ? "expanded-row" : ""}>
        <td>
          <button
            className="table-person report-person"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            <Avatar name={r.name} small />
            <span>
              <strong>{r.name}</strong>
              <small>{r.crm ? `CRM ${r.crm}` : "Equipe médica"}</small>
            </span>
          </button>
        </td>
        <td>{r.days.length}</td>
        <td>
          <span className="turn-count morning">{r.morning || "—"}</span>
        </td>
        <td>
          <span className="turn-count afternoon">{r.afternoon || "—"}</span>
        </td>
        <td>
          <span className="turn-count night">{r.night || "—"}</span>
        </td>
        <td>
          <span className="turn-count dawn">{r.dawn || "—"}</span>
        </td>
        <td>
          <strong>{r.turns}</strong>
        </td>
        <td>
          <span className="hours-pill">{formatNumber(r.hours)}h</span>
        </td>
        <td>
          <button
            className="icon-button"
            aria-label={`Ver plantões de ${r.name}`}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="report-expanded">
          <td colSpan={9}>
            <div className="expanded-title">
              Plantões de {r.name}
              <span>{r.days.length} dias de cuidado</span>
            </div>
            <div className="report-shift-grid">
              {r.shifts.map((s, i) => (
                <div
                  className="report-shift-item"
                  key={`${s.date}-${s.start_time}-${i}`}
                >
                  <span>{dayLabel(s.date)}</span>
                  <PeriodBadge period={s.period} />
                  <strong>
                    {s.start_time}–{s.end_time}
                  </strong>
                  <small>{s.unit}</small>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
const auditLabels: Record<string, string> = {
  shift_created: "Plantão criado",
  shift_updated: "Plantão atualizado",
  shift_deleted: "Plantão excluído",
  shift_cancelled: "Plantão cancelado",
  doctor_assigned: "Médico adicionado ao plantão",
  doctor_removed: "Médico removido do plantão",
  month_closed: "Mês fechado",
  month_reopened: "Mês reaberto",
  account_activated: "Acesso ativado",
  password_changed: "Senha alterada",
  import_created: "Escala importada",
  doctors_merged: "Cadastros consolidados",
  import_issue_resolved: "Conferência registrada",
  assignment_added: "Médico adicionado",
  assignment_removed: "Médico removido",
  offer_created: "Repasse disponibilizado",
  offer_accepted: "Repasse assumido",
  offer_cancelled: "Repasse cancelado",
  doctor_created: "Médico cadastrado",
  doctor_updated: "Cadastro atualizado",
  month_locked: "Mês fechado",
  month_unlocked: "Mês reaberto",
  invite_created: "Convite criado",
  invite_revoked: "Convite revogado",
  user_updated: "Acesso atualizado",
  password_reset: "Acesso redefinido",
  login: "Acesso ao portal",
};
export function AuditView({
  month,
  onMonth,
  version,
  user,
}: {
  month: string;
  onMonth: (m: string) => void;
  version: number;
  user: User;
}) {
  const { data, loading, error, reload } = useResource<{ audit: Audit[] }>(
    `/audit?month=${month}`,
    version,
  );
  const [search, setSearch] = useState("");
  const filtered =
    data?.audit.filter((a) =>
      `${a.description} ${a.actor_name} ${auditLabels[a.action] || a.action}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    ) || [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CADA MUDANÇA, COM TRANSPARÊNCIA</span>
          <h1>
            O cuidado tem história<span>.</span>
          </h1>
          <p>
            {user.role === "doctor"
              ? "Acompanhe os repasses e alterações relacionados a você."
              : "Uma trilha completa das alterações na escala e na equipe."}
          </p>
        </div>
        <MonthControl month={month} onMonth={onMonth} />
      </div>
      <section className="content-card">
        <div className="section-heading card-heading">
          <div>
            <h2>Histórico de atividades</h2>
            <p>Registros preservados para acompanhar cada decisão.</p>
          </div>
          <div className="input-icon compact-search">
            <Search size={16} />
            <input
              aria-label="Buscar no histórico"
              placeholder="Buscar atividade ou pessoa"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {loading && !data ? (
          <Spinner label="Carregando o histórico…" />
        ) : error ? (
          <div className="card-error">
            <ErrorBox retry={reload}>{error}</ErrorBox>
          </div>
        ) : !filtered.length ? (
          <Empty
            icon={<Activity size={27} />}
            title="Nenhuma atividade por aqui"
            description={
              search
                ? "Experimente buscar por outro termo."
                : "As alterações deste período aparecerão aqui, com a pessoa responsável e o horário."
            }
          />
        ) : (
          <div className="audit-list">
            {filtered.map((a, i) => {
              const date = new Date(a.created_at);
              const previous =
                i > 0
                  ? new Date(filtered[i - 1].created_at).toLocaleDateString(
                      "pt-BR",
                    )
                  : "";
              const current = date.toLocaleDateString("pt-BR");
              const isOffer = a.action.includes("offer");
              return (
                <div key={a.id}>
                  {current !== previous && (
                    <div className="audit-date">
                      {date.toLocaleDateString("pt-BR", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
                    </div>
                  )}
                  <article className="audit-item">
                    <div className={`audit-icon ${isOffer ? "warm" : ""}`}>
                      {isOffer ? (
                        <ArrowRightLeft size={16} />
                      ) : a.action.includes("month") ? (
                        <LockKeyhole size={16} />
                      ) : a.action.includes("doctor") ||
                        a.action.includes("user") ? (
                        <Users size={16} />
                      ) : (
                        <CalendarDays size={16} />
                      )}
                    </div>
                    <div className="audit-content">
                      <h3>
                        {auditLabels[a.action] ||
                          a.action.replace(/[._]/g, " ")}
                      </h3>
                      <p>{a.description}</p>
                      <span>
                        <strong>{a.actor_name || "Sistema"}</strong> <i>·</i>{" "}
                        {date.toLocaleTimeString("pt-BR", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <span className="audit-record">
                      <ShieldCheck size={13} />
                      Registrado
                    </span>
                  </article>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
export function ProfileModal({
  user,
  doctor,
  onCorrections,
  onClose,
  onLogout,
  notify,
}: {
  user: User;
  doctor:Doctor|null;
  onCorrections:()=>void;
  onClose: () => void;
  onLogout: () => void;
  notify: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [showPassword, setShowPassword] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    if (f.get("newPassword") !== f.get("confirmPassword")) {
      setError("As senhas não coincidem. Confira e tente novamente.");
      return;
    }
    setBusy(true);
    try {
      await post("/auth/password", {
        currentPassword: f.get("currentPassword"),
        newPassword: f.get("newPassword"),
      });
      notify("Senha atualizada com segurança.");
      setShowPassword(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Seu perfil"
      subtitle="Seu acesso, do seu jeito."
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="profile-card">
          <Avatar name={user.name} />
          <div>
            <h3>{doctor?.name||user.name}</h3>
            <p>{user.email}</p>
            {doctor&&<p className="workflow-profile-crm">{crmLabel(doctor)}</p>}
            <span className="role-badge">{roleLabels[user.role]}</span>{doctor&&user.role!=="doctor"&&<span className="role-badge workflow-doctor-role">Médico</span>}
          </div>
        </div>
        {doctor&&<button className="profile-option" onClick={onCorrections}><FileCheck2 size={19}/><span>Conferir meus dados e plantões<small>Solicitar ajustes para a coordenação</small></span><ChevronRight size={17}/></button>}
        <button
          className="profile-option"
          onClick={() => setShowPassword(!showPassword)}
          aria-expanded={showPassword}
        >
          <KeyRound size={19} />
          <span>
            Alterar minha senha<small>Mantenha seu acesso protegido</small>
          </span>
          {showPassword ? (
            <ChevronDown size={17} />
          ) : (
            <ChevronRight size={17} />
          )}
        </button>
        {showPassword && (
          <form onSubmit={submit} className="password-form">
            <Field label="Senha atual">
              <input
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
              />
            </Field>
            <Field label="Nova senha" hint="Use pelo menos 10 caracteres.">
              <input
                name="newPassword"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirme a nova senha">
              <input
                name="confirmPassword"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
              />
            </Field>
            {error && <ErrorBox>{error}</ErrorBox>}
            <Submit busy={busy}>Atualizar senha</Submit>
          </form>
        )}
        <button className="profile-option logout-option" onClick={onLogout}>
          <LogOut size={19} />
          <span>
            Sair do portal<small>Encerrar sua sessão neste dispositivo</small>
          </span>
          <ArrowUpRight size={17} />
        </button>
      </div>
      <div className="modal-footer">
        <button className="button button-secondary" onClick={onClose}>
          Concluir
        </button>
      </div>
    </Modal>
  );
}
