import { test, expect } from "@playwright/test";

/**
 * CUJ-2: Daily Dashboard
 *
 * The Dashboard page (/:prefix/dashboard) renders:
 *   - Greeting: "Good morning/afternoon/evening" + company name + date
 *   - "All clear" panel OR "Needs your attention" items (agent errors, blocked tasks, budget incidents, pending approvals)
 *   - TEAM section: agent status dots + count summary, "View all" link
 *   - THIS MONTH stats: tasks completed card + spend card
 *   - RECENT ACTIVITY section (when activity exists) with "View all" link
 *
 * Tests create isolated companies via API and navigate directly to /:prefix/dashboard.
 * Assertions verify real rendered content so regressions (missing onClick, broken API
 * queries, broken navigation links) are caught before users see them.
 */

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

interface Company { id: string; name: string; issuePrefix: string }
interface Agent { id: string; name: string }

async function createCompany(page: import("@playwright/test").Page, suffix?: string): Promise<Company> {
  const ts = Date.now();
  const name = `E2E-Dashboard-${suffix ?? ts}`;
  // Use last 4 digits of timestamp to stay within typical prefix length limits
  const prefix = `ED${ts.toString().slice(-4)}`;
  const res = await page.request.post("/api/companies", {
    data: { name, issuePrefix: prefix },
  });
  expect(res.ok(), `create company failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function createAgent(
  page: import("@playwright/test").Page,
  companyId: string,
  name: string,
  role = "engineer",
): Promise<Agent> {
  const res = await page.request.post(`/api/companies/${companyId}/agents`, {
    data: { name, role, adapterType: "process", adapterConfig: {} },
  });
  expect(res.ok(), `create agent "${name}" failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function createIssue(
  page: import("@playwright/test").Page,
  companyId: string,
  title: string,
  assigneeAgentId?: string,
) {
  const res = await page.request.post(`/api/companies/${companyId}/issues`, {
    data: { title, assigneeAgentId: assigneeAgentId ?? null },
  });
  expect(res.ok(), `create issue "${title}" failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function navigateToDashboard(page: import("@playwright/test").Page, prefix: string) {
  await page.goto(`/${prefix}/dashboard`);
  await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("CUJ-2: Daily Dashboard", () => {
  // --------------------------------------------------------------------------
  // Greeting
  // --------------------------------------------------------------------------

  test("shows time-of-day greeting with company name and date", async ({ page }) => {
    const company = await createCompany(page, "greet");
    await navigateToDashboard(page, company.issuePrefix);

    // Greeting must be one of the three time-based phrases
    await expect(
      page.locator("h1", { hasText: /Good morning|Good afternoon|Good evening/ })
    ).toBeVisible({ timeout: 10_000 });

    // Company name appears in the subtitle line
    await expect(page.locator(`text=${company.name}`)).toBeVisible({ timeout: 5_000 });

    // Current weekday name is present somewhere on the page
    const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const todayName = weekdays[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
    await expect(page.locator(`text=${todayName}`).first()).toBeVisible({ timeout: 5_000 });
  });

  // --------------------------------------------------------------------------
  // All-clear panel (fresh company with no issues/errors)
  // --------------------------------------------------------------------------

  test("shows All clear panel for a fresh company with no attention items", async ({ page }) => {
    const company = await createCompany(page, "clear");
    await navigateToDashboard(page, company.issuePrefix);

    await expect(
      page.locator("text=All clear — nothing needs your attention right now.")
    ).toBeVisible({ timeout: 10_000 });
  });

  // --------------------------------------------------------------------------
  // No-agents banner
  // --------------------------------------------------------------------------

  test("shows no-agents banner with Create one link for a company without agents", async ({ page }) => {
    const company = await createCompany(page, "noagent");
    await navigateToDashboard(page, company.issuePrefix);

    await expect(page.locator("text=No agents yet.")).toBeVisible({ timeout: 10_000 });
    const createLink = page.locator("button", { hasText: "Create one" });
    await expect(createLink).toBeVisible();
    // The button must have a real onClick handler — clicking it should open a dialog
    // (openOnboarding is called). We verify the dialog appears, not just that the
    // button renders, so a missing handler is caught.
    await createLink.click();
    // The onboarding dialog or wizard heading should appear
    await expect(
      page.locator("text=/Create your first agent|Name your company|onboarding/i").first()
    ).toBeVisible({ timeout: 5_000 });
  });

  // --------------------------------------------------------------------------
  // Team section
  // --------------------------------------------------------------------------

  test("shows TEAM section with agent count when agents exist", async ({ page }) => {
    const company = await createCompany(page, "team");
    await createAgent(page, company.id, "Alpha Agent", "engineer");
    await createAgent(page, company.id, "Beta Agent", "researcher");
    await navigateToDashboard(page, company.issuePrefix);

    // Section heading
    await expect(page.locator("text=Team").first()).toBeVisible({ timeout: 10_000 });

    // Count text — should say "2 agents" (or more if plan created extras)
    await expect(page.locator("text=/\\d+ agents?/")).toBeVisible({ timeout: 10_000 });
  });

  test("View all link in TEAM section navigates to agents list", async ({ page }) => {
    const company = await createCompany(page, "teamlink");
    await createAgent(page, company.id, "Gamma Agent", "engineer");
    await navigateToDashboard(page, company.issuePrefix);

    // Find the "View all" link inside the Team section
    await expect(page.locator("text=Team").first()).toBeVisible({ timeout: 10_000 });
    const viewAllLinks = page.locator("a", { hasText: "View all" });
    // At least one View-all link must exist (Team section)
    await expect(viewAllLinks.first()).toBeVisible({ timeout: 5_000 });

    // Click it and confirm navigation to agents URL
    await viewAllLinks.first().click();
    await expect(page).toHaveURL(/\/agents/, { timeout: 10_000 });
  });

  // --------------------------------------------------------------------------
  // THIS MONTH stats
  // --------------------------------------------------------------------------

  test("shows This month stats cards with tasks completed and spend", async ({ page }) => {
    const company = await createCompany(page, "stats");
    await createAgent(page, company.id, "Stats Agent", "engineer");
    await navigateToDashboard(page, company.issuePrefix);

    // Section heading
    await expect(page.locator("text=This month").first()).toBeVisible({ timeout: 10_000 });

    // Tasks completed card
    await expect(page.locator("text=tasks completed")).toBeVisible({ timeout: 5_000 });

    // Spend card: "spent this month"
    await expect(page.locator("text=spent this month")).toBeVisible({ timeout: 5_000 });

    // In-progress and open count line appears inside the tasks card
    await expect(page.locator("text=/in progress.*open/")).toBeVisible({ timeout: 5_000 });
  });

  test("spend card shows No budget set when no budget is configured", async ({ page }) => {
    const company = await createCompany(page, "nobudget");
    await createAgent(page, company.id, "Budget Agent", "engineer");
    await navigateToDashboard(page, company.issuePrefix);

    await expect(page.locator("text=spent this month")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=No budget set")).toBeVisible({ timeout: 5_000 });
  });

  // --------------------------------------------------------------------------
  // Recent Activity section
  // --------------------------------------------------------------------------

  test("shows Recent activity section header when activity exists", async ({ page }) => {
    const company = await createCompany(page, "activity");
    const agent = await createAgent(page, company.id, "Activity Agent", "engineer");
    // Creating and assigning an issue generates activity events
    await createIssue(page, company.id, "Activity test task", agent.id);
    await navigateToDashboard(page, company.issuePrefix);

    // Activity events may take a moment to propagate
    await expect(
      page.locator("text=Recent activity")
    ).toBeVisible({ timeout: 10_000 });
  });

  test("View all link in Recent activity section navigates to activity page", async ({ page }) => {
    const company = await createCompany(page, "activitylink");
    const agent = await createAgent(page, company.id, "Link Agent", "engineer");
    await createIssue(page, company.id, "Link test task", agent.id);
    await navigateToDashboard(page, company.issuePrefix);

    await expect(page.locator("text=Recent activity")).toBeVisible({ timeout: 10_000 });

    // The second "View all" link belongs to the Recent activity section
    const viewAllLinks = page.locator("a", { hasText: "View all" });
    const count = await viewAllLinks.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Click the last "View all" (activity section is below team section)
    await viewAllLinks.last().click();
    await expect(page).toHaveURL(/\/activity/, { timeout: 10_000 });
  });

  // --------------------------------------------------------------------------
  // Needs Attention items
  // --------------------------------------------------------------------------

  test("shows Needs your attention section when attention items exist via API mock", async ({ page }) => {
    const company = await createCompany(page, "attn");
    await createAgent(page, company.id, "Error Agent", "engineer");

    // Intercept the dashboard summary API to inject an agent-in-error situation
    await page.route(`**/api/companies/${company.id}/dashboard/summary`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agents: { active: 0, running: 0, paused: 0, error: 1 },
          tasks: { open: 2, inProgress: 1, done: 5, blocked: 0 },
          costs: { monthSpendCents: 1500, monthBudgetCents: 0, monthUtilizationPercent: 0 },
          budgets: { activeIncidents: 0, pausedAgents: 0, pendingApprovals: 0 },
          pendingApprovals: 0,
        }),
      });
    });

    await navigateToDashboard(page, company.issuePrefix);

    await expect(page.locator("text=Needs your attention")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=/1 agent in error/")).toBeVisible({ timeout: 5_000 });
    // All-clear panel must NOT be present
    await expect(page.locator("text=All clear")).toHaveCount(0);
  });

  test("blocked tasks attention item is a clickable link to issues page", async ({ page }) => {
    const company = await createCompany(page, "blocked");
    await createAgent(page, company.id, "Blocked Agent", "engineer");

    await page.route(`**/api/companies/${company.id}/dashboard/summary`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agents: { active: 1, running: 0, paused: 0, error: 0 },
          tasks: { open: 3, inProgress: 1, done: 2, blocked: 2 },
          costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
          budgets: { activeIncidents: 0, pausedAgents: 0, pendingApprovals: 0 },
          pendingApprovals: 0,
        }),
      });
    });

    await navigateToDashboard(page, company.issuePrefix);

    await expect(page.locator("text=/2 tasks blocked/")).toBeVisible({ timeout: 10_000 });
    // The blocked-tasks item is a Link — clicking it should navigate to issues
    const blockedLink = page.locator("a", { hasText: /tasks blocked/ });
    await expect(blockedLink).toBeVisible();
    await blockedLink.click();
    await expect(page).toHaveURL(/\/issues/, { timeout: 10_000 });
  });

  test("pending approvals attention item links to approvals page", async ({ page }) => {
    const company = await createCompany(page, "approvals");
    await createAgent(page, company.id, "Approval Agent", "engineer");

    await page.route(`**/api/companies/${company.id}/dashboard/summary`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agents: { active: 1, running: 0, paused: 0, error: 0 },
          tasks: { open: 1, inProgress: 0, done: 0, blocked: 0 },
          costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
          budgets: { activeIncidents: 0, pausedAgents: 0, pendingApprovals: 1 },
          pendingApprovals: 2,
        }),
      });
    });

    await navigateToDashboard(page, company.issuePrefix);

    // totalApprovals = pendingApprovals(2) + budgets.pendingApprovals(1) = 3
    await expect(page.locator("text=/3 pending approvals/")).toBeVisible({ timeout: 10_000 });
    const approvalsLink = page.locator("a", { hasText: /pending approvals/ });
    await expect(approvalsLink).toBeVisible();
    await approvalsLink.click();
    await expect(page).toHaveURL(/\/approvals/, { timeout: 10_000 });
  });

  // --------------------------------------------------------------------------
  // Loading state
  // --------------------------------------------------------------------------

  test("renders without crashing and eventually shows content (smoke test)", async ({ page }) => {
    const company = await createCompany(page, "smoke");
    await navigateToDashboard(page, company.issuePrefix);

    // The page must eventually show the greeting — no error boundary, no blank page
    await expect(
      page.locator("h1", { hasText: /Good morning|Good afternoon|Good evening/ })
    ).toBeVisible({ timeout: 15_000 });

    // No visible error boundary
    const errorBoundary = page.locator("[data-testid='error-boundary']");
    await expect(errorBoundary).toHaveCount(0);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.length).toBeGreaterThan(100);
  });
});
