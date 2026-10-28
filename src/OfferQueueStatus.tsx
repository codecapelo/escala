import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import type { Offer } from "./types";

export default function OfferQueueStatus({
  offer,
  onExpired,
}: {
  offer: Offer;
  onExpired: () => void;
}) {
  const deadline = offer.queue_expires_at;
  const serverNow = offer.queue_server_now;
  const [remaining, setRemaining] = useState(() =>
    deadline && serverNow
      ? Math.max(
          0,
          Math.ceil((Date.parse(deadline) - Date.parse(serverNow)) / 1000),
        )
      : 0,
  );
  useEffect(() => {
    if (!deadline || !serverNow || offer.queue_mode !== "exclusive") return;
    const start = performance.now();
    const initial = Date.parse(deadline) - Date.parse(serverNow);
    let expired = false;
    const update = () => {
      const value = Math.max(0, initial - (performance.now() - start));
      setRemaining(Math.ceil(value / 1000));
      if (!value && !expired) {
        expired = true;
        onExpired();
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [deadline, serverNow, offer.queue_mode, onExpired]);
  if (offer.target_doctor_id || offer.status !== "open") return null;
  if (offer.queue_mode === "public")
    return (
      <div className="offer-queue-status">
        Liberado para a equipe: não há mais médicos aguardando a vez neste
        repasse.
      </div>
    );
  if (offer.queue_mode !== "exclusive") return null;
  const time = [
    Math.floor(remaining / 3600),
    Math.floor((remaining % 3600) / 60),
    remaining % 60,
  ]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
  return (
    <div
      className={`offer-queue-status ${offer.queue_is_my_turn ? "queue-my-turn" : ""}`}
    >
      <Clock3 size={16} />
      <div>
        <strong>
          {offer.queue_is_my_turn
            ? "Sua vez de pedir este repasse"
            : offer.queue_current_name
              ? `Vez de ${offer.queue_current_name}`
              : "Aguardando a vez de outro médico"}
        </strong>
        {deadline && (
          <p>
            <span role="timer" aria-live="off">
              Tempo restante: {time}
            </span>
            {remaining === 0 && " · Atualizando a fila…"}
          </p>
        )}
        {!offer.queue_is_my_turn && offer.queue_my_position != null && (
          <p>
            Você está na fila deste repasse, posição {offer.queue_my_position}.
          </p>
        )}
      </div>
    </div>
  );
}
