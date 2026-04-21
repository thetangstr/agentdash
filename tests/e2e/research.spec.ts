import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-7: AutoResearch
 *
 * CUJ-STATUS notes:
 *   - Research dashboard (cycle list): DONE
 *   - Cycle detail pages (hypotheses/experiments): DONE (ResearchCycleDetail.tsx built)
 *   - LLM hypothesis generation: NOT BUILT (P2) — cycles/hypotheses are human-created only
 *
 * API notes (discovered from live server):
 *   - POST /research-cycles requires goalId (FK not-null constraint)
 *   - POST /security-policies requires rules array (not-null constraint)
 *
 * Test strategy:
 *   1. Create a goal via API, then create a research cycle linked to that goal
 *   2. "New Research Cycle" button is present and visible (but has no dialog handler — documented as bug/TODO)
 *   3. Navigate to cycle detail page, verify header and stat cards render
 *   4. Create hypothesis via API, verify it appears in cycle detail
 *   5. Create experiment via API, verify it appears in cycle detail
 */

// ---------------------------------------------------------------------------
// Helper: create a goal and return its id — required for research cycle creation
// ---------------------------------------------------------------------------
async function createGoal(page: any, companyId: string): Promise<string> {
  const goalRes = await page.request.post(
    `/api/companies/${companyId}/goals`,
    { data: { title: `E2E Goal ${Date.now()}`, description: "Auto-created for research cycle tests" } }
  );
  expect(goalRes.ok(), `create goal should succeed, got ${goalRes.status()}`).toBe(true);
  const goal = await goalRes.json();
  return goal.id;
}

test.describe("CUJ-7: AutoResearch", () => {
  // ---------------------------------------------------------------------------
  // Test 1: Research dashboard loads with the "AutoResearch" heading
  // ---------------------------------------------------------------------------
  test("research dashboard shows AutoResearch heading", async ({ page, prefix }) => {
    await navigateAndWait(page, "/research", prefix);

    await expect(
      page.locator("h1").filter({ hasText: /autoResearch/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 2: Cycle created via API appears in the dashboard list
  // ---------------------------------------------------------------------------
  test("cycle created via API appears in the research dashboard list", async ({ page, company, prefix }) => {
    const cycleTitle = `E2E-Cycle-${Date.now()}`;
    const goalId = await createGoal(page, company.id);

    // Create cycle via API — goalId is required (FK not-null)
    const res = await page.request.post(
      `/api/companies/${company.id}/research-cycles`,
      {
        data: {
          title: cycleTitle,
          description: "Automated e2e test cycle",
          goalId,
          maxIterations: 3,
        },
      }
    );
    expect(res.ok(), `create research cycle should succeed, got ${res.status()}`).toBe(true);
    const cycle = await res.json();
    expect(cycle.id).toBeTruthy();

    // Navigate to dashboard and verify cycle card appears
    await navigateAndWait(page, "/research", prefix);
    await expect(
      page.locator(`text=${cycleTitle}`).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 3: Each cycle card shows a status badge
  // ---------------------------------------------------------------------------
  test("cycle card shows iteration count and status badge", async ({ page, company, prefix }) => {
    const cycleTitle = `E2E-Badge-${Date.now()}`;
    const goalId = await createGoal(page, company.id);

    const createRes = await page.request.post(
      `/api/companies/${company.id}/research-cycles`,
      {
        data: { title: cycleTitle, goalId, maxIterations: 5 },
      }
    );
    expect(createRes.ok()).toBe(true);

    await navigateAndWait(page, "/research", prefix);

    // The card renders "Iteration 0/5" (currentIteration=0, maxIterations=5)
    await expect(
      page.locator("text=/Iteration/i").first()
    ).toBeVisible({ timeout: 10_000 });

    // Status badge rendered in the card (pending/active/etc.)
    await expect(
      page.locator("text=/pending|active|paused|completed/i").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 4: "New Research Cycle" button is visible on the dashboard
  //
  // NOTE: As of CUJ-STATUS 2026-03-31 the button renders but has no dialog
  // handler wired — clicking it does nothing. The test verifies the button
  // exists. A follow-up TODO is marked below to test the creation dialog once
  // the handler is implemented.
  // ---------------------------------------------------------------------------
  test("New Research Cycle button is visible on the dashboard", async ({ page, prefix }) => {
    await navigateAndWait(page, "/research", prefix);

    const btn = page.locator("button").filter({ hasText: /new research cycle/i }).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });

    // TODO: When the "New Research Cycle" dialog handler is implemented,
    // click the button and verify a modal/dialog appears with a form.
    // await btn.click();
    // await expect(page.locator("dialog, [role='dialog']").first()).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Cycle detail page renders the cycle title and stat cards
  // ---------------------------------------------------------------------------
  test("cycle detail page renders title and stat cards", async ({ page, company, prefix }) => {
    const cycleTitle = `E2E-Detail-${Date.now()}`;
    const goalId = await createGoal(page, company.id);

    const createRes = await page.request.post(
      `/api/companies/${company.id}/research-cycles`,
      { data: { title: cycleTitle, goalId, maxIterations: 4 } }
    );
    expect(createRes.ok()).toBe(true);
    const cycle = await createRes.json();

    // Navigate to the cycle detail page
    await navigateAndWait(page, `/research/${cycle.id}`, prefix);

    // h1 should show the cycle title
    await expect(
      page.locator("h1").filter({ hasText: cycleTitle }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Stat cards: Status, Iteration, Hypotheses, Experiments
    await expect(page.locator("text=Status").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Iteration").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Hypotheses").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Experiments").first()).toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Hypothesis created via API appears in cycle detail
  // ---------------------------------------------------------------------------
  test("hypothesis created via API appears in cycle detail", async ({ page, company, prefix }) => {
    const cycleTitle = `E2E-Hypo-${Date.now()}`;
    const hypothesisTitle = "Reducing onboarding time increases retention";
    const goalId = await createGoal(page, company.id);

    // Create cycle
    const cycleRes = await page.request.post(
      `/api/companies/${company.id}/research-cycles`,
      { data: { title: cycleTitle, goalId, maxIterations: 3 } }
    );
    expect(cycleRes.ok()).toBe(true);
    const cycle = await cycleRes.json();

    // Create hypothesis via API
    const hypoRes = await page.request.post(
      `/api/companies/${company.id}/research-cycles/${cycle.id}/hypotheses`,
      {
        data: {
          title: hypothesisTitle,
          rationale: "Based on industry data from SaaS benchmarks",
          source: "human",
        },
      }
    );
    expect(hypoRes.ok(), `create hypothesis should succeed, got ${hypoRes.status()}`).toBe(true);

    // Navigate to detail page and verify hypothesis appears
    await navigateAndWait(page, `/research/${cycle.id}`, prefix);

    await expect(
      page.locator(`text=${hypothesisTitle}`).first()
    ).toBeVisible({ timeout: 10_000 });

    // Hypotheses section heading shows "(1)" count
    await expect(
      page.locator("h2").filter({ hasText: /hypotheses \(1\)/i }).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 7: Experiment created via API appears in cycle detail
  //
  // API notes (discovered from live server):
  //   - experiments require hypothesisId (FK not-null) AND successCriteria (not-null)
  //   - must create a hypothesis first to get a valid hypothesisId
  // ---------------------------------------------------------------------------
  test("experiment created via API appears in cycle detail", async ({ page, company, prefix }) => {
    const cycleTitle = `E2E-Exp-${Date.now()}`;
    const experimentTitle = "A/B test onboarding flow variant";
    const goalId = await createGoal(page, company.id);

    // Create cycle — goalId is required
    const cycleRes = await page.request.post(
      `/api/companies/${company.id}/research-cycles`,
      { data: { title: cycleTitle, goalId, maxIterations: 3 } }
    );
    expect(cycleRes.ok()).toBe(true);
    const cycle = await cycleRes.json();

    // Create hypothesis first — required for experiment creation
    const hypoRes = await page.request.post(
      `/api/companies/${company.id}/research-cycles/${cycle.id}/hypotheses`,
      { data: { title: "Supporting hypothesis", source: "human" } }
    );
    expect(hypoRes.ok(), `create hypothesis should succeed, got ${hypoRes.status()}`).toBe(true);
    const hypothesis = await hypoRes.json();

    // Create experiment via API — hypothesisId and successCriteria are both required
    const expRes = await page.request.post(
      `/api/companies/${company.id}/research-cycles/${cycle.id}/experiments`,
      {
        data: {
          title: experimentTitle,
          description: "Test two onboarding variants with a 50/50 split",
          hypothesisId: hypothesis.id,
          successCriteria: "Retention improvement >= 10%",
        },
      }
    );
    expect(expRes.ok(), `create experiment should succeed, got ${expRes.status()}`).toBe(true);

    // Navigate to detail page and verify experiment appears
    await navigateAndWait(page, `/research/${cycle.id}`, prefix);

    await expect(
      page.locator(`text=${experimentTitle}`).first()
    ).toBeVisible({ timeout: 10_000 });

    // Experiments section heading shows "(1)"
    await expect(
      page.locator("h2").filter({ hasText: /experiments \(1\)/i }).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 8: Empty state renders when cycle has no hypotheses or experiments
  // ---------------------------------------------------------------------------
  test("cycle detail shows empty state messages when no hypotheses or experiments exist", async ({ page, company, prefix }) => {
    const cycleTitle = `E2E-Empty-${Date.now()}`;
    const goalId = await createGoal(page, company.id);

    const cycleRes = await page.request.post(
      `/api/companies/${company.id}/research-cycles`,
      { data: { title: cycleTitle, goalId, maxIterations: 2 } }
    );
    expect(cycleRes.ok()).toBe(true);
    const cycle = await cycleRes.json();

    await navigateAndWait(page, `/research/${cycle.id}`, prefix);

    // Both empty-state paragraphs should be visible
    await expect(
      page.locator("text=No hypotheses generated yet.").first()
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.locator("text=No experiments created yet.").first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
