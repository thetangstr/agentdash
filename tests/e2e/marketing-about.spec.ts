import { test, expect } from "@playwright/test";

test("about page renders mission and founder card", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1, name: /why agentdash exists/i })).toBeVisible();
  await expect(page.getByText(/Who We Are/i)).toBeVisible();
});
