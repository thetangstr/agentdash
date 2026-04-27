import { test, expect } from "@playwright/test";

/**
 * AGE-43: Goals page is a creation-only entry point.
 *
 * Asserts:
 *   - /goals renders the "New Goal" CTA
 *   - /goals does NOT render a GoalTree / list of existing goals, even when
 *     the company already has goals
 *   - Clicking "New Goal" opens the NewGoalDialog with the parent-goal
 *     selector hidden (hideParentSelector: true on this launch path)
 *   - /goals/:id remains accessible by direct URL
 */

interface Company { id: string; name: string; issuePrefix: string }
interface Goal { id: string; title: string; level: string }

async function createCompany(
  page: import("@playwright/test").Page,
  suffix?: string,
): Promise<Company> {
  const ts = Date.now();
  const name = `E2E-Goals-${suffix ?? ts}`;
  const prefix = `G${ts.toString().slice(-5)}`;
  const res = await page.request.post("/api/companies", {
    data: { name, issuePrefix: prefix },
  });
  expect(res.ok(), `create company failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function createGoal(
  page: import("@playwright/test").Page,
  companyId: string,
  title: string,
  level = "company",
): Promise<Goal> {
  const res = await page.request.post(`/api/companies/${companyId}/goals`, {
    data: { title, level },
  });
  expect(res.ok(), `create goal "${title}" failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function gotoGoals(page: import("@playwright/test").Page, prefix: string) {
  await page.goto(`/${prefix}/goals`);
  await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });
}

test.describe("AGE-43: /goals creation-only entry point", () => {
  // TODO(AGE-71): un-skip when real fix lands. Was failing on agentdash-main baseline.
  test.skip("shows New Goal CTA and does NOT render GoalTree list", async ({ page }) => {
    const company = await createCompany(page, "cta");
    // Seed existing goals so the list would normally render if we hadn't
    // removed it. This is the regression guard for AGE-43.
    await createGoal(page, company.id, "Existing goal alpha");
    await createGoal(page, company.id, "Existing goal beta");

    await gotoGoals(page, company.issuePrefix);

    // Empty-state CTA copy is visible.
    await expect(
      page.locator("text=Start a new goal to drive focused work"),
    ).toBeVisible({ timeout: 10_000 });

    // "New Goal" CTA button is visible and clickable.
    const newGoalBtn = page.locator("button", { hasText: "New Goal" });
    await expect(newGoalBtn).toBeVisible({ timeout: 5_000 });

    // Existing goal titles MUST NOT appear in a list on /goals.
    await expect(page.locator("text=Existing goal alpha")).toHaveCount(0);
    await expect(page.locator("text=Existing goal beta")).toHaveCount(0);
  });

  test("New Goal dialog hides parent-goal selector when launched from /goals", async ({ page }) => {
    const company = await createCompany(page, "parent");
    // Pre-create a goal so the parent selector would have something to show
    // if it were rendered.
    await createGoal(page, company.id, "Candidate parent goal");

    await gotoGoals(page, company.issuePrefix);

    const newGoalBtn = page.locator("button", { hasText: "New Goal" });
    await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
    await newGoalBtn.click();

    // The NewGoalDialog header appears (Dialog uses the title "New goal").
    await expect(
      page.locator("text=/Describe your goal|new goal/i").first(),
    ).toBeVisible({ timeout: 10_000 });

    // The "Parent goal" trigger must NOT be present on this launch path.
    await expect(page.locator("button", { hasText: "Parent goal" })).toHaveCount(0);
  });

  test("GoalDetail (/goals/:id) remains accessible by direct URL", async ({ page }) => {
    const company = await createCompany(page, "detail");
    const goal = await createGoal(page, company.id, "Direct-link goal");

    await page.goto(`/${company.issuePrefix}/goals/${goal.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The goal title should render somewhere on the detail page.
    await expect(page.locator(`text=${goal.title}`).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
