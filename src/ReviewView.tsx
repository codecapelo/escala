import { useState, type FormEvent } from "react";
import {
  FileCheck2,
  FileText,
  Check,
  AlertCircle,
  ArrowRight,
  ArrowRightLeft,
  GitMerge,
  ShieldCheck,
  Clock3,
  Info,
  ChevronDown,
  ChevronUp,
  Link2,
} from "lucide-react";
import { Avatar, Modal, Field, Submit, Spinner, ErrorBox, Empty } from "./ui";
import { post, message } from "./api";
import { dayLabel } from "./utils";
export interface ReviewDoctor {
  id: string;
  name: string;
  active: boolean;
  crm: string | null;
  user_id: string | null;
  merged_into_id: string | null;
}
export interface ReviewIssue {
  id: string;
  source_issue_id: string;
  sha256: string;
  filename: string;
  imported_at: string;
  type: string;
  description: string;
  doctorIds?: string[];
  doctorId?: string;
  sourceNames?: string[];
  date?: string;
  code?: string;
  sourcePage?: number;
  resolved: boolean;
  resolution: null | {
    resolved_at: string;
    resolved_by_name: string;
    note: string;
  };
}
export interface ImportReview {
  imports: {
    sha256: string;
    filename: string;
    imported_at: string;
    summary: Record<string, unknown>;
  }[];
  issues: ReviewIssue[];
  doctors: ReviewDoctor[];
  counts: { total: number; pending: number; resolved: number };
}
type Resource = {
  data: ImportReview | null;
  loading: boolean;
  error: string;
  reload: () => void;
};
const issueLabels: Record<string, string> = {
  "possible-name-alias": "Possível variante de nome",
  "section-meaning": "Horário do reforço",
  "source-staffing-anomaly": "Quantidade de médicos",
  "duplicate-assignment": "Linha repetida no PDF",
};
export function canonicalDoctor(
  id: string,
  doctors: ReviewDoctor[],
): ReviewDoctor | undefined {
  let current = doctors.find((d) => d.id === id);
  const seen = new Set<string>();
  while (current?.merged_into_id && !seen.has(current.id)) {
    seen.add(current.id);
    current = doctors.find((d) => d.id === current!.merged_into_id);
  }
  return current;
}
export default function ReviewView({
  resource,
  onChanged,
  onReauthenticate,
  notify,
}: {
  resource: Resource;
  onChanged: () => void;
  onReauthenticate: () => void;
  notify: (s: string) => void;
}) {
  const [filter, setFilter] = useState<"pending" | "resolved" | "all">(
      "pending",
    ),
    [resolve, setResolve] = useState<ReviewIssue | null>(null),
    [merge, setMerge] = useState<ReviewIssue | null>(null),
    [sources, setSources] = useState(false);
  const { data, loading, error, reload } = resource;
  if (loading && !data)
    return <Spinner label="Carregando a conferência do PDF…" />;
  if (error && !data) return <ErrorBox retry={reload}>{error}</ErrorBox>;
  if (!data) return null;
  const issues = data.issues.filter(
    (i) =>
      filter === "all" || (filter === "resolved" ? i.resolved : !i.resolved),
  );
  return (
    <>
      {error && <ErrorBox retry={reload}>{error}</ErrorBox>}
      <div className="review-intro">
        <div className="review-intro-icon">
          <FileCheck2 size={27} />
        </div>
        <div>
          <span className="eyebrow">CONFERÊNCIA DA FONTE</span>
          <h2>Dados fiéis. Decisões humanas.</h2>
          <p>
            Confira as diferenças encontradas no PDF com a coordenação. As
            grafias e os registros de origem foram preservados.
          </p>
        </div>
        <div className="review-progress">
          <strong>
            {data.counts.resolved}
            <span> / {data.counts.total}</span>
          </strong>
          <small>pendências conferidas</small>
        </div>
      </div>
      <div className="review-tools">
        <div className="review-filters" aria-label="Filtrar pendências">
          <button
            className={filter === "pending" ? "active" : ""}
            onClick={() => setFilter("pending")}
          >
            Pendentes <span>{data.counts.pending}</span>
          </button>
          <button
            className={filter === "resolved" ? "active" : ""}
            onClick={() => setFilter("resolved")}
          >
            Conferidas <span>{data.counts.resolved}</span>
          </button>
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            Todas
          </button>
        </div>
        <button
          className="text-button"
          onClick={() => setSources(!sources)}
          aria-expanded={sources}
        >
          <FileText size={14} />
          Documento de origem
          {sources ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {sources && (
        <div className="review-sources">
          {data.imports.map((i) => (
            <div key={i.sha256}>
              <FileText size={20} />
              <div>
                <strong>{i.filename}</strong>
                <span>
                  Importado em{" "}
                  {new Date(i.imported_at).toLocaleDateString("pt-BR")}
                </span>
                <small>
                  SHA-256: <code title={i.sha256}>{i.sha256}</code>
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
      {!issues.length ? (
        <div className="content-card">
          <Empty
            icon={
              filter === "pending" ? (
                <ShieldCheck size={28} />
              ) : (
                <FileCheck2 size={28} />
              )
            }
            title={
              filter === "pending"
                ? "Conferência em dia"
                : "Nenhuma conferência registrada"
            }
            description={
              filter === "pending"
                ? "Todas as pendências desta importação foram conferidas e as decisões estão registradas."
                : "As decisões da coordenação aparecerão aqui após a conferência."
            }
          />
        </div>
      ) : (
        <div className="review-issues">
          {issues.map((issue) => {
            const ids = issue.doctorIds || [
              ...(issue.doctorId ? [issue.doctorId] : []),
            ];
            const originals = ids
              .map((id) => data.doctors.find((d) => d.id === id))
              .filter((d): d is ReviewDoctor => !!d);
            const possibleMerge =
              issue.type === "possible-name-alias" &&
              originals.some((d) => !d.merged_into_id) &&
              new Set(
                originals.map((d) => canonicalDoctor(d.id, data.doctors)?.id),
              ).size > 1;
            return (
              <article
                className={`review-issue ${issue.resolved ? "resolved" : ""}`}
                key={issue.id}
              >
                <div className="review-issue-heading">
                  <span
                    className={`review-type ${issue.resolved ? "review-type-resolved" : ""}`}
                  >
                    {issue.resolved ? (
                      <Check size={14} />
                    ) : (
                      <AlertCircle size={14} />
                    )}{" "}
                    {issueLabels[issue.type] || "Conferência da importação"}
                  </span>
                  <span
                    className={`status-pill ${issue.resolved ? "status-success" : "status-warm"}`}
                  >
                    <span />
                    {issue.resolved ? "Conferida" : "Pendente"}
                  </span>
                </div>
                <p className="review-description">{issue.description}</p>
                {originals.length > 0 && (
                  <div className="review-identity-grid">
                    {originals.map((d, i) => {
                      const canonical = canonicalDoctor(d.id, data.doctors);
                      return (
                        <div
                          className={`review-identity ${d.merged_into_id ? "identity-merged" : ""}`}
                          key={d.id}
                        >
                          <Avatar name={d.name} small />
                          <div>
                            <strong>{d.name}</strong>
                            {issue.sourceNames?.[i] &&
                              issue.sourceNames[i] !== d.name && (
                                <small>Na fonte: {issue.sourceNames[i]}</small>
                              )}
                            <small>
                              {d.crm ? `CRM ${d.crm}` : "Sem CRM no cadastro"}
                              {d.user_id ? " · Acesso vinculado" : ""}
                            </small>
                            {d.merged_into_id && (
                              <span className="canonical-label">
                                <Link2 size={11} />
                                Consolidado em{" "}
                                {canonical?.name || "outro cadastro"}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {issue.date && (
                  <div className="review-reference">
                    <Clock3 size={13} />
                    <span>
                      {dayLabel(issue.date, {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
                      {issue.code ? ` · Turno ${issue.code}` : ""}
                      {issue.sourcePage ? ` · Página ${issue.sourcePage}` : ""}
                    </span>
                  </div>
                )}
                <div className="review-issue-footer">
                  <span>
                    <FileText size={12} />
                    {issue.filename}
                    {issue.sourcePage ? ` · p. ${issue.sourcePage}` : ""}
                  </span>
                  {!issue.resolved && (
                    <div className="button-row">
                      {possibleMerge && (
                        <button
                          className="button button-secondary button-sm"
                          onClick={() => setMerge(issue)}
                        >
                          <GitMerge size={13} />
                          Consolidar cadastro
                        </button>
                      )}
                      <button
                        className="button button-primary button-sm"
                        onClick={() => setResolve(issue)}
                      >
                        <Check size={13} />
                        Registrar conferência
                      </button>
                    </div>
                  )}
                </div>
                {issue.resolution && (
                  <div className="review-resolution">
                    <span className="resolution-icon">
                      <ShieldCheck size={17} />
                    </span>
                    <div>
                      <p>{issue.resolution.note}</p>
                      <small>
                        {issue.resolution.resolved_by_name} ·{" "}
                        {new Date(issue.resolution.resolved_at).toLocaleString(
                          "pt-BR",
                          { dateStyle: "short", timeStyle: "short" },
                        )}
                      </small>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <div className="review-footer-note">
        <Info size={16} />
        <p>
          Registrar uma conferência preserva a decisão da coordenação. Corrija
          os horários ou cadastros necessários e marque os plantões revisados na
          escala. A consolidação de nomes é uma ação separada, realizada após
          confirmar a identidade.
        </p>
      </div>
      {resolve && (
        <ResolveModal
          issue={resolve}
          onClose={() => setResolve(null)}
          onSaved={() => {
            onChanged();
            notify("Conferência registrada no histórico.");
          }}
        />
      )}
      {merge && (
        <MergeModal
          issue={merge}
          doctors={data.doctors}
          onClose={() => setMerge(null)}
          onSaved={(reauth) => {
            if (reauth) {
              onReauthenticate();
              return;
            }
            onChanged();
            notify(
              "Cadastros consolidados. Registre agora a conferência da pendência.",
            );
          }}
        />
      )}
    </>
  );
}
function ResolveModal({
  issue,
  onClose,
  onSaved,
}: {
  issue: ReviewIssue;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = String(new FormData(e.currentTarget).get("note") || "").trim();
    if (note.length < 3) {
      setError("Descreva a conferência com pelo menos 3 caracteres.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await post(`/imports/review/${encodeURIComponent(issue.id)}/resolve`, {
        note,
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
      title="Registrar conferência"
      subtitle={issueLabels[issue.type] || "Pendência da importação"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <p className="confirm-description">{issue.description}</p>
          <Field
            label="Decisão da coordenação"
            hint="Descreva o que foi conferido, a referência utilizada e a decisão. Este registro será preservado no histórico."
          >
            <textarea
              name="note"
              required
              minLength={3}
              maxLength={1000}
              rows={5}
              placeholder="Ex.: Identidade confirmada pelo CRM. Cadastro consolidado com o nome completo…"
            />
          </Field>
          <div className="notice">
            <ShieldCheck size={17} />
            <span>
              Após salvar, a nota de conferência não poderá ser alterada. Revise
              o texto antes de confirmar.
            </span>
          </div>
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
          <Submit busy={busy}>Salvar conferência</Submit>
        </div>
      </form>
    </Modal>
  );
}
function MergeModal({
  issue,
  doctors,
  onClose,
  onSaved,
}: {
  issue: ReviewIssue;
  doctors: ReviewDoctor[];
  onClose: () => void;
  onSaved: (reauth: boolean) => void;
}) {
  const candidates = (issue.doctorIds || [])
    .map((id) => canonicalDoctor(id, doctors))
    .filter((d): d is ReviewDoctor => !!d && !d.merged_into_id);
  const unique = Array.from(new Map(candidates.map((d) => [d.id, d])).values());
  const [source, setSource] = useState(unique[0]?.id || ""),
    [target, setTarget] = useState(unique[1]?.id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const origin = doctors.find((d) => d.id === source),
    destination = doctors.find((d) => d.id === target);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!source || !target || source === target) {
      setError("Selecione dois cadastros diferentes.");
      return;
    }
    const reason = String(
      new FormData(e.currentTarget).get("reason") || "",
    ).trim();
    if (reason.length < 3) {
      setError("Descreva como a identidade foi confirmada.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await post<{ reauthentication_required: boolean }>(
        `/doctors/${source}/merge`,
        { target_id: target, reason },
      );
      onSaved(result.reauthentication_required);
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Consolidar a mesma identidade"
      subtitle="Confirme a identidade antes de unir os cadastros."
      onClose={onClose}
      wide
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="notice notice-warm">
            <AlertCircle size={17} />
            <span>
              Use este recurso apenas se os cadastros representam a mesma
              pessoa, com identidade confirmada pela coordenação. Não há
              desfazer automático.
            </span>
          </div>
          <div className="merge-selectors">
            <Field label="Cadastro que será inativado">
              <select
                value={source}
                required
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">Selecione a origem</option>
                {doctors
                  .filter((d) => !d.merged_into_id && d.id !== target)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {!d.active ? " (inativo)" : ""}
                    </option>
                  ))}
              </select>
            </Field>
            <button
              className="icon-button merge-swap"
              type="button"
              aria-label="Inverter origem e destino"
              title="Inverter origem e destino"
              onClick={() => {
                if (origin?.active) {
                  setSource(target);
                  setTarget(source);
                }
              }}
              disabled={!origin?.active}
            >
              <ArrowRightLeft size={18} />
            </button>
            <Field label="Cadastro que permanecerá ativo">
              <select
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Selecione o destino</option>
                {doctors
                  .filter(
                    (d) => d.active && !d.merged_into_id && d.id !== source,
                  )
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          {origin && destination && (
            <div className="merge-preview">
              <div>
                <Avatar name={origin.name} small />
                <strong>{origin.name}</strong>
                <small>Origem inativada</small>
              </div>
              <ArrowRight size={19} />
              <div>
                <Avatar name={destination.name} small />
                <strong>{destination.name}</strong>
                <small>Nome e CRM preservados</small>
              </div>
            </div>
          )}
          <ul className="merge-effects">
            <li>
              <Check size={13} />
              Os plantões serão transferidos para o cadastro ativo, sem duplicar
              participações no mesmo turno.
            </li>
            <li>
              <Check size={13} />
              Ofertas abertas da origem e convites pendentes dos dois cadastros
              serão cancelados.
            </li>
            <li>
              <Check size={13} />O cadastro de origem e o histórico serão
              preservados. Uma conta transferida precisará entrar novamente.
            </li>
          </ul>
          <Field label="Como a identidade foi confirmada?">
            <textarea
              name="reason"
              rows={3}
              required
              minLength={3}
              maxLength={1000}
              placeholder="Registre a confirmação da identidade e o motivo da consolidação"
            />
          </Field>
          <label className="inline-checkbox merge-check">
            <input type="checkbox" required />
            <span>
              Conferi os cadastros e confirmo que representam a mesma pessoa.
            </span>
          </label>
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
          <Submit busy={busy}>Confirmar consolidação</Submit>
        </div>
      </form>
    </Modal>
  );
}
