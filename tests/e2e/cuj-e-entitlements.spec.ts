import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-E: Three-tier entitlements
 *
 * Verifies the Billing page renders the tier badge, limits, and feature matrix
 * and that a premium surface (HubSpot Settings) is gated for a free-tier
 * company with an upgrade CTA instead of the connector form.
 *
 * Requires: dev server running with at least one seeded company. Default
 * company_plan tier for new companies is "free" so the gates are exercised.
 */

test.describe("CUJ-E: entitlements", () => {
  test("Billing page renders tier badge, limits, and feature matrix", async ({
    page,
    prefix,
  }) => {
    await navigateAndWait(page, "/billing", prefix);

    await expect(page.getByTestId("billing-page")).toBeVisible();
    await expect(page.getByTestId("billing-limits")).toBeVisible();
    await expect(page.getByTestId("billing-matrix")).toBeVisible();

    // At least one tier badge (free/pro/enterprise) must surface.
    const badge = page.locator("[data-tier]").first();
    await expect(badge).toBeVisible();

    // Feature matrix must include rows for every gated capability.
    for (const feature of [
      "hubspotSync",
      "autoResearch",
      "assessMode",
      "prioritySupport",
    ]) {
      await expect(page.getByTestId(`matrix-${feature}-free`)).toBeVisible();
      await expect(page.getByTestId(`matrix-${feature}-pro`)).toBeVisible();
      await expect(
        page.getByTestId(`matrix-${feature}-enterprise`),
      ).toBeVisible();
    }
  });

  test("HubSpot settings shows upgrade gate when feature is not entitled", async ({
    page,
    prefix,
  }) => {
    // Force the entitlements API to return free tier regardless of seed data
    // so the gate is exercised deterministically.
    await page.route("**/api/companies/*/entitlements", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tier: "free",
          limits: { agents: 3, monthlyActions: 500, pipelines: 1 },
          features: {
            hubspotSync: false,
            autoResearch: false,
            assessMode: false,
            prioritySupport: false,
          },
        }),
      });
    });

    await navigateAndWait(page, "/crm/hubspot", prefix);

    // Gate renders instead of the configuration form.
    await expect(page.getByTestId("hubspot-gate")).toBeVisible();
    await expect(page.getByTestId("hubspot-upgrade")).toBeVisible();

    // The connector form inputs must not render when gated.
    await expect(
      page.locator('[data-testid="hubspot-access-token"]'),
    ).toHaveCount(0);
  });
});
