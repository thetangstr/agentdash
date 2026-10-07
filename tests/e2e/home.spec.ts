/**
 * E2E: UX-3 (#784) — the honest Home.
 *
 * Seeds an issue assigned to the signed-in person (local_trusted: local-board),
 * opens Home, sends the tab to the background by opening another page, comes
 * back, and asserts that Waiting on you still shows the real count, that the
 * count equals its rows, and that it equals the pending-decisions route the
 * assistant's list_pending_decisions reads.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resolveE2eServerPort } from "./e2e-port";

const PORT = resolveE2eServerPort(3399);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function ensureCompany(request: APIRequestContext) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Home-${Date.now()}` },
  });
  if (created.ok()) return (await created.json()) as { id: string; issuePrefix: string };
  const list = await request.get(`${BASE_URL}/api/companies`);
  expect(list.ok()).toBe(true);
  const companies = (await list.json()) as Array<{ id: string; issuePrefix: string }>;
  expect(companies.length).toBeGreaterThan(0);
  return companies[0]!;
}

test.describe("Home (UX-3)", () => {
  test("Waiting on you includes issues assigned to you and survives a background tab", async ({ page, context, request }) => {
    const company = await ensureCompany(request);
    const title = `Decide the launch date ${Date.now()}`;
    const issueRes = await request.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: { title, status: "todo", assigneeUserId: "local-board" },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);

    const pendingRes = await request.get(`${BASE_URL}/api/companies/${company.id}/assistant/pending-decisions`);
    expect(pendingRes.ok()).toBe(true);
    const pending = (await pendingRes.json()) as { total: number; tasksAssignedToYouTotal: number };
    const expected = pending.total + pending.tasksAssignedToYouTotal;
    expect(expected).toBeGreaterThan(0);

    await page.goto(`${BASE_URL}/${company.issuePrefix}/dashboard`);
    const waiting = page.getByTestId("home-waiting");
    await expect(waiting).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("home-waiting-count")).toHaveText(String(expected));
    await expect(waiting).toContainText(title);
    await expect(page.getByTestId("home-greeting")).not.toContainText("board");

    // Send Home to the background, then come back.
    const other = await context.newPage();
    await other.goto(`${BASE_URL}/api/health`);
    await other.bringToFront();
    await page.waitForTimeout(2_500);
    await page.bringToFront();
    await other.close();

    await expect(page.getByTestId("home-waiting-count")).toHaveText(String(expected));
    const shownRows = await page.getByTestId("home-waiting-row").count();
    const moreText = (await waiting.textContent()) ?? "";
    const more = [...moreText.matchAll(/and (\d+) more/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(shownRows + more).toBe(expected);

    // The subline names the workspace; agent and issue counts live in the stat tiles only.
    const summary = (await (await request.get(`${BASE_URL}/api/companies/${company.id}/dashboard`)).json()) as {
      tasks: { open: number };
    };
    await expect(page.getByTestId("home-subline")).not.toContainText("open issue");
    await expect(page.getByTestId("home-plan-with-cos")).toHaveAttribute("href", /\/cos$/);

    // One-UX: the control-plane panels sit under the three blocks, for every company.
    await expect(page.getByTestId("dashboard-control-plane")).toBeVisible();
    await expect(page.getByTestId("dashboard-stat-issues-value")).toHaveText(String(summary.tasks.open));
    await expect(page.getByTestId("dashboard-fleet")).toBeVisible();
    await expect(page.getByTestId("dashboard-activity")).toBeVisible();
  });
});
