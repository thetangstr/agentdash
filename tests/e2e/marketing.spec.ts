import { expect, test, type Page } from "@playwright/test";

/**
 * Public marketing surface. These pages never need a company or a session, so
 * the checks run against the throwaway local_trusted instance the default
 * config boots. `?preview=1` keeps the landing page from redirecting the
 * implicitly-logged-in local user to /companies.
 */

async function clickDemoButton(page: Page, pattern: RegExp) {
  await page.locator("#demo button, .mkt-demo button").filter({ hasText: pattern }).first().click();
}

test.describe("marketing site", () => {
  test("landing leads with the steward story and honest calls to action", async ({ page }) => {
    await page.goto("/?preview=1");
    await expect(page.locator("h1")).toContainText("Chief of Staff");
    await expect(page).toHaveTitle(/Chief of Staff/);
    await expect(page.locator("main")).toContainText("Simulated walkthrough");
    await expect(page.locator("main")).toContainText("Self-hosted and open source today");
    await expect(page.locator("body")).not.toContainText(/Start free|Placeholder|Logo 1/);
    await expect(page.locator('a[href*="sign_up"]')).toHaveCount(0);
    await expect(page.locator('a[href^="mailto:"]').first()).toBeVisible();
    await expect(page.locator('a[href="/demo"]').first()).toBeVisible();
  });

  test("interactive demo runs request → delegate → decide → result", async ({ page }) => {
    await page.goto("/?preview=1");
    await page.locator("#demo").scrollIntoViewIfNeeded();
    await clickDemoButton(page, /^Send:/);
    await expect(page.locator("#demo .mkt-term")).toContainText("inbox_propose");
    await clickDemoButton(page, /Reply “yes”/);
    await expect(page.locator("#demo .mkt-term")).toContainText("inbox_confirm");
    await clickDemoButton(page, /Skip ahead/);
    await expect(page.locator("#demo .mkt-approval")).toBeVisible();
    await expect(page.locator("#demo .mkt-term")).toContainText("inbox_sync");
    await expect(page.locator("#demo .mkt-deliverable")).toHaveCount(0);
    await clickDemoButton(page, /Reply “approve”/);
    await clickDemoButton(page, /Skip ahead/);
    await expect(page.locator("#demo .mkt-deliverable")).toBeVisible();
    await expect(page.locator("#demo .mkt-term")).toContainText("inbox_decide");
    await expect(page.locator("#demo .mkt-issue.is-done")).toHaveCount(4);
  });

  test("demo page explains what is real behind each step", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("h1")).toContainText("Chief of Staff");
    await expect(page.locator(".mkt-behind")).toContainText("inbox_propose");
    await expect(page.locator(".mkt-behind")).toContainText("Simulated here");
  });

  test("mobile layout has no horizontal overflow and a working menu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?preview=1");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    const toggle = page.locator(".mkt-header__toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator(".mkt-header__sheet")).toBeVisible();
    await expect(page.locator(".mkt-header__sheet")).toContainText("Demo");
    await page.keyboard.press("Escape");
    await expect(page.locator(".mkt-header__sheet")).toBeHidden();
  });

  test("secondary pages render on the marketing shell", async ({ page }) => {
    for (const path of ["/about", "/consulting", "/mcp"]) {
      await page.goto(path);
      await expect(page.locator(".mkt-root")).toBeVisible();
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator("body")).not.toContainText(/\[Founder|Placeholder/);
    }
  });
});
