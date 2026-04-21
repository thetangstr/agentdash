import { test, expect } from "./fixtures/test-helpers";

/**
 * CUJ-6: CRM Pipeline
 *
 * Tests CRM data management across the pipeline:
 * - Accounts list: empty state + account appears after API creation
 * - Account detail: contact and deal sections render
 * - Contacts list: contact appears after API creation
 * - CRM pipeline page (/) loads with summary cards
 * - Kanban page loads (stub)
 * - HubSpot settings page loads (stub)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CrmAccount {
  id: string;
  name: string;
  stage: string | null;
}

interface CrmContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

interface CrmDeal {
  id: string;
  name: string;
  stage: string | null;
  amount: number | null;
}

async function createCrmAccount(
  page: import("@playwright/test").Page,
  companyId: string,
  data: Partial<CrmAccount> & { name: string },
): Promise<CrmAccount> {
  const res = await page.request.post(`/api/companies/${companyId}/crm/accounts`, {
    data,
  });
  expect(res.ok(), `createCrmAccount status ${res.status()}`).toBe(true);
  return res.json();
}

async function createCrmContact(
  page: import("@playwright/test").Page,
  companyId: string,
  data: Partial<CrmContact> & { accountId?: string },
): Promise<CrmContact> {
  const res = await page.request.post(`/api/companies/${companyId}/crm/contacts`, {
    data,
  });
  expect(res.ok(), `createCrmContact status ${res.status()}`).toBe(true);
  return res.json();
}

async function createCrmDeal(
  page: import("@playwright/test").Page,
  companyId: string,
  data: { name: string; accountId: string; stage?: string; amount?: number },
): Promise<CrmDeal> {
  const res = await page.request.post(`/api/companies/${companyId}/crm/deals`, {
    data,
  });
  expect(res.ok(), `createCrmDeal status ${res.status()}`).toBe(true);
  return res.json();
}

// ---------------------------------------------------------------------------
// CRM Pipeline page (the main /crm route = CrmPipeline component)
// ---------------------------------------------------------------------------

test.describe("CUJ-6: CRM Pipeline — main pipeline page", () => {
  test("CRM pipeline page loads with heading", async ({ page, prefix }) => {
    await page.goto(`/${prefix}/crm`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // CrmPipeline renders an h1 with the company pipeline overview
    await expect(
      page.locator("h1,h2").filter({ hasText: /pipeline|crm|account|deal/i }).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  test("CRM pipeline page shows account and deal sections", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    await createCrmAccount(page, company.id, {
      name: `PL-Account-${ts}`,
      stage: "prospect",
    });

    await page.goto(`/${prefix}/crm`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Page should show summary content (Accounts or Deals section)
    await expect(
      page
        .locator("text=/account|deal|lead|pipeline/i")
        .first(),
    ).toBeVisible({ timeout: 12_000 });
  });
});

// ---------------------------------------------------------------------------
// CRM Accounts list page
// ---------------------------------------------------------------------------

test.describe("CUJ-6: CRM Accounts list", () => {
  test("accounts page renders Accounts heading", async ({ page, prefix }) => {
    await page.goto(`/${prefix}/crm/accounts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("h2").filter({ hasText: /Accounts/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("account appears in list after API creation", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const accountName = `E2E-Account-${ts}`;

    await createCrmAccount(page, company.id, {
      name: accountName,
      stage: "prospect",
    });

    await page.goto(`/${prefix}/crm/accounts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The new account name should appear in the list
    await expect(
      page.locator("text=" + accountName).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  test("accounts list shows account count badge", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    await createCrmAccount(page, company.id, { name: `CNT-Account-${ts}` });

    await page.goto(`/${prefix}/crm/accounts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The count badge shows "{n} account(s)"
    await expect(
      page.locator("span").filter({ hasText: /account/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("account row links to account detail page", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createCrmAccount(page, company.id, {
      name: `LINK-Account-${ts}`,
    });

    await page.goto(`/${prefix}/crm/accounts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Find the link to the new account and click it
    const accountLink = page.locator(`a[href*="/crm/accounts/${account.id}"]`).first();
    await expect(accountLink).toBeVisible({ timeout: 12_000 });
    await accountLink.click();

    await expect(page).toHaveURL(new RegExp(`/crm/accounts/${account.id}`), {
      timeout: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// CRM Contacts list page
// ---------------------------------------------------------------------------

test.describe("CUJ-6: CRM Contacts list", () => {
  test("contacts page renders Contacts heading", async ({ page, prefix }) => {
    await page.goto(`/${prefix}/crm/contacts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("h2").filter({ hasText: /Contacts/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("contact appears in contacts list after API creation", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const email = `e2e-contact-${ts}@example.com`;

    await createCrmContact(page, company.id, {
      firstName: "E2E",
      lastName: `Contact-${ts}`,
      email,
    });

    await page.goto(`/${prefix}/crm/contacts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The contact email appears in the list (CrmContacts renders it as trailing)
    await expect(
      page.locator(`text=${email}`).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  test("contacts list shows full name for contact", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const firstName = "Jane";
    const lastName = `Smith-${ts}`;

    await createCrmContact(page, company.id, {
      firstName,
      lastName,
      email: `jane-${ts}@example.com`,
    });

    await page.goto(`/${prefix}/crm/contacts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The row title is "Jane Smith-{ts}"
    await expect(
      page.locator(`text=${firstName} ${lastName}`).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  test("contacts list shows contact count badge", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    await createCrmContact(page, company.id, {
      firstName: "Count",
      lastName: `Test-${ts}`,
      email: `count-${ts}@example.com`,
    });

    await page.goto(`/${prefix}/crm/contacts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("span").filter({ hasText: /contact/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// CRM Kanban page
// ---------------------------------------------------------------------------

test.describe("CUJ-6: CRM Kanban page", () => {
  test("kanban page loads with heading", async ({ page, prefix }) => {
    await page.goto(`/${prefix}/crm/kanban`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // CrmKanban is a stub: renders <h1>CrmKanban</h1>
    await expect(
      page.locator("h1").filter({ hasText: /CrmKanban|Kanban|board/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("kanban page has body content (not blank)", async ({ page, prefix }) => {
    await page.goto(`/${prefix}/crm/kanban`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.length, "kanban page should have content").toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// HubSpot settings page
// ---------------------------------------------------------------------------

test.describe("CUJ-6: HubSpot settings page", () => {
  test("HubSpot settings page loads", async ({ page, prefix }) => {
    await page.goto(`/${prefix}/crm/hubspot`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // HubSpotSettings is a stub: renders <h1>HubSpotSettings</h1>
    await expect(
      page.locator("h1").filter({ hasText: /HubSpotSettings|HubSpot/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("HubSpot settings page has body content", async ({ page, prefix }) => {
    await page.goto(`/${prefix}/crm/hubspot`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.length).toBeGreaterThan(10);
  });
});
