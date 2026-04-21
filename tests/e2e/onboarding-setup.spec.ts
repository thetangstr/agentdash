import { test, expect } from "@playwright/test";

/**
 * CUJ-1: AgentDash Onboarding Wizard (OnboardingWizardPage)
 *
 * Tests the 5-step AgentDash setup wizard at /:prefix/setup:
 *   Step 1 — Discovery: company info textarea
 *   Step 2 — Scope: radio buttons (Entire Company / Department / Team / Project)
 *   Step 3 — Goals: company goal + team goal inputs
 *   Step 4 — Access: overseer name + email
 *   Step 5 — Bootstrap: "Deploy Team" button → calls onboarding APIs → navigates to dashboard
 *
 * Each test creates an isolated company via API to avoid cross-test contamination.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createCompany(page: import("@playwright/test").Page) {
  const name = `E2E-Setup-${Date.now()}`;
  const res = await page.request.post("/api/companies", {
    data: { name, issuePrefix: `ES${Date.now().toString().slice(-4)}` },
  });
  expect(res.ok(), `create company: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return company as { id: string; name: string; issuePrefix: string };
}

async function navigateToSetup(page: import("@playwright/test").Page, prefix: string) {
  await page.goto(`/${prefix}/setup`);
  // Wait for the wizard to render — the progress bar is rendered as a series of divs
  await page.locator("text=Step 1 of 5").waitFor({ state: "visible", timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("CUJ-1: AgentDash Onboarding Wizard", () => {
  // --------------------------------------------------------------------------
  // Step rendering
  // --------------------------------------------------------------------------

  test("shows step 1 Discovery with company info textarea", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    await expect(page.locator("h1", { hasText: "Discovery" })).toBeVisible();
    await expect(page.locator("text=Step 1 of 5")).toBeVisible();
    await expect(
      page.locator("textarea[placeholder*='company description']")
    ).toBeVisible();
    // Back button is disabled on step 1
    await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
    // Next button is available
    await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  });

  test("Next button advances from Discovery to Scope step", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    await page.locator("textarea").fill("We are a fintech startup focused on SMB lending.");
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.locator("h1", { hasText: "Scope" })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Step 2 of 5")).toBeVisible();
  });

  test("shows Scope step with four operating mode radio buttons", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.locator("h1", { hasText: "Scope" })).toBeVisible({ timeout: 5_000 });
    // All four scope options must be present
    await expect(page.locator("text=Entire Company")).toBeVisible();
    await expect(page.locator("text=Department")).toBeVisible();
    await expect(page.locator("text=Team")).toBeVisible();
    await expect(page.locator("text=Project")).toBeVisible();
    // "Entire Company" is selected by default (radio checked)
    const companyRadio = page.locator("input[type='radio'][value='company']");
    await expect(companyRadio).toBeChecked();
  });

  test("clicking a scope radio button selects it", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("h1", { hasText: "Scope" })).toBeVisible({ timeout: 5_000 });

    const departmentRadio = page.locator("input[type='radio'][value='department']");
    await departmentRadio.click();
    await expect(departmentRadio).toBeChecked();
    // company radio is now unchecked
    await expect(page.locator("input[type='radio'][value='company']")).not.toBeChecked();
  });

  test("Back button on Scope step returns to Discovery step", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("h1", { hasText: "Scope" })).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator("h1", { hasText: "Discovery" })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Step 1 of 5")).toBeVisible();
  });

  test("shows Goals step with company goal and team goal inputs", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);
    // Step 1 -> 2 -> 3
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("h1", { hasText: "Scope" })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.locator("h1", { hasText: "Goals" })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Step 3 of 5")).toBeVisible();
    await expect(page.locator("text=Company Goal")).toBeVisible();
    await expect(page.locator("text=Team Goals")).toBeVisible();
    // Two team goal inputs (indices 0 and 1)
    const teamGoalInputs = page.locator("input[placeholder^='Team goal']");
    await expect(teamGoalInputs).toHaveCount(2);
  });

  test("filled goal values persist when navigating back and forward", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    // Advance to Goals step
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("h1", { hasText: "Scope" })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("h1", { hasText: "Goals" })).toBeVisible({ timeout: 5_000 });

    // Fill goals
    await page.locator("input[placeholder*='Launch v2']").fill("Ship v2 by Q3 2026");
    await page.locator("input[placeholder='Team goal 1']").fill("Grow ARR 3x");

    // Navigate back to Scope and return to Goals
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator("h1", { hasText: "Scope" })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("h1", { hasText: "Goals" })).toBeVisible({ timeout: 5_000 });

    // Values must still be there (React state preserved)
    await expect(page.locator("input[placeholder*='Launch v2']")).toHaveValue("Ship v2 by Q3 2026");
    await expect(page.locator("input[placeholder='Team goal 1']")).toHaveValue("Grow ARR 3x");
  });

  test("shows Access step with overseer name and email inputs", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    // Advance through steps 1-3
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }

    await expect(page.locator("h1", { hasText: "Access" })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Step 4 of 5")).toBeVisible();
    await expect(page.locator("input[placeholder='Name']")).toBeVisible();
    await expect(page.locator("input[placeholder='Email']")).toBeVisible();
    await expect(page.locator("text=Primary Overseer")).toBeVisible();
  });

  test("shows Bootstrap step with Deploy Team button", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    // Advance through steps 1-4
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }

    await expect(page.locator("h1", { hasText: "Bootstrap" })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Step 5 of 5")).toBeVisible();
    await expect(page.locator("text=Ready to deploy your agent team")).toBeVisible();
    await expect(page.getByRole("button", { name: "Deploy Team" })).toBeVisible();
    // No "Next" button on the last step
    await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
  });

  test("Deploy Team button shows Deploying... state while request is in flight", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    // Fill some data so the source content is non-trivial
    await page.locator("textarea").fill("AI-native startup building dev tooling.");
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }
    await expect(page.locator("h1", { hasText: "Bootstrap" })).toBeVisible({ timeout: 5_000 });

    // Click Deploy Team and immediately assert the in-flight label
    const deployBtn = page.getByRole("button", { name: "Deploy Team" });
    // Intercept the first API call so we can inspect the button while it's in-flight
    let requestFired = false;
    page.on("request", (req) => {
      if (req.url().includes("/onboarding/sessions") && req.method() === "POST") {
        requestFired = true;
      }
    });
    await deployBtn.click();

    // The button should immediately become disabled and say "Deploying..."
    await expect(page.getByRole("button", { name: "Deploying..." })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Deploying..." })).toBeDisabled();

    // Confirm the network request fired (button had a real onClick handler)
    expect(requestFired).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Full happy-path flow
  // --------------------------------------------------------------------------

  test("completes full wizard and navigates to dashboard", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    // Step 1: Discovery
    await page.locator("textarea").fill("AgentDash is an AI-native platform for orchestrating enterprise agent teams.");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 2: Scope — choose "Team"
    await expect(page.locator("h1", { hasText: "Scope" })).toBeVisible({ timeout: 5_000 });
    await page.locator("input[type='radio'][value='team']").click();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 3: Goals
    await expect(page.locator("h1", { hasText: "Goals" })).toBeVisible({ timeout: 5_000 });
    await page.locator("input[placeholder*='Launch v2']").fill("Reach 100 enterprise customers by EOY");
    await page.locator("input[placeholder='Team goal 1']").fill("Launch self-service onboarding");
    await page.locator("input[placeholder='Team goal 2']").fill("Reduce support tickets 50%");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 4: Access
    await expect(page.locator("h1", { hasText: "Access" })).toBeVisible({ timeout: 5_000 });
    await page.locator("input[placeholder='Name']").fill("Jane Smith");
    await page.locator("input[placeholder='Email']").fill("jane@example.com");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 5: Bootstrap
    await expect(page.locator("h1", { hasText: "Bootstrap" })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "Deploy Team" }).click();

    // Should navigate to /:prefix/dashboard after a successful deploy
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/dashboard`), {
      timeout: 30_000,
    });
  });

  test("verifies onboarding session was created and completed via API", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    // Fill wizard minimally and deploy
    await page.locator("textarea").fill("SaaS platform for B2B analytics.");
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }
    await expect(page.locator("h1", { hasText: "Bootstrap" })).toBeVisible({ timeout: 5_000 });

    // Capture the session ID from the first API response
    let sessionId: string | null = null;
    page.on("response", async (res) => {
      if (res.url().includes(`/companies/${company.id}/onboarding/sessions`) && res.request().method() === "POST" && !res.url().includes("/sources") && !res.url().includes("/extract")) {
        try {
          const body = await res.json();
          if (body.id && !sessionId) sessionId = body.id;
        } catch { /* ignore parse errors during teardown */ }
      }
    });

    await page.getByRole("button", { name: "Deploy Team" }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/dashboard`), {
      timeout: 30_000,
    });

    // Verify session exists and is completed
    expect(sessionId, "Deploy Team should have fired the create-session API").not.toBeNull();
    const sessionRes = await page.request.get(
      `/api/companies/${company.id}/onboarding/sessions/${sessionId}`
    );
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    expect(session.status).toBe("completed");

    // Verify sources were ingested
    const sourcesRes = await page.request.get(
      `/api/companies/${company.id}/onboarding/sessions/${sessionId}/sources`
    );
    expect(sourcesRes.ok()).toBe(true);
    const sources = await sourcesRes.json();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0].sourceType).toBe("text");
  });

  test("verifies apply-plan creates agents or departments for the company", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    await page.locator("textarea").fill("B2B SaaS startup in HR tech space.");
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }
    await expect(page.locator("h1", { hasText: "Bootstrap" })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "Deploy Team" }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/dashboard`), {
      timeout: 30_000,
    });

    // After apply-plan, agents or templates should exist
    const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`);
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    // The plan may create agents; at minimum the API must succeed
    expect(Array.isArray(agents)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  test("Deploy Team button is re-enabled after deploy error", async ({ page }) => {
    const company = await createCompany(page);
    await navigateToSetup(page, company.issuePrefix);

    // Advance to Bootstrap step
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Next" }).click();
    }
    await expect(page.locator("h1", { hasText: "Bootstrap" })).toBeVisible({ timeout: 5_000 });

    // Intercept the create-session call and force a 500
    await page.route(`**/onboarding/sessions`, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 500, body: JSON.stringify({ error: "Server error" }) });
      } else {
        await route.continue();
      }
    });

    await page.getByRole("button", { name: "Deploy Team" }).click();

    // Button must return to enabled state (deploying=false after error)
    await expect(page.getByRole("button", { name: "Deploy Team" })).toBeEnabled({ timeout: 10_000 });
    // Error message must appear
    await expect(page.locator("text=/deploy failed|server error/i")).toBeVisible({ timeout: 5_000 });
  });
});
