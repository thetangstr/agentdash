import { test, expect } from "@playwright/test";

test("consulting → run the assessment lands on /assess", async ({ page }) => {
  await page.goto("/consulting");
  await page.getByRole("link", { name: "Run the assessment" }).click();
  await expect(page).toHaveURL(/\/assess$/);
});

test("consulting page contains all 4 phase names", async ({ page }) => {
  await page.goto("/consulting");
  for (const name of ["Diagnose", "Design", "Deploy", "Operate"]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
});
