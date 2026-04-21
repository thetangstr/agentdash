// AgentDash (AGE-48 Phase 2): Plan approval card E2E.
//
// Verifies the full Phase 1+2 loop end-to-end:
//   1. Creating a goal via the HTTP API (no `skipAutoPropose`) triggers
//      the CoS orchestrator, which persists an `agent_plans` row with
//      `status='proposed'`.
//   2. Navigating to the goal hub surfaces the new PlanApprovalCard with
//      real proposal content (agents list, rationale).
//   3. Clicking Edit opens the drawer, the user tweaks an agent name, and
//      Save persists the patch (the server PATCH endpoint updates the
//      proposalPayload while still in proposed state).
//   4. Clicking Approve transitions the plan to `expanded` and spawns at
//      least one agent (reuse of agents-only approve; Phase 3 will extend
//      this to sub-goals + project + playbooks).

import { test, expect } from "@playwright/test";

interface Company {
  id: string;
  name: string;
  issuePrefix: string;
}

interface Goal {
  id: string;
  title: string;
  level: string;
}

async function createCompany(
  page: import("@playwright/test").Page,
  suffix: string,
): Promise<Company> {
  const ts = Date.now();
  const name = `E2E-PlanApproval-${suffix}-${ts}`;
  const prefix = `P${ts.toString().slice(-5)}`;
  const res = await page.request.post("/api/companies", {
    data: { name, issuePrefix: prefix },
  });
  expect(res.ok(), `create company failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function createGoalViaApi(
  page: import("@playwright/test").Page,
  companyId: string,
  title: string,
): Promise<Goal> {
  const res = await page.request.post(`/api/companies/${companyId}/goals`, {
    data: {
      title,
      level: "company",
      description: "Ship ICP-focused outbound and drive pipeline to $250k.",
    },
  });
  expect(res.ok(), `create goal failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function waitForProposedPlan(
  page: import("@playwright/test").Page,
  companyId: string,
  goalId: string,
  timeoutMs = 15_000,
): Promise<{ id: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await page.request.get(
      `/api/companies/${companyId}/agent-plans?goalId=${goalId}&status=proposed`,
    );
    if (res.ok()) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) return rows[0];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

test.describe("@agents AGE-48: CoS auto-propose + approval card", () => {
  test("creates a proposed plan automatically and exposes it on the goal hub", async ({
    page,
  }) => {
    const company = await createCompany(page, "autoprop");
    const goal = await createGoalViaApi(page, company.id, "Q1 outbound lift");

    // Phase 1 assertion: auto-propose produced a plan row within ~15s.
    const plan = await waitForProposedPlan(page, company.id, goal.id);
    expect(plan, "CoS did not auto-propose a plan within 15s").not.toBeNull();

    // Phase 2 assertion: navigate to the goal hub and the approval card renders
    // with real proposal content.
    await page.goto(`/${company.issuePrefix}/goals/${goal.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    const approvalCard = page.locator('[data-testid="plan-approval-card"]');
    await expect(approvalCard).toBeVisible({ timeout: 15_000 });
    // The agents list should have at least one row.
    await expect(
      approvalCard.locator('[data-testid^="plan-agent-"]').first(),
    ).toBeVisible();
  });

  test("edit-drawer save persists a patch to the proposal payload", async ({ page }) => {
    const company = await createCompany(page, "edit");
    const goal = await createGoalViaApi(page, company.id, "Growth ops refresh");
    const plan = await waitForProposedPlan(page, company.id, goal.id);
    expect(plan, "auto-propose did not land").not.toBeNull();
    if (!plan) return;

    await page.goto(`/${company.issuePrefix}/goals/${goal.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    const approvalCard = page.locator('[data-testid="plan-approval-card"]');
    await expect(approvalCard).toBeVisible({ timeout: 15_000 });

    // Open the editor drawer.
    await page.locator('[data-testid="plan-edit-btn"]').click();
    const drawer = page.locator('[data-testid="plan-editor-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    // Tweak the first agent's name.
    const firstAgentName = drawer.locator('[data-testid="plan-editor-agent-name-0"]');
    await expect(firstAgentName).toBeVisible();
    await firstAgentName.fill("Renamed Agent E2E");

    // Save → drawer closes.
    await page.locator('[data-testid="plan-editor-save"]').click();
    await expect(drawer).toBeHidden({ timeout: 10_000 });

    // Verify via API: the proposal payload now carries the renamed agent.
    const planRes = await page.request.get(
      `/api/companies/${company.id}/agent-plans/${plan.id}`,
    );
    expect(planRes.ok()).toBe(true);
    const updated = await planRes.json();
    expect(updated.proposalPayload.proposedAgents[0].name).toBe("Renamed Agent E2E");
  });

  test("approve spawns at least one agent (agents-only behavior preserved)", async ({
    page,
  }) => {
    const company = await createCompany(page, "approve");
    const goal = await createGoalViaApi(page, company.id, "Support capacity lift");
    const plan = await waitForProposedPlan(page, company.id, goal.id);
    expect(plan, "auto-propose did not land").not.toBeNull();
    if (!plan) return;

    // Pre-approval agent count for delta assertion.
    const before = await page.request
      .get(`/api/companies/${company.id}/agents`)
      .then((r) => r.json() as Promise<unknown[]>);
    const beforeCount = Array.isArray(before) ? before.length : 0;

    await page.goto(`/${company.issuePrefix}/goals/${goal.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    const approvalCard = page.locator('[data-testid="plan-approval-card"]');
    await expect(approvalCard).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="plan-approve-btn"]').click();

    // Wait for the plan to flip status. The card disappears (status != proposed
    // filter), so we poll the API.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            `/api/companies/${company.id}/agent-plans/${plan.id}`,
          );
          const row = await res.json();
          return row.status;
        },
        { timeout: 15_000 },
      )
      .toBe("expanded");

    // At least one agent was created by the approve path.
    const after = await page.request
      .get(`/api/companies/${company.id}/agents`)
      .then((r) => r.json() as Promise<unknown[]>);
    expect(Array.isArray(after)).toBe(true);
    expect(after.length).toBeGreaterThan(beforeCount);
  });
});
