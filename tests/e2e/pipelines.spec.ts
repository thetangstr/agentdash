import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-6: Pipeline Orchestration (DAG Workflows) — now "Playbooks" under Goals.
 *
 * AgentDash (AGE-42): Pipelines are no longer a top-level concept. The list
 * view at /pipelines redirects into /goals, and /pipelines/:id redirects into
 * the owning goal hub when the pipeline has a goalId (falling back to the
 * legacy detail view when it doesn't).
 */
test.describe("CUJ-6: Pipeline Orchestration (folded under Goals)", () => {
  test("/pipelines redirects to /goals", async ({ page, prefix }) => {
    await navigateAndWait(page, "/pipelines", prefix);
    await expect(page).toHaveURL(/\/goals(\?|#|$)/);
  });

  test("dev-only debug list still exposes seeded pipelines", async ({ page, prefix }) => {
    await navigateAndWait(page, "/pipelines/_debug", prefix);

    // Seeded pipelines: Site Assessment Workflow, Client Onboarding, RFP Response Pipeline
    await expect(
      page.locator("text=/Site Assessment|Client Onboarding|RFP Response/i").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("pipeline detail redirects to its goal when goalId is set", async ({
    page,
    company,
    prefix,
  }) => {
    const res = await page.request.get(`/api/companies/${company.id}/pipelines`);
    expect(res.ok()).toBe(true);
    const pipelines = await res.json();
    expect(pipelines.length).toBeGreaterThan(0);

    // Pick the first pipeline that has a goalId — the seeded data has at
    // least one after AGE-30 linked pipelines to goals.
    const linked = pipelines.find((p: { goalId: string | null }) => !!p.goalId);
    if (!linked) {
      test.skip(true, "No seeded pipeline with goalId; covered by unit test");
      return;
    }

    await navigateAndWait(page, `/pipelines/${linked.id}`, prefix);
    await expect(page).toHaveURL(new RegExp(`/goals/${linked.goalId}`));
  });

  test("pipeline detail falls back to legacy view when goalId is null", async ({
    page,
    company,
    prefix,
  }) => {
    const res = await page.request.get(`/api/companies/${company.id}/pipelines`);
    expect(res.ok()).toBe(true);
    const pipelines = await res.json();

    const orphan = pipelines.find((p: { goalId: string | null }) => !p.goalId);
    if (!orphan) {
      test.skip(true, "No seeded orphan (goalId=null) pipeline; skip fallback check");
      return;
    }

    await navigateAndWait(page, `/pipelines/${orphan.id}`, prefix);
    // Stays on /pipelines/<id> (fallback to the legacy detail view).
    await expect(page).toHaveURL(new RegExp(`/pipelines/${orphan.id}`));
    await expect(page.locator(`text=${orphan.name}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test("pipeline wizard page loads", async ({ page, prefix }) => {
    await navigateAndWait(page, "/pipelines/new", prefix);

    await expect(
      page.locator("h1").filter({ hasText: /pipeline|playbook|wizard/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
