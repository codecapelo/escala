import { useState } from "react";
import { ArrowUpRight, CalendarDays } from "lucide-react";
import { Modal, Spinner, ErrorBox, PeriodBadge } from "./ui";
import { patch, message } from "./api";
import { useResource } from "./hooks";
import { dayLabel } from "./utils";
import type { Doctor, Period } from "./types";
export interface UpcomingShift {
  assignment_id: string;
  shift_id: string;
  date: string;
  start_time: string;
  end_time: string;
  period: Period;
  unit: string;
}
// Lists the doctor's future shifts so they can be redistributed before inactivation.
export default function InactivateDoctor({
  doctor,
  onClose,
  onOpenShift,
  onDone,
}: {
  doctor: Doctor;
  onClose: () => void;
  onOpenShift: (shift: UpcomingShift) => void;
  onDone: () => void;
}) {
  const upcoming = useResource<{ shifts: UpcomingShift[] }>(
    `/doctors/${doctor.id}/upcoming`,
    0,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const shifts = upcoming.data?.shifts || [];
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await patch(`/doctors/${doctor.id}`, { active: false });
      onDone();
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="Inativar médico?" onClose={onClose} wide>
      <div className="modal-body">
        <p className="confirm-description">
          {doctor.name} deixará de aparecer nas novas alocações. Os plantões
          passados e o histórico serão preservados.
        </p>
        {upcoming.loading && !upcoming.data ? (
          <Spinner label="Conferindo plantões futuros…" />
        ) : upcoming.error ? (
          <ErrorBox retry={upcoming.reload}>{upcoming.error}</ErrorBox>
        ) : shifts.length ? (
          <div className="upcoming-block">
            <p className="upcoming-title">
              <CalendarDays size={16} />
              {shifts.length} plantão{shifts.length === 1 ? "" : "ões"} futuro
              {shifts.length === 1 ? "" : "s"} para redistribuir
            </p>
            <p className="upcoming-help">
              Abra cada plantão, remova {doctor.name.split(" ")[0]} e adicione
              outro médico. Depois volte e conclua a inativação.
            </p>
            <ul className="upcoming-list">
              {shifts.map((s) => (
                <li key={s.assignment_id}>
                  <div>
                    <strong>
                      {dayLabel(s.date, {
                        weekday: "short",
                        day: "2-digit",
                        month: "long",
                      })}
                    </strong>
                    <span>
                      {s.start_time} às {s.end_time} · {s.unit}
                    </span>
                  </div>
                  <PeriodBadge period={s.period} />
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    onClick={() => onOpenShift(s)}
                  >
                    Abrir plantão <ArrowUpRight size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="notice">Nenhum plantão futuro. Pode inativar.</div>
        )}
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
        <button
          type="button"
          className="button button-danger"
          disabled={busy || upcoming.loading || !!shifts.length}
          onClick={confirm}
        >
          {busy ? "Aguarde…" : "Inativar médico"}
        </button>
      </div>
    </Modal>
  );
}
