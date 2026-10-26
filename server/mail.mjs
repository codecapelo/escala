// Transactional e-mail through Resend. Never throws: callers decide what a failed send means.
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const mailConfigured = () =>
  !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
export async function sendMail({ to, subject, html, text }) {
  if (!mailConfigured()) return { sent: false, reason: "not_configured" };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [to],
        subject,
        html,
        text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json()).message || "";
      } catch {}
      console.error("Mail error", response.status, detail.slice(0, 200));
      return { sent: false, reason: "provider_error", status: response.status };
    }
    return { sent: true };
  } catch (e) {
    console.error("Mail error", e.name);
    return { sent: false, reason: "network_error" };
  }
}
export function resetEmail({ name, url, minutes }) {
  const first = String(name || "").split(" ")[0] || "";
  const text = `Olá${first ? ", " + first : ""}!\n\nRecebemos um pedido para redefinir a senha do seu acesso à Escala Amil Telemedicina.\n\nCrie uma nova senha neste link (vale por ${minutes} minutos e só pode ser usado uma vez):\n${url}\n\nSe você não pediu isso, ignore esta mensagem; sua senha continua a mesma.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#29412f"><h2 style="color:#147d83">Redefinir sua senha</h2><p>Olá${first ? ", " + escapeHtml(first) : ""}!</p><p>Recebemos um pedido para redefinir a senha do seu acesso à Escala Amil Telemedicina.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#147d83;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Criar nova senha</a></p><p style="font-size:13px;color:#6b7d6e">O link vale por ${minutes} minutos e só pode ser usado uma vez. Se o botão não abrir, copie este endereço:<br>${escapeHtml(url)}</p><p style="font-size:13px;color:#6b7d6e">Se você não pediu isso, ignore esta mensagem; sua senha continua a mesma.</p></div>`;
  return { subject: "Redefinir sua senha · Escala Amil", text, html };
}
