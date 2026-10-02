// AgentDash (#767, SC-6): claim link to /cos, then the link is dead.
// Run with tests/e2e/playwright-claim-link.config.ts (see its header).
import { expect, test } from "@playwright/test";

const BASE = process.env.CLAIM_E2E_BASE_URL_RESOLVED ?? process.env.CLAIM_E2E_BASE_URL ?? "";
const EMAIL = process.env.CLAIM_E2E_EMAIL ?? "";
const CODE = process.env.CLAIM_E2E_CODE ?? "";
const PASSWORD = `claim-e2e-${Date.now()}-pw`;

test.skip(!BASE || !EMAIL || !CODE, "needs CLAIM_E2E_EMAIL and CLAIM_E2E_CODE (set by the config for a local run)");

// #836: the control plane's current link form, email in the fragment beside the code.
const link = () => `${BASE}/claim#code=${encodeURIComponent(CODE)}&email=${encodeURIComponent(EMAIL)}`;

test("the claim link creates the founder's account and lands on /cos; the link is then dead", async ({ page, browser, request }) => {
  const before = await (await request.get(`${BASE}/api/health`)).json();
  if (before.hostedBox) expect(before.claimed).toBe(false);

  await page.goto(link());
  await expect(page.getByRole("heading", { name: "Claim your workspace" })).toBeVisible();
  // The code is read from the fragment and dropped from the address bar.
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect(page.locator("#claim-email")).toHaveValue(EMAIL);
  await page.locator("#claim-name").fill("Claim E2E Founder");
  await page.locator("#claim-password").fill(PASSWORD);
  await page.locator("#claim-repeat").fill(PASSWORD);
  await page.getByRole("button", { name: "Claim workspace" }).click();
  // /cos, which the gate may already have moved on to naming the workspace.
  // One onboarding path: never the six-step wizard at /onboarding, hosted or not.
  await page.waitForURL(/\/(cos|company-create)(\b|\/|\?|$)/, { timeout: 60_000 });
  expect(new URL(page.url()).pathname).not.toBe("/onboarding");

  const after = await (await request.get(`${BASE}/api/health`)).json();
  if (after.hostedBox) expect(after.claimed).toBe(true);

  // A second visitor with the same link is refused with a clear message.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.goto(link());
  await page2.locator("#claim-name").fill("Someone Else");
  await page2.locator("#claim-password").fill(PASSWORD);
  await page2.locator("#claim-repeat").fill(PASSWORD);
  await page2.getByRole("button", { name: "Claim workspace" }).click();
  await expect(page2.getByRole("alert")).toContainText(/already been used/);
  await other.close();
});

// AgentDash: first live canary claim. After the claim, the founder names the
// workspace; the server makes them a member and the instance admin. The UI
// used to keep its pre-company access cache and show "No company access"
// until a reload. Also: a box has no www front door (/find, /start).
// One onboarding path: a self-hosted instance (the local run of this config)
// takes the same /company-create → /setup route as a hosted box.
test("after the claim the founder names the workspace and lands in the app, not No company access", async ({ page, request }) => {
  const health = await (await request.get(`${BASE}/api/health`)).json();
  test.skip(health.instanceHasCompany === true, "the box already has a workspace");

  await page.goto(`${BASE}/auth`);
  await page.locator("input[type=email]").fill(EMAIL);
  await page.locator("input[type=password]").fill(PASSWORD);
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(/\/company-create(\b|\/|\?|$)/, { timeout: 60_000 });

  await page.locator("#company-name").fill("Claim E2E Workspace");
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(/\/setup(\b|\/|\?|$)/, { timeout: 60_000 });
  // Give the gate time to re-render on its refreshed data; it must not dead-end.
  await page.waitForTimeout(3_000);
  await expect(page.getByRole("heading", { name: "No company access" })).toHaveCount(0);
  expect(new URL(page.url()).pathname).not.toBe("/auth");
});

test("on a box, the claim page's Sign in and the www-only pages go to the box's own sign-in", async ({ page, request }) => {
  const health = await (await request.get(`${BASE}/api/health`)).json();
  test.skip(!health.hostedBox, "www-only pages render on www");

  await page.goto(`${BASE}/claim`);
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth?next=%2F");

  for (const path of ["/find", "/start", "/start/verify", "/start/progress"]) {
    await page.goto(`${BASE}${path}`);
    await page.waitForURL((url) => url.pathname === "/auth", { timeout: 20_000 });
  }
});
