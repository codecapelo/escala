import { useState, type FormEvent } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Wand2 } from "lucide-react";
import { Modal, Field, Submit, ErrorBox } from "./ui";
import { post, message } from "./api";
import type { User } from "./types";
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
// Readable strong password: no look-alike characters, always mixed case, digit and symbol.
export function strongPassword(length = 14) {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  const base = Array.from(bytes, (n) => alphabet[n % alphabet.length]);
  const pick = (set: string, i: number) =>
    (base[i] = set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length]);
  pick("ABCDEFGHJKLMNPQRSTUVWXYZ", 0);
  pick("abcdefghijkmnpqrstuvwxyz", 1);
  pick("23456789", 2);
  pick("!@#$%&*?", 3);
  return base.join("");
}
export default function SetPassword({
  user,
  onClose,
  onSaved,
}: {
  user: User;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState(""),
    [visible, setVisible] = useState(false),
    [copied, setCopied] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(`/team/${user.id}/password`, { password });
      setDone(true);
      onSaved();
    } catch (err) {
      setError(message(err));
    }
    setBusy(false);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(
        "Não foi possível copiar. Selecione e copie a senha manualmente.",
      );
    }
  }
  return (
    <Modal
      title="Definir nova senha"
      subtitle={`${user.name} · ${user.email}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          {done ? (
            <div className="notice">
              <Check size={17} />
              <span>
                Senha alterada e sessões anteriores encerradas. Passe a nova
                senha a {user.name.split(" ")[0]} por um canal seguro e peça que
                troque no perfil.
              </span>
            </div>
          ) : (
            <>
              <div className="notice">
                <KeyRound size={17} />
                <span>
                  A senha atual deixa de valer e a pessoa será desconectada de
                  todos os aparelhos. A troca fica registrada no histórico, sem
                  a senha.
                </span>
              </div>
              <Field label="Nova senha" hint="Use pelo menos 10 caracteres.">
                <div className="password-input">
                  <input
                    type={visible ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    minLength={10}
                    maxLength={128}
                    autoFocus
                  />
                  <button
                    type="button"
                    aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </Field>
              <div className="button-row">
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => {
                    setPassword(strongPassword());
                    setVisible(true);
                  }}
                >
                  <Wand2 size={14} />
                  Gerar senha forte
                </button>
                <button
                  type="button"
                  className="button button-ghost button-sm"
                  disabled={!password}
                  onClick={copy}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copiada" : "Copiar"}
                </button>
              </div>
            </>
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
            {done ? "Fechar" : "Voltar"}
          </button>
          {!done && <Submit busy={busy}>Salvar nova senha</Submit>}
        </div>
      </form>
    </Modal>
  );
}
