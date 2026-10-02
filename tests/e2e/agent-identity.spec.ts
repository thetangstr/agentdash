/**
 * E2E: scan 3 lane H — agents read as people would describe them.
 *
 * The board printed stored values: "General - research_analyst" in the agent
 * header, "general" / "chief of staff" under each name in the Home fleet, and
 * bare names in the assignee picker. Seeds a company with two agents whose
 * titles are slugs, then checks:
 *   - Home fleet rows show the title first, then the humanized role;
 *   - the agent header shows the same line, with no raw slug;
 *   - the New issue assignee picker shows the title under each agent's name.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(`${BASE_URL}${url}`, { data });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test.describe("Agent identity copy (scan 3, lane H)", () => {
  test("fleet, agent header and assignee picker show title then humanized role", async ({ page, request }) => {
    const company = await post<{ id: string; issuePrefix: string }>(request, "/api/companies", {
      name: `E2E-Identity-${Date.now()}`,
    });
    const agent = (name: string, role: string, title: string) =>
      post<{ id: string; name: string }>(request, `/api/companies/${company.id}/agents`, {
        name,
        role,
        title,
        adapterType: "process",
        // Addressed over the API, never run.
        adapterConfig: { command: process.execPath },
      });
    await agent("Ivy", "general", "proposal_drafter");
    await agent("Scout", "researcher", "research_analyst");

    await page.goto(`${BASE_URL}/${company.issuePrefix}/dashboard`);
    const fleet = page.getByTestId("dashboard-fleet");
    await expect(fleet).toBeVisible({ timeout: 20_000 });
    const ivyRow = fleet.getByTestId("dashboard-fleet-row").filter({ hasText: "Ivy" });
    const scoutRow = fleet.getByTestId("dashboard-fleet-row").filter({ hasText: "Scout" });
    await expect(ivyRow).toContainText("Proposal Drafter");
    await expect(scoutRow).toContainText("Research Analyst · Researcher");
    const fleetText = (await fleet.textContent()) ?? "";
    expect(fleetText).not.toMatch(/proposal_drafter|research_analyst|\bgeneral\b/);

    await ivyRow.getByRole("link").click();
    const header = page.getByRole("heading", { level: 2, name: "Ivy" });
    await expect(header).toBeVisible({ timeout: 20_000 });
    const subtitle = header.locator("xpath=following-sibling::p[1]");
    await expect(subtitle).toHaveText("Proposal Drafter");

    await page.goto(`${BASE_URL}/${company.issuePrefix}/dashboard`);
    await expect(page.getByTestId("dashboard-fleet")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "New Issue" }).first().click();
    await page.getByRole("button", { name: "Assignee" }).first().click();
    const ivyOption = page.getByRole("button").filter({ hasText: "Ivy" }).filter({ has: page.getByTestId("assignee-option-subtitle") });
    await expect(ivyOption.getByTestId("assignee-option-subtitle")).toHaveText("Proposal Drafter");
    const scoutOption = page.getByRole("button").filter({ hasText: "Scout" }).filter({ has: page.getByTestId("assignee-option-subtitle") });
    await expect(scoutOption.getByTestId("assignee-option-subtitle")).toHaveText("Research Analyst");
  });
});
