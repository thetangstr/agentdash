import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-B: Agent Governance
 *
 * Verifies that:
 *  - Action Proposals page renders the human-approval queue (not a stub)
 *  - Feed page renders aggregated activity (not a stub)
 *
 * Both pages previously showed "coming soon" style placeholders; after the
 * CUJ-B work they wire up to /api/companies/:id/action-proposals and
 * /api/companies/:id/feed respectively.
 *
 * Requires: dev server running with at least one company seeded.
 */

test.describe("CUJ-B: agent governance", () => {
  test("action proposals page renders approval queue UI", async ({ page, prefix }) => {
    await navigateAndWait(page, "/action-proposals", prefix);
    await page.waitForLoadState("networkidle");

    // No "coming soon" copy anywhere on the page.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // The page header should be visible.
    await expect(page.getByRole("heading", { name: /action proposals/i })).toBeVisible();

    // Status filter controls should be present (pending / approved / rejected).
    await expect(page.getByRole("button", { name: /pending/i }).first()).toBeVisible();
  });

  test("feed page renders activity feed UI", async ({ page, prefix }) => {
    await navigateAndWait(page, "/feed", prefix);
    await page.waitForLoadState("networkidle");

    // No stub copy.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // The page header should be visible.
    await expect(page.getByRole("heading", { name: /feed|activity/i }).first()).toBeVisible();
  });
});
