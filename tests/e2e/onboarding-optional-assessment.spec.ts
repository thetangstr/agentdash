import { test, expect } from "@playwright/test";
import { resolveE2eServerPort } from "./e2e-port";

/**
 * E2E (GH #785, UX-4): the five-question assessment is optional.
 *
 * - naming a new workspace at /company-create goes straight to setup (/setup)
 *   and never through /assess;
 * - the assessment is still reachable later: Settings → Advanced links to it,
 *   and /assess opens for the workspace.
 *
 * The e2e instance's board user may already belong to workspaces made by other
 * specs, which would make /company-create answer 409 (and route to /cos for a
 * different reason). The request is continued without `fromSignup` so a real
 * workspace is created and the success path is the one under test.
 */

const PORT = resolveE2eServerPort(3399);
const BASE_URL = `http://127.0.0.1:${PORT}`;

test("a new workspace goes from /company-create to setup without the assessment", async ({ page, request }) => {
  const name = `E2E-NoAssess-${Date.now()}`;
  const visited: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  await page.route("**/api/companies?*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST" && url.searchParams.has("fromSignup")) {
      url.searchParams.delete("fromSignup");
      await route.continue({ url: url.toString() });
      return;
    }
    await route.continue();
  });

  await page.goto(`${BASE_URL}/company-create`);
  await page.getByLabel("Workspace name").fill(name);
  const created = page.waitForResponse(
    (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/companies",
  );
  await page.getByRole("button", { name: "Continue" }).click();
  expect((await created).status()).toBe(201);

  // GH #786: setup is now the first run at /setup.
  await expect(page).toHaveURL(/\/setup(\?|$)/);
  expect(visited.some((path) => path.startsWith("/assess"))).toBe(false);

  const companies = (await (await request.get(`${BASE_URL}/api/companies`)).json()) as Array<{
    id: string;
    name: string;
    issuePrefix: string;
  }>;
  const company = companies.find((candidate) => candidate.name === name);
  expect(company).toBeTruthy();

  // Later: Settings → Advanced offers the assessment, and it opens.
  await page.goto(`${BASE_URL}/${company!.issuePrefix}/company/settings`);
  const advanced = page.getByTestId("company-settings-advanced-section");
  await expect(advanced).toContainText("Readiness assessment");
  await advanced.getByRole("link", { name: "Run the assessment" }).click();
  await expect(page).toHaveURL(/\/assess$/);
  // A full page load of the marketing-shell page; give it room on a busy runner.
  await expect(page.getByRole("heading", { name: /How would you like to assess/ })).toBeVisible({ timeout: 20_000 });
});
