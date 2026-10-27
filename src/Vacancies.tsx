import { useEffect, useState } from "react";
import { post, message } from "./api";
import { useResource } from "./hooks";
import { isUpcoming } from "./utils";
import { ErrorBox } from "./ui";
import type { Shift, User } from "./types";
interface VacancyRequest {
  id: string;
  doctor_id: string;
  user_id: string;
  doctor_name: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  created_at: string;
  decision_note: string | null;
}
export function StaffingBadge({ shift }: { shift: Shift }) {
  if (shift.capacity === null || shift.capacity === undefined) return null;
  const missing = Math.max(0, shift.capacity - shift.assignments.length);
  return (
    <span
      className={`staffing-badge ${missing ? "staffing-open" : "staffing-full"}`}
    >
      {missing
        ? `Faltam ${missing} médico${missing === 1 ? "" : "s"}`
        : "Equipe completa"}
      {(shift.pending_vacancies ?? 0) > 0
        ? ` · ${shift.pending_vacancies} pendente(s)`
        : ""}
    </span>
  );
}
export default function Vacancies({
  shift,
  user,
  locked,
  onChanged,
}: {
  shift: Shift;
  user: User;
  locked: boolean;
  onChanged: () => void;
}) {
  const { data, error, reload } = useResource<{ requests: VacancyRequest[] }>(
    `/vacancy-requests?month=${shift.date.slice(0, 7)}&shift_id=${shift.id}`,
    (shift.pending_vacancies ?? 0) + shift.assignments.length,
  );
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  useEffect(() => {
    const timer = setInterval(reload, 30000);
    return () => clearInterval(timer);
  }, [reload]);
  const admin = user.role !== "doctor",
    requests = data?.requests || [],
    own = requests.find((r) => r.user_id === user.id && r.status === "pending");
  // Pending requests form a queue in the order they were made.
  const queue = requests
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const position = (id: string) => queue.findIndex((r) => r.id === id) + 1;
  const assigned = shift.assignments.some(
    (a) => a.doctor_id === user.doctor_id,
  );
  const upcoming = isUpcoming(shift.date, shift.start_time);
  async function act(path: string) {
    setBusy(true);
    setActionError("");
    try {
      await post(path);
      reload();
      onChanged();
    } catch (e) {
      setActionError(message(e));
      reload();
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  if (shift.capacity === null || shift.capacity === undefined) return null;
  const missing = Math.max(0, shift.capacity - shift.assignments.length);
  return (
    <section
      className="vacancy-panel"
      aria-label="Cobertura e vagas do plantão"
    >
      <div className="vacancy-heading">
        <span className="eyebrow">COBERTURA DO PLANTÃO</span>
        <StaffingBadge shift={shift} />
      </div>
      <h3>
        {shift.assignments.length} de {shift.capacity} médicos confirmados
      </h3>
      {missing > 0 && (
        <p>
          <strong>
            {shift.available_vacancies ?? 0} vaga(s) disponível(is)
          </strong>
          {(shift.pending_vacancies ?? 0) > 0 &&
            ` · ${shift.pending_vacancies} reservada(s), aguardando autorização`}
        </p>
      )}
      {own ? (
        <div className="vacancy-request">
          <strong>
            Você está na fila: {position(own.id)}º de {queue.length}.
          </strong>
          <p>
            A vaga está reservada. Você entrará na escala após aprovação da
            administração.
          </p>
          {!locked && (
            <button
              className="button button-secondary button-sm"
              disabled={busy}
              onClick={() => act(`/vacancy-requests/${own.id}/cancel`)}
            >
              Cancelar solicitação
            </button>
          )}
        </div>
      ) : (
        user.doctor_id &&
        !assigned &&
        upcoming &&
        !locked &&
        (shift.available_vacancies ?? 0) > 0 && (
          <>
            <button
              className="button button-primary"
              disabled={busy || !data}
              onClick={() => act(`/shifts/${shift.id}/vacancy-requests`)}
            >
              {busy ? "Solicitando…" : "Solicitar para assumir vaga"}
            </button>
            <p className="form-hint">
              A vaga ficará reservada até a administração decidir.
            </p>
          </>
        )
      )}
      {!own &&
        requests.find(
          (r) => r.user_id === user.id && r.status === "rejected",
        ) && (
          <p>
            Solicitação anterior recusada. Você pode solicitar novamente se
            houver vaga.
          </p>
        )}
      {admin && queue.length > 0 && (
        <p className="eyebrow">FILA DE SOLICITAÇÕES (POR ORDEM DE PEDIDO)</p>
      )}
      {admin &&
        queue.map((r) => (
          <div className="vacancy-request" key={r.id}>
            <strong>
              {position(r.id)}º · {r.doctor_name}
            </strong>
            <p>Solicitou para assumir uma vaga. Aguardando autorização.</p>
            {!locked && (
              <div className="button-row">
                <button
                  className="button button-primary button-sm"
                  disabled={busy || !upcoming}
                  onClick={() => act(`/vacancy-requests/${r.id}/approve`)}
                >
                  Autorizar
                </button>
                <button
                  className="button button-secondary button-sm"
                  disabled={busy}
                  onClick={() => act(`/vacancy-requests/${r.id}/reject`)}
                >
                  Recusar
                </button>
              </div>
            )}
          </div>
        ))}
      {(actionError || error) && <ErrorBox>{actionError || error}</ErrorBox>}
    </section>
  );
}
