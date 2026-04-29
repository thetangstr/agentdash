import { test, expect } from "@playwright/test";

/**
 * Marketing routing smoke: confirms the public marketing pages mount under
 * `/`, `/consulting`, and `/about` and that the header CTA points at the
 * sign-up route. Uses Playwright's stock `test`/`expect` (no MAW fixtures)
 * because these pages are unprefixed and unauthenticated.
 */
test.describe("marketing routing", () => {
  test("logged-out / shows the landing page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("/consulting renders", async ({ page }) => {
    await page.goto("/consulting");
    await expect(page.getByRole("heading", { level: 1, name: /consulting/i })).toBeVisible();
  });

  test("/about renders", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByRole("heading", { level: 1, name: /about/i })).toBeVisible();
  });

  test("clicking Start free in header navigates to /auth?mode=sign_up", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Start free" }).first().click();
    await expect(page).toHaveURL(/\/auth\?mode=sign_up/);
  });
});
