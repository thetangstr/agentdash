import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * E2E (Scan 3, lane J): onboarding, navigation and plain language.
 *
 *  - A direct load of /:prefix/onboarding opens on the agent step for that
 *    company, never on "Name your company"; Close leaves the page; nothing
 *    creates a second company.
 *  - "Hire a new agent" keeps the technical settings under a collapsed
 *    Advanced section and asks for what the agent should do.
 *  - Page headers match the sidebar: Team, Work.
 *  - The New Issue dialog starts on Backlog while "Start new issues right
 *    away" is off (the default).
 *  - /company-create shows the AgentDash mark.
 */

async function createCompany(request: APIRequestContext, name: string) {
  const res = await request.post("/api/companies", { data: { name } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; issuePrefix: string; name: string };
}

async function companyCount(request: APIRequestContext) {
  const res = await request.get("/api/companies");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as unknown[]).length;
}

test("a direct load of /:prefix/onboarding opens on the agent step and Close leaves it", async ({ page, request }) => {
  const company = await createCompany(request, `E2E-LaneJ-${Date.now()}`);
  const before = await companyCount(request);

  await page.goto(`/${company.issuePrefix}/onboarding`);
  await expect(page.locator("h3", { hasText: /Create your first agent|Add an agent/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("h3", { hasText: "Name your company" })).toHaveCount(0);
  // The Company tab is not a step to go back to once the company exists.
  await expect(page.getByRole("button", { name: "Company", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/dashboard$`));
  await expect(page.locator("h3", { hasText: /Create your first agent|Add an agent/ })).toHaveCount(0);

  // The unprefixed deep link also lands on the agent step, not company creation.
  await page.goto("/onboarding");
  await expect(page.locator("h3", { hasText: /Create your first agent|Add an agent/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("h3", { hasText: "Name your company" })).toHaveCount(0);

  expect(await companyCount(request)).toBe(before);
});

test("Hire a new agent shows plain fields first and hides the technical ones under Advanced", async ({ page, request }) => {
  const company = await createCompany(request, `E2E-LaneJ-Hire-${Date.now()}`);
  await page.goto(`/${company.issuePrefix}/agents/new`);
  await expect(page.getByRole("heading", { name: "Hire a new agent" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("What it should do")).toBeVisible();
  const advanced = page.getByTestId("new-agent-advanced");
  await expect(advanced).not.toHaveAttribute("open", "");
  await expect(page.getByText("Skip permissions", { exact: false })).toBeHidden();
  await advanced.locator("summary").click();
  await expect(advanced).toHaveAttribute("open", "");
});

test("page headers match the sidebar names", async ({ page, request }) => {
  const company = await createCompany(request, `E2E-LaneJ-Headers-${Date.now()}`);
  await page.goto(`/${company.issuePrefix}/agents/all`);
  await expect(page.locator("h1", { hasText: /^Team$/ })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/${company.issuePrefix}/issues`);
  await expect(page.locator("h1", { hasText: /^Work$/ })).toBeVisible({ timeout: 30_000 });
});

test("New Issue starts on Backlog while new issues do not start right away", async ({ page, request }) => {
  const company = await createCompany(request, `E2E-LaneJ-Status-${Date.now()}`);
  await page.goto(`/${company.issuePrefix}/issues`);
  await expect(page.locator("h1", { hasText: /^Work$/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New Issue" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Backlog$/ })).toBeVisible();
});

test("/company-create shows the AgentDash mark, not a sparkle", async ({ page }) => {
  await page.goto("/company-create?another=1");
  await expect(page.getByRole("heading", { name: "Name your workspace" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("svg.lucide-sparkles")).toHaveCount(0);
});
