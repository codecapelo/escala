import { PDFDocument, StandardFonts } from "pdf-lib";
import logo from "./pdf-logo.mjs";
// Layout follows the original "ESCALA <MÊS> - <ANO>" PDF: letter pages, one
// heading per day section, morning/afternoon in two columns, night and reinforcement
// in alternating columns, dawn as a single column.
const W = 612,
  H = 792,
  M = 72,
  COL = [72, 324],
  COLW = 240,
  SIZE = 10.5,
  LEAD = 17;
const weekdays = [
  "DOMINGO",
  "SEGUNDA",
  "TERÇA",
  "QUARTA",
  "QUINTA",
  "SEXTA",
  "SÁBADO",
];
const months = [
  "JANEIRO",
  "FEVEREIRO",
  "MARÇO",
  "ABRIL",
  "MAIO",
  "JUNHO",
  "JULHO",
  "AGOSTO",
  "SETEMBRO",
  "OUTUBRO",
  "NOVEMBRO",
  "DEZEMBRO",
];
const byName = (a, b) => a.doctor_name.localeCompare(b.doctor_name, "pt-BR");
export function sectionsFor(shifts) {
  const days = new Map();
  for (const s of shifts) {
    if (!days.has(s.date)) days.set(s.date, []);
    days.get(s.date).push(s);
  }
  return [...days.keys()].sort().flatMap((date) => {
    const list = days.get(date);
    const names = (pred) =>
      list
        .filter(pred)
        .flatMap((s) => s.assignments)
        .sort(byName)
        .map((a) => a.doctor_name);
    const night = (reinforce) => (s) =>
      s.period === "night" && /refor/i.test(s.unit) === reinforce;
    const out = [];
    const dawn = names((s) => s.period === "dawn");
    if (dawn.length)
      out.push({
        date,
        label: "MADRUGADA",
        kind: "single",
        rows: dawn.map((n) => `00 as 07h ${n}`),
      });
    const m = names((s) => s.period === "morning").map((n) => `M ${n}`),
      t = names((s) => s.period === "afternoon").map((n) => `T ${n}`);
    if (m.length || t.length)
      out.push({ date, label: "MT", kind: "split", left: m, right: t });
    for (const [label, flag] of [
      ["NOITE", false],
      ["REFORÇO", true],
    ]) {
      const n = names(night(flag)).map((x) => `N ${x}`);
      if (n.length) out.push({ date, label, kind: "alternate", rows: n });
    }
    return out;
  });
}
export async function schedulePdf(month, shifts, { subtitle } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(
    `AMIL TELEMED ${months[Number(month.slice(5)) - 1]} - ${month.slice(0, 4)}`,
  );
  const font = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = (f, text) =>
    [...String(text)]
      .map((c) => {
        try {
          f.encodeText(c);
          return c;
        } catch {
          return "?";
        }
      })
      .join("");
  const width = (f, text, size) => f.widthOfTextAtSize(clean(f, text), size);
  let page, y;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const text = (t, x, f = font, size = SIZE) =>
    page.drawText(clean(f, t), { x, y, size, font: f });
  const centered = (t, f, size) =>
    page.drawText(clean(f, t), {
      x: (W - width(f, t, size)) / 2,
      y,
      size,
      font: f,
    });
  const wrap = (t, max = COLW) => {
    const words = clean(font, t).split(" "),
      lines = [];
    let cur = "";
    for (const w of words) {
      if (cur && width(font, `${cur} ${w}`, SIZE) > max) {
        lines.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    return [...lines, cur];
  };
  newPage();
  const img = await doc.embedPng(Buffer.from(logo, "base64"));
  page.drawImage(img, { x: (W - 96) / 2, y: y - 96, width: 96, height: 96 });
  y -= 96 + 30;
  centered(
    `ESCALA ${months[Number(month.slice(5)) - 1]} - ${month.slice(0, 4)}`,
    bold,
    15,
  );
  y -= 28;
  centered("Manhã - 07:00 às 13:00 // Tarde - 13:00 às 19:00", bold, 9.5);
  y -= 15;
  centered("Noite - 19:00 às 00:00 // Madrugada - 00:00 às 07:00", bold, 9.5);
  y -= 34;
  if (subtitle) {
    centered(subtitle, bold, 11);
    y -= 26;
  }
  if (!shifts.length) {
    centered("Nenhum plantão neste mês.", font, SIZE);
    y -= 26;
  }
  for (const sec of sectionsFor(shifts)) {
    // Each cell is one name, already wrapped into lines; rows are placed together.
    const cells =
      sec.kind === "split"
        ? [sec.left.map((r) => wrap(r)), sec.right.map((r) => wrap(r))]
        : sec.kind === "single"
          ? [sec.rows.map((r) => wrap(r, W - 2 * M))]
          : [
              sec.rows.filter((_, i) => i % 2 === 0).map((r) => wrap(r)),
              sec.rows.filter((_, i) => i % 2 === 1).map((r) => wrap(r)),
            ];
    const first =
      Math.max(...cells.map((c) => (c[0] ? c[0].length : 0))) * LEAD || LEAD;
    if (y - 2 * LEAD - first < M) newPage();
    const [d, mo, yr] = [
      sec.date.slice(8),
      sec.date.slice(5, 7),
      sec.date.slice(0, 4),
    ];
    const weekday = weekdays[new Date(`${sec.date}T12:00:00Z`).getUTCDay()];
    centered(`${d}/${mo}/${yr} - ${weekday} ${sec.label}`, bold, SIZE);
    y -= 2 * LEAD;
    if (sec.kind === "alternate") {
      // Rows alternate left/right, so advance both columns together.
      const rows = Math.max(cells[0].length, cells[1].length);
      for (let r = 0; r < rows; r++) {
        const lines = Math.max(
          cells[0][r]?.length || 0,
          cells[1][r]?.length || 0,
        );
        if (y - lines * LEAD < M) newPage();
        [0, 1].forEach((c) =>
          (cells[c][r] || []).forEach((l, i) => {
            const yy = y - i * LEAD;
            page.drawText(l, { x: COL[c], y: yy, size: SIZE, font });
          }),
        );
        y -= lines * LEAD;
      }
    } else {
      const maxRows = Math.max(...cells.map((c) => c.length));
      for (let r = 0; r < maxRows; r++) {
        const lines = Math.max(...cells.map((c) => c[r]?.length || 0));
        if (y - lines * LEAD < M) newPage();
        cells.forEach((c, ci) =>
          (c[r] || []).forEach((l, i) =>
            page.drawText(l, { x: COL[ci], y: y - i * LEAD, size: SIZE, font }),
          ),
        );
        y -= lines * LEAD;
      }
    }
    y -= LEAD * 1.4;
  }
  return Buffer.from(await doc.save());
}
