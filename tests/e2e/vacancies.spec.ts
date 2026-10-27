import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  test,
  expect,
  accounts,
  login,
  nav,
  monthTo,
  shot,
  noOverflow,
  ok,
  nextMonth,
} from "./helpers";
test("vaga reservada, decisão administrativa, notas privadas e exportação individual", async ({
  page,
  browser,
  request,
  fixture,
}, info) => {
  const seed = await ok(request, "POST", "/shifts", {
    date: nextMonth + "-02",
    start_time: "07:00",
    end_time: "13:00",
    period: "morning",
    capacity: 1,
    unit: fixture.tag,
    notes: "Observação exclusiva da administração " + fixture.tag,
    doctor_ids: [],
  });
  const id = seed.shifts[0].id;
  fixture.registerShift(id);
  await page.clock.setFixedTime(new Date("2026-10-26T12:00:00-03:00"));
  await login(page, accounts.doctors[0].email);
  await monthTo(page, nextMonth);
  await page.getByRole("button", { name: "Visualização em lista" }).click();
  const row = page.locator(".shift-list-row").filter({ hasText: fixture.tag });
  await expect(row).toContainText("Faltam 1 médico");
  await row.click();
  const detail = page.getByRole("dialog", { name: "Detalhes do plantão" });
  await expect(detail).toContainText("0 de 1 médicos confirmados");
  await expect(detail).not.toContainText("Observação exclusiva");
  await expect(detail.locator(".notes-block")).toHaveCount(0);
  await detail
    .getByRole("button", { name: "Solicitar para assumir vaga" })
    .click();
  await expect(detail).toContainText("Sua solicitação está pendente");
  await expect(detail).toContainText("0 vaga(s) disponível(is)");
  await expect(detail).toContainText("1 reservada(s)");
  await expect(
    detail.getByRole("button", { name: "Solicitar para assumir vaga" }),
  ).toHaveCount(0);
  await noOverflow(page);
  await shot(page, info.project.name + "-vacancy-physician-pending");
  const current = await ok(page.request, "GET", "/shifts?month=" + nextMonth);
  expect(JSON.stringify(current)).not.toContain("Observação exclusiva");
  const slot = current.shifts.find((s: any) => s.id === id);
  expect(slot.assignments).toHaveLength(0);
  expect(slot.pending_vacancies).toBe(1);
  // A cancellation immediately makes the seat available again.
  await detail.getByRole("button", { name: "Cancelar solicitação" }).click();
  await expect(
    detail.getByRole("button", { name: "Solicitar para assumir vaga" }),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: "Solicitar para assumir vaga" })
    .click();
  await expect(detail).toContainText("Sua solicitação está pendente");
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5273",
    viewport: info.project.use.viewport,
    locale: "pt-BR",
    timezoneId: "America/Fortaleza",
  });
  const admin = await context.newPage();
  try {
    await admin.clock.setFixedTime(new Date("2026-10-26T12:00:00-03:00"));
    await login(admin);
    await monthTo(admin, nextMonth);
    await admin.getByRole("button", { name: "Visualização em lista" }).click();
    await admin
      .locator(".shift-list-row")
      .filter({ hasText: fixture.tag })
      .click();
    const panel = admin.getByRole("dialog", { name: "Detalhes do plantão" });
    await expect(panel).toContainText("Observação exclusiva da administração");
    await expect(panel.locator(".vacancy-request")).toContainText(
      accounts.doctors[0].name,
    );
    await noOverflow(admin);
    await shot(admin, info.project.name + "-vacancy-admin-pending");
    await panel.getByRole("button", { name: "Autorizar", exact: true }).click();
    await expect(panel).toContainText("1 de 1 médicos confirmados");
    await expect(panel).toContainText("Equipe completa");
    await expect(
      panel.getByRole("button", { name: "Autorizar", exact: true }),
    ).toHaveCount(0);
    await shot(admin, info.project.name + "-vacancy-approved");
  } finally {
    await context.close();
  }
  await detail.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.reload();
  await nav(page, "Relatórios");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Exportar meus plantões (PDF)", exact: true })
    .click();
  const pdf = await download;
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  const text = execFileSync("pdftotext", [(await pdf.path())!, "-"], {
    encoding: "utf8",
  });
  expect(text).toContain(accounts.doctors[0].name);
  expect(text).not.toContain(accounts.doctors[1].name);
  expect(text).not.toContain("Observação exclusiva");
  await noOverflow(page);
  await shot(page, info.project.name + "-vacancy-individual-report");
  const csvEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Exportar meus plantões (CSV)", exact: true })
    .click();
  const csv = await readFile((await (await csvEvent).path())!, "utf8");
  expect(csv).toContain(accounts.doctors[0].name);
  expect(csv).not.toContain(accounts.doctors[1].name);
});
