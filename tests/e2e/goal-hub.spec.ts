// AgentDash: Goal hub rollup E2E (AGE-40).
// Verifies /companies/:companyId/goals/:goalId hub tab renders all rollup
// cards (agents, plan, work, spend, KPIs, activity) and that the hub API
// responds with the expected rollup shape.

import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

test.describe("AGE-40: Goal hub rollup", () => {
  test("hub API returns rollup shape for a seeded goal", async ({ page, company }) => {
    const goalsRes = await page.request.get(`/api/companies/${company.id}/goals`);
    expect(goalsRes.ok()).toBe(true);
    const goals = await goalsRes.json();
    if (goals.length === 0) {
      test.skip();
      return;
    }

    const hubRes = await page.request.get(
      `/api/companies/${company.id}/goals/${goals[0].id}/hub`,
    );
    expect(hubRes.ok()).toBe(true);
    const rollup = await hubRes.json();

    // Must include every rollup slice (empty-state friendly)
    expect(rollup).toHaveProperty("goal");
    expect(rollup).toHaveProperty("plan");
    expect(rollup).toHaveProperty("agents");
    expect(rollup).toHaveProperty("work");
    expect(rollup).toHaveProperty("spend");
    expect(rollup).toHaveProperty("kpis");
    expect(rollup).toHaveProperty("activity");

    expect(rollup.goal.id).toBe(goals[0].id);
    expect(Array.isArray(rollup.agents)).toBe(true);
    expect(Array.isArray(rollup.kpis)).toBe(true);
    expect(Array.isArray(rollup.activity)).toBe(true);
    expect(rollup.work).toHaveProperty("openIssueCount");
    expect(rollup.work).toHaveProperty("activeRoutineCount");
    expect(rollup.work).toHaveProperty("activePipelineCount");
    expect(rollup.spend).toHaveProperty("spendCents");
    expect(rollup.spend).toHaveProperty("revenueCents");
    expect(rollup.spend).toHaveProperty("netCents");
  });

  test("goal detail page renders hub tab with all rollup cards", async ({
    page,
    company,
    prefix,
  }) => {
    const goalsRes = await page.request.get(`/api/companies/${company.id}/goals`);
    expect(goalsRes.ok()).toBe(true);
    const goals = await goalsRes.json();
    if (goals.length === 0) {
      test.skip();
      return;
    }

    await navigateAndWait(page, `/goals/${goals[0].id}`, prefix);

    // Hub is the default tab
    const hub = page.locator('[data-testid="goal-hub"]');
    await expect(hub).toBeVisible({ timeout: 15_000 });

    // All six rollup cards render (empty-state friendly)
    await expect(page.locator('[data-testid="goal-hub-agents-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="goal-hub-plan-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="goal-hub-work-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="goal-hub-spend-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="goal-hub-kpi-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="goal-hub-activity-card"]')).toBeVisible();

    // Work card surfaces the three counters
    await expect(page.locator('[data-testid="work-open-issues"]')).toBeVisible();
    await expect(page.locator('[data-testid="work-active-routines"]')).toBeVisible();
    await expect(page.locator('[data-testid="work-active-pipelines"]')).toBeVisible();

    // Spend card surfaces the key money metrics
    await expect(page.locator('[data-testid="spend-amount"]')).toBeVisible();
    await expect(page.locator('[data-testid="revenue-amount"]')).toBeVisible();
    await expect(page.locator('[data-testid="net-amount"]')).toBeVisible();
  });
});
