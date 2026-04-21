import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * Cross-cutting: Sidebar navigation and page load smoke tests.
 * Verifies every major page loads without errors.
 */
test.describe("Navigation smoke tests", () => {
  const pages = [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/agents/all", label: "Agents" },
    { path: "/issues", label: "Issues" },
    { path: "/pipelines", label: "Pipelines" },
    { path: "/crm", label: "CRM Pipeline" },
    { path: "/crm/accounts", label: "CRM Accounts" },
    { path: "/crm/contacts", label: "CRM Contacts" },
    { path: "/crm/leads", label: "CRM Leads" },
    { path: "/crm/kanban", label: "CRM Kanban" },
    { path: "/security", label: "Security" },
    { path: "/research", label: "Research" },
    { path: "/skill-versions", label: "Skill Versions" },
    { path: "/budget", label: "Budget" },
    { path: "/capacity", label: "Capacity" },
    { path: "/costs", label: "Costs" },
    { path: "/templates", label: "Templates" },
    { path: "/activity", label: "Activity" },
    { path: "/task-dependencies", label: "Task Dependencies" },
    { path: "/org", label: "Org Chart" },
    { path: "/feed", label: "Feed" },
    { path: "/goals", label: "Goals" },
    { path: "/approvals/pending", label: "Approvals" },
    { path: "/connectors", label: "Connectors" },
  ];

  for (const { path, label } of pages) {
    test(`${label} (${path}) loads without error`, async ({ page, prefix }) => {
      await navigateAndWait(page, path, prefix);

      // No React error boundary
      const errorBoundary = page.locator("[class*='error-boundary'], [data-testid='error-boundary']");
      expect(await errorBoundary.count()).toBe(0);

      // Page should have meaningful content (not blank)
      const bodyText = await page.locator("body").textContent();
      expect(bodyText!.length).toBeGreaterThan(50);
    });
  }
});
