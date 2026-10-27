import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
export async function schedulePdf(shifts, month, user) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(
    `Escala Amil - ${month}${user.role === "doctor" ? " - " + user.name : ""}`,
  );
  let page, y;
  const W = 595.28,
    H = 841.89,
    margin = 42;
  function newPage() {
    page = pdf.addPage([W, H]);
    y = H - margin;
  }
  function line(
    text,
    { size = 10, strong = false, color = rgb(0.15, 0.25, 0.2), gap = 5 } = {},
  ) {
    const f = strong ? bold : font;
    const words = String(text)
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/[^\x20-\x7e\xa0-\xff]/g, " ")
      .split(/\s+/);
    let out = "";
    const draw = () => {
      if (y < margin + size) newPage();
      page.drawText(out, { x: margin, y, size, font: f, color });
      y -= size + gap;
    };
    for (const word of words) {
      const next = out ? out + " " + word : word;
      if (f.widthOfTextAtSize(next, size) > W - 2 * margin && out) {
        draw();
        out = word;
      } else out = next;
    }
    if (out) draw();
  }
  newPage();
  line("AMIL | ESCALA MÉDICA", { size: 20, strong: true });
  line(
    `Mês: ${month.split("-").reverse().join("/")} | ${user.role === "doctor" ? "Escala individual" : "Escala geral"}`,
    { size: 12 },
  );
  if (user.role === "doctor") line(user.name, { size: 13, strong: true });
  line(
    "Horários em America/Fortaleza. Escala vigente no momento da exportação.",
    { size: 9 },
  );
  y -= 12;
  const visible =
    user.role === "doctor"
      ? shifts
          .filter((s) =>
            s.assignments.some((a) => a.doctor_id === user.doctor_id),
          )
          .map((s) => ({
            ...s,
            assignments: s.assignments.filter(
              (a) => a.doctor_id === user.doctor_id,
            ),
          }))
      : shifts;
  if (!visible.length) line("Nenhum plantão neste mês.");
  const periods = {
    morning: "Manhã",
    afternoon: "Tarde",
    night: "Noite / reforço",
    dawn: "Madrugada",
  };
  for (const s of visible) {
    if (y < 115) newPage();
    line(
      `${s.date.split("-").reverse().join("/")} | ${periods[s.period]} | ${s.start_time} - ${s.end_time}`,
      { strong: true, size: 11 },
    );
    line(s.unit, { size: 9 });
    if (user.role !== "doctor")
      line(
        `${s.assignments.length} alocados${s.capacity !== null && s.capacity !== undefined ? ` / ${s.capacity} necessários | ${s.available_vacancies ?? 0} disponíveis | ${s.pending_vacancies ?? 0} pendentes` : ""}`,
        { size: 9 },
      );
    line(
      s.assignments.map((a) => a.doctor_name).join("; ") || "Equipe a definir",
      { size: 10 },
    );
    y -= 12;
  }
  const pages = pdf.getPages();
  for (const [i, p] of pages.entries())
    p.drawText(`${i + 1} / ${pages.length}`, {
      x: W - margin - 40,
      y: 22,
      font,
      size: 8,
      color: rgb(0.4, 0.4, 0.4),
    });
  return Buffer.from(await pdf.save());
}
