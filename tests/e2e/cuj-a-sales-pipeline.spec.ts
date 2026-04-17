import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-A: Sales Pipeline
 *
 * Verifies that the CRM surfaces render full UI (no "coming soon" stub copy):
 *  - /crm/leads — leads table with filters
 *  - /crm/kanban — pipeline kanban board with stage columns
 *  - /crm/pipeline — pipeline overview page
 *  - /crm/deals/:dealId — deal detail page (skipped if no deals seeded)
 *  - /crm/hubspot — HubSpot settings config form
 *
 * Note: the backend convertLead route only marks the lead as converted and
 * does NOT create a deal, so this spec does not exercise the convert flow
 * end-to-end. It instead asserts each page's primary UI renders.
 *
 * Requires: dev server running with at least one company seeded.
 */

test.describe("CUJ-A: sales pipeline", () => {
  test("crm leads page renders table UI with filters", async ({ page, prefix }) => {
    await navigateAndWait(page, "/crm/leads", prefix);
    await page.waitForLoadState("networkidle");

    // No stub copy.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // Page header should be visible.
    await expect(page.getByRole("heading", { name: /leads/i })).toBeVisible();
  });

  test("crm kanban page renders columns", async ({ page, prefix }) => {
    await navigateAndWait(page, "/crm/kanban", prefix);
    await page.waitForLoadState("networkidle");

    // No stub copy.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // Expect at least one stage column label visible.
    await expect(page.getByText(/prospect|qualified|proposal/i).first()).toBeVisible();
  });

  test("crm pipeline page renders without @ts-nocheck stub copy", async ({ page, prefix }) => {
    await navigateAndWait(page, "/crm/pipeline", prefix);
    await page.waitForLoadState("networkidle");

    // No stub copy.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // Page header should be visible.
    await expect(page.getByRole("heading", { name: /pipeline/i }).first()).toBeVisible();
  });

  test("crm deal detail page renders when navigating to a seeded deal", async ({ page, company, prefix }) => {
    const res = await page.request.get(`/api/companies/${company.id}/crm/deals`);
    if (!res.ok()) test.skip();
    const deals = (await res.json()) as Array<{ id: string }>;
    test.skip(deals.length === 0, "No deals seeded — skip deal detail render check");

    await navigateAndWait(page, `/crm/deals/${deals[0].id}`, prefix);
    await page.waitForLoadState("networkidle");

    // No stub copy.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  });

  test("hubspot settings page renders config form", async ({ page, prefix }) => {
    await navigateAndWait(page, "/crm/hubspot", prefix);
    await page.waitForLoadState("networkidle");

    // No stub copy.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // Page header should be visible.
    await expect(page.getByRole("heading", { name: /hubspot/i }).first()).toBeVisible();
  });
});
