import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  ShieldCheck,
  CalendarDays,
  CircleCheck,
  Activity,
  ArrowUpRight,
} from "lucide-react";
import { post, message } from "./api";
import { Logo, ErrorBox, Field } from "./ui";
import type { Auth } from "./types";
export default function AuthView({ onAuth }: { onAuth: (auth: Auth) => void }) {
  const token = new URLSearchParams(window.location.search).get("token");
  const activate = window.location.pathname === "/ativar";
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [visible, setVisible] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      const auth = await post<Auth>(
        activate ? "/auth/activate" : "/auth/login",
        activate
          ? { token, name: form.get("name"), password: form.get("password") }
          : {
              email: String(form.get("email")).trim(),
              password: form.get("password"),
            },
      );
      if (activate) window.history.replaceState({}, "", "/");
      onAuth(auth);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <Logo light />
        <div className="auth-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <div className="art-plus">+</div>
          <div className="art-card art-card-calendar">
            <CalendarDays size={20} />
            <span>
              Uma equipe conectada.<strong>Um cuidado que continua.</strong>
            </span>
            <CircleCheck size={17} />
          </div>
          <div className="art-card art-card-pulse">
            <Activity size={34} />
            <div>
              <span>TELEMEDICINA</span>
              <strong>Presença, onde importa.</strong>
            </div>
          </div>
        </div>
        <div className="auth-statement">
          <span className="eyebrow light">TEMPO PARA CUIDAR</span>
          <h1>
            Seu próximo plantão.
            <br />
            <em>Nosso próximo cuidado.</em>
          </h1>
          <p>
            A escala da sua equipe, em um só lugar.
            <br />
            Mais organização para quem cuida de vidas.
          </p>
        </div>
        <div className="auth-story-footer">
          <span>Amil Telemedicina</span>
          <span>
            Cuidado que conecta <ArrowUpRight size={15} />
          </span>
        </div>
      </section>
      <section className="auth-main">
        <div className="auth-mobile-logo">
          <Logo />
        </div>
        <div className="auth-form-wrap">
          <span className="eyebrow">PORTAL DA EQUIPE MÉDICA</span>
          <h2>{activate ? "Vamos começar?" : "Que bom ter você aqui."}</h2>
          <p className="auth-subtitle">
            {activate
              ? "Ative seu acesso e faça parte da nossa equipe."
              : "Entre para acompanhar e organizar seus plantões."}
          </p>
          {activate && !token ? (
            <ErrorBox>
              Este convite está incompleto. Solicite um novo link ao
              administrador da sua equipe.
            </ErrorBox>
          ) : (
            <form onSubmit={submit} className="auth-form">
              {activate ? (
                <Field label="Seu nome completo">
                  <input
                    name="name"
                    autoComplete="name"
                    placeholder="Como devemos chamar você?"
                    required
                    minLength={2}
                  />
                </Field>
              ) : (
                <Field label="E-mail">
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="voce@exemplo.com"
                    required
                    autoFocus
                  />
                </Field>
              )}
              <Field
                label={activate ? "Crie sua senha" : "Senha"}
                hint={activate ? "Use pelo menos 10 caracteres." : undefined}
              >
                <div className="password-input">
                  <input
                    name="password"
                    type={visible ? "text" : "password"}
                    autoComplete={
                      activate ? "new-password" : "current-password"
                    }
                    placeholder={
                      activate
                        ? "Uma senha segura para o seu acesso"
                        : "Digite sua senha"
                    }
                    required
                    minLength={activate ? 10 : 1}
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
              {error && <ErrorBox>{error}</ErrorBox>}
              <button
                type="submit"
                className="button button-primary auth-submit"
                disabled={busy}
              >
                {busy
                  ? "Aguarde…"
                  : activate
                    ? "Ativar meu acesso"
                    : "Entrar na minha escala"}
                <ArrowRight size={18} />
              </button>
            </form>
          )}
          <div className="auth-help">
            <ShieldCheck size={18} />
            <p>
              {activate
                ? "Seu convite é pessoal. Mantenha suas credenciais em segurança."
                : "Precisa de acesso ou esqueceu a senha?"}
              {!activate && (
                <strong> Fale com o administrador da sua equipe.</strong>
              )}
            </p>
          </div>
        </div>
        <footer className="auth-footer">
          © {new Date().getFullYear()} Amil · Gestão de escalas{" "}
          <span>Acesso restrito à equipe autorizada</span>
        </footer>
      </section>
    </main>
  );
}
