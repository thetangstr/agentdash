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
    // AgentDash (AGE-42): /pipelines top-level is gone — /pipelines now
    // redirects to /goals. Covered explicitly in its own spec below.
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

  // AgentDash (AGE-42): "Pipelines" is no longer a top-level nav concept —
  // everything rolls up under Goals. The sidebar Work section must not
  // expose a Pipelines link.
  test("sidebar Work section no longer shows 'Pipelines'", async ({ page, prefix }) => {
    await navigateAndWait(page, "/dashboard", prefix);
    const workSection = page.locator("aside").getByText("Work", { exact: true }).first();
    await expect(workSection).toBeVisible();

    // No sidebar nav link points to /pipelines any more.
    const pipelinesLink = page.locator("aside a[href$='/pipelines']");
    expect(await pipelinesLink.count()).toBe(0);

    // And there's no visible "Pipelines" label in the sidebar (CRM "Pipeline"
    // deals page lives under the CRM section and uses the singular form).
    const pipelinesLabel = page.locator("aside").getByText("Pipelines", { exact: true });
    expect(await pipelinesLabel.count()).toBe(0);
  });

  // AgentDash (AGE-42): /pipelines top-level route redirects to /goals.
  test("/pipelines redirects to /goals", async ({ page, prefix }) => {
    await navigateAndWait(page, "/pipelines", prefix);
    await expect(page).toHaveURL(/\/goals(\?|#|$)/);
  });
});
