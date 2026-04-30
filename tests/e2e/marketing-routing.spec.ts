import { test, expect } from "@playwright/test";

/**
 * Marketing routing smoke. The CI dev server runs in `local_trusted`
 * deployment mode, where the user is implicitly "logged in" and visiting
 * `/` redirects to `/companies`. The Landing page exposes a `?preview=1`
 * escape that bypasses the redirect for design QA — we use that here so
 * the landing markup is reachable in CI.
 */
test.describe("marketing routing", () => {
  test("logged-out / shows the landing page", async ({ page }) => {
    await page.goto("/?preview=1");
    await expect(page.getByRole("heading", { level: 1, name: /run an ai workforce/i })).toBeVisible();
  });

  test("/consulting renders", async ({ page }) => {
    await page.goto("/consulting");
    await expect(page.getByRole("heading", { level: 1, name: /install ai workforces/i })).toBeVisible();
  });

  test("/about renders", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByRole("heading", { level: 1, name: /why agentdash exists/i })).toBeVisible();
  });

  test("clicking Start free in header navigates to /auth?mode=sign_up", async ({ page }) => {
    await page.goto("/?preview=1");
    await page.getByRole("link", { name: "Start free" }).first().click();
    await expect(page).toHaveURL(/\/auth\?mode=sign_up/);
  });
});
