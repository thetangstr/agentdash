// AgentDash: Billing upgrade E2E spec
// Tests the self-serve billing upgrade flow on the Billing page.
// All Stripe API calls are mocked via page.route() — no real Stripe requests made.
//
// Scenarios:
//   1. Free user sees Pro/Enterprise upgrade CTAs
//   2. Clicking "Upgrade to Pro" calls POST /billing/checkout-session (mocked)
//   3. When entitlements returns active + stripeCustomerId → "Manage Subscription" visible
//   4. When subscriptionStatus = "past_due" → past-due banner visible
//   5. When subscriptionStatus = "canceled" → canceled banner visible

import { test, expect, type Page } from "./fixtures/test-helpers";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

interface Company {
  id: string;
  name: string;
  issuePrefix: string;
}

async function createCompany(page: Page, suffix?: string): Promise<Company> {
  const ts = Date.now();
  const name = `E2E-Billing-${suffix ?? ts}`;
  const prefix = `BL${ts.toString().slice(-4)}`;
  const res = await page.request.post("/api/companies", {
    data: { name, issuePrefix: prefix },
  });
  expect(res.ok(), `create company failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function navigateToBilling(page: Page, prefix: string) {
  await page.goto(`/${prefix}/billing`);
  await page.locator("[data-testid='billing-page']").waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: Free user sees upgrade CTAs
// ---------------------------------------------------------------------------

test.describe("Billing page — free tier", () => {
  test("shows Pro and feature matrix on billing page for free tier", async ({ page }) => {
    const company = await createCompany(page, "free");

    // Force the entitlements API to return free tier
    await page.route(`**/api/companies/${company.id}/entitlements`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tier: "free",
          limits: { agents: 3, monthlyActions: 1000, pipelines: 1 },
          features: {
            hubspotSync: false,
            autoResearch: false,
            assessMode: false,
            prioritySupport: false,
          },
          stripeCustomerId: null,
          subscriptionStatus: null,
          currentPeriodEnd: null,
        }),
      });
    });

    await navigateToBilling(page, company.issuePrefix);

    // Upgrade CTA must be visible
    await expect(page.getByTestId("billing-upgrade")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("billing-upgrade")).toContainText("Upgrade to Pro");

    // Manage Subscription must NOT be visible (no stripeCustomerId)
    await expect(page.getByTestId("billing-manage-subscription")).toHaveCount(0);

    // Feature matrix must be visible
    await expect(page.getByTestId("billing-matrix")).toBeVisible();

    // No status banners for free clean state
    await expect(page.getByTestId("billing-past-due-banner")).toHaveCount(0);
    await expect(page.getByTestId("billing-canceled-banner")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Clicking "Upgrade to Pro" triggers checkout-session API call
// ---------------------------------------------------------------------------

test.describe("Billing page — upgrade to Pro flow", () => {
  test("clicking Upgrade to Pro opens UpgradeDialog and checkout-session is called on confirm", async ({
    page,
  }) => {
    const company = await createCompany(page, "upgrade");

    await page.route(`**/api/companies/${company.id}/entitlements`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tier: "free",
          limits: { agents: 3, monthlyActions: 1000, pipelines: 1 },
          features: {
            hubspotSync: false,
            autoResearch: false,
            assessMode: false,
            prioritySupport: false,
          },
          stripeCustomerId: null,
          subscriptionStatus: null,
          currentPeriodEnd: null,
        }),
      });
    });

    // Mock the checkout-session endpoint — return a fake redirect URL
    let checkoutSessionCalled = false;
    await page.route(
      `**/api/companies/${company.id}/billing/checkout-session`,
      async (route) => {
        checkoutSessionCalled = true;
        const body = route.request().postDataJSON() as { targetTier?: string };
        expect(body.targetTier).toBe("pro");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ url: "https://checkout.stripe.com/pay/cs_test_e2e_stub" }),
        });
      },
    );

    // Intercept the navigation to Stripe so the test doesn't actually redirect
    await page.route("https://checkout.stripe.com/**", async (route) => {
      await route.abort();
    });

    await navigateToBilling(page, company.issuePrefix);

    // Click the Upgrade to Pro button — opens the UpgradeDialog
    const upgradeBtn = page.getByTestId("billing-upgrade");
    await expect(upgradeBtn).toBeVisible({ timeout: 10_000 });
    await upgradeBtn.click();

    // UpgradeDialog must appear
    const dialogTitle = page.getByTestId("upgrade-dialog-title");
    await expect(dialogTitle).toBeVisible({ timeout: 5_000 });
    await expect(dialogTitle).toContainText("Upgrade to Pro");

    // Click the confirm CTA inside the dialog
    const ctaBtn = page.getByTestId("upgrade-cta");
    await expect(ctaBtn).toBeVisible();
    await ctaBtn.click();

    // Wait for the POST to be issued
    await page.waitForTimeout(500);
    expect(checkoutSessionCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Active subscriber sees "Manage Subscription" button
// ---------------------------------------------------------------------------

test.describe("Billing page — active subscription", () => {
  test("shows Manage Subscription button when stripeCustomerId is set and status is active", async ({
    page,
  }) => {
    const company = await createCompany(page, "active");

    await page.route(`**/api/companies/${company.id}/entitlements`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tier: "pro",
          limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
          features: {
            hubspotSync: true,
            autoResearch: true,
            assessMode: true,
            prioritySupport: false,
          },
          stripeCustomerId: "cus_e2e_test_active",
          subscriptionStatus: "active",
          currentPeriodEnd: "2026-07-01T00:00:00.000Z",
        }),
      });
    });

    await navigateToBilling(page, company.issuePrefix);

    // Manage Subscription button must be visible
    await expect(page.getByTestId("billing-manage-subscription")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("billing-manage-subscription")).toContainText(
      "Manage Subscription",
    );

    // Renewal date must be visible
    await expect(page.getByTestId("billing-renewal-date")).toBeVisible();
    await expect(page.getByTestId("billing-renewal-date")).toContainText("Renews on");

    // No banners for healthy active state
    await expect(page.getByTestId("billing-past-due-banner")).toHaveCount(0);
    await expect(page.getByTestId("billing-canceled-banner")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: past_due → banner visible
// ---------------------------------------------------------------------------

test.describe("Billing page — past due subscription", () => {
  test("shows past-due banner when subscriptionStatus is past_due", async ({ page }) => {
    const company = await createCompany(page, "pastdue");

    await page.route(`**/api/companies/${company.id}/entitlements`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tier: "pro",
          limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
          features: {
            hubspotSync: true,
            autoResearch: true,
            assessMode: true,
            prioritySupport: false,
          },
          stripeCustomerId: "cus_e2e_pastdue",
          subscriptionStatus: "past_due",
          currentPeriodEnd: null,
        }),
      });
    });

    await navigateToBilling(page, company.issuePrefix);

    await expect(page.getByTestId("billing-past-due-banner")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("billing-past-due-banner")).toContainText("Payment past due");

    // Canceled banner must NOT be present
    await expect(page.getByTestId("billing-canceled-banner")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: canceled → banner visible
// ---------------------------------------------------------------------------

test.describe("Billing page — canceled subscription", () => {
  test("shows canceled banner when subscriptionStatus is canceled", async ({ page }) => {
    const company = await createCompany(page, "canceled");

    await page.route(`**/api/companies/${company.id}/entitlements`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tier: "free",
          limits: { agents: 3, monthlyActions: 1000, pipelines: 1 },
          features: {
            hubspotSync: false,
            autoResearch: false,
            assessMode: false,
            prioritySupport: false,
          },
          stripeCustomerId: "cus_e2e_canceled",
          subscriptionStatus: "canceled",
          currentPeriodEnd: "2026-05-01T00:00:00.000Z",
        }),
      });
    });

    await navigateToBilling(page, company.issuePrefix);

    await expect(page.getByTestId("billing-canceled-banner")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("billing-canceled-banner")).toContainText(
      "Subscription canceled",
    );
    // Date should appear in the banner
    await expect(page.getByTestId("billing-canceled-banner")).toContainText("May 1, 2026");

    // Past-due banner must NOT be present
    await expect(page.getByTestId("billing-past-due-banner")).toHaveCount(0);
  });
});
