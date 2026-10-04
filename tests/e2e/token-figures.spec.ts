/**
 * E2E: scan 4 lane O1 — token figures that agree, and honest usage labels.
 *
 *   - The agent page's daily-ceiling line read "589.4k used today" while Home,
 *     Shipped and the run page agreed on 60.7k / 36.9k. The ceiling counts
 *     cached reads (enforcement), so the line now says so.
 *   - Right after a run, the issue's Result card read "not measured",
 *     which looked like an error. A run-created deliverable without usage now
 *     reads "counting…" for a few minutes; one recorded by hand keeps "not
 *     measured".
 *
 * The Readable transcript's single-command summaries and redaction are covered
 * by ui/src/lib/readableTranscript.test.ts (a run transcript cannot be seeded
 * through the public API).
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

async function ensureCompany(request: APIRequestContext) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Figures-${Date.now()}` },
  });
  if (created.ok()) return (await created.json()) as { id: string; issuePrefix: string };
  // Single-company installs refuse a second company; reuse the one there is.
  const list = await request.get(`${BASE_URL}/api/companies`);
  expect(list.ok()).toBe(true);
  const companies = (await list.json()) as Array<{ id: string; issuePrefix: string }>;
  expect(companies.length).toBeGreaterThan(0);
  return companies[0]!;
}

test.describe("Token figures (scan 4, lane O1)", () => {
  test("the agent page labels the ceiling's count as counting cached reads", async ({ page, request }) => {
    const company = await ensureCompany(request);
    const agent = await post<{ id: string }>(request, `/api/companies/${company.id}/agents`, {
      name: `Dana-${Date.now() % 10_000}`,
      role: "general",
      title: "Close Checklist Manager",
      adapterType: "process",
      // Addressed over the API, never run.
      adapterConfig: { command: process.execPath },
    });

    await page.goto(`${BASE_URL}/${company.issuePrefix}/agents/${agent.id}`);
    const line = page.getByTestId("token-ceiling-usage");
    await expect(line).toBeVisible({ timeout: 20_000 });
    await expect(line).toContainText("counted toward it today (counts cached reads)");
    await expect(line).not.toContainText("used today");
    await expect(line).toHaveAttribute("title", /counts cached input/);
  });

  // "counting…" is only for a deliverable a run created (its usage is on the
  // way). One recorded by hand through the API has no run to meter it, so it
  // must say so plainly rather than "counting…" forever. The run-created case
  // is covered by IssueResultBlock.test.tsx (a run cannot be seeded here).
  test("a hand-recorded deliverable reads 'not measured', never 'counting…'", async ({ page, request }) => {
    const company = await ensureCompany(request);
    const issue = await post<{ id: string; identifier: string | null }>(
      request,
      `/api/companies/${company.id}/issues`,
      { title: "Draft the month-end close checklist", status: "in_review" },
    );
    await post(request, `/api/issues/${issue.id}/work-products`, {
      type: "document",
      provider: "paperclip",
      title: "Month-end close checklist",
      status: "ready_for_review",
      isPrimary: true,
    });

    await page.goto(`${BASE_URL}/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const result = page.getByTestId("issue-result-block");
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.getByTestId("issue-result-usage")).toHaveText("not measured");
    await expect(result).not.toContainText("counting…");
  });
});
