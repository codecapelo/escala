import { useState, type FormEvent } from "react";
import {
  Plus,
  Search,
  Users,
  Mail,
  Shield,
  Stethoscope,
  Copy,
  Check,
  Link,
  UserRoundCheck,
  RefreshCw,
  Pencil,
  Power,
  X,
  LockKeyhole,
} from "lucide-react";
import {
  Avatar,
  Modal,
  Field,
  Submit,
  ErrorBox,
  Spinner,
  Empty,
  Confirm,
} from "./ui";
import { post, patch, message } from "./api";
import { useResource } from "./hooks";
import { roleLabels, dayLabel, isApproved, crmLabel, brazilStates } from "./utils";
import type { Doctor, User, Team, Role, Invite } from "./types";
import ReviewView, { type ImportReview } from "./ReviewView";
import {RegistrationQueue,SchedulePermission} from "./RegistrationViews";
import InactivateDoctor, { type UpcomingShift } from "./InactivateDoctor";
type LinkResult = { inviteUrl: string; expires_at: string };
export default function TeamView({
  doctors,
  user,
  version,
  onChanged,
  notify,
  onReauthenticate,
  onOpenShift,
}: {
  doctors: Doctor[];
  user: User;
  version: number;
  onChanged: () => void;
  notify: (s: string) => void;
  onReauthenticate: () => void;
  onOpenShift: (shift: UpcomingShift) => void;
}) {
  const [tab, setTab] = useState<"doctors" | "access" | "review" | "registrations">("doctors"),
    [search, setSearch] = useState(""),
    [showInactive, setShowInactive] = useState(false),
    [editDoctor, setEditDoctor] = useState<Doctor | null | undefined>(
      undefined,
    ),
    [invite, setInvite] = useState(false),
    [editUser, setEditUser] = useState<User | null>(null),
    [link, setLink] = useState<LinkResult | null>(null),
    [confirm, setConfirm] = useState<{
      type: "doctor" | "reset" | "revoke";
      doctor?: Doctor;
      user?: User;
      invite?: Invite;
    } | null>(null);
  const resource = useResource<Team>("/team", version);
  const team = resource.data;
  const reviewResource = useResource<ImportReview>("/imports/review", version);
  const enrichedDoctors = doctors.map((d) => ({
    ...d,
    merged_into_id:
      reviewResource.data?.doctors.find((r) => r.id === d.id)?.merged_into_id ||
      null,
  }));
  const filtered = enrichedDoctors.filter(
    (d) =>
      (showInactive || d.active) &&
      `${d.name} ${d.crm || ""} ${d.specialty}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const owner = user.role === "owner";
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PESSOAS QUE FAZEM A DIFERENÇA</span>
          <h1>
            Juntos, cuidamos melhor<span>.</span>
          </h1>
          <p>Conheça a equipe e organize os acessos ao portal.</p>
        </div>
        <div className="button-row">
          <button
            className="button button-secondary"
            onClick={() => setInvite(true)}
          >
            <Mail size={17} />
            Convidar usuário
          </button>
          <button
            className="button button-primary"
            onClick={() => setEditDoctor(null)}
          >
            <Plus size={18} />
            Novo médico
          </button>
        </div>
      </div>
      <div className="team-summary">
        <div>
          <span className="summary-icon">
            <Users size={22} />
          </span>
          <span>
            <strong>{doctors.filter((d) => d.active).length}</strong> médicos
            ativos<small>Uma rede de cuidado conectada</small>
          </span>
        </div>
        <div>
          <span className="summary-icon">
            <Shield size={22} />
          </span>
          <span>
            <strong>
              {team?.users.filter((u) => u.active !== false && isApproved(u)).length ?? "—"}
            </strong>{" "}
            usuários com acesso
            <small>Permissões para cada responsabilidade</small>
          </span>
        </div>
        <div>
          <span className="summary-icon warm">
            <Mail size={22} />
          </span>
          <span>
            <strong>
              {team?.invites.filter(
                (i) =>
                  !i.accepted_at &&
                  !i.revoked_at &&
                  new Date(i.expires_at) > new Date(),
              ).length ?? "—"}
            </strong>{" "}
            convites pendentes<small>O próximo cuidado começa aqui</small>
          </span>
        </div>
      </div>
      <div className="section-tabs">
        <button className={tab==="registrations"?"active":""} onClick={()=>setTab("registrations")}><UserRoundCheck size={17}/>Cadastros pendentes</button>
        <button
          className={tab === "doctors" ? "active" : ""}
          onClick={() => setTab("doctors")}
        >
          <Stethoscope size={17} />
          Equipe médica <span>{doctors.length}</span>
        </button>
        <button
          className={tab === "access" ? "active" : ""}
          onClick={() => setTab("access")}
        >
          <Shield size={17} />
          Acessos e convites
        </button>
        <button
          className={tab === "review" ? "active" : ""}
          onClick={() => setTab("review")}
        >
          <Check size={17} />
          Conferência do PDF
          {reviewResource.data && (
            <span>{reviewResource.data.counts.pending}</span>
          )}
        </button>
      </div>
      {tab === "doctors" ? (
        <>
          <div className="team-filters">
            <div className="input-icon">
              <Search size={17} />
              <input
                aria-label="Buscar na equipe"
                placeholder="Buscar nome, CRM ou especialidade"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Mostrar inativos
            </label>
            <span className="muted small">{filtered.length} médicos</span>
          </div>
          {!filtered.length ? (
            <div className="content-card">
              <Empty
                icon={<Users size={28} />}
                title="Nenhum médico encontrado"
                description={
                  search
                    ? "Tente buscar por outro nome ou especialidade."
                    : "Cadastre os médicos para começar a montar sua escala."
                }
                action={
                  !search ? (
                    <button
                      className="button button-primary"
                      onClick={() => setEditDoctor(null)}
                    >
                      <Plus size={16} />
                      Cadastrar médico
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="doctor-cards">
              {filtered.map((d) => (
                <article
                  className={`doctor-card ${!d.active ? "inactive" : ""}`}
                  key={d.id}
                >
                  <div className="doctor-card-top">
                    <Avatar name={d.name} color={d.color} />
                    <span
                      className={`status-pill ${d.active ? "status-success" : "status-muted"}`}
                    >
                      <span />
                      {d.merged_into_id
                        ? "Consolidado"
                        : d.active
                          ? "Ativo"
                          : "Inativo"}
                    </span>
                  </div>
                  <h3>{d.name}</h3>
                  <p>{d.specialty || "Médico"}</p>
                  <div className="doctor-card-meta">
                    <span>
                      <Stethoscope size={14} />
                      {crmLabel(d)}
                    </span>
                    <span>
                      <Shield size={14} />
                      {d.user_id ? "Acesso vinculado" : "Sem acesso vinculado"}
                    </span>
                  </div>
                  <div className="doctor-card-footer">
                    {d.merged_into_id ? (
                      <span className="doctor-merged-label">
                        <Link size={12} />
                        Cadastro consolidado
                      </span>
                    ) : (
                      <>
                        <button
                          className="text-button"
                          onClick={() => setEditDoctor(d)}
                        >
                          <Pencil size={14} />
                          Editar cadastro
                        </button>
                        <button
                          className="icon-button"
                          aria-label={
                            d.active
                              ? `Inativar ${d.name}`
                              : `Reativar ${d.name}`
                          }
                          title={
                            d.active ? "Inativar médico" : "Reativar médico"
                          }
                          onClick={() =>
                            setConfirm({ type: "doctor", doctor: d })
                          }
                        >
                          <Power size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : tab === "registrations" ? <RegistrationQueue doctors={doctors} version={version} onChanged={onChanged} notify={notify}/> : tab === "review" ? (
        <ReviewView
          resource={reviewResource}
          onChanged={onChanged}
          onReauthenticate={onReauthenticate}
          notify={notify}
        />
      ) : resource.loading && !team ? (
        <Spinner label="Carregando acessos da equipe…" />
      ) : resource.error ? (
        <ErrorBox retry={resource.reload}>{resource.error}</ErrorBox>
      ) : team ? (
        <>
          <section className="content-card">
            <div className="section-heading card-heading">
              <div>
                <h2>Acessos ao portal</h2>
                <p>Cada pessoa com a permissão certa.</p>
              </div>
              <span className="count-badge">{team.users.length} usuários</span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Usuário</th>
                    <th>Permissão</th>
                    <th>Médico vinculado</th>
                    <th>Gestão de escala</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {team.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="table-person">
                          <Avatar name={u.name} small />
                          <span>
                            <strong>
                              {u.name} {u.id === user.id && <em>(você)</em>}
                            </strong>
                            <small>{u.email}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className={`role-badge role-${u.role}`}>
                          {u.role === "owner" ? (
                            <LockKeyhole size={12} />
                          ) : (
                            <Shield size={12} />
                          )}{" "}
                          {roleLabels[u.role]}
                        </span>
                      </td>
                      <td>
                        {doctors.find((d) => d.id === u.doctor_id)?.name || "—"}
                      </td>
                      <td><SchedulePermission user={u} onChanged={onChanged} notify={notify}/></td>
                      <td>
                        <span
                          className={`status-pill ${u.active !== false ? "status-success" : "status-muted"}`}
                        >
                          <span />
                          {!isApproved(u)?u.approval_status==="rejected"?"Não aprovado":"Em análise":u.active!==false?"Ativo":"Inativo"}
                        </span>
                      </td>
                      <td>
                        <div className="table-actions">
                          {owner && isApproved(u) && u.role !== "owner" && u.id !== user.id && (
                            <button
                              className="icon-button"
                              title="Editar acesso"
                              aria-label={`Editar acesso de ${u.name}`}
                              onClick={() => setEditUser(u)}
                            >
                              <Pencil size={15} />
                            </button>
                          )}
                          {isApproved(u) && u.role !== "owner" &&
                            (owner || u.role === "doctor") &&
                            u.id !== user.id && (
                              <button
                                className="icon-button"
                                title="Gerar link para redefinir senha"
                                aria-label={`Redefinir senha de ${u.name}`}
                                onClick={() =>
                                  setConfirm({ type: "reset", user: u })
                                }
                              >
                                <RefreshCw size={15} />
                              </button>
                            )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="content-card invites-section">
            <div className="section-heading card-heading">
              <div>
                <h2>Convites enviados</h2>
                <p>
                  Compartilhe o link de acesso diretamente com a pessoa
                  convidada.
                </p>
              </div>
              <button
                className="button button-secondary button-sm"
                onClick={() => setInvite(true)}
              >
                <Plus size={15} />
                Convidar
              </button>
            </div>
            {!team.invites.length ? (
              <Empty
                icon={<Mail size={25} />}
                title="A equipe pode crescer"
                description="Os convites de acesso aparecerão aqui."
              />
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Pessoa convidada</th>
                      <th>Permissão</th>
                      <th>Validade</th>
                      <th>Status</th>
                      <th>
                        <span className="sr-only">Ações</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.invites.map((i) => {
                      const status = i.revoked_at
                        ? "Revogado"
                        : i.accepted_at
                          ? "Aceito"
                          : new Date(i.expires_at) < new Date()
                            ? "Expirado"
                            : "Pendente";
                      return (
                        <tr key={i.id}>
                          <td>
                            <div className="table-person">
                              <span className="invite-avatar">
                                <Mail size={17} />
                              </span>
                              <span>
                                <strong>{i.name}</strong>
                                <small>{i.email}</small>
                              </span>
                            </div>
                          </td>
                          <td>
                            <span className="role-badge">
                              {roleLabels[i.role]}
                            </span>
                          </td>
                          <td>{dayLabel(i.expires_at.slice(0, 10))}</td>
                          <td>
                            <span
                              className={`status-pill ${status === "Pendente" ? "status-warm" : status === "Aceito" ? "status-success" : "status-muted"}`}
                            >
                              <span />
                              {status}
                            </span>
                          </td>
                          <td>
                            {status === "Pendente" &&
                              (owner || i.role === "doctor") && (
                                <button
                                  className="icon-button danger-icon"
                                  aria-label={`Revogar convite de ${i.name}`}
                                  title="Revogar convite"
                                  onClick={() =>
                                    setConfirm({ type: "revoke", invite: i })
                                  }
                                >
                                  <X size={16} />
                                </button>
                              )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
      {editDoctor !== undefined && (
        <DoctorForm
          doctor={editDoctor}
          onClose={() => setEditDoctor(undefined)}
          onSaved={() => {
            onChanged();
            notify(
              editDoctor
                ? "Cadastro atualizado."
                : "Médico cadastrado na equipe.",
            );
          }}
        />
      )}
      {invite && (
        <InviteForm
          doctors={doctors}
          owner={owner}
          onClose={() => setInvite(false)}
          onSaved={(result) => {
            setLink(result);
            setInvite(false);
            onChanged();
          }}
        />
      )}
      {editUser && (
        <UserForm
          user={editUser}
          doctors={doctors}
          onClose={() => setEditUser(null)}
          onSaved={() => {
            onChanged();
            notify("Permissões atualizadas.");
          }}
        />
      )}
      {link && <InviteLink result={link} onClose={() => setLink(null)} />}{" "}
      {confirm?.type === "doctor" && confirm.doctor?.active && (
        <InactivateDoctor
          doctor={confirm.doctor}
          onClose={() => setConfirm(null)}
          onOpenShift={(shift) => {
            setConfirm(null);
            onOpenShift(shift);
          }}
          onDone={() => {
            notify("Cadastro atualizado.");
            onChanged();
          }}
        />
      )}
      {confirm && !(confirm.type === "doctor" && confirm.doctor?.active) && (
        <Confirm
          title={
            confirm.type === "doctor"
              ? confirm.doctor?.active
                ? "Inativar médico?"
                : "Reativar médico?"
              : confirm.type === "reset"
                ? "Gerar novo acesso?"
                : "Revogar este convite?"
          }
          description={
            confirm.type === "doctor"
              ? confirm.doctor?.active
                ? `${confirm.doctor.name} deixará de aparecer nas novas alocações. Os plantões existentes e o histórico serão preservados.`
                : `${confirm.doctor?.name} voltará a aparecer para novas alocações na escala.`
              : confirm.type === "reset"
                ? `Um link pessoal será gerado para ${confirm.user?.name} redefinir a senha. Compartilhe-o diretamente com essa pessoa.`
                : `O link de convite para ${confirm.invite?.email} deixará de funcionar.`
          }
          onClose={() => setConfirm(null)}
          danger={
            confirm.type === "revoke" ||
            (confirm.type === "doctor" && confirm.doctor?.active)
          }
          confirmLabel={
            confirm.type === "doctor"
              ? confirm.doctor?.active
                ? "Inativar médico"
                : "Reativar médico"
              : confirm.type === "reset"
                ? "Gerar link"
                : "Revogar convite"
          }
          onConfirm={async () => {
            if (confirm.type === "doctor") {
              await patch(`/doctors/${confirm.doctor!.id}`, {
                active: !confirm.doctor!.active,
              });
              notify("Cadastro atualizado.");
            } else if (confirm.type === "reset") {
              setLink(
                await post<LinkResult>(`/team/${confirm.user!.id}/reset`),
              );
            } else {
              await post(`/team/invites/${confirm.invite!.id}/revoke`);
              notify("Convite revogado.");
            }
            onChanged();
          }}
        />
      )}
    </>
  );
}
const colors = [
  "#14675E",
  "#3F74A2",
  "#8362AD",
  "#C17B43",
  "#A85366",
  "#6D8244",
  "#497A89",
  "#786E60",
];
function DoctorForm({
  doctor,
  onClose,
  onSaved,
}: {
  doctor: Doctor | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [color, setColor] = useState(doctor?.color || colors[0]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const data = {
      name: String(f.get("name")).trim(),
      crm: String(f.get("crm")).trim() || null,
      crm_uf:String(f.get("crm_uf")||"")||null,
      specialty: String(f.get("specialty")).trim(),
      color,
    };
    try {
      if (doctor) await patch(`/doctors/${doctor.id}`, data);
      else await post("/doctors", data);
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={doctor ? "Editar médico" : "Uma nova pessoa na equipe"}
      subtitle="Informações para identificar o médico na escala."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="Nome completo">
            <input
              name="name"
              defaultValue={doctor?.name}
              required
              minLength={2}
              maxLength={120}
              placeholder="Nome do médico"
            />
          </Field>
          <div className="form-grid">
            <Field label="CRM (opcional)">
              <input
                name="crm"
                defaultValue={doctor?.crm || ""}
                placeholder="12345"
                inputMode="numeric"
                maxLength={40}
              />
            </Field>
            <Field label="UF do CRM"><select name="crm_uf" defaultValue={doctor?.crm_uf||"CE"}>{brazilStates.map(uf=><option key={uf} value={uf}>{uf}</option>)}</select></Field>
            <Field label="Especialidade">
              <input
                name="specialty"
                defaultValue={doctor?.specialty || "Clínica médica"}
                placeholder="Clínica médica"
                maxLength={100}
              />
            </Field>
          </div>
          <div className="field">
            <span>Cor na escala</span>
            <div className="color-picker">
              {colors.map((c) => (
                <button
                  type="button"
                  key={c}
                  style={{ backgroundColor: c }}
                  className={color === c ? "selected" : ""}
                  onClick={() => setColor(c)}
                  aria-label={`Selecionar cor ${c}`}
                  aria-pressed={color === c}
                >
                  {color === c && <Check size={17} />}
                </button>
              ))}
            </div>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </button>
          <Submit busy={busy}>
            {doctor ? "Salvar cadastro" : "Adicionar à equipe"}
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
function InviteForm({
  doctors,
  owner,
  onClose,
  onSaved,
}: {
  doctors: Doctor[];
  owner: boolean;
  onClose: () => void;
  onSaved: (r: LinkResult) => void;
}) {
  const [role, setRole] = useState<"admin" | "doctor">("doctor"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      const result = await post<LinkResult>("/team/invite", {
        name: String(f.get("name")).trim(),
        email: String(f.get("email")).trim(),
        role,
        ...(f.get("doctor_id") ? { doctor_id: f.get("doctor_id") } : {}),
      });
      onSaved(result);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Convide alguém para a equipe"
      subtitle="Gere um acesso pessoal e compartilhe o link."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="Nome completo">
            <input
              name="name"
              placeholder="Nome da pessoa convidada"
              required
              minLength={2}
            />
          </Field>
          <Field label="E-mail">
            <input
              type="email"
              name="email"
              placeholder="pessoa@exemplo.com"
              required
            />
          </Field>
          <Field label="Permissão">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "doctor")}
            >
              <option value="doctor">
                Médico · consultar escala e realizar repasses
              </option>
              {owner && (
                <option value="admin">
                  Administrador · gerenciar escala e equipe
                </option>
              )}
            </select>
          </Field>
          {role === "doctor" && (
            <Field
              label="Vincular ao cadastro médico"
              hint="Selecione um médico cadastrado e sem acesso vinculado. Para adicionar uma pessoa nova, use Novo médico na página Equipe."
            >
              <select name="doctor_id" required>
                <option value="">Selecione um médico da equipe</option>
                {doctors
                  .filter((d) => d.active && !d.user_id)
                  .map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <div className="notice">
            <Link size={17} />
            Nenhum e-mail será enviado automaticamente. O link ficará disponível
            para você copiar e compartilhar.
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </button>
          <Submit busy={busy}>Gerar convite</Submit>
        </div>
      </form>
    </Modal>
  );
}
export function InviteLink({
  result,
  onClose,
}: {
  result: LinkResult;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const url = result.inviteUrl.startsWith("/")
    ? `${window.location.origin}${result.inviteUrl}`
    : result.inviteUrl;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError(
        "Não foi possível copiar automaticamente. Selecione o link abaixo e copie.",
      );
    }
  }
  return (
    <Modal
      title="Tudo pronto para conectar"
      subtitle="Compartilhe este link apenas com a pessoa convidada."
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="invite-success-icon">
          <UserRoundCheck size={30} />
        </div>
        <p className="confirm-description">
          O link é pessoal e permite criar uma nova senha. Validade até{" "}
          {new Date(result.expires_at).toLocaleString("pt-BR", {
            dateStyle: "short",
            timeStyle: "short",
          })}
          .
        </p>
        <Field label="Link de acesso">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Field>
        <button className="button button-primary full-width" onClick={copy}>
          {copied ? <Check size={17} /> : <Copy size={17} />}{" "}
          {copied ? "Link copiado" : "Copiar link de acesso"}
        </button>
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
      <div className="modal-footer">
        <button className="button button-secondary" onClick={onClose}>
          Concluir
        </button>
      </div>
    </Modal>
  );
}
function UserForm({
  user,
  doctors,
  onClose,
  onSaved,
}: {
  user: User;
  doctors: Doctor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [role, setRole] = useState<Role>(user.role);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await patch(`/team/${user.id}`, {
        role,
        active: f.get("active") === "on",
        doctor_id: f.get("doctor_id") || null,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="Editar acesso" subtitle={user.email} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="Permissão">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              <option value="doctor">Médico</option>
              <option value="admin">Administrador</option>
            </select>
          </Field>
          <Field label="Médico vinculado">
            <select
              name="doctor_id"
              required={role === "doctor"}
              defaultValue={user.doctor_id || ""}
            >
              <option value="">Sem vínculo médico</option>
              {doctors
                .filter((d) => !d.user_id || d.user_id === user.id)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </Field>
          <label className="inline-checkbox">
            <input
              type="checkbox"
              name="active"
              defaultChecked={user.active !== false}
            />
            Acesso ativo
          </label>
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
          <Submit busy={busy} />
        </div>
      </form>
    </Modal>
  );
}
