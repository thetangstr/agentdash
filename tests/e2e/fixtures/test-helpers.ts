import { test as base, expect, type Page } from "@playwright/test";

/**
 * Shared helpers for AgentDash CUJ e2e tests.
 *
 * All tests assume the dev server is running at localhost:3100 with at least
 * one seeded company (MKthink, prefix MKT). Routes live under /:issuePrefix/.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestCompany {
  id: string;
  name: string;
  issuePrefix: string;
  status?: string;
}

export interface TestAgent {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface TestIssue {
  id: string;
  title: string;
  status: string;
}

// ---------------------------------------------------------------------------
// API helpers (run against the live server through page.request)
// ---------------------------------------------------------------------------

export async function getCompanies(page: Page): Promise<TestCompany[]> {
  const res = await page.request.get("/api/companies");
  expect(res.ok()).toBe(true);
  return res.json();
}

export async function getFirstCompany(page: Page): Promise<TestCompany> {
  const companies = await getCompanies(page);
  expect(companies.length).toBeGreaterThan(0);
  const active = companies.find((c) => !c.status || c.status === "active");
  return active ?? companies[0];
}

export async function getAgents(page: Page, companyId: string): Promise<TestAgent[]> {
  const res = await page.request.get(`/api/companies/${companyId}/agents`);
  expect(res.ok()).toBe(true);
  return res.json();
}

export async function getIssues(page: Page, companyId: string): Promise<TestIssue[]> {
  const res = await page.request.get(`/api/companies/${companyId}/issues`);
  expect(res.ok()).toBe(true);
  return res.json();
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to a board-scoped path and wait for the layout to render.
 * Paths are auto-prefixed with the company issuePrefix: /MKT/dashboard
 */
export async function navigateAndWait(page: Page, path: string, prefix?: string) {
  const pfx = prefix ?? "MKT";
  // Ensure path starts with / and prefix it
  const fullPath = `/${pfx}${path.startsWith("/") ? path : "/" + path}`;
  await page.goto(fullPath);
  // Wait for sidebar nav to appear — the Layout wrapper renders <nav>
  await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });
}

/** Wait for the page to settle (no pending network requests). */
export async function waitForSettle(page: Page, ms = 1_000) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Extended test fixture with company context
// ---------------------------------------------------------------------------

type CujFixtures = {
  company: TestCompany;
  prefix: string;
};

export const test = base.extend<CujFixtures>({
  company: async ({ page }, use) => {
    // Navigate to root first so page.request has a base URL resolved
    await page.goto("/");
    const company = await getFirstCompany(page);
    await use(company);
  },
  prefix: async ({ company }, use) => {
    await use(company.issuePrefix);
  },
});

export { expect };
