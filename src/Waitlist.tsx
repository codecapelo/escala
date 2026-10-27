import { useState } from "react";
import { Hourglass, UserMinus } from "lucide-react";
import { post, message } from "./api";
import { useResource } from "./hooks";
import { ErrorBox } from "./ui";
import type { Shift, User } from "./types";
interface Entry {
  id: string;
  doctor_id: string;
  doctor_name: string;
  position: number;
  note: string;
}
// Whether the shift (start + duration) is still running or ahead, in Brasília time.
function notEnded(shift: Shift) {
  const start = new Date(
    `${shift.date}T${shift.start_time}:00-03:00`,
  ).getTime();
  const [sh, sm] = shift.start_time.split(":").map(Number);
  const [eh, em] = shift.end_time.split(":").map(Number);
  const minutes =
    (((eh * 60 + em - (sh * 60 + sm)) % 1440) + 1440) % 1440 || 1440;
  return start + minutes * 60000 > Date.now();
}
export default function Waitlist({
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
  const admin = user.role !== "doctor";
  const assigned = shift.assignments.some(
    (a) => a.doctor_id === user.doctor_id,
  );
  const { data, reload } = useResource<{ entries: Entry[]; count: number }>(
    `/shifts/${shift.id}/waitlist`,
    (shift.waitlist_count ?? 0) + (shift.my_waitlist_id ? 1 : 0),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const full =
    shift.capacity !== null &&
    shift.capacity !== undefined &&
    (shift.available_vacancies ?? 0) === 0;
  const entries = data?.entries || [];
  const mine = entries.find((e) => e.doctor_id === user.doctor_id);
  const canJoin =
    !!user.doctor_id &&
    !assigned &&
    !mine &&
    full &&
    !locked &&
    notEnded(shift);
  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await post(path, body);
      reload();
      onChanged();
    } catch (e) {
      setError(message(e));
    }
    setBusy(false);
  }
  if (!full && !entries.length) return null;
  return (
    <section className="waitlist-panel" aria-label="Lista de espera do plantão">
      <div className="vacancy-heading">
        <span className="eyebrow">LISTA DE ESPERA</span>
        <span className="staffing-badge staffing-full">
          <Hourglass size={12} />{" "}
          {(data?.count ?? shift.waitlist_count ?? 0) === 1
            ? "1 disponível"
            : `${data?.count ?? shift.waitlist_count ?? 0} disponíveis`}
        </span>
      </div>
      <p>
        Médicos sem lugar neste plantão que estão disponíveis para assumir caso
        alguém queira passar. Vale durante o plantão e nos seguintes.
      </p>
      {mine && (
        <div className="vacancy-request">
          <strong>
            Você está na lista de espera (posição {mine.position}).
          </strong>
          <p>Quem quiser repassar este plantão poderá indicar você.</p>
          {!locked && (
            <button
              className="button button-secondary button-sm"
              disabled={busy}
              onClick={() => act(`/waitlist/${mine.id}/cancel`, {})}
            >
              <UserMinus size={14} /> Sair da lista
            </button>
          )}
        </div>
      )}
      {canJoin && (
        <button
          className="button button-primary"
          disabled={busy}
          onClick={() => act(`/shifts/${shift.id}/waitlist`, {})}
        >
          {busy ? "Entrando…" : "Estou disponível para assumir"}
        </button>
      )}
      {(admin || assigned) && entries.length > 0 && (
        <ol className="waitlist-entries">
          {entries.map((e) => (
            <li key={e.id}>
              <span>
                {e.position}º · {e.doctor_name}
              </span>
              {admin && !locked && (
                <button
                  className="button button-ghost button-sm"
                  disabled={busy}
                  onClick={() => act(`/waitlist/${e.id}/cancel`, {})}
                >
                  Remover
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </section>
  );
}
