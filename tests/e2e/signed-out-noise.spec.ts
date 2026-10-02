// AgentDash (scan 4, lane O2): a signed-out visitor on /auth used to fire
// GET /api/companies (43x) and GET /api/adapters (15x), each a 403. The
// sign-in page asks only what a visitor may ask.
// Run with tests/e2e/playwright-signed-out.config.ts (see its header).
import { expect, test } from "@playwright/test";

// The session check answers 401 for a visitor by design; that is the question, not noise.
const EXPECTED_FOR_VISITOR = new Set(["/api/auth/get-session"]);

test("the signed-out /auth page makes no 4xx API calls", async ({ page }) => {
  const failures: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    if (response.status() < 400 || response.status() >= 500) return;
    if (EXPECTED_FOR_VISITOR.has(url.pathname)) return;
    failures.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
  });

  await page.goto("/auth");
  await expect(page.locator("input[type=email]")).toBeVisible();
  // Long enough for retries and refetches to have shown up before the fix.
  await page.waitForTimeout(4_000);

  expect(failures).toEqual([]);
});
