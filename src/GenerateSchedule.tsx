import { useState, type FormEvent } from "react";
import {
  CalendarPlus,
  CalendarRange,
  Copy,
  Eye,
  Layers,
  Save,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Modal, Field, Submit, ErrorBox, Spinner, Empty, Confirm } from "./ui";
import { ApiError, post, remove, message } from "./api";
import { useResource } from "./hooks";
import { dayLabel, monthLabel, shiftMonth, todayISO } from "./utils";
import type { User } from "./types";
interface Template {
  id: string;
  name: string;
  kind: "week" | "month";
  source_ref: string;
  shifts: number;
  created_by_name: string | null;
  created_at: string;
}
interface Skipped {
  date: string;
  start_time: string;
  doctor: string;
  reason: string;
}
interface Result {
  shifts: number;
  assignments: number;
  skipped: number;
  skipped_details: Skipped[];
  source: string;
  dry_run: boolean;
}
type Mode = "month" | "week" | "template";
export default function GenerateSchedule({
  month,
  user,
  onClose,
  onDone,
}: {
  month: string;
  user: User;
  onClose: () => void;
  onDone: (targetMonth: string, result: Result) => void;
}) {
  const [tab, setTab] = useState<"generate" | "models">("generate"),
    [target, setTarget] = useState(shiftMonth(month, 1)),
    [mode, setMode] = useState<Mode>("month"),
    [fromMonth, setFromMonth] = useState(month),
    [weekDate, setWeekDate] = useState(
      month === todayISO().slice(0, 7) ? todayISO() : `${month}-07`,
    ),
    [templateId, setTemplateId] = useState(""),
    [allowExisting, setAllowExisting] = useState(false),
    [existingCount, setExistingCount] = useState(0),
    [preview, setPreview] = useState<Result | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  const templates = useResource<{ templates: Template[] }>(
    "/templates",
    version,
  );
  const list = templates.data?.templates || [];
  const source =
    mode === "month"
      ? { type: "month", month: fromMonth }
      : mode === "week"
        ? { type: "week", date: weekDate }
        : { type: "template", template_id: templateId };
  const invalidate = () => {
    setPreview(null);
    setError("");
  };
  async function run(dry_run: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await post<Result>("/schedule/generate", {
        target_month: target,
        source,
        dry_run,
        allow_existing: allowExisting,
      });
      if (dry_run) setPreview(result);
      else {
        onDone(target, result);
        onClose();
        return;
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "MONTH_NOT_EMPTY") {
        setExistingCount(
          Number((e.details as { shifts?: number })?.shifts || 0),
        );
        setPreview(null);
      }
      setError(message(e));
    }
    setBusy(false);
  }
  const ready =
    /^\d{4}-\d{2}$/.test(target) &&
    (mode !== "template" || !!templateId) &&
    (mode !== "month" || /^\d{4}-\d{2}$/.test(fromMonth)) &&
    (mode !== "week" || !!weekDate);
  return (
    <Modal
      title="Gerar escala"
      subtitle="Monte um mês a partir de uma escala que já existe."
      onClose={onClose}
      wide
    >
      <div className="section-tabs generate-tabs">
        <button
          type="button"
          className={tab === "generate" ? "active" : ""}
          onClick={() => setTab("generate")}
        >
          <CalendarPlus size={16} />
          Gerar mês
        </button>
        <button
          type="button"
          className={tab === "models" ? "active" : ""}
          onClick={() => setTab("models")}
        >
          <Layers size={16} />
          Modelos salvos <span>{list.length}</span>
        </button>
      </div>
      {tab === "generate" ? (
        <div className="modal-body generate-body">
          <Field label="Mês a montar">
            <input
              type="month"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setAllowExisting(false);
                setExistingCount(0);
                invalidate();
              }}
            />
          </Field>
          <fieldset className="generate-sources">
            <legend>Como montar</legend>
            <label
              className={`generate-source ${mode === "month" ? "active" : ""}`}
            >
              <input
                type="radio"
                name="mode"
                checked={mode === "month"}
                onChange={() => {
                  setMode("month");
                  invalidate();
                }}
              />
              <Copy size={18} />
              <span>
                <strong>Repetir um mês anterior</strong>
                <small>
                  Cada dia recebe os plantões do mesmo dia da semana do mês
                  escolhido.
                </small>
                {mode === "month" && (
                  <input
                    type="month"
                    aria-label="Mês de origem"
                    value={fromMonth}
                    onChange={(e) => {
                      setFromMonth(e.target.value);
                      invalidate();
                    }}
                  />
                )}
              </span>
            </label>
            <label
              className={`generate-source ${mode === "week" ? "active" : ""}`}
            >
              <input
                type="radio"
                name="mode"
                checked={mode === "week"}
                onChange={() => {
                  setMode("week");
                  invalidate();
                }}
              />
              <CalendarRange size={18} />
              <span>
                <strong>Semana padrão, repetida o mês todo</strong>
                <small>
                  Usa a semana (domingo a sábado) que contém a data escolhida e
                  a repete em todas as semanas do mês.
                </small>
                {mode === "week" && (
                  <input
                    type="date"
                    aria-label="Data da semana padrão"
                    value={weekDate}
                    onChange={(e) => {
                      setWeekDate(e.target.value);
                      invalidate();
                    }}
                  />
                )}
              </span>
            </label>
            <label
              className={`generate-source ${mode === "template" ? "active" : ""}`}
            >
              <input
                type="radio"
                name="mode"
                checked={mode === "template"}
                onChange={() => {
                  setMode("template");
                  invalidate();
                }}
              />
              <Layers size={18} />
              <span>
                <strong>Modelo salvo</strong>
                <small>
                  {list.length
                    ? "Aplique uma semana ou um mês que você guardou."
                    : "Nenhum modelo ainda. Salve um na aba Modelos salvos."}
                </small>
                {mode === "template" && !!list.length && (
                  <select
                    aria-label="Modelo"
                    value={templateId}
                    onChange={(e) => {
                      setTemplateId(e.target.value);
                      invalidate();
                    }}
                  >
                    <option value="">Escolha um modelo</option>
                    {list.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {t.kind === "week" ? "semana" : "mês"} ·{" "}
                        {t.shifts} plantões
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </label>
          </fieldset>
          {existingCount > 0 && (
            <label className="workflow-checkbox workflow-confirm">
              <input
                type="checkbox"
                checked={allowExisting}
                onChange={(e) => {
                  setAllowExisting(e.target.checked);
                  invalidate();
                }}
              />
              <span>
                <strong>
                  {monthLabel(target)} já tem {existingCount} plantões.
                </strong>
                <small>
                  Marque para adicionar o que falta, sem duplicar o que já está
                  na escala.
                </small>
              </span>
            </label>
          )}
          {error && <ErrorBox>{error}</ErrorBox>}
          {preview && (
            <div className="generate-preview" role="status">
              <strong>
                {preview.shifts} plantões e {preview.assignments} alocações
                seriam criados em {monthLabel(target)}.
              </strong>
              <small>Origem: {preview.source}</small>
              {preview.skipped > 0 && (
                <div className="generate-skipped">
                  <p>
                    <TriangleAlert size={14} />
                    {preview.skipped} alocação(ões) ficariam de fora:
                  </p>
                  <ul>
                    {preview.skipped_details.slice(0, 8).map((s, i) => (
                      <li key={i}>
                        {dayLabel(s.date)} {s.start_time} · {s.doctor} (
                        {s.reason})
                      </li>
                    ))}
                  </ul>
                  {preview.skipped > 8 && (
                    <small>e mais {preview.skipped - 8}…</small>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <ModelsTab
          month={month}
          user={user}
          list={list}
          loading={templates.loading && !templates.data}
          error={templates.error}
          reload={() => setVersion((v) => v + 1)}
        />
      )}
      {tab === "generate" && (
        <div className="modal-footer">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Voltar
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || !ready}
            onClick={() => run(true)}
          >
            <Eye size={16} />
            Pré-visualizar
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !ready || !preview}
            onClick={() => run(false)}
          >
            {busy ? "Aguarde…" : `Gerar ${monthLabel(target)}`}
          </button>
        </div>
      )}
    </Modal>
  );
}
function ModelsTab({
  month,
  user,
  list,
  loading,
  error,
  reload,
}: {
  month: string;
  user: User;
  list: Template[];
  loading: boolean;
  error: string;
  reload: () => void;
}) {
  const [kind, setKind] = useState<"week" | "month">("week"),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(""),
    [del, setDel] = useState<Template | null>(null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setProblem("");
    try {
      await post("/templates", {
        name: String(f.get("name") || "").trim(),
        kind,
        ...(kind === "week"
          ? { date: String(f.get("date")) }
          : { month: String(f.get("month")) }),
      });
      form.reset();
      reload();
    } catch (err) {
      setProblem(message(err));
    }
    setBusy(false);
  }
  return (
    <div className="modal-body generate-body">
      <form className="generate-save" onSubmit={save}>
        <h3>Salvar a escala atual como modelo</h3>
        <div className="form-grid">
          <Field label="Nome do modelo">
            <input
              name="name"
              required
              minLength={2}
              maxLength={80}
              placeholder="Ex.: Semana padrão"
            />
          </Field>
          <Field label="O que salvar">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "week" | "month")}
            >
              <option value="week">Uma semana (repete no mês)</option>
              <option value="month">Um mês inteiro</option>
            </select>
          </Field>
        </div>
        {kind === "week" ? (
          <Field
            label="Data dentro da semana"
            hint="Salva a semana de domingo a sábado que contém esta data."
          >
            <input
              type="date"
              name="date"
              required
              defaultValue={`${month}-07`}
            />
          </Field>
        ) : (
          <Field label="Mês">
            <input type="month" name="month" required defaultValue={month} />
          </Field>
        )}
        {problem && <ErrorBox>{problem}</ErrorBox>}
        <Submit busy={busy}>
          <Save size={15} />
          Salvar modelo
        </Submit>
      </form>
      {loading ? (
        <Spinner label="Carregando modelos…" />
      ) : error ? (
        <ErrorBox retry={reload}>{error}</ErrorBox>
      ) : !list.length ? (
        <Empty
          title="Nenhum modelo salvo"
          description="Salve uma semana ou um mês para reutilizar quando quiser."
        />
      ) : (
        <ul className="generate-models">
          {list.map((t) => (
            <li key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <span>
                  {t.kind === "week" ? "Semana de " : "Mês "}
                  {t.kind === "week"
                    ? dayLabel(t.source_ref, { day: "2-digit", month: "short" })
                    : monthLabel(t.source_ref)}
                  {" · "}
                  {t.shifts} plantões
                  {t.created_by_name ? ` · ${t.created_by_name}` : ""}
                </span>
              </div>
              {user.role !== "doctor" && (
                <button
                  type="button"
                  className="icon-button danger-icon"
                  aria-label={`Excluir modelo ${t.name}`}
                  onClick={() => setDel(t)}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {del && (
        <Confirm
          title="Excluir este modelo?"
          description={`“${del.name}” deixará de estar disponível. Escalas já geradas não são afetadas.`}
          danger
          confirmLabel="Excluir modelo"
          onClose={() => setDel(null)}
          onConfirm={async () => {
            await remove(`/templates/${del.id}`, {});
            reload();
          }}
        />
      )}
    </div>
  );
}
