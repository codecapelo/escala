import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  X,
  Loader2,
  AlertCircle,
  Check,
  ArrowRight,
  CalendarDays,
  Sun,
  Sunset,
  Moon,
  Sunrise,
} from "lucide-react";
import { periods, initials } from "./utils";
import type { Period } from "./types";
export function Logo({
  light = false,
  compact = false,
}: {
  light?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`brand ${light ? "brand-light" : ""}`}>
      <div className="brand-symbol">
        <span />
        <span />
        <span />
      </div>
      {!compact && (
        <div className="brand-text">
          <strong>
            amil<span> · </span>
            <b>escala</b>
          </strong>
          <small>TELEMEDICINA</small>
        </div>
      )}
    </div>
  );
}
export function Spinner({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <Loader2 size={24} className="spin" />
      <span>{label}</span>
    </div>
  );
}
export function ErrorBox({
  children,
  retry,
}: {
  children: ReactNode;
  retry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <span>{children}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          Tentar novamente <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <CalendarDays size={27} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Avatar({
  name,
  color,
  small = false,
}: {
  name: string;
  color?: string;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar ${small ? "avatar-small" : ""}`}
      style={color ? { backgroundColor: `${color}18`, color } : undefined}
    >
      {initials(name)}
    </span>
  );
}
export function PeriodIcon({
  period,
  size = 14,
}: {
  period: Period;
  size?: number;
}) {
  const Icon = { morning: Sun, afternoon: Sunset, night: Moon, dawn: Sunrise }[
    period
  ];
  return <Icon size={size} />;
}
export function PeriodBadge({ period }: { period: Period }) {
  return (
    <span className={`period-badge ${period}`}>
      <PeriodIcon period={period} />
      {periods[period].label}
    </span>
  );
}
const modalStack: string[] = [];
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    modalStack.push(titleId);
    const prior = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const node = ref.current;
    const items = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
        ) || [],
      ).filter((e) => e.offsetParent !== null);
    items()[0]?.focus();
    const handle = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== titleId) return;
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const els = items();
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      const stackIndex = modalStack.indexOf(titleId);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", handle);
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Fechar janela"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
  className = "",
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Submit({
  busy,
  children = "Salvar alterações",
  disabled = false,
}: {
  busy: boolean;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      className="button button-primary"
      disabled={busy || disabled}
    >
      {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{" "}
      {busy ? "Salvando…" : children}
    </button>
  );
}
export function Confirm({
  title,
  description,
  onClose,
  onConfirm,
  danger = false,
  confirmLabel = "Confirmar",
  reason = false,
}: {
  title: string;
  description: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
  danger?: boolean;
  confirmLabel?: string;
  reason?: boolean;
}) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <ConfirmForm
        description={description}
        onClose={onClose}
        onConfirm={onConfirm}
        danger={danger}
        confirmLabel={confirmLabel}
        reason={reason}
        formRef={ref}
      />
    </Modal>
  );
}
import { useState, type RefObject } from "react";
import { message } from "./api";
function ConfirmForm({
  description,
  onClose,
  onConfirm,
  danger,
  confirmLabel,
  reason,
  formRef,
}: {
  description: string;
  onClose: () => void;
  onConfirm: (r: string) => Promise<void>;
  danger: boolean;
  confirmLabel: string;
  reason: boolean;
  formRef: RefObject<HTMLFormElement | null>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onConfirm(
        String(new FormData(e.currentTarget).get("reason") || ""),
      );
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <form ref={formRef} onSubmit={submit}>
      <div className="modal-body">
        <p className="confirm-description">{description}</p>
        {reason && (
          <Field label="Motivo">
            <textarea
              name="reason"
              placeholder="Registre o motivo para o histórico"
              required
              minLength={3}
              rows={3}
            />
          </Field>
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
          className={`button ${danger ? "button-danger" : "button-primary"}`}
          disabled={busy}
        >
          {busy && <Loader2 size={16} className="spin" />}
          {busy ? "Aguarde…" : confirmLabel}
        </button>
      </div>
    </form>
  );
}
