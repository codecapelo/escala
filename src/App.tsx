import {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
} from "react";
import {
  CalendarDays,
  ArrowRightLeft,
  Users,
  ChartNoAxesCombined,
  Activity,
  ChevronDown,
  ShieldCheck,
  Check,
  X,
  Menu,
  ChevronRight,
  LayoutGrid,
  Loader2,
  ClipboardCheck,
} from "lucide-react";
import { api, post, ApiError, message } from "./api";
import { Logo, Spinner, ErrorBox, Avatar, Modal, Confirm } from "./ui";
const AuthView = lazy(() => import("./AuthView"));
import Schedule, { ShiftList } from "./Schedule";
const ShiftForm = lazy(() =>
  import("./ShiftForms").then((m) => ({ default: m.ShiftForm })),
);
const ShiftDetail = lazy(() =>
  import("./ShiftForms").then((m) => ({ default: m.ShiftDetail })),
);
const OfferForm = lazy(() =>
  import("./ShiftForms").then((m) => ({ default: m.OfferForm })),
);
const AcceptOffer = lazy(() =>
  import("./ShiftForms").then((m) => ({ default: m.AcceptOffer })),
);
const CorrectionsView = lazy(()=>import("./CorrectionsView"));
const RegistrationStatus = lazy(()=>import("./RegistrationViews").then(m=>({default:m.RegistrationStatus})));
import type {CorrectionSeed} from "./CorrectionsView";
const TeamView = lazy(() => import("./TeamView"));
const OffersView = lazy(() =>
  import("./SecondaryViews").then((m) => ({ default: m.OffersView })),
);
const ReportsView = lazy(() =>
  import("./SecondaryViews").then((m) => ({ default: m.ReportsView })),
);
const AuditView = lazy(() =>
  import("./SecondaryViews").then((m) => ({ default: m.AuditView })),
);
const ProfileModal = lazy(() =>
  import("./SecondaryViews").then((m) => ({ default: m.ProfileModal })),
);
import { dayLabel, monthLabel, roleLabels, todayISO, timeZone, isApproved } from "./utils";
import type { Auth, Dashboard, Page, Shift, Offer } from "./types";
const nav = [
  { id: "schedule", label: "Minha escala", icon: CalendarDays },
  { id: "offers", label: "Repasses", icon: ArrowRightLeft },
  { id: "team", label: "Equipe", icon: Users },
  { id: "reports", label: "Relatórios", icon: ChartNoAxesCombined },
  { id: "corrections", label: "Conferência", icon: ClipboardCheck },
  { id: "audit", label: "Histórico", icon: Activity },
] as const;
export default function App() {
  const [auth, setAuth] = useState<Auth | null | undefined>(undefined),
    [bootError, setBootError] = useState(""),
    [bootVersion, setBootVersion] = useState(0),
    [page, setPage] = useState<Page>("schedule"),
    [month, setMonth] = useState(todayISO().slice(0, 7)),
    [data, setData] = useState<Dashboard | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [selectedSnapshot,setSelectedSnapshot]=useState<Shift|null>(null),
    [correctionSeed,setCorrectionSeed]=useState<CorrectionSeed|null>(null),
    [form, setForm] = useState<{ shift?: Shift; date: string } | null>(null),
    [offerAssignment, setOfferAssignment] = useState<string | null>(null),
    [acceptOffer, setAcceptOffer] = useState<Offer | null>(null),
    [cancelOffer, setCancelOffer] = useState<Offer | null>(null),
    [approveOffer, setApproveOffer] = useState<Offer | null>(null),
    [rejectOffer, setRejectOffer] = useState<Offer | null>(null),
    [day, setDay] = useState<string | null>(null),
    [profile, setProfile] = useState(false),
    [lock, setLock] = useState<boolean | null>(null),
    [toast, setToast] = useState(""),
    [mobileMenu, setMobileMenu] = useState(false),
    [loggingOut, setLoggingOut] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((s: string) => {
    setToast(s);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5500);
  }, []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!auth) return;
    const update = () => {
      if (document.visibilityState === "visible") setVersion((v) => v + 1);
    };
    window.addEventListener("focus", update);
    const timer = setInterval(update, 30000);
    return () => {
      window.removeEventListener("focus", update);
      clearInterval(timer);
    };
  }, [auth]);
  useEffect(() => {
    let live = true;
    setBootError("");
    api<Auth>("/auth/me")
      .then((a) => {
        if (live) setAuth(a);
      })
      .catch((e) => {
        if (live) {
          if (e instanceof ApiError && e.status === 401) setAuth(null);
          else setBootError(message(e));
        }
      });
    return () => {
      live = false;
    };
  }, [bootVersion]);
  useEffect(() => {
    if (!auth || !isApproved(auth.user)) return;
    let live = true;
    setLoading(true);
    setError("");
    api<Dashboard>(`/dashboard?month=${month}`)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) {
          setError(message(e));
          if(e instanceof ApiError && (e.code==="PENDING_APPROVAL"||e.code==="REGISTRATION_REJECTED")){
            setData(null);void api<Auth>("/auth/me").then(setAuth).catch(()=>setAuth(null));
          }
          if (e instanceof ApiError && e.status === 401) {
            setAuth(null);
            setData(null);
          }
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [auth, month, version]);
  useEffect(() => {
    document.title = `${nav.find((n) => n.id === page)?.label || "Escala"} · Amil Telemedicina`;
  }, [page]);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  function changeMonth(next: string) {
    if (next === month) return;
    setData(null);
    setMonth(next);
    setSelectedId(null);
  }
  function navigate(next: Page) {
    setPage(next);
    setMobileMenu(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function selectShift(shift:Shift){setSelectedSnapshot(shift);setSelectedId(shift.id);}
  function refreshIdentity(){refresh();void api<Auth>("/auth/me").then(setAuth).catch(e=>{if(e instanceof ApiError&&e.status===401){setAuth(null);setData(null);}});}
  async function logout() {
    setLoggingOut(true);
    try {
      await post("/auth/logout");
      setAuth(null);
      setData(null);
      setProfile(false);
      setPage("schedule");
      notify("Sessão encerrada. Até o próximo cuidado.");
    } catch (e) {
      if(e instanceof ApiError&&e.status===401){setAuth(null);setData(null);setProfile(false);}else notify(message(e));
    } finally {
      setLoggingOut(false);
    }
  }
  const authenticated = (value: Auth) => {
    setAuth(value);
    setData(null);
    setPage("schedule");
  };
  if (auth === undefined)
    return (
      <div className="boot-screen">
        <Logo />
        {bootError ? (
          <div className="boot-error">
            <ErrorBox retry={() => setBootVersion((v) => v + 1)}>
              {bootError}
            </ErrorBox>
          </div>
        ) : (
          <Spinner label="Preparando o seu espaço de cuidado…" />
        )}
      </div>
    );
  if (
    !auth ||
    window.location.pathname === "/ativar" ||
    window.location.pathname === "/redefinir"
  )
    return (
      <Suspense
        fallback={
          <div className="boot-screen">
            <Logo />
            <Spinner label="Abrindo seu acesso…" />
          </div>
        }
      >
        <AuthView onAuth={authenticated} />
        {toast && <Toast text={toast} close={() => setToast("")} />}
      </Suspense>
    );
  if(!isApproved(auth.user))return <Suspense fallback={<Spinner label="Consultando aprovação…"/>}><RegistrationStatus auth={auth} onAuth={authenticated} onLogout={logout}/>{toast&&<Toast text={toast} close={()=>setToast("")}/>}</Suspense>;
  const user = data?.user || auth.user,
    admin = user.role !== "doctor";
  const selected = selectedId ? data?.shifts.find((s)=>s.id===selectedId)||(selectedSnapshot?.id===selectedId?selectedSnapshot:undefined):undefined;
  const ownDoctor=data?.doctors.find(d=>d.id===user.doctor_id)||auth.doctor;
  const openOffers =
    data?.offers.filter((o) => o.status === "open").length || 0;
  const availableNav = nav.filter(n=>(n.id!=="team"||admin)&&(n.id!=="corrections"||admin||!!user.doctor_id));
  const mobileNav=availableNav.length>5?availableNav.filter(n=>n.id!=="audit"):availableNav;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Pular para o conteúdo
      </a>
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <Logo light />
          <button
            className="icon-button sidebar-close"
            aria-label="Fechar menu"
            onClick={() => setMobileMenu(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace-chip">
          <span className="workspace-logo">
            <ShieldCheck size={18} />
          </span>
          <span>
            Amil Telemedicina<small>Gestão de escalas médicas</small>
          </span>
          <ChevronDown size={13} />
        </div>
        <span className="nav-caption">SEU ESPAÇO DE CUIDADO</span>
        <nav className="main-nav" aria-label="Navegação principal">
          {availableNav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "active" : ""}
              onClick={() => navigate(n.id)}
              aria-current={page === n.id ? "page" : undefined}
            >
              <n.icon size={19} />
              <span>
                {n.id === "schedule" && admin ? "Escala de plantões" : n.label}
              </span>
              {n.id === "offers" && openOffers > 0 && <b>{openOffers}</b>}
              {page === n.id && n.id !== "offers" && (
                <span className="nav-active-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-message">
            <span className="sidebar-message-plus">+</span>
            <span className="eyebrow light">NOSSO PROPÓSITO</span>
            <p>
              Cuidar de quem
              <br />
              cuida de todos.
            </p>
            <div className="sidebar-message-line" />
            <small>
              Organização que faz
              <br />a diferença no cuidado.
            </small>
          </div>
          <button className="sidebar-profile" onClick={() => setProfile(true)}>
            <Avatar name={user.name} />
            <span>
              <strong>{user.name.split(" ").slice(0, 2).join(" ")}</strong>
              <small>{roleLabels[user.role]}{user.role!=="doctor"&&user.doctor_id?" · Médico":""}</small>
            </span>
            <ChevronRight size={15} />
          </button>
          <span className="sidebar-version">AMIL · PORTAL DA EQUIPE</span>
        </div>
      </aside>
      {mobileMenu && (
        <button
          className="sidebar-scrim"
          aria-label="Fechar menu"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Abrir menu"
              onClick={() => setMobileMenu(true)}
            >
              <Menu size={21} />
            </button>
            <span className="topbar-home">
              <LayoutGrid size={16} />
              Meu espaço
            </span>
            <ChevronRight size={13} />
            <strong>
              {nav.find((n) => n.id === page)?.label === "Minha escala" && admin
                ? "Escala de plantões"
                : nav.find((n) => n.id === page)?.label}
            </strong>
          </div>
          <div className="topbar-right">
            {loading && data && (
              <span className="sync-state">
                <Loader2 className="spin" size={13} />
                Atualizando
              </span>
            )}
            <span className="topbar-date">
              {new Date().toLocaleDateString("pt-BR", {
                timeZone,
                weekday: "short",
                day: "numeric",
                month: "long",
              })}
            </span>
            <span className="topbar-divider" />
            <button
              className="topbar-profile"
              onClick={() => setProfile(true)}
              aria-label={`Abrir perfil de ${user.name}`}
            >
              <Avatar name={user.name} small />
              <span>
                Olá, <strong>{user.name.split(" ")[0]}</strong>
              </span>
              <ChevronDown size={13} />
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <Suspense fallback={<Spinner label="Preparando seu espaço…" />}>
            {error && (
              <div className="global-error">
                <ErrorBox retry={refresh}>{error}</ErrorBox>
              </div>
            )}
            {!data ? (
              loading ? (
                <div className="page-loading">
                  <div className="skeleton-heading" />
                  <div className="skeleton-text" />
                  <div className="skeleton-stats">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} />
                    ))}
                  </div>
                  <div className="skeleton-calendar" />
                  <Spinner label="Carregando sua escala…" />
                </div>
              ) : (
                <div className="content-card">
                  <ErrorBox retry={refresh}>
                    {error || "Não foi possível carregar sua escala."}
                  </ErrorBox>
                </div>
              )
            ) : (
              <>
                {page === "schedule" && (
                  <Schedule
                    data={data}
                    user={user}
                    month={month}
                    onMonth={changeMonth}
                    onNew={(date) =>
                      setForm({
                        date:
                          date ||
                          (month === todayISO().slice(0, 7)
                            ? todayISO()
                            : `${month}-01`),
                      })
                    }
                    onShift={selectShift}
                    onDay={setDay}
                    onOffers={() => navigate("offers")}
                    onGenerated={(target, summary) => {
                      refresh();
                      if (target !== month) changeMonth(target);
                      notify(summary);
                    }}
                  />
                )}{" "}
                {page === "offers" && (
                  <OffersView
                    offers={data.offers}
                    doctors={data.doctors}
                    user={user}
                    locked={data.locked}
                    month={month}
                    onMonth={changeMonth}
                    onAccept={setAcceptOffer}
                    onCancel={setCancelOffer}
                    onApprove={setApproveOffer}
                    onReject={setRejectOffer}
                    onSchedule={() => navigate("schedule")}
                  />
                )}{" "}
                {page === "team" && admin && (
                  <TeamView
                    doctors={data.doctors}
                    user={user}
                    version={version}
                    onChanged={refresh}
                    notify={notify}
                    onOpenShift={(s) => {
                      setPage("schedule");
                      if (s.date.slice(0, 7) !== month) {
                        setData(null);
                        setMonth(s.date.slice(0, 7));
                      }
                      setSelectedId(s.shift_id);
                      window.scrollTo({ top: 0 });
                    }}
                    onReauthenticate={() => {
                      setAuth(null);
                      setData(null);
                      notify(
                        "Os cadastros foram consolidados. Entre novamente para atualizar seu acesso.",
                      );
                    }}
                  />
                )}{" "}
                {page === "reports" && (
                  <ReportsView
                    user={user}
                    month={month}
                    onMonth={changeMonth}
                    version={version}
                    onLock={setLock}
                    notify={notify}
                  />
                )}{" "}
                {page === "corrections" && <CorrectionsView user={user} doctor={ownDoctor||null} shifts={data.shifts} month={month} onMonth={changeMonth} version={version} onChanged={refreshIdentity} notify={notify} initialRequest={correctionSeed} onConsumed={()=>setCorrectionSeed(null)}/>}
                {page === "audit" && (
                  <AuditView
                    user={user}
                    month={month}
                    onMonth={changeMonth}
                    version={version}
                  />
                )}
              </>
            )}
          </Suspense>
        </main>
      </div>
      <nav className="bottom-nav" aria-label="Navegação móvel">
        {mobileNav.map((n) => (
          <button
            key={n.id}
            className={page === n.id ? "active" : ""}
            onClick={() => navigate(n.id)}
            aria-current={page === n.id ? "page" : undefined}
          >
            <span>
              <n.icon size={20} />
              {n.id === "offers" && openOffers > 0 && <i />}
            </span>
            <small>{n.id === "schedule" ? "Escala" : n.label}</small>
          </button>
        ))}
      </nav>
      <Suspense
        fallback={
          <div className="modal-backdrop">
            <Spinner label="Carregando…" />
          </div>
        }
      >
        {form && data && (
          <ShiftForm
            user={user}
            shift={form.shift}
            defaultDate={form.date}
            doctors={data.doctors}
            onClose={() => setForm(null)}
            onSaved={() => {
              refresh();
              notify(
                form.shift
                  ? "Plantão atualizado."
                  : "Plantão criado. A equipe está na escala.",
              );
            }}
          />
        )}
        {selected && data && !form && (
          <ShiftDetail
            shift={selected}
            user={user}
            doctors={data.doctors}
            offers={data.offers}
            locked={selected.month_locked??data.locked}
            onRequestCorrection={user.doctor_id&&selected.assignments.some(a=>a.doctor_id===user.doctor_id)?type=>{setCorrectionSeed({shift:selected,type});setSelectedId(null);navigate("corrections");}:undefined}
            onClose={() => setSelectedId(null)}
            onEdit={() => {
              setForm({ shift: selected, date: selected.date });
              setSelectedId(null);
            }}
            onChanged={() => {
              refresh();
              notify("Escala atualizada.");
            }}
            onOffer={(id) => {
              setSelectedId(null);
              setOfferAssignment(id);
            }}
          />
        )}
        {day && data && (
          <Modal
            title={`Plantões de ${dayLabel(day, { day: "numeric", month: "long" })}`}
            subtitle="Todos os turnos deste dia."
            onClose={() => setDay(null)}
            wide
          >
            <div className="modal-day-list">
              <ShiftList
                shifts={data.shifts.filter((s) => s.date === day)}
                onShift={(s) => {
                  setDay(null);
                  selectShift(s);
                }}
              />
            </div>
            <div className="modal-footer">
              <button
                className="button button-secondary"
                onClick={() => setDay(null)}
              >
                Fechar
              </button>
            </div>
          </Modal>
        )}
        {offerAssignment && (
          <OfferForm
            assignmentId={offerAssignment}
            onClose={() => setOfferAssignment(null)}
            onSaved={() => {
              refresh();
              notify("Repasse disponível para a equipe.");
            }}
          />
        )}
        {acceptOffer && data && (
          <AcceptOffer
            offer={acceptOffer}
            user={user}
            onClose={() => setAcceptOffer(null)}
            onSaved={() => {
              refresh();
              notify("Pedido enviado. Aguardando a autorização da administração.");
            }}
          />
        )}
        {cancelOffer && (
          <Confirm
            title="Cancelar este repasse?"
            description={`O plantão de ${dayLabel(cancelOffer.date)} às ${cancelOffer.start_time} deixará de estar disponível. A responsabilidade permanece com ${cancelOffer.from_name}.`}
            onClose={() => setCancelOffer(null)}
            confirmLabel="Cancelar repasse"
            onConfirm={async () => {
              await post(`/offers/${cancelOffer.id}/cancel`);
              refresh();
              notify("Repasse cancelado.");
            }}
          />
        )}
        {approveOffer && (
          <Confirm
            title="Autorizar este repasse?"
            description={`${approveOffer.requested_name} assumirá o plantão de ${approveOffer.from_name} em ${dayLabel(approveOffer.date)} às ${approveOffer.start_time}. Seu nome ficará registrado como quem autorizou.`}
            onClose={() => setApproveOffer(null)}
            confirmLabel="Autorizar repasse"
            onConfirm={async () => {
              await post(`/offers/${approveOffer.id}/approve`);
              refresh();
              notify("Repasse autorizado e registrado no histórico.");
            }}
          />
        )}
        {rejectOffer && (
          <Confirm
            title="Recusar este pedido?"
            description={`O plantão de ${rejectOffer.from_name} volta a ficar disponível. Informe o motivo para o histórico.`}
            onClose={() => setRejectOffer(null)}
            reason
            confirmLabel="Recusar pedido"
            onConfirm={async (reason) => {
              await post(`/offers/${rejectOffer.id}/reject`, { note: reason });
              refresh();
              notify("Pedido recusado. O plantão voltou a ficar disponível.");
            }}
          />
        )}
        {lock !== null && (
          <Confirm
            title={
              lock
                ? "Fechar a escala deste mês?"
                : "Reabrir a escala deste mês?"
            }
            description={
              lock
                ? `Os plantões de ${monthLabel(month)} ficarão protegidos contra alterações e novos repasses. Confira a escala e resolva as revisões e ofertas pendentes antes de confirmar. Apenas o proprietário poderá reabrir o mês.`
                : `As alterações em ${monthLabel(month)} serão liberadas novamente. Registre o motivo da reabertura para manter o histórico da equipe.`
            }
            onClose={() => setLock(null)}
            reason={!lock}
            confirmLabel={lock ? "Confirmar fechamento" : "Reabrir mês"}
            onConfirm={async (reason) => {
              await post(`/months/${month}/lock`, {
                locked: lock,
                ...(reason ? { reason } : {}),
              });
              refresh();
              notify(
                lock
                  ? "Mês fechado. Escala protegida."
                  : "Mês reaberto para alterações.",
              );
            }}
          />
        )}
        {profile && (
          <Suspense
            fallback={
              <div className="modal-backdrop">
                <Spinner label="Abrindo seu perfil…" />
              </div>
            }
          >
            <ProfileModal
              user={user}
              doctor={ownDoctor||null}
              onCorrections={()=>{setProfile(false);navigate("corrections");}}
              onClose={() => setProfile(false)}
              onLogout={logout}
              notify={notify}
            />
          </Suspense>
        )}{" "}
      </Suspense>
      {loggingOut && (
        <div className="logout-progress" role="status">
          <Loader2 size={18} className="spin" />
          Encerrando sessão…
        </div>
      )}
      {toast && <Toast text={toast} close={() => setToast("")} />}
    </div>
  );
}
function Toast({ text, close }: { text: string; close: () => void }) {
  return (
    <div className="toast" role="status">
      <span>
        <Check size={16} />
      </span>
      <p>{text}</p>
      <button
        className="icon-button"
        aria-label="Dispensar mensagem"
        onClick={close}
      >
        <X size={16} />
      </button>
    </div>
  );
}
