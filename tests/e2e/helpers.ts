import {
  test as base,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { parseEnv } from "node:util";
const environment = parseEnv(readFileSync("private/local.env", "utf8"));
if (
  !environment.DATABASE_URL ||
  !["127.0.0.1", "localhost", "[::1]"].includes(
    new URL(environment.DATABASE_URL).hostname,
  )
)
  throw new Error("Refusing nonlocal database for E2E.");
export const accounts = JSON.parse(
  readFileSync("private/local-test-accounts.json", "utf8"),
);
export const importedMonth = "2026-10";
export const nextMonth = "2026-11";
export async function login(
  page: Page,
  email = accounts.owner.email,
  password = accounts.password,
) {
  await page.goto("/");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar na minha escala" }).click();
  await expect(
    page.getByRole("heading", { name: "A sua equipe, em sintonia." }),
  ).toBeVisible();
}
export async function nav(page: Page, label: string) {
  const mobile = await page.locator(".bottom-nav").isVisible();
  await page
    .getByRole("navigation", {
      name: mobile ? "Navegação móvel" : "Navegação principal",
    })
    .getByRole("button", { name: new RegExp("^" + label + "(?:\\s*\\d+)?$") })
    .click();
}
export async function monthTo(page: Page, target: string) {
  const months = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  for (let n = 0; n < 24; n++) {
    const value = (await page.locator(".month-control").first().innerText())
      .trim()
      .toLowerCase();
    const expected =
      months[Number(target.slice(5)) - 1] + " de " + target.slice(0, 4);
    if (value === expected) return;
    const match = months.findIndex((m) => value.startsWith(m));
    const year = Number(value.match(/20\d{2}/)?.[0]);
    if (match < 0 || !year)
      throw new Error("Unexpected month control: " + value);
    const direction =
      year * 12 + match <
      Number(target.slice(0, 4)) * 12 + Number(target.slice(5)) - 1
        ? "Próximo mês"
        : "Mês anterior";
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/dashboard?month=") && r.ok(),
      ),
      page
        .getByRole("button", { name: direction, exact: true })
        .first()
        .click(),
    ]);
  }
  throw new Error("Target month too distant: " + target);
}
export async function shot(page: Page, name: string) {
  mkdirSync("private/screenshots", { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  const dialog = page.getByRole("dialog").last();
  const hasDialog = (await dialog.count()) > 0;
  if (hasDialog)
    await dialog.evaluate((el) => {
      el.scrollTop = 0;
    });
  const mobile = (page.viewportSize()?.width || 0) <= 800;
  if (mobile && !hasDialog) {
    const selector = name.endsWith("-calendar")
      ? ".schedule-card"
      : name.endsWith("-pdf-review")
        ? ".review-intro"
        : name.endsWith("-accepted-offer")
          ? ".offer-cards"
          : name.endsWith("-review-resolved")
            ? ".review-issues"
            : null;
    if (selector)
      await page
        .locator(selector)
        .first()
        .evaluate((el) =>
          window.scrollTo(
            0,
            Math.max(0, el.getBoundingClientRect().top + window.scrollY - 76),
          ),
        );
  }
  await page.screenshot({
    animations: "disabled",
    path: `private/screenshots/${name}.png`,
    fullPage: !hasDialog && !mobile,
  });
}
export async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
}
export async function ok(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown,
) {
  const r = await request.fetch("/api" + path, { method, data });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
}
export const test = base.extend<{
  fixture: {
    tag: string;
    doctor: any;
    other: any;
    createdShifts: Set<string>;
    registerShift: (id: string) => void;
  };
}>({
  fixture: async ({ request }, use) => {
    await ok(request, "POST", "/auth/login", {
      email: accounts.owner.email,
      password: accounts.password,
    });
    const tag = `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const doctor = (
      await ok(request, "POST", "/doctors", {
        name: tag + " Origem",
        specialty: "Teste E2E",
      })
    ).doctor;
    const other = (
      await ok(request, "POST", "/doctors", {
        name: tag + " Destino",
        specialty: "Teste E2E",
      })
    ).doctor;
    const createdShifts = new Set<string>();
    try {
      await use({
        tag,
        doctor,
        other,
        createdShifts,
        registerShift: (id) => createdShifts.add(id),
      });
    } finally {
      // Logical cleanup only: preserve every test audit and original PDF record.
      const dashboard = await ok(
        request,
        "GET",
        `/dashboard?month=${nextMonth}`,
      );
      for (const s of dashboard.shifts)
        if (s.unit?.includes(tag) || createdShifts.has(s.id))
          await request.delete(`/api/shifts/${s.id}`, {
            data: { reason: "Encerramento de teste E2E " + tag },
          });
      const team = await ok(request, "GET", "/team");
      for (const invite of team.invites)
        if (
          invite.email?.includes(tag.toLowerCase()) &&
          !invite.accepted_at &&
          !invite.revoked_at
        )
          await request.post(`/api/team/invites/${invite.id}/revoke`, {
            data: {},
          });
      for (const user of team.users)
        if ([doctor.id, other.id].includes(user.doctor_id))
          await request.patch(`/api/team/${user.id}`, {
            data: { active: false },
          });
      for (const d of [doctor, other])
        await request.patch(`/api/doctors/${d.id}`, {
          data: { active: false },
        });
    }
  },
});
export { expect };
export async function seedSyntheticReview(
  tag: string,
  doctorIds: string[],
  names: string[],
) {
  const { createHash } = await import("node:crypto");
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: environment.DATABASE_URL });
  await db.connect();
  const sha = createHash("sha256").update(tag).digest("hex");
  try {
    await db.query(
      "INSERT INTO escala.imports(sha256,filename,summary) VALUES($1,$2,$3)",
      [
        sha,
        tag + "-fixture.pdf",
        {
          fixture: true,
          uncertainties: [
            {
              id: "e2e-name-alias",
              type: "possible-name-alias",
              description:
                "Pendência sintética de identidade para teste local " + tag,
              doctorIds,
              sourceNames: names,
              requiresHumanReview: true,
            },
          ],
        },
      ],
    );
  } finally {
    await db.end();
  }
  return sha + ":e2e-name-alias";
}
