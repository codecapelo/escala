import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPool, transaction } from "../server/db.mjs";
import { audit } from "../server/queries.mjs";
const path = process.argv[2] || "data/import-october.json";
const source = JSON.parse(await readFile(path, "utf8"));
const pool = createPool();
const db = await pool.connect();
try {
  const result = await transaction(db, async () => {
    if (
      (
        await db.query("SELECT sha256 FROM escala.imports WHERE sha256=$1", [
          source.source.sha256,
        ])
      ).rows.length
    )
      return { alreadyImported: true };
    const existing = (
      await db.query(
        "SELECT count(*)::int count FROM escala.shifts WHERE date>=($1||'-01')::date AND date<(($1||'-01')::date+interval '1 month')",
        [source.source.month],
      )
    ).rows[0].count;
    if (existing)
      throw new Error(
        "Month already has shifts; refusing to merge an unreviewed import.",
      );
    const doctorMap = new Map();
    const colors = [
      "#147d83",
      "#6757a6",
      "#a35d32",
      "#3972a6",
      "#9b527b",
      "#58813d",
    ];
    for (const [i, d] of source.doctors.entries()) {
      const { rows } = await db.query(
        "INSERT INTO escala.doctors(name,source_key,color) VALUES($1,$2,$3) ON CONFLICT(source_key) DO UPDATE SET source_key=EXCLUDED.source_key RETURNING id",
        [d.name, source.source.sha256 + ":" + d.id, colors[i % colors.length]],
      );
      doctorMap.set(d.id, rows[0].id);
    }
    const groups = new Map();
    for (const s of source.shifts) {
      const key = [
        s.date,
        s.code,
        s.source.section === "REFORÇO" ? "reforco" : "regular",
      ].join(":");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    let assignments = 0,
      duplicates = 0,
      review = 0;
    const periods = { M: "morning", T: "afternoon", N: "night", D: "dawn" };
    for (const [key, items] of groups) {
      const first = items[0];
      const pages = [...new Set(items.map((s) => s.source.page))].sort(
        (a, b) => a - b,
      );
      const issues = [...new Set(items.flatMap((s) => s.issues))];
      const notes = [];
      if (first.source.section === "REFORÇO")
        notes.push(
          "REFORÇO: horário 19:00–00:00 inferido pela legenda N do PDF. Confirmar com a coordenação.",
        );
      if (issues.some((x) => x.startsWith("duplicate-assignment")))
        notes.push(
          "O PDF repete um nome neste turno. Importada apenas uma participação por médico; original preservado para conferência.",
        );
      if (issues.includes("oct14-night-staffing"))
        notes.push(
          "A fonte contém apenas quatro nomes nesta noite, diferente das outras quartas. Confirmar cobertura.",
        );
      const needsReview = items.some((s) => s.reviewRequired);
      if (needsReview) review++;
      const { rows } = await db.query(
        "INSERT INTO escala.shifts(date,start_time,end_time,period,unit,notes,source,source_key,needs_review) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
        [
          first.date,
          first.startTime,
          first.endTime,
          periods[first.code],
          first.source.section === "REFORÇO"
            ? "Amil • Reforço"
            : "Amil • Telemedicina",
          notes.join("\n"),
          `PDF outubro/2026 • página(s) ${pages.join(", ")} • ${first.source.section}`,
          source.source.sha256 + ":" + key,
          needsReview,
        ],
      );
      const used = new Set();
      for (const item of items) {
        if (used.has(item.doctorId)) {
          duplicates++;
          continue;
        }
        used.add(item.doctorId);
        await db.query(
          "INSERT INTO escala.assignments(shift_id,doctor_id) VALUES($1,$2)",
          [rows[0].id, doctorMap.get(item.doctorId)],
        );
        assignments++;
      }
    }
    const summary = {
      month: source.source.month,
      sourceRows: source.shifts.length,
      doctors: doctorMap.size,
      shiftGroups: groups.size,
      assignments,
      duplicatesExcluded: duplicates,
      shiftsNeedingReview: review,
      timezone: "America/Fortaleza",
      timezoneAssumption: "Fuso da operação adotado; PDF não declara.",
      uncertainties: source.uncertainties.map((i) => ({
        ...i,
        doctorIds: i.doctorIds?.map((id) => doctorMap.get(id)),
        doctorId: i.doctorId ? doctorMap.get(i.doctorId) : undefined,
      })),
    };
    await db.query(
      "INSERT INTO escala.imports(sha256,filename,summary) VALUES($1,$2,$3)",
      [source.source.sha256, source.source.filename, summary],
    );
    await audit(
      db,
      null,
      "pdf_imported",
      `Escala de outubro/2026 importada: ${assignments} participações em ${groups.size} turnos, ${doctorMap.size} cadastros. Cinco linhas duplicadas não foram contadas duas vezes.`,
      summary,
      [],
      source.source.month,
    );
    return summary;
  });
  await mkdir("private", { recursive: true });
  await writeFile(
    "private/import-result.json",
    JSON.stringify(result, null, 2),
  );
  const { uncertainties, ...publicSummary } = result;
  console.log(JSON.stringify(publicSummary, null, 2));
} finally {
  db.release();
  await pool.end();
}
