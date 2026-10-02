/**
 * E2E: canary1 pass on v2026.1002.1 (lane R), the UI half.
 *
 *  1. Team: a workspace without stewardship shows no "Needs a steward" badge
 *     on an agent nobody is paired with, since Members & access says
 *     stewardship is "available on request" there.
 *  2. Members & access: chat channels sit behind the same workspace gate, so
 *     the page never asks GET /channel-bindings just to read its 404.
 *  3. Billing: a workspace without Stripe reads "Billing isn't set up yet for
 *     your workspace." and never "instance".
 *
 * Run on a free port, e.g.
 *   PAPERCLIP_E2E_PORT=3848 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts hosted-canary1.spec.ts
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

type Company = { id: string; issuePrefix: string };
type AgentRow = { id: string; status: string; autonomy?: string; accountable?: unknown };

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function hire(request: APIRequestContext, companyId: string, name: string) {
  const result = await post<{ agent: { id: string }; approval?: { id: string } }>(
    request,
    `/api/companies/${companyId}/agent-hires`,
    {
      name,
      role: "engineer",
      title: "Engineer",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.stdout.write('done\\n')"] },
    },
  );
  if (result.approval) await post(request, `/api/approvals/${result.approval.id}/approve`, {});
  return result.agent.id;
}

test.describe("Hosted canary1 fixes (lane R)", () => {
  test("Team hides 'Needs a steward' where stewardship is off; access page skips channel bindings; billing copy is plain", async ({ page, request }) => {
    const company = await post<Company>(request, "/api/companies", { name: `E2E Canary1 ${Date.now()}` });
    // The first agent may be paired with the founder; the second is left unpaired.
    await hire(request, company.id, "Canary First");
    await hire(request, company.id, "Canary Second");

    const capabilities = await request.get(`/api/me/capabilities?companyId=${company.id}`);
    expect(capabilities.ok()).toBe(true);
    expect((await capabilities.json()).features?.stewardship).toBe(false);

    const agentsRes = await request.get(`/api/companies/${company.id}/agents`);
    expect(agentsRes.ok()).toBe(true);
    const agents = (await agentsRes.json()) as AgentRow[];
    const unpaired = agents.filter(
      (agent) => agent.status !== "terminated" && (agent.autonomy ?? "stewarded") === "stewarded" && !agent.accountable,
    );
    expect(unpaired.length, "the seed must leave at least one agent with nobody paired").toBeGreaterThan(0);

    const channelBindingCalls: string[] = [];
    page.on("request", (req) => {
      if (/\/api\/companies\/[^/]+\/channel-bindings(\?|$)/.test(req.url())) channelBindingCalls.push(req.url());
    });

    // 1. Team list.
    await page.goto(`/${company.issuePrefix}/agents/all`);
    await expect(page.getByText("Canary Second").first()).toBeVisible({ timeout: 30_000 });
    // Give the capabilities answer time to land before asserting absence.
    await expect.poll(async () => page.getByTestId("agent-kind-unpaired").count(), { timeout: 10_000 }).toBe(0);

    // 2. Members & access.
    await page.goto(`/${company.issuePrefix}/company/settings/access`);
    await expect(page.getByText("Channel bindings")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/ask us to turn on chat channels/)).toBeVisible();
    await expect(page.getByText(/ask us to turn on stewardship/)).toBeVisible();
    expect(channelBindingCalls).toEqual([]);

    // 3. Billing.
    await page.goto(`/${company.issuePrefix}/billing`);
    await expect(page.getByText("Billing isn't set up yet for your workspace.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/on this instance/)).toHaveCount(0);
  });
});
