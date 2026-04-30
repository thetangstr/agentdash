import { test, expect } from "@playwright/test";

test.describe("layered descent", () => {
  test("all 7 layer names appear in the DOM after scrolling", async ({ page }) => {
    await page.goto("/?preview=1");
    await page.locator("#layered-descent").scrollIntoViewIfNeeded();
    // Scroll past the descent so every layer has been activated at least once.
    await page.evaluate(() => window.scrollBy(0, 7000));
    const expected = [
      "Control Plane", "Orchestration", "Workspaces & Adapters",
      "Agent Primitives", "Interop", "Trust & Safety", "Model Serving",
    ];
    for (const name of expected) {
      await expect(page.getByRole("heading", { name })).toBeAttached();
    }
  });

  test("clicking 'See the architecture' anchors to #layered-descent", async ({ page }) => {
    await page.goto("/?preview=1");
    await page.getByRole("link", { name: "See the architecture" }).click();
    await expect(page).toHaveURL(/#layered-descent$/);
  });
});
