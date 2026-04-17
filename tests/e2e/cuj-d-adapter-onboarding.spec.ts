import { test, expect, getAgents, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-D: Adapter Onboarding
 *
 * Verifies that all adapters are available (no "coming soon" gating) and that
 * the Skills tab is visible on AgentDetail.
 *
 * Requires: dev server running with at least one company and one agent seeded.
 */

test.describe("CUJ-D: adapter onboarding", () => {
  test("invite landing page shows no 'coming soon' copy for any adapter", async ({ page }) => {
    // Mock the invite API so the InviteLanding renders its full form regardless
    // of whether the backend has a seeded token.
    await page.route("**/api/access/invites/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: "e2e-test",
          companyName: "CUJ-D E2E",
          companyId: "00000000-0000-0000-0000-000000000001",
          inviteType: "standard",
          allowedJoinTypes: "both",
          expiresAt: null,
        }),
      });
    });

    await page.goto("/invite/e2e-test");
    await page.waitForLoadState("networkidle");

    // Render must not contain any "coming soon" copy anywhere on the page.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // Switch to "agent" join type so the adapter selector renders, if the UI
    // defaults to human. Look for an adapter-type selector and confirm no
    // gated copy appears in its options.
    const agentRadio = page.getByRole("radio", { name: /agent/i }).or(page.getByLabel(/agent/i));
    if (await agentRadio.first().isVisible().catch(() => false)) {
      await agentRadio.first().click().catch(() => {});
      await expect(page.getByText(/coming soon/i)).toHaveCount(0);
    }
  });

  test("adapter config dropdown has no 'coming soon' options", async ({ page, company, prefix }) => {
    // Get an agent to navigate to its config tab
    const agents = await getAgents(page, company.id);
    test.skip(agents.length === 0, "No agents seeded — skip adapter dropdown check");

    const agent = agents[0];
    // Navigate to the agent's configuration tab
    await navigateAndWait(page, `/agents/${agent.id}/configuration`, prefix);
    await page.waitForLoadState("networkidle");

    // The adapter dropdown button should be visible
    // Open the adapter picker popover
    const adapterButton = page.locator("button").filter({ hasText: /claude|codex|gemini|opencode|pi|cursor|openclaw|process|http/i }).first();
    if (await adapterButton.isVisible()) {
      await adapterButton.click();
      // After opening, verify no "coming soon" text appears in the dropdown
      await expect(page.getByText(/coming soon/i)).toHaveCount(0);
    }
  });

  test("AgentDetail renders Skills tab and heading", async ({ page, company, prefix }) => {
    const agents = await getAgents(page, company.id);
    test.skip(agents.length === 0, "No agents seeded — skip skills tab check");

    const agent = agents[0];
    // Navigate to the skills tab directly
    await navigateAndWait(page, `/agents/${agent.id}/skills`, prefix);
    await page.waitForLoadState("networkidle");

    // The Skills tab should be visible in the tab bar
    const skillsTab = page.getByRole("tab", { name: /skills/i });
    if (await skillsTab.count() === 0) {
      // Fallback: look for a link or button with "Skills" text in the tab bar
      await expect(page.getByText("Skills").first()).toBeVisible();
    } else {
      await expect(skillsTab).toBeVisible();
    }
  });
});
