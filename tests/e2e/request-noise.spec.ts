/**
 * E2E: scan 3 lane L — request noise and consistent token figures.
 *
 *  1. Billing status: every reader shares one request, a 429 is not retried,
 *     and a 429 never surfaces as an uncaught page error. The limiter is off in
 *     e2e, so the 429 is served by a route stub.
 *  2. Feature probes: a workspace without stewardship gets its answer from
 *     /me/capabilities (a 200) and never probes the stewardship-gated routes
 *     (/me/inbox, /me/fact-requests, /inbox/override,
 *     connector-send-executions, /agents/:id/governance) for their 404s.
 *  3. Token figures: Home and the Companies card count input + output tokens
 *     (cached input excluded), and an unmetered workspace's card shows tokens
 *     "billed by your model provider" instead of "$0.00 Unlimited budget".
 *
 * Run on a free port, e.g.
 *   PAPERCLIP_E2E_PORT=3846 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts request-noise.spec.ts
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

type Company = { id: string; issuePrefix: string };

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function seedCompany(request: APIRequestContext, name: string): Promise<{ company: Company; agentId: string }> {
  const company = await post<Company>(request, "/api/companies", { name: `${name} ${Date.now()}` });
  const hire = await post<{ agent: { id: string }; approval?: { id: string } }>(
    request,
    `/api/companies/${company.id}/agent-hires`,
    {
      name: "Noise Check Worker",
      role: "engineer",
      title: "Engineer",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.stdout.write('done\\n')"] },
    },
  );
  if (hire.approval) {
    await post(request, `/api/approvals/${hire.approval.id}/approve`, {});
  }
  return { company, agentId: hire.agent.id };
}

/** Client-side navigation, so the app (and its query cache) stays mounted. */
async function navigate(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForTimeout(1_200);
}

const GATED_PROBE = /\/api\/companies\/[^/]+\/(me\/inbox|me\/fact-requests|inbox\/override|connector-send-executions)|\/agents\/[^/]+\/governance(\?|$)/;

test.describe("Request noise (scan 3 lane L)", () => {
  test("billing status is read once, a 429 is not retried, and never becomes a page error", async ({ page, request }) => {
    const { company } = await seedCompany(request, "E2E Billing Noise");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    let billingCalls = 0;
    await page.route("**/api/billing/status**", async (route) => {
      billingCalls += 1;
      await route.fulfill({
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "900" },
        body: JSON.stringify({ error: "Rate limited", retryAfter: 900 }),
      });
    });

    await page.goto(`/${company.issuePrefix}/dashboard`);
    await expect(page.getByTestId("dashboard-control-plane")).toBeVisible({ timeout: 30_000 });
    for (const path of ["issues", "agents/all", "shipped", "dashboard", "issues", "dashboard"]) {
      await navigate(page, `/${company.issuePrefix}/${path}`);
    }

    expect(billingCalls).toBe(1);
    expect(pageErrors.filter((message) => /rate limited/i.test(message))).toEqual([]);
  });

  test("a workspace without stewardship is told so with a 200 and never probes the gated routes", async ({ page, request }) => {
    const { company } = await seedCompany(request, "E2E Probe Noise");

    const capabilities = await request.get(`/api/me/capabilities?companyId=${company.id}`);
    expect(capabilities.status()).toBe(200);
    expect(((await capabilities.json()) as { features?: { stewardship: boolean | null } }).features).toEqual({
      stewardship: false,
    });

    const probes: string[] = [];
    page.on("request", (req) => {
      if (GATED_PROBE.test(new URL(req.url()).pathname + new URL(req.url()).search)) probes.push(req.url());
    });

    await page.goto(`/${company.issuePrefix}/dashboard`);
    await expect(page.getByTestId("dashboard-control-plane")).toBeVisible({ timeout: 30_000 });
    for (const path of ["decisions", "dashboard", "company/settings", "decisions", "my-agent", "dashboard"]) {
      await navigate(page, `/${company.issuePrefix}/${path}`);
    }
    // A full reload too: the answer comes from /me/capabilities, not a probe.
    await page.reload();
    await expect(page.getByTestId("dashboard-control-plane")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);

    expect(probes).toEqual([]);
  });

  test("tokens count input + output everywhere, and an unmetered card says who bills them", async ({ page, request }) => {
    const { company, agentId } = await seedCompany(request, "E2E Token Figures");
    await post(request, `/api/companies/${company.id}/cost-events`, {
      agentId,
      provider: "openrouter",
      model: "glm-5.3",
      inputTokens: 100_000,
      cachedInputTokens: 900_000,
      outputTokens: 5_000,
      costCents: 0,
      occurredAt: new Date().toISOString(),
    });

    await page.goto(`/${company.issuePrefix}/dashboard`);
    const tile = page.getByTestId("dashboard-stat-spend");
    // 100k input + 5k output; the 900k cached input is not counted.
    await expect(page.getByTestId("dashboard-stat-spend-value")).toHaveText("105.0k", { timeout: 30_000 });
    await expect(tile).toHaveAttribute("title", /Cached input .* not counted/);

    await page.goto(`/${company.issuePrefix}/companies`);
    const usage = page.getByTestId("company-card-usage").filter({ hasText: "105.0k tokens" });
    await expect(usage).toHaveCount(1, { timeout: 30_000 });
    await expect(usage).toContainText("billed by your model provider");
    await expect(usage).not.toContainText("$0.00");
    await expect(usage).not.toContainText("Unlimited budget");
  });
});
