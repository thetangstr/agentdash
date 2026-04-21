import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-6: Pipeline Orchestration (DAG Workflows)
 * Pipelines list → create pipeline → pipeline detail → run detail
 */
test.describe("CUJ-6: Pipeline Orchestration", () => {
  test("displays pipelines list", async ({ page, prefix }) => {
    await navigateAndWait(page, "/pipelines", prefix);

    await expect(
      page.locator("h1").filter({ hasText: /pipeline/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("shows existing pipelines from seeded data", async ({ page, prefix }) => {
    await navigateAndWait(page, "/pipelines", prefix);

    // Seeded pipelines: Site Assessment Workflow, Client Onboarding, RFP Response Pipeline
    await expect(
      page.locator("text=/Site Assessment|Client Onboarding|RFP Response/i").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("navigates to pipeline detail", async ({ page, company, prefix }) => {
    // Get pipelines via API
    const res = await page.request.get(`/api/companies/${company.id}/pipelines`);
    expect(res.ok()).toBe(true);
    const pipelines = await res.json();
    expect(pipelines.length).toBeGreaterThan(0);

    await navigateAndWait(page, `/pipelines/${pipelines[0].id}`, prefix);

    // Pipeline name visible in detail
    await expect(
      page.locator(`text=${pipelines[0].name}`).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("pipeline wizard page loads", async ({ page, prefix }) => {
    await navigateAndWait(page, "/pipelines/new", prefix);

    await expect(
      page.locator("h1").filter({ hasText: /pipeline|wizard/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
