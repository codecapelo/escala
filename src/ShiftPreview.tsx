import { useEffect, useState, type FocusEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  AlertCircle,
  Clock3,
  MousePointerClick,
} from "lucide-react";
import { PeriodBadge } from "./ui";
import { formatNumber, hours } from "./utils";
import type { Shift } from "./types";
type Target = { shift: Shift; rect: DOMRect } | null;
let publish: (target: Target) => void = () => {};
// Spread onto any element that opens a shift; the single <ShiftPreviewHost/> draws the card.
export function previewProps(shift: Shift) {
  const show = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) =>
    publish({ shift, rect: e.currentTarget.getBoundingClientRect() });
  const hide = () => publish(null);
  return {
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  };
}
const MAX_NAMES = 36;
export function ShiftPreviewHost({
  ownDoctorId,
}: {
  ownDoctorId: string | null;
}) {
  const [target, setTarget] = useState<Target>(null);
  publish = setTarget;
  useEffect(() => {
    const hide = () => setTarget(null);
    window.addEventListener("click", hide, true);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("click", hide, true);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  if (!target) return null;
  const { shift, rect } = target;
  const names = [...shift.assignments].sort((a, b) =>
    a.doctor_name.localeCompare(b.doctor_name, "pt-BR"),
  );
  const shown = names.slice(0, MAX_NAMES);
  const width = names.length > 9 ? 520 : 300;
  const cardWidth = Math.min(width, window.innerWidth - 24);
  const rows = Math.ceil(shown.length / (names.length > 9 ? 2 : 1));
  const estimatedHeight = 150 + rows * 24;
  const right = rect.right + 10 + cardWidth <= window.innerWidth - 12;
  const left = right
    ? rect.right + 10
    : Math.max(
        12,
        Math.min(
          rect.left - 10 - cardWidth,
          window.innerWidth - cardWidth - 12,
        ),
      );
  const top = Math.max(
    12,
    Math.min(rect.top - 8, window.innerHeight - estimatedHeight - 12),
  );
  const hasOffer = shift.assignments.some((a) => a.offer_id);
  return createPortal(
    <div
      className="shift-preview"
      role="tooltip"
      style={{ left, top, width: cardWidth }}
    >
      <div className="shift-preview-head">
        <PeriodBadge period={shift.period} />
        <strong>
          {shift.start_time} <span>às</span> {shift.end_time}
        </strong>
        <small>
          <Clock3 size={12} />
          {formatNumber(hours(shift.start_time, shift.end_time))}h
        </small>
      </div>
      <p className="shift-preview-unit">
        {shift.unit}
        {shift.end_time < shift.start_time ? " · termina no dia seguinte" : ""}
      </p>
      <div className="shift-preview-count">
        {names.length} médico{names.length === 1 ? "" : "s"} na escala
        {shift.capacity != null && (
          <span
            className={
              shift.capacity > names.length ? "preview-open" : "preview-full"
            }
          >
            {shift.capacity > names.length
              ? `faltam ${shift.capacity - names.length} de ${shift.capacity}`
              : "equipe completa"}
          </span>
        )}
        {hasOffer && (
          <span>
            <ArrowUpRight size={12} />
            repasse em andamento
          </span>
        )}
      </div>
      {shown.length ? (
        <ul className={names.length > 9 ? "two-columns" : ""}>
          {shown.map((a) => (
            <li key={a.id} className={a.doctor_id === ownDoctorId ? "own" : ""}>
              <i style={{ background: a.doctor_color }} />
              {a.doctor_name}
              {a.doctor_id === ownDoctorId && <b>você</b>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="shift-preview-empty">Equipe a definir.</p>
      )}
      {names.length > shown.length && (
        <p className="shift-preview-more">
          + {names.length - shown.length} médicos. Abra o plantão para ver
          todos.
        </p>
      )}
      {shift.needs_review && (
        <p className="shift-preview-review">
          <AlertCircle size={13} />
          Aguarda conferência dos dados importados.
        </p>
      )}
      <p className="shift-preview-hint">
        <MousePointerClick size={12} />
        Clique para abrir os detalhes
      </p>
    </div>,
    document.body,
  );
}
