import { readFile } from "node:fs/promises";
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
  seedSyntheticReview,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:00-03:00"));
});

test("escala importada: login, 102 turnos, 1306 alocações, filtros, calendário e teclado", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const path of [
    "/private/local-test-accounts.json",
    "/private/local.env",
    "/data/import-october.json",
    "/docs/pdf-import-audit.md",
    "/@fs/Users/test/escala/private/local-test-accounts.json",
    "/@fs/Users/test/escala/private/local.env",
    "/@fs/Users/test/escala/data/import-october.json",
  ]) {
    const denied = await page.request.get(path);
    expect(denied.status(), path).toBe(403);
  }
  await page.goto("/");
  await noOverflow(page);
  await shot(page, `${info.project.name}-login`);
  await login(page);
  await monthTo(page, "2026-10");
  const d = await ok(page.request, "GET", "/dashboard?month=2026-10");
  expect(d.shifts).toHaveLength(102);
  expect(
    d.shifts.reduce((n: number, s: any) => n + s.assignments.length, 0),
  ).toBe(1306);
  await expect(page.locator(".filter-count")).toHaveText("102 plantões");
  await page.getByRole("button", { name: "Visualização em lista" }).click();
  await expect(page.locator(".shift-list-row")).toHaveCount(102);
  await page
    .getByLabel("Filtrar por médico")
    .selectOption(accounts.doctors[0].id);
  const count = d.shifts.filter((s: any) =>
    s.assignments.some((a: any) => a.doctor_id === accounts.doctors[0].id),
  ).length;
  await expect(page.locator(".shift-list-row")).toHaveCount(count);
  await page.getByRole("button", { name: "Manhã", exact: true }).click();
  await expect(
    page.locator(".shift-list-row .period-badge:not(.morning)"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Limpar", exact: true }).click();
  await page
    .getByRole("button", { name: "Visualização em calendário" })
    .click();
  await expect(page.getByRole("grid")).toBeVisible();
  await noOverflow(page);
  await shot(page, `${info.project.name}-calendar`);
  await page.getByRole("button", { name: "Novo plantão", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Fechar janela" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Criar plantão", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Fechar janela" }),
  ).toBeFocused();
  await noOverflow(page);
  await shot(page, `${info.project.name}-shift-form`);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Novo plantão", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Próximo mês", exact: true }).click();
  await expect(page.locator(".month-control")).toContainText(
    "novembro de 2026",
  );
  await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
  expect(errors).toEqual([]);
});

test("relatório de outubro, exportação CSV e perfil sem expor senha", async ({
  page,
}, info) => {
  await login(page);
  await monthTo(page, "2026-10");
  await nav(page, "Relatórios");
  await expect(
    page.getByRole("heading", { name: "O mês, em perspectiva." }),
  ).toBeVisible();
  const report = await ok(page.request, "GET", "/reports?month=2026-10");
  expect(report.totals.assignments).toBe(1306);
  expect(report.totals.shifts).toBe(102);
  await expect(page.locator(".reports-stats .stat-value").nth(2)).toHaveText(
    "1306",
  );
  await page
    .getByLabel("Buscar médico no relatório")
    .fill(accounts.doctors[0].name);
  await expect(page.locator(".report-table tbody > tr")).toHaveCount(1);
  await page
    .getByRole("button", {
      name: `Ver plantões de ${accounts.doctors[0].name}`,
    })
    .click();
  await expect(page.locator(".report-expanded")).toBeVisible();
  await noOverflow(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("escala-amil-2026-10.csv");
  const csv = await readFile((await file.path())!, "utf8");
  expect(csv).toContain("Médico");
  expect(csv).toContain(accounts.doctors[0].name);
  expect(csv.split(/\r?\n/).length).toBeGreaterThan(80);
  await shot(page, `${info.project.name}-reports`);
  await page.getByRole("button", { name: /Abrir perfil de / }).click();
  const profile = page.getByRole("dialog", { name: "Seu perfil" });
  await expect(profile).toContainText(accounts.owner.email);
  await profile.getByRole("button", { name: /Alterar minha senha/ }).click();
  await profile
    .getByLabel("Senha atual", { exact: true })
    .fill("Senha-teste-errada");
  await profile
    .getByLabel("Nova senha", { exact: false })
    .first()
    .fill("Teste-nova-senha-2026!");
  await profile
    .getByLabel("Confirme a nova senha")
    .fill("Senhas-diferentes-2026!");
  await profile.getByRole("button", { name: "Atualizar senha" }).click();
  await expect(profile.getByRole("alert")).toContainText(
    "As senhas não coincidem",
  );
  await noOverflow(page);
  await page.keyboard.press("Escape");
});

test("criar plantão repetido, editar, remover e adicionar médico com auditoria", async ({
  page,
  fixture,
}, info) => {
  await login(page);
  await monthTo(page, nextMonth);
  await page.getByRole("button", { name: "Novo plantão", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Um novo plantão" });
  await form.getByLabel("Data do plantão").fill(nextMonth + "-03");
  await form.getByLabel("Unidade / atendimento").fill(fixture.tag);
  await form.getByLabel("Buscar médico para plantão").fill(fixture.doctor.name);
  await form
    .getByRole("checkbox", { name: new RegExp(fixture.doctor.name) })
    .check();
  await form.getByRole("switch").check();
  await form.getByLabel("Repetir até").fill(nextMonth + "-10");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/shifts") && r.request().method() === "POST",
  );
  await form.getByRole("button", { name: "Criar 2 plantões" }).click();
  const body = await (await created).json();
  expect(body.shifts).toHaveLength(2);
  body.shifts.forEach((s: any) => fixture.registerShift(s.id));
  await expect(form).toHaveCount(0);
  await page.getByRole("button", { name: "Visualização em lista" }).click();
  const row = page
    .locator(".shift-list-row")
    .filter({ hasText: fixture.tag })
    .first();
  await row.click();
  let detail = page.getByRole("dialog", { name: "Detalhes do plantão" });
  await expect(detail).toContainText(fixture.doctor.name);
  await detail.getByRole("button", { name: "Editar plantão" }).click();
  const edit = page.getByRole("dialog", { name: "Editar plantão" });
  await edit
    .getByLabel("Observações (opcional)")
    .fill("Observação de verificação E2E " + fixture.tag);
  await edit.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(edit).toHaveCount(0);
  await row.click();
  detail = page.getByRole("dialog", { name: "Detalhes do plantão" });
  await expect(detail).toContainText("Observação de verificação E2E");
  await detail
    .getByRole("button", { name: `Remover ${fixture.doctor.name} do plantão` })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Remover médico do plantão?",
  });
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(detail).toBeVisible();
  await detail
    .getByRole("button", { name: `Remover ${fixture.doctor.name} do plantão` })
    .click();
  await page
    .getByRole("dialog", { name: "Remover médico do plantão?" })
    .getByLabel("Motivo")
    .fill("Correção de teste " + fixture.tag);
  await page
    .getByRole("button", { name: "Remover médico", exact: true })
    .click();
  await expect(detail).toContainText("Equipe a definir");
  await detail.getByRole("button", { name: "Adicionar", exact: true }).click();
  await detail.getByLabel("Médico a adicionar").selectOption(fixture.other.id);
  await detail
    .locator("form.inline-add")
    .getByRole("button", { name: "Adicionar", exact: true })
    .click();
  await expect(detail).toContainText(fixture.other.name);
  await noOverflow(page);
  await shot(page, `${info.project.name}-shift-detail`);
  await page.keyboard.press("Escape");
  await nav(page, "Histórico");
  await page.getByLabel("Buscar no histórico").fill(fixture.tag);
  await expect(page.locator(".audit-item")).not.toHaveCount(0);
  await expect(page.locator(".audit-list")).toContainText("Correção de teste");
});

test("repasse real entre dois médicos e histórico de origem e destino", async ({
  page,
  browser,
  fixture,
  request,
}, info) => {
  const doctors = accounts.doctors;
  const seed = await ok(request, "POST", "/shifts", {
    date: nextMonth + "-17",
    start_time: "13:00",
    end_time: "19:00",
    period: "afternoon",
    unit: fixture.tag,
    doctor_ids: [doctors[0].id],
  });
  fixture.registerShift(seed.shifts[0].id);
  await login(page, doctors[0].email);
  await monthTo(page, nextMonth);
  await page.getByRole("button", { name: "Visualização em lista" }).click();
  await page
    .locator(".shift-list-row")
    .filter({ hasText: fixture.tag })
    .click();
  const detail = page.getByRole("dialog", { name: "Detalhes do plantão" });
  await detail.getByRole("button", { name: "Ofertar", exact: true }).click();
  const offer = page.getByRole("dialog", { name: "Disponibilizar repasse" });
  await offer.getByLabel("Mensagem para a equipe (opcional)").fill(fixture.tag);
  await offer.getByRole("button", { name: "Disponibilizar plantão" }).click();
  await expect(offer).toHaveCount(0);
  await nav(page, "Repasses");
  await expect(
    page.locator(".offer-card").filter({ hasText: fixture.tag }),
  ).toContainText("Você está oferecendo");
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5273",
    viewport: info.project.use.viewport,
    locale: "pt-BR",
    timezoneId: "America/Fortaleza",
  });
  const target = await context.newPage();
  try {
    await target.clock.setFixedTime(new Date("2026-10-24T12:00:00-03:00"));
    await login(target, doctors[1].email);
    await monthTo(target, nextMonth);
    await nav(target, "Repasses");
    await target
      .locator(".offer-card")
      .filter({ hasText: fixture.tag })
      .getByRole("button", { name: "Assumir plantão" })
      .click();
    await target
      .getByRole("dialog", { name: "Assumir este plantão?" })
      .getByRole("button", { name: "Confirmar e assumir" })
      .click();
    await expect(target.getByRole("dialog")).toHaveCount(0);
    await target
      .getByRole("button", { name: "Assumidos", exact: true })
      .click();
    const accepted = target
      .locator(".offer-card")
      .filter({ hasText: fixture.tag });
    await expect(accepted).toContainText(doctors[0].name);
    await expect(accepted).toContainText(doctors[1].name);
    await noOverflow(target);
    await shot(target, `${info.project.name}-accepted-offer`);
    await nav(target, "Histórico");
    await expect(target.locator(".audit-list")).toContainText(doctors[0].name);
    await expect(target.locator(".audit-list")).toContainText(doctors[1].name);
    const live = await ok(target.request, "GET", `/shifts?month=${nextMonth}`);
    const transferred = live.shifts.find(
      (s: any) => s.id === seed.shifts[0].id,
    );
    expect(transferred.assignments[0].doctor_id).toBe(doctors[1].id);
  } finally {
    await context.close();
  }
});

test("convite via interface, ativação única e senha escolhida no formulário", async ({
  page,
  browser,
  fixture,
}, info) => {
  await login(page);
  await nav(page, "Equipe");
  await page.getByRole("button", { name: "Convidar usuário" }).click();
  const invite = page.getByRole("dialog", {
    name: "Convide alguém para a equipe",
  });
  const email = fixture.tag.toLowerCase() + "@teste.local";
  await invite
    .getByLabel("Nome completo", { exact: true })
    .fill(fixture.doctor.name);
  await invite.getByLabel("E-mail", { exact: true }).fill(email);
  await invite
    .getByLabel("Vincular ao cadastro médico", { exact: false })
    .selectOption(fixture.doctor.id);
  await invite.getByRole("button", { name: "Gerar convite" }).click();
  const link = page.getByRole("dialog", { name: "Tudo pronto para conectar" });
  const url = new URL(await link.getByLabel("Link de acesso").inputValue());
  await link.getByRole("button", { name: "Concluir" }).click();
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5273",
    viewport: info.project.use.viewport,
    locale: "pt-BR",
    timezoneId: "America/Fortaleza",
  });
  const activated = await context.newPage();
  const password = "SenhaE2E-ativacao-" + Date.now();
  try {
    await activated.goto(url.pathname + url.search);
    await activated
      .getByLabel("Seu nome completo", { exact: true })
      .fill(fixture.doctor.name);
    await activated
      .getByLabel("Crie sua senha", { exact: false })
      .fill(password);
    await activated.getByRole("button", { name: "Ativar meu acesso" }).click();
    await expect(
      activated.getByRole("heading", { name: "A sua equipe, em sintonia." }),
    ).toBeVisible();
    await noOverflow(activated);
    await activated.getByRole("button", { name: /Abrir perfil de / }).click();
    await expect(
      activated.getByRole("dialog", { name: "Seu perfil" }),
    ).toContainText(email);
    await shot(activated, `${info.project.name}-activated-profile`);
    await activated.getByRole("button", { name: /Sair do portal/ }).click();
    await expect(
      activated.getByRole("button", { name: "Entrar na minha escala" }),
    ).toBeVisible();
    await activated.goto(url.pathname + url.search);
    await activated
      .getByLabel("Seu nome completo", { exact: true })
      .fill(fixture.doctor.name);
    await activated
      .getByLabel("Crie sua senha", { exact: false })
      .fill(password);
    await activated.getByRole("button", { name: "Ativar meu acesso" }).click();
    await expect(activated.getByRole("alert")).toContainText(
      "Convite inválido ou expirado",
    );
  } finally {
    await context.close();
  }
});

test("rotas e revisão de PDF em desktop e celular sem overflow global", async ({
  page,
}, info) => {
  await login(page);
  for (const label of ["Equipe", "Relatórios", "Histórico", "Repasses"]) {
    await nav(page, label);
    await noOverflow(page);
  }
  await nav(page, "Equipe");
  await page.getByRole("button", { name: /Conferência do PDF/ }).click();
  await expect(
    page.getByRole("heading", { name: "Dados fiéis. Decisões humanas." }),
  ).toBeVisible();
  const review = await ok(page.request, "GET", "/imports/review");
  expect(review.counts.total).toBeGreaterThanOrEqual(13);
  await expect(page.locator(".review-issue")).toHaveCount(
    review.counts.pending,
  );
  await noOverflow(page);
  await shot(page, `${info.project.name}-pdf-review`);
  await page.getByRole("button", { name: "Documento de origem" }).click();
  await expect(page.locator(".review-sources")).toContainText("SHA-256");
  await noOverflow(page);
  await page
    .locator(".review-issue")
    .first()
    .getByRole("button", { name: "Registrar conferência" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Registrar conferência" }),
  ).toBeVisible();
  await noOverflow(page);
  await page.keyboard.press("Escape");
  // Do not resolve source uncertainties or merge real physicians in an automated test.
});

test("consolidar cadastros fictícios e registrar conferência persistente pela interface", async ({
  page,
  request,
  fixture,
}, info) => {
  const issueId = await seedSyntheticReview(
    fixture.tag,
    [fixture.doctor.id, fixture.other.id],
    [fixture.doctor.name, fixture.other.name],
  );
  for (const day of ["12", "13"]) {
    const r = await ok(request, "POST", "/shifts", {
      date: nextMonth + "-" + day,
      start_time: "07:00",
      end_time: "13:00",
      period: "morning",
      unit: fixture.tag,
      doctor_ids:
        day === "12"
          ? [fixture.doctor.id, fixture.other.id]
          : [fixture.doctor.id],
    });
    fixture.registerShift(r.shifts[0].id);
  }
  await login(page);
  await nav(page, "Equipe");
  await page.getByRole("button", { name: /Conferência do PDF/ }).click();
  let issue = page.locator(".review-issue").filter({ hasText: fixture.tag });
  await issue.getByRole("button", { name: "Consolidar cadastro" }).click();
  const merge = page.getByRole("dialog", {
    name: "Consolidar a mesma identidade",
  });
  await expect(merge.getByLabel("Cadastro que será inativado")).toHaveValue(
    fixture.doctor.id,
  );
  await expect(merge.getByLabel("Cadastro que permanecerá ativo")).toHaveValue(
    fixture.other.id,
  );
  await merge
    .getByLabel("Como a identidade foi confirmada?")
    .fill("Teste de identidade fictícia " + fixture.tag);
  await merge.getByRole("checkbox", { name: /Conferi os cadastros/ }).check();
  await noOverflow(page);
  await shot(page, `${info.project.name}-merge-form`);
  await merge.getByRole("button", { name: "Confirmar consolidação" }).click();
  await expect(merge).toHaveCount(0);
  await expect(issue).toContainText("Consolidado em");
  await issue.getByRole("button", { name: "Registrar conferência" }).click();
  const resolve = page.getByRole("dialog", { name: "Registrar conferência" });
  const decision = "Conferência sintética validada no teste " + fixture.tag;
  await resolve
    .getByLabel("Decisão da coordenação", { exact: false })
    .fill(decision);
  await resolve.getByRole("button", { name: "Salvar conferência" }).click();
  await expect(resolve).toHaveCount(0);
  await page.getByRole("button", { name: /^Conferidas/ }).click();
  issue = page.locator(".review-issue").filter({ hasText: fixture.tag });
  await expect(issue).toContainText(decision);
  await noOverflow(page);
  await shot(page, `${info.project.name}-review-resolved`);
  const review = await ok(request, "GET", "/imports/review");
  expect(review.issues.find((i: any) => i.id === issueId).resolved).toBe(true);
  expect(
    review.doctors.find((d: any) => d.id === fixture.doctor.id).merged_into_id,
  ).toBe(fixture.other.id);
  const report = await ok(request, "GET", `/reports?month=${nextMonth}`);
  expect(
    report.rows.find((r: any) => r.doctor_id === fixture.other.id).turns,
  ).toBe(2);
  expect(
    report.rows.find((r: any) => r.doctor_id === fixture.doctor.id).turns,
  ).toBe(0);
});
