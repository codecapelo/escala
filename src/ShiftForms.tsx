import { useState, useMemo, type FormEvent } from "react";
import {
  CalendarDays,
  Clock3,
  Users,
  Plus,
  Check,
  Trash2,
  ArrowUpRight,
  LockKeyhole,
  Info,
  Pencil,
  X,
  Repeat2,
  Search,
} from "lucide-react";
import { post, patch, remove, message } from "./api";
import {
  Modal,
  Field,
  ErrorBox,
  Submit,
  Avatar,
  PeriodBadge,
  Confirm,
  Empty,
} from "./ui";
import {
  periods,
  dayLabel,
  dateLocal,
  toISO,
  hours,
  formatNumber,
  isUpcoming,
} from "./utils";
import type { Doctor, Shift, User, Period, Offer } from "./types";
export function ShiftForm({
  shift,
  defaultDate,
  doctors,
  onClose,
  onSaved,
}: {
  shift?: Shift;
  defaultDate: string;
  doctors: Doctor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [period, setPeriod] = useState<Period>(shift?.period || "morning"),
    [date, setDate] = useState(shift?.date || defaultDate),
    [start, setStart] = useState(shift?.start_time || "07:00"),
    [end, setEnd] = useState(shift?.end_time || "13:00");
  const [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [repeat, setRepeat] = useState(false),
    [until, setUntil] = useState(""),
    [weekdays, setWeekdays] = useState<number[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dates = useMemo(() => {
    if (!repeat || !until || until < date) return [date];
    const result: string[] = [];
    const d = dateLocal(date),
      last = dateLocal(until);
    for (
      let count = 0;
      d <= last && count < 367;
      count++, d.setDate(d.getDate() + 1)
    ) {
      if (toISO(d) === date || weekdays.includes(d.getDay()))
        result.push(toISO(d));
    }
    return result;
  }, [date, until, repeat, weekdays]);
  function choosePeriod(p: Period) {
    setPeriod(p);
    const times = {
      morning: ["07:00", "13:00"],
      afternoon: ["13:00", "19:00"],
      night: ["19:00", "00:00"],
      dawn: ["00:00", "07:00"],
    }[p];
    setStart(times[0]);
    setEnd(times[1]);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (!shift && !selected.length) {
      setError("Selecione ao menos um médico para o plantão.");
      return;
    }
    if (repeat && (!until || until < date)) {
      setError(
        "Escolha uma data final igual ou posterior ao primeiro plantão.",
      );
      return;
    }
    if (dates.length > 62) {
      setError("Crie até 62 datas por vez. Reduza o período de repetição.");
      return;
    }
    if (start === end) {
      setError("O início e o término precisam ter horários diferentes.");
      return;
    }
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const body = {
      date,
      start_time: start,
      end_time: end,
      period,
      unit: String(f.get("unit")),
      notes: String(f.get("notes")),
    };
    try {
      if (shift) await patch(`/shifts/${shift.id}`, body);
      else
        await post("/shifts", {
          ...body,
          doctor_ids: selected,
          ...(repeat ? { dates } : {}),
        });
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  const filtered = doctors.filter(
    (d) =>
      d.active &&
      d.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <Modal
      title={shift ? "Editar plantão" : "Um novo plantão"}
      subtitle={
        shift
          ? "Atualize os detalhes da escala."
          : "Organize o cuidado, um plantão de cada vez."
      }
      onClose={onClose}
      wide
    >
      <form onSubmit={submit}>
        <div className="modal-body form-sections">
          <div className="form-section-title">
            <CalendarDays size={17} />
            <h3>Quando acontece</h3>
          </div>
          <div className="form-grid">
            <Field label="Data do plantão">
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Unidade / atendimento">
              <input
                name="unit"
                required
                defaultValue={shift?.unit || "Telemedicina"}
                placeholder="Ex.: Telemedicina"
                maxLength={120}
              />
            </Field>
          </div>
          <div className="period-options">
            {(Object.keys(periods) as Period[]).map((p) => (
              <button
                type="button"
                key={p}
                className={period === p ? "selected" : ""}
                aria-pressed={period === p}
                onClick={() => choosePeriod(p)}
              >
                <PeriodBadge period={p} />
                {period === p && <Check size={15} />}
              </button>
            ))}
          </div>
          <div className="form-grid">
            <Field label="Início">
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              />
            </Field>
            <Field label="Término">
              <input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                required
              />
            </Field>
          </div>
          <div className="form-hint">
            <Clock3 size={14} />
            {formatNumber(hours(start, end))} horas de plantão
            {end < start ? " · Término no dia seguinte" : ""}
          </div>
          {!shift && (
            <>
              <div className="form-section-title">
                <Users size={17} />
                <h3>Quem vai cuidar</h3>
                <span>
                  {selected.length} selecionado
                  {selected.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="input-icon">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Buscar médico para plantão"
                  placeholder="Buscar médico pelo nome"
                />
              </div>
              <div className="doctor-selector">
                {filtered.map((d) => (
                  <label
                    key={d.id}
                    className={`doctor-option ${selected.includes(d.id) ? "checked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(d.id)}
                      onChange={() =>
                        setSelected((s) =>
                          s.includes(d.id)
                            ? s.filter((id) => id !== d.id)
                            : [...s, d.id],
                        )
                      }
                    />
                    <Avatar name={d.name} color={d.color} small />
                    <span>
                      {d.name}
                      <small>
                        {d.specialty || "Médico"} {d.crm && `· CRM ${d.crm}`}
                      </small>
                    </span>
                    <span className="check-square">
                      {selected.includes(d.id) && <Check size={12} />}
                    </span>
                  </label>
                ))}
                {!filtered.length && (
                  <p className="muted small">
                    Nenhum médico encontrado. Cadastre médicos na página Equipe.
                  </p>
                )}
              </div>
              <label className="repeat-toggle">
                <span>
                  <Repeat2 size={18} />
                  <span>
                    Repetir plantão
                    <small>Mesma equipe e horário em outras datas</small>
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={repeat}
                  onChange={(e) => {
                    setRepeat(e.target.checked);
                    if (!weekdays.length)
                      setWeekdays([dateLocal(date).getDay()]);
                  }}
                  role="switch"
                />
              </label>
              {repeat && (
                <div className="repeat-panel">
                  <Field label="Repetir até">
                    <input
                      type="date"
                      min={date}
                      required
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                    />
                  </Field>
                  <span className="field-label">Dias da semana</span>
                  <div className="weekday-picker">
                    {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map(
                      (d, i) => (
                        <button
                          type="button"
                          className={weekdays.includes(i) ? "selected" : ""}
                          key={d}
                          onClick={() =>
                            setWeekdays((s) =>
                              s.includes(i)
                                ? s.filter((v) => v !== i)
                                : [...s, i],
                            )
                          }
                          aria-pressed={weekdays.includes(i)}
                        >
                          {d}
                        </button>
                      ),
                    )}
                  </div>
                  <p className="form-hint">
                    <Info size={14} />
                    {dates.length} data{dates.length !== 1 ? "s" : ""} ·{" "}
                    {dates.length * selected.length} alocaç
                    {dates.length * selected.length !== 1
                      ? "ões médicas"
                      : "ão médica"}
                  </p>
                </div>
              )}
            </>
          )}
          <Field label="Observações (opcional)">
            <textarea
              name="notes"
              rows={3}
              defaultValue={shift?.notes || ""}
              placeholder="Informações importantes para a equipe"
              maxLength={2000}
            />
          </Field>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
        <div className="modal-footer">
          <button
            className="button button-secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </button>
          <Submit busy={busy}>
            {shift
              ? "Salvar alterações"
              : repeat
                ? `Criar ${dates.length} plantões`
                : "Criar plantão"}
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
export function ShiftDetail({
  shift,
  user,
  doctors,
  offers,
  locked,
  onClose,
  onEdit,
  onChanged,
  onOffer,
}: {
  shift: Shift;
  user: User;
  doctors: Doctor[];
  offers: Offer[];
  locked: boolean;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
  onOffer: (a: string) => void;
}) {
  const admin = user.role !== "doctor";
  const [confirm, setConfirm] = useState<{
      type: "delete" | "remove";
      id: string;
      name?: string;
    } | null>(null),
    [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [doctorId, setDoctorId] = useState("");
  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(`/shifts/${shift.id}/assignments`, { doctor_id: doctorId });
      setAdding(false);
      setDoctorId("");
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const available = doctors.filter(
    (d) => d.active && !shift.assignments.some((a) => a.doctor_id === d.id),
  );
  return (
    <>
      <Modal
        title="Detalhes do plantão"
        subtitle={dayLabel(shift.date, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        })}
        onClose={onClose}
        wide
      >
        <div className="modal-body">
          <div className={`shift-detail-hero ${shift.period}`}>
            <div className="detail-hero-icon">
              <CalendarDays size={27} />
            </div>
            <div>
              <PeriodBadge period={shift.period} />
              <h3>
                {shift.start_time} <span>às</span> {shift.end_time}
              </h3>
              <p>
                {shift.unit} <span>·</span>{" "}
                {formatNumber(hours(shift.start_time, shift.end_time))} horas
                {shift.end_time < shift.start_time
                  ? " · término no dia seguinte"
                  : ""}
              </p>
            </div>
          </div>
          {locked && (
            <div className="notice">
              <LockKeyhole size={17} />
              Este mês está fechado. A escala está disponível para consulta.
            </div>
          )}
          {shift.needs_review && (
            <div className="notice notice-warm">
              <Info size={17} />
              Este plantão está sinalizado para revisão.
              {admin && !locked && (
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await patch(`/shifts/${shift.id}`, {
                        needs_review: false,
                      });
                      onChanged();
                    } catch (e) {
                      setError(message(e));
                    }
                  }}
                >
                  Marcar revisado
                </button>
              )}
            </div>
          )}
          <div className="section-heading detail-section">
            <div>
              <span className="eyebrow">EQUIPE DO PLANTÃO</span>
              <h3>
                {shift.assignments.length} médico
                {shift.assignments.length !== 1 ? "s" : ""} na escala
              </h3>
            </div>
            {admin && !locked && (
              <button
                className="button button-secondary button-sm"
                onClick={() => setAdding(!adding)}
              >
                <Plus size={15} />
                Adicionar
              </button>
            )}
          </div>
          <div className="assignment-list">
            {shift.assignments.map((a) => {
              const offer = offers.find(
                (o) => o.assignment_id === a.id && o.status === "open",
              );
              return (
                <div className="assignment-row" key={a.id}>
                  <Avatar name={a.doctor_name} color={a.doctor_color} />
                  <div className="assignment-info">
                    <strong>{a.doctor_name}</strong>
                    <small>
                      {offer ? (
                        <span className="text-orange">Repasse disponível</span>
                      ) : (
                        doctors.find((d) => d.id === a.doctor_id)?.specialty ||
                        "Equipe médica"
                      )}
                    </small>
                  </div>
                  {!locked &&
                    (admin || user.doctor_id === a.doctor_id) &&
                    !offer &&
                    isUpcoming(shift.date, shift.start_time) && (
                      <button
                        className="button button-secondary button-sm"
                        onClick={() => onOffer(a.id)}
                      >
                        <ArrowUpRight size={15} />
                        Ofertar
                      </button>
                    )}
                  {admin && !locked && (
                    <button
                      className="icon-button danger-icon"
                      aria-label={`Remover ${a.doctor_name} do plantão`}
                      onClick={() =>
                        setConfirm({
                          type: "remove",
                          id: a.id,
                          name: a.doctor_name,
                        })
                      }
                    >
                      <X size={17} />
                    </button>
                  )}
                </div>
              );
            })}
            {!shift.assignments.length && (
              <Empty
                title="Equipe a definir"
                description="Adicione um médico para preencher este plantão."
              />
            )}
          </div>
          {adding && (
            <form className="inline-add" onSubmit={add}>
              <select
                required
                aria-label="Médico a adicionar"
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
              >
                <option value="">Selecione um médico</option>
                {available.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <Submit busy={busy}>Adicionar</Submit>
            </form>
          )}
          {shift.notes && (
            <div className="notes-block">
              <span className="eyebrow">OBSERVAÇÕES</span>
              <p>{shift.notes}</p>
            </div>
          )}
          {shift.source && (
            <div className="source-block">
              <Info size={13} />
              <span>Procedência: {shift.source}</span>
            </div>
          )}
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
        <div className="modal-footer">
          <div>
            {admin && !locked && (
              <button
                className="button button-ghost danger-text"
                onClick={() => setConfirm({ type: "delete", id: shift.id })}
              >
                <Trash2 size={16} />
                Excluir plantão
              </button>
            )}
          </div>
          <div className="button-row">
            <button className="button button-secondary" onClick={onClose}>
              Fechar
            </button>
            {admin && !locked && (
              <button className="button button-primary" onClick={onEdit}>
                <Pencil size={16} />
                Editar plantão
              </button>
            )}
          </div>
        </div>
      </Modal>
      {confirm && (
        <Confirm
          title={
            confirm.type === "delete"
              ? "Excluir este plantão?"
              : "Remover médico do plantão?"
          }
          description={
            confirm.type === "delete"
              ? "O plantão e suas alocações deixarão de fazer parte da escala. A exclusão ficará registrada no histórico."
              : `${confirm.name} deixará de fazer parte deste plantão. A alteração ficará registrada no histórico.`
          }
          onClose={() => setConfirm(null)}
          danger
          reason
          confirmLabel={
            confirm.type === "delete" ? "Excluir plantão" : "Remover médico"
          }
          onConfirm={async (reason) => {
            if (confirm.type === "delete") {
              await remove(`/shifts/${confirm.id}`, { reason });
              onClose();
            } else await remove(`/assignments/${confirm.id}`, { reason });
            onChanged();
          }}
        />
      )}
    </>
  );
}
export function OfferForm({
  assignmentId,
  onClose,
  onSaved,
}: {
  assignmentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      await post("/offers", {
        assignment_id: assignmentId,
        note: new FormData(e.currentTarget).get("note"),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Disponibilizar repasse"
      subtitle="Abra este plantão para a equipe."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="notice">
            <Info size={18} />
            <span>
              O plantão continua sob sua responsabilidade até outro médico
              assumir o repasse.
            </span>
          </div>
          <Field label="Mensagem para a equipe (opcional)">
            <textarea
              rows={4}
              name="note"
              placeholder="Adicione uma observação sobre o repasse"
              maxLength={1000}
            />
          </Field>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Voltar
          </button>
          <Submit busy={busy}>Disponibilizar plantão</Submit>
        </div>
      </form>
    </Modal>
  );
}
export function AcceptOffer({
  offer,
  user,
  doctors,
  onClose,
  onSaved,
}: {
  offer: Offer;
  user: User;
  doctors: Doctor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [doctor, setDoctor] = useState(user.doctor_id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const admin = user.role !== "doctor";
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await post(
        `/offers/${offer.id}/accept`,
        admin ? { doctor_id: doctor } : {},
      );
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Assumir este plantão?"
      subtitle="Confira os detalhes antes de confirmar."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="accept-summary">
            <PeriodBadge period={offer.period} />
            <h3>
              {dayLabel(offer.date, {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </h3>
            <p>
              {offer.start_time} às {offer.end_time} · {offer.unit}
            </p>
            <span>Repasse de {offer.from_name}</span>
          </div>
          {admin && (
            <Field label="Médico que assumirá">
              <select
                value={doctor}
                onChange={(e) => setDoctor(e.target.value)}
                required
              >
                <option value="">Selecione um médico</option>
                {doctors
                  .filter((d) => d.active && d.id !== offer.from_doctor_id)
                  .map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <p className="confirm-description">
            Ao confirmar, o plantão será transferido para{" "}
            {admin ? "o médico selecionado" : "você"} e a alteração será
            registrada no histórico. O sistema verifica conflitos de horário
            automaticamente.
          </p>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Voltar
          </button>
          <Submit busy={busy}>Confirmar e assumir</Submit>
        </div>
      </form>
    </Modal>
  );
}
