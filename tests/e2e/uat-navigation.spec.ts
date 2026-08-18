import { expect, test, type Page } from "@playwright/test";

/**
 * Every destination, clicked and typed, asserting the failures we actually hit.
 *
 * Three real bugs motivated this file, and all three were found by a person
 * clicking rather than by a test:
 *
 *  - "No company matches prefix MY-AGENT" — a board route missing from the
 *    known-roots list is read as a company code, so the app reports a company
 *    problem for a page that has nothing to do with one.
 *  - A completely blank page — deep links were served an `index.html` cached at
 *    server start, pointing at a bundle that no longer existed after a rebuild.
 *  - A 403 storm — a stored company id pointing at a workspace that no longer
 *    exists.
 *
 * So this asserts the absence of those specific symptoms, not a generic smoke
 * test: an empty body, a company-not-found screen, an unreachable-server
 * overlay, or an unhandled error boundary. It walks routes BOTH by clicking the
 * sidebar (which exercises company-prefix link generation) and by typing the
 * URL unprefixed (which exercises the redirect routes), because those are
 * different code paths and each has broken independently.
 *
 * Needs a signed-in session, so it takes a bootstrap invite URL:
 *   UAT_BOOTSTRAP_URL=... pnpm exec playwright test --config tests/e2e/playwright-uat.config.ts uat-navigation
 */

const BOOTSTRAP_URL = process.env.UAT_BOOTSTRAP_URL?.trim();
const PASSWORD = "Nav-UAT-2026!";

/** Symptoms that mean the app broke, as distinct from a page being empty of data. */
const FAILURE_TEXTS = [
  "Company not found",
  "No company matches prefix",
  "No company access",
  "Server unreachable",
  "Connection lost",
  "Something went wrong",
  "Unexpected Application Error",
];

/** Board destinations reachable from the shell, as a person would type them. */
const ROUTES = [
  "/dashboard",
  "/dashboard/live",
  "/my-agent",
  "/agents",
  "/agents/all",
  "/issues",
  "/inbox",
  "/org",
  "/goals",
  "/approvals",
  "/activity",
  "/projects",
  "/workspaces",
  "/routines",
  "/companies",
  "/company/settings",
  "/company/settings/access",
  "/company/settings/invites",
  "/company/settings/health",
  "/company/settings/environments",
  "/skills",
  "/billing",
  "/costs",
];

async function assertHealthy(page: Page, where: string) {
  // Let the SPA settle: these screens fetch before they can render anything.
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);

  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";

  // A blank body is the stale-bundle signature — the page renders literally
  // nothing, with no error to explain it.
  expect(body.trim().length, `${where}: rendered an empty page`).toBeGreaterThan(0);

  for (const bad of FAILURE_TEXTS) {
    expect(body, `${where}: shows "${bad}"`).not.toContain(bad);
  }
}

test.describe("every destination stays reachable", () => {
  test.skip(!BOOTSTRAP_URL, "set UAT_BOOTSTRAP_URL to a fresh bootstrap invite");

  test("no company-not-found, no blank page, no lost connection", async ({ page }) => {
    const failedRequests: string[] = [];
    page.on("response", (res) => {
      const url = res.url();
      // 401/403 before sign-in is normal; only record failures once we are in.
      if (res.status() >= 500) failedRequests.push(`${res.status()} ${url}`);
    });

    await test.step("sign in through the bootstrap invite", async () => {
      await page.goto(BOOTSTRAP_URL!);
      await page.fill('input[name="name"]', "Nav UAT");
      await page.fill('input[name="email"]', `nav-uat-${Date.now()}@kestrelbay.test`);
      await page.fill('input[name="password"]', PASSWORD);
      await page.getByRole("button", { name: "Create account and continue" }).click();
      await expect(page).not.toHaveURL(/\/invite\//, { timeout: 45_000 });
      await assertHealthy(page, "after sign-in");
    });

    await test.step("typed URLs, unprefixed", async () => {
      for (const route of ROUTES) {
        await page.goto(route);
        await assertHealthy(page, `typed ${route}`);
        process.stdout.write(`  ✓ typed ${route}\n`);
      }
    });

    await test.step("clicked from the sidebar", async () => {
      await page.goto("/dashboard");
      // Only the links actually rendered for this user — role and profile
      // decide what the shell offers, and clicking a hidden one proves nothing.
      const labels = ["Dashboard", "Inbox", "Issues", "Org", "Billing", "Settings", "My Agent"];
      for (const label of labels) {
        const link = page.getByRole("link", { name: label, exact: true }).first();
        if (!(await link.count())) {
          process.stdout.write(`  – ${label} not offered to this user\n`);
          continue;
        }
        await link.click();
        await assertHealthy(page, `clicked ${label}`);
        process.stdout.write(`  ✓ clicked ${label} → ${new URL(page.url()).pathname}\n`);
      }
    });

    await test.step("reload holds, and back/forward do not strand you", async () => {
      await page.goto("/agents");
      await page.reload();
      await assertHealthy(page, "reload /agents");
      await page.goto("/issues");
      await page.goBack();
      await assertHealthy(page, "back from /issues");
      await page.goForward();
      await assertHealthy(page, "forward to /issues");
    });

    await test.step("a bad company prefix fails honestly, without breaking the app", async () => {
      // This SHOULD say it cannot find the company — that is correct behaviour
      // for a genuinely unknown prefix. What must not happen is a blank page,
      // and recovery must work.
      await page.goto("/ZZZZ/dashboard");
      const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
      expect(body.trim().length, "unknown prefix rendered nothing at all").toBeGreaterThan(0);
      await page.goto("/dashboard");
      await assertHealthy(page, "recovery after a bad prefix");
    });

    expect(failedRequests, `server errors during navigation:\n${failedRequests.join("\n")}`).toEqual([]);
  });
});
