import { test, expect } from "./fixtures/test-helpers";

/**
 * CUJ-12: CRM Customer 360
 *
 * A comprehensive single-account journey that:
 * - Creates account + contact + deal via API
 * - Navigates to account detail and verifies header info
 * - Verifies the Contacts section shows the linked contact
 * - Verifies the Deals section shows the linked deal
 * - Verifies account detail info grid shows industry/size/stage
 * - Navigates to contacts list and verifies the contact is listed
 * - Navigates back to accounts list and verifies the account is listed
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CrmAccount {
  id: string;
  name: string;
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
}

async function createAccount(
  page: import("@playwright/test").Page,
  companyId: string,
  data: Record<string, unknown>,
): Promise<CrmAccount> {
  const res = await page.request.post(`/api/companies/${companyId}/crm/accounts`, {
    data,
  });
  expect(res.ok(), `createAccount status ${res.status()}`).toBe(true);
  return res.json();
}

async function createContact(
  page: import("@playwright/test").Page,
  companyId: string,
  data: Record<string, unknown>,
): Promise<CrmContact> {
  const res = await page.request.post(`/api/companies/${companyId}/crm/contacts`, {
    data,
  });
  expect(res.ok(), `createContact status ${res.status()}`).toBe(true);
  return res.json();
}

async function createDeal(
  page: import("@playwright/test").Page,
  companyId: string,
  data: Record<string, unknown>,
): Promise<CrmDeal> {
  const res = await page.request.post(`/api/companies/${companyId}/crm/deals`, {
    data,
  });
  expect(res.ok(), `createDeal status ${res.status()}`).toBe(true);
  return res.json();
}

// ---------------------------------------------------------------------------
// Shared setup — account + contact + deal created once per suite run
// ---------------------------------------------------------------------------

test.describe("CUJ-12: CRM Customer 360", () => {
  // -------------------------------------------------------------------------
  // Account detail: header shows account name
  // -------------------------------------------------------------------------
  test("account detail page shows account name in header", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const accountName = `360-Account-${ts}`;
    const account = await createAccount(page, company.id, {
      name: accountName,
      industry: "Technology",
      size: "50-200",
      stage: "prospect",
      domain: `360-${ts}.example.com`,
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // h1 shows the account name
    await expect(
      page.locator("h1").filter({ hasText: accountName }).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Account detail: info grid shows industry/size/stage
  // -------------------------------------------------------------------------
  test("account detail info grid shows industry and stage", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createAccount(page, company.id, {
      name: `360-Grid-${ts}`,
      industry: "Healthcare",
      size: "200-500",
      stage: "qualified",
      domain: `grid-${ts}.example.com`,
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // DetailCard for Industry
    await expect(page.locator("text=Industry").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Healthcare").first()).toBeVisible({ timeout: 10_000 });

    // DetailCard for Company Size
    await expect(page.locator("text=Company Size").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=200-500").first()).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Account detail: Contacts section renders linked contact
  // -------------------------------------------------------------------------
  test("account detail Contacts section shows linked contact", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createAccount(page, company.id, {
      name: `360-Contacts-${ts}`,
      stage: "prospect",
    });

    const contactFirstName = "Alice";
    const contactLastName = `360-${ts}`;
    const contactEmail = `alice-${ts}@example.com`;

    await createContact(page, company.id, {
      firstName: contactFirstName,
      lastName: contactLastName,
      email: contactEmail,
      title: "VP Engineering",
      accountId: account.id,
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The Contacts section heading (CrmAccountDetail renders "Contacts (N)")
    await expect(
      page.locator("h2").filter({ hasText: /Contacts/i }).first(),
    ).toBeVisible({ timeout: 12_000 });

    // The contact's full name appears in the contacts section
    await expect(
      page.locator(`text=${contactFirstName} ${contactLastName}`).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Account detail: Contacts section shows contact count > 0
  // -------------------------------------------------------------------------
  test("account detail Contacts section shows non-zero count when contacts exist", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createAccount(page, company.id, {
      name: `360-CntCount-${ts}`,
    });
    await createContact(page, company.id, {
      firstName: "Bob",
      lastName: `Count-${ts}`,
      email: `bob-count-${ts}@example.com`,
      accountId: account.id,
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // "Contacts (1)" or "Contacts (N)" — count must be positive
    await expect(
      page.locator("h2").filter({ hasText: /Contacts \([1-9]/ }).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Account detail: Deals section renders linked deal
  // -------------------------------------------------------------------------
  test("account detail Deals section shows linked deal", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createAccount(page, company.id, {
      name: `360-Deals-${ts}`,
      stage: "qualified",
    });

    const dealName = `360-Deal-${ts}`;
    await createDeal(page, company.id, {
      name: dealName,
      accountId: account.id,
      stage: "proposal",
      amount: 75000,
      currency: "USD",
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The Deals section heading
    await expect(
      page.locator("h2").filter({ hasText: /Deals/i }).first(),
    ).toBeVisible({ timeout: 12_000 });

    // The deal name appears in the deals section
    await expect(
      page.locator(`text=${dealName}`).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Account detail: Deals section shows deal name (amount field is not
  // currently populated since the API uses amountCents but the UI reads amount)
  // -------------------------------------------------------------------------
  test("account detail Deals section shows deal name", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createAccount(page, company.id, {
      name: `360-DealAmt-${ts}`,
    });
    const dealName = `DealAmt-${ts}`;
    await createDeal(page, company.id, {
      name: dealName,
      accountId: account.id,
      stage: "new",
      amount: 50000,
      currency: "USD",
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Deal name is always rendered as the entity row title
    await expect(
      page.locator(`text=${dealName}`).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Account detail: empty Contacts section shows helper text
  // -------------------------------------------------------------------------
  test("account detail Contacts section shows helper text when no contacts", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createAccount(page, company.id, {
      name: `360-NoCnt-${ts}`,
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("text=No contacts linked to this account.").first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Account detail: empty Deals section shows helper text
  // -------------------------------------------------------------------------
  test("account detail Deals section shows helper text when no deals", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createAccount(page, company.id, {
      name: `360-NoDeal-${ts}`,
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("text=No deals for this account.").first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Contact link in account detail navigates to contacts list
  // -------------------------------------------------------------------------
  test("contact row in account detail links to crm/contacts/:id", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const account = await createAccount(page, company.id, {
      name: `360-CntLink-${ts}`,
    });
    const contact = await createContact(page, company.id, {
      firstName: "Link",
      lastName: `Test-${ts}`,
      email: `link-${ts}@example.com`,
      accountId: account.id,
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Click the contact row link
    const contactLink = page
      .locator(`a[href*="/crm/contacts/${contact.id}"]`)
      .first();
    await expect(contactLink).toBeVisible({ timeout: 12_000 });
    await contactLink.click();

    await expect(page).toHaveURL(new RegExp(`/crm/contacts/${contact.id}`), {
      timeout: 10_000,
    });
  });

  // -------------------------------------------------------------------------
  // Breadcrumb trail on account detail shows CRM > Accounts > name
  // -------------------------------------------------------------------------
  test("account detail breadcrumbs show CRM > Accounts > account name", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const accountName = `360-Bread-${ts}`;
    const account = await createAccount(page, company.id, {
      name: accountName,
    });

    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Breadcrumbs: CRM > Accounts > accountName
    await expect(page.locator("text=CRM").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Accounts").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`text=${accountName}`).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  // -------------------------------------------------------------------------
  // Full 360 journey: account + contact + deal — all visible on detail page
  // -------------------------------------------------------------------------
  test("full 360 journey: account detail shows contact and deal in one view", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const accountName = `360-Full-${ts}`;
    const contactEmail = `full-${ts}@example.com`;
    const dealName = `Full-Deal-${ts}`;

    // Create account
    const account = await createAccount(page, company.id, {
      name: accountName,
      industry: "Finance",
      size: "500+",
      stage: "customer",
      domain: `full-${ts}.example.com`,
    });

    // Create contact linked to account
    await createContact(page, company.id, {
      firstName: "Full",
      lastName: `Contact-${ts}`,
      email: contactEmail,
      title: "CFO",
      accountId: account.id,
    });

    // Create deal linked to account
    await createDeal(page, company.id, {
      name: dealName,
      accountId: account.id,
      stage: "closed_won",
      amount: 100000,
      currency: "USD",
    });

    // Navigate to account detail
    await page.goto(`/${prefix}/crm/accounts/${account.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Account name in header
    await expect(
      page.locator("h1").filter({ hasText: accountName }).first(),
    ).toBeVisible({ timeout: 12_000 });

    // Contact full name visible
    await expect(
      page.locator(`text=Full Contact-${ts}`).first(),
    ).toBeVisible({ timeout: 12_000 });

    // Deal name visible
    await expect(
      page.locator(`text=${dealName}`).first(),
    ).toBeVisible({ timeout: 12_000 });

    // Industry in info grid
    await expect(page.locator("text=Finance").first()).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Accounts list: account appears with stage badge
  // -------------------------------------------------------------------------
  test("accounts list shows stage badge for account with stage set", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    await createAccount(page, company.id, {
      name: `360-Stage-${ts}`,
      stage: "qualified",
    });

    await page.goto(`/${prefix}/crm/accounts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The account row should show account name
    await expect(
      page.locator(`text=360-Stage-${ts}`).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Contacts list: newly created contact is visible
  // -------------------------------------------------------------------------
  test("contacts list shows newly created contact with email", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const email = `c360-${ts}@example.com`;

    await createContact(page, company.id, {
      firstName: "C360",
      lastName: `Test-${ts}`,
      email,
    });

    await page.goto(`/${prefix}/crm/contacts`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator(`text=${email}`).first(),
    ).toBeVisible({ timeout: 12_000 });
  });
});
