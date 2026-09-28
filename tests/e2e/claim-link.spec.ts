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
  await page.waitForURL(/\/cos(\b|\/|\?|$)/, { timeout: 60_000 });

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
