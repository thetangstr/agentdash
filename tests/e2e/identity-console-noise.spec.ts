/**
 * E2E: scan 4 lane O2 — title-first agent identity and a quiet console.
 *
 *  1. Team (desktop org list and list view, phone cards) and the agent header
 *     show the title first and drop a generic role ("General", "PM"); the
 *     "Runs when asked" chip never overlaps the last-run time.
 *  2. The agent page and /agents/new log no React warnings (DOM nesting,
 *     missing DialogTitle), and /agents/new does not 404 on a config schema.
 *  3. Settings keeps archive and the technical panels collapsed at the bottom.
 *
 * Run on a free port, e.g.
 *   PAPERCLIP_E2E_PORT=3847 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts identity-console-noise.spec.ts
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

type Company = { id: string; issuePrefix: string };
type Agent = { id: string; urlKey?: string | null };

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function hire(
  request: APIRequestContext,
  companyId: string,
  input: { name: string; role: string; title: string },
): Promise<Agent> {
  const result = await post<{ agent: Agent; approval?: { id: string } }>(
    request,
    `/api/companies/${companyId}/agent-hires`,
    {
      ...input,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.stdout.write('done\\n')"] },
    },
  );
  if (result.approval) await post(request, `/api/approvals/${result.approval.id}/approve`, {});
  return result.agent;
}

// React 19 dev warnings and Radix's accessibility warnings.
const REACT_WARNING =
  /cannot be a descendant of|cannot contain a nested|validateDOMNesting|In HTML, <|requires a `DialogTitle`|Missing `Description`|Each child in a list should have a unique "key"/;

function collectWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (process.env.E2E_LOG_CONSOLE) console.log(`[browser ${message.type()}] ${text.slice(0, 300)}`);
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (REACT_WARNING.test(text)) warnings.push(text);
  });
  return warnings;
}

test.describe("Agent identity and console noise (scan 4 lane O2)", () => {
  let company: Company;
  let closeManager: Agent;

  test.beforeAll(async ({ request }) => {
    company = await post<Company>(request, "/api/companies", { name: `E2E Identity ${Date.now()}` });
    closeManager = await hire(request, company.id, {
      name: "Dana",
      role: "general",
      title: "Close Checklist Manager",
    });
    await hire(request, company.id, { name: "Maya", role: "pm", title: "Client Email Coordinator" });
  });

  test("Team rows put the title first, drop generic roles, and keep the schedule chip clear of the time", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${company.issuePrefix}/agents/all`);
    const identities = page.getByTestId("agent-org-row-identity");
    await expect(identities.filter({ hasText: "Close Checklist Manager" })).toHaveCount(1, { timeout: 30_000 });
    const texts = await identities.allTextContents();
    expect(texts).toContain("Close Checklist Manager");
    expect(texts).toContain("Client Email Coordinator");
    for (const text of texts) {
      expect(text).not.toMatch(/^(General|PM)\b/);
      expect(text).not.toContain(" - ");
    }

    // The chip column holds "Runs when asked" and the status without spilling left.
    const columns = page.getByTestId("agent-row-schedule-status");
    await expect(columns.first()).toBeVisible();
    for (const box of await columns.all()) {
      const overflow = await box.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });

  test("phone Team cards show the title alone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${company.issuePrefix}/agents/all`);
    const card = page.getByTestId("agent-phone-card").filter({ hasText: "Dana" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Close Checklist Manager");
    await expect(card).not.toContainText("General");
  });

  test("the agent page shows the title alone and logs no React warnings", async ({ page, request }) => {
    // Give the page something to render: an assigned issue and a run.
    const issue = await post<{ identifier: string }>(request, `/api/companies/${company.id}/issues`, {
      title: "Draft the month-end close checklist",
      status: "todo",
      assigneeAgentId: closeManager.id,
    });
    await post(request, `/api/agents/${closeManager.id}/heartbeat/invoke`, {});
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/companies/${company.id}/heartbeat-runs?agentId=${closeManager.id}`);
          return ((await res.json()) as unknown[]).length;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    // The process adapter writes no summary, so the run list is served with
    // the kind a model writes: one that names an issue. The Latest Run card
    // then renders that issue link inside itself (the <a> inside <a> the
    // canary agent page logged).
    await page.route("**/api/companies/*/heartbeat-runs?agentId=*", async (route) => {
      const response = await route.fetch();
      const runs = (await response.json()) as Array<Record<string, unknown>>;
      const summary = `Revision complete on ${issue.identifier}. What I did this run: drafted the checklist.`;
      await route.fulfill({
        response,
        json: runs.map((run) => ({ ...run, status: "succeeded", error: null, resultJson: { summary } })),
      });
    });

    const warnings = collectWarnings(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${company.issuePrefix}/agents/${closeManager.urlKey ?? closeManager.id}`);
    await expect(page.getByRole("heading", { name: "Dana" })).toBeVisible({ timeout: 30_000 });
    const identity = page.getByText("Close Checklist Manager", { exact: true }).first();
    await expect(identity).toBeVisible();
    await expect(page.getByText("Close Checklist Manager · General")).toHaveCount(0);
    // The run summary's issue reference is a link inside the run card.
    const runCard = page.getByTestId("latest-run-card");
    await expect(runCard.locator('a[data-mention-kind="issue"]')).toHaveCount(1, { timeout: 30_000 });

    // The issue dialog opened from the header has an accessible title.
    await page.getByRole("button", { name: "Assign Task" }).click();
    await expect(page.getByRole("dialog", { name: "New issue" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.waitForTimeout(1_500);
    expect(warnings).toEqual([]);

    // A click on the card outside the issue link still opens the run.
    await runCard.click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(/\/runs\//);
  });

  test("/agents/new fetches no missing config schema and logs no React warnings", async ({ page }) => {
    const warnings = collectWarnings(page);
    const failed: string[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/") && response.status() === 404) failed.push(url.pathname);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${company.issuePrefix}/agents/new`);
    await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);
    expect(failed.filter((path) => path.includes("/config-schema"))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("Settings keeps archive and the technical panels collapsed at the bottom", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${company.issuePrefix}/company/settings`);
    const advanced = page.getByTestId("company-settings-advanced");
    const danger = page.getByTestId("company-settings-danger-zone");
    await expect(advanced).toBeVisible({ timeout: 30_000 });
    await expect(danger).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive workspace" })).toBeHidden();
    await expect(page.getByText("Needs reconciliation")).toBeHidden();
    expect(await advanced.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    expect(await danger.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);

    await danger.locator("summary").click();
    await expect(page.getByRole("button", { name: "Archive workspace" })).toBeVisible();
  });
});
