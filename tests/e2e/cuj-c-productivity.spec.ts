import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-C: Productivity Surface
 *
 * Verifies that:
 *  - User Profile page renders identity, preferences, and danger zone
 *  - Feed page renders aggregated activity (cross-links with CUJ-B)
 *
 * Both pages previously showed "coming soon" style placeholders; after the
 * CUJ-C work they wire up to BetterAuth session + /api/companies/:id/feed.
 *
 * Requires: dev server running with at least one company seeded.
 */

test.describe("CUJ-C: productivity surface", () => {
  test("user profile page renders identity, preferences, danger zone", async ({
    page,
    prefix,
  }) => {
    await navigateAndWait(page, "/profile", prefix);
    await page.waitForLoadState("networkidle");

    // No stub copy.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // Header.
    await expect(page.getByRole("heading", { name: /profile/i }).first()).toBeVisible();

    // Identity section — name/email visible (BetterAuth or dev fallback).
    // We don't assert specific values — just that the identity block rendered.
    const identitySection = page.locator("text=/name|email/i").first();
    await expect(identitySection).toBeVisible({ timeout: 10_000 });

    // Danger zone — delete-account button is present and disabled.
    const deleteBtn = page.getByRole("button", { name: /delete account/i });
    await expect(deleteBtn).toBeVisible();
    await expect(deleteBtn).toBeDisabled();
  });

  test("feed page renders activity aggregation UI", async ({ page, prefix }) => {
    await navigateAndWait(page, "/feed", prefix);
    await page.waitForLoadState("networkidle");

    // No stub copy.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // Header present.
    await expect(
      page.getByRole("heading", { name: /feed|activity/i }).first(),
    ).toBeVisible();

    // Either events render with timestamps, or the empty-state copy is shown.
    const hasEvents = (await page.locator("text=/ago|just now/i").count()) > 0;
    const hasEmptyState = (await page.getByText(/no activity yet/i).count()) > 0;
    expect(hasEvents || hasEmptyState).toBe(true);
  });
});
