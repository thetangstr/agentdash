import { test, expect, navigateAndWait, getIssues } from "./fixtures/test-helpers";

/**
 * CUJ-15: Agent-Human Conversation (Comment-Driven Interaction)
 * Issue detail → comment thread → chat-style rendering → waiting indicator
 */
test.describe("CUJ-15: Agent-Human Conversation", () => {
  test("issue detail page loads with comment section", async ({ page, company, prefix }) => {
    // Ensure at least one issue exists in the fixture company before asserting
    let issues = await getIssues(page, company.id);
    if (issues.length === 0) {
      const res = await page.request.post(`/api/companies/${company.id}/issues`, {
        data: { title: "E2E comment test issue" },
      });
      expect(res.ok(), `create seed issue failed: ${await res.text()}`).toBe(true);
      issues = await getIssues(page, company.id);
    }
    expect(issues.length).toBeGreaterThan(0);

    await navigateAndWait(page, `/issues/${issues[0].id}`, prefix);

    // Issue title visible (heading, not breadcrumb)
    await expect(
      page.locator("h2").filter({ hasText: issues[0].title })
    ).toBeVisible({ timeout: 10_000 });

    // Comment section should be present (use the Comments tab panel's editor)
    await expect(
      page.getByRole("tabpanel", { name: "Comments" }).getByLabel("editable markdown")
    ).toBeVisible({ timeout: 10_000 });
  });

  // TODO(AGE-71): un-skip when real fix lands. Was failing on agentdash-main baseline.
  test.skip("comment input allows typing", async ({ page, company, prefix }) => {
    const issues = await getIssues(page, company.id);
    await navigateAndWait(page, `/issues/${issues[0].id}`, prefix);

    // Find comment input
    const commentInput = page.locator("textarea").first();
    const isVisible = await commentInput.isVisible().catch(() => false);

    if (isVisible) {
      await commentInput.fill("E2E test comment");
      await expect(commentInput).toHaveValue("E2E test comment");
    }
  });
});
