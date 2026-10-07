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
    await expect(page.locator("body")).not.toContainText(/Placeholder|Logo 1/);
    await expect(page.locator('a[href*="sign_up"]')).toHaveCount(0);
    // SC-9 (GH #770): "Start free" goes to the self-serve front door, "Sign in" to /find.
    await expect(page.locator(".mkt-hero").getByRole("link", { name: "Start free" })).toHaveAttribute("href", "/start");
    await expect(page.locator(".mkt-header__cta").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/find");
    await expect(page.locator('a[href="/auth"]')).toHaveCount(0);
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
    for (const path of ["/about", "/consulting", "/mcp", "/whats-new", "/whats-new/launch-week"]) {
      await page.goto(path);
      await expect(page.locator(".mkt-root")).toBeVisible();
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator("body")).not.toContainText(/\[Founder|Placeholder/);
    }
  });
});


test.describe("What's new launch update", () => {
  test("is discoverable, links its source notes, and lets readers use the illustrations", async ({ page }) => {
    await page.goto("/whats-new");
    await expect(page).toHaveTitle(/What's new/);
    await expect(page.locator(".mkt-header__nav").getByRole("link", { name: "What’s new" })).toHaveAttribute("href", "/whats-new");
    await page.getByRole("link", { name: "Read the update" }).click();
    await expect(page).toHaveURL(/\/whats-new\/launch-week$/);
    await expect(page.locator("h1")).toContainText("Find your team");
    await expect(page.locator("figure figcaption")).toHaveCount(2);
    for (const caption of await page.locator("figure figcaption").allTextContents()) expect(caption).toContain("Simulated illustration");
    await expect(page.getByRole("link", { name: "v2026.1007.1 release notes" })).toHaveAttribute("href", /\/blob\/main\/releases\/v2026.1007.1.md$/);

    const teams = page.getByRole("figure", { name: "Team sidebar example" });
    const team = teams.locator("details").first();
    await team.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(team).not.toHaveAttribute("open");
    await expect(teams.locator('[aria-current="true"]')).toBeVisible();

    const transcript = page.getByRole("figure", { name: "Transcript following example" });
    await transcript.scrollIntoViewIfNeeded();
    await transcript.getByRole("button", { name: "Play output" }).click();
    await transcript.getByRole("button", { name: "Read earlier" }).click();
    await expect(transcript.getByRole("status")).toContainText("Following paused");
    const pane = transcript.getByRole("region");
    const heldTop = await pane.evaluate((element) => element.scrollTop);
    await expect(pane).toContainText("Draft prepared");
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(heldTop);
    await expect(pane).toContainText("Update ready to read");
    await transcript.getByRole("button", { name: "Jump to latest" }).click();
    await expect(transcript.getByRole("status")).toContainText("Following latest");
    await expect.poll(() => pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    // Browser wheel input releases follow without using the helper button.
    await pane.hover();
    await page.mouse.wheel(0, -200);
    await expect(transcript.getByRole("status")).toContainText("Following paused");
  });

  test("supports reduced motion, keyboard controls, and phone/tablet layouts", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [390, 900, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/whats-new/launch-week");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await expect(page.locator(".mkt-header__toggle")).toBeVisible();
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(page.locator(".mkt-header__sheet").getByRole("link", { name: "What’s new" })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const transcript = page.getByRole("figure", { name: "Transcript following example" });
    await transcript.getByRole("button", { name: "Next output" }).focus();
    await page.keyboard.press("Enter");
    await expect(transcript).toContainText("Draft prepared");
    await expect(transcript.getByRole("button", { name: "Play output" })).toHaveCount(0);
  });
});
