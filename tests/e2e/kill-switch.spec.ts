import { test, expect } from "@playwright/test";

/**
 * CUJ-5: Kill Switch — halt → verify halted state → resume → verify resumed state
 *
 * Each test creates its own isolated company via API.
 * Every button click is verified by its result (UI state change + API state).
 */

const BASE = "http://127.0.0.1:3100";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function createCompany(
  request: import("@playwright/test").APIRequestContext,
  name: string
): Promise<{ id: string; issuePrefix: string; name: string }> {
  const res = await request.post(`${BASE}/api/companies`, {
    data: { name, issuePrefix: name.replace(/\W/g, "").slice(0, 5).toUpperCase() },
  });
  expect(res.ok(), `POST /api/companies failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function createAgent(
  request: import("@playwright/test").APIRequestContext,
  companyId: string,
  name: string
): Promise<{ id: string; name: string; status: string }> {
  const res = await request.post(`${BASE}/api/companies/${companyId}/agents`, {
    data: {
      name,
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-3-5-haiku-20241022" },
    },
  });
  expect(res.ok(), `POST /api/companies/${companyId}/agents failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function getKillSwitchStatus(
  request: import("@playwright/test").APIRequestContext,
  companyId: string
): Promise<{ companyHalted: boolean; haltedAgentIds?: string[] }> {
  const res = await request.get(`${BASE}/api/companies/${companyId}/kill-switch/status`);
  expect(res.ok(), `GET kill-switch/status failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function haltViaApi(
  request: import("@playwright/test").APIRequestContext,
  companyId: string
): Promise<void> {
  const res = await request.post(`${BASE}/api/companies/${companyId}/kill-switch`, {
    data: { scope: "company", scopeId: companyId, reason: "API test halt" },
  });
  expect(res.ok(), `POST kill-switch failed: ${await res.text()}`).toBe(true);
}

async function resumeViaApi(
  request: import("@playwright/test").APIRequestContext,
  companyId: string
): Promise<void> {
  const res = await request.post(`${BASE}/api/companies/${companyId}/kill-switch/resume`, {
    data: { scope: "company", scopeId: companyId },
  });
  expect(res.ok(), `POST kill-switch/resume failed: ${await res.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("CUJ-5: Kill Switch", () => {
  // -------------------------------------------------------------------------
  // Test 1: Security page loads with correct heading and HALT button
  // -------------------------------------------------------------------------
  test("security page shows Security & Governance heading and HALT ALL AGENTS button", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("h1").filter({ hasText: /security & governance/i })
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByRole("button", { name: /halt all agents/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Test 2: Kill switch status API returns not-halted for fresh company
  // -------------------------------------------------------------------------
  test("fresh company kill-switch status reports not halted", async ({ page: _page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    const status = await getKillSwitchStatus(request, company.id);
    expect(status.companyHalted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3: Clicking HALT ALL AGENTS changes UI to halted state
  // -------------------------------------------------------------------------
  test("clicking HALT ALL AGENTS shows AGENTS HALTED heading and Resume button", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Verify initial state shows halt button (not resume)
    const haltButton = page.getByRole("button", { name: /halt all agents/i });
    await expect(haltButton).toBeVisible({ timeout: 10_000 });

    // Click to halt
    await haltButton.click();

    // UI must switch to halted state — heading changes to "AGENTS HALTED"
    await expect(
      page.locator("h2").filter({ hasText: /agents halted/i })
    ).toBeVisible({ timeout: 10_000 });

    // Resume button must now be visible
    await expect(
      page.getByRole("button", { name: /resume all agents/i })
    ).toBeVisible({ timeout: 10_000 });

    // HALT button must be gone
    await expect(
      page.getByRole("button", { name: /halt all agents/i })
    ).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Test 4: API confirms halted state after UI halt click
  // -------------------------------------------------------------------------
  test("API reports companyHalted=true after clicking HALT ALL AGENTS", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await page.getByRole("button", { name: /halt all agents/i }).click();

    // Wait for UI to confirm halted
    await expect(
      page.locator("h2").filter({ hasText: /agents halted/i })
    ).toBeVisible({ timeout: 10_000 });

    // Verify via API
    const status = await getKillSwitchStatus(request, company.id);
    expect(status.companyHalted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: Halted state shows agent count in description text
  // -------------------------------------------------------------------------
  test("halted state description mentions number of affected agents", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");
    await createAgent(request, company.id, "CTO");

    // Halt via API so we don't need to wait for UI polling
    await haltViaApi(request, company.id);

    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Should show halted heading
    await expect(
      page.locator("h2").filter({ hasText: /agents halted/i })
    ).toBeVisible({ timeout: 10_000 });

    // Description should mention agent count
    await expect(
      page.locator("text=/agent.*affected|affected.*agent/i").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Test 6: Resume button click transitions UI back to normal state
  // -------------------------------------------------------------------------
  test("clicking Resume All Agents shows HALT ALL AGENTS button again", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    // Halt via API so we start from a known halted state
    await haltViaApi(request, company.id);

    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Should show resume button because we're already halted
    const resumeButton = page.getByRole("button", { name: /resume all agents/i });
    await expect(resumeButton).toBeVisible({ timeout: 10_000 });

    // Click resume
    await resumeButton.click();

    // UI must switch back to normal — HALT button reappears
    await expect(
      page.getByRole("button", { name: /halt all agents/i })
    ).toBeVisible({ timeout: 10_000 });

    // Resume button must be gone
    await expect(
      page.getByRole("button", { name: /resume all agents/i })
    ).not.toBeVisible();

    // Heading must not say AGENTS HALTED anymore
    await expect(
      page.locator("h2").filter({ hasText: /kill switch/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Test 7: API confirms resumed state after UI resume click
  // -------------------------------------------------------------------------
  test("API reports companyHalted=false after clicking Resume All Agents", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await haltViaApi(request, company.id);

    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Wait for halted state to render (page polls every 5s)
    await expect(
      page.getByRole("button", { name: /resume all agents/i })
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /resume all agents/i }).click();

    // Wait for UI to confirm resumed
    await expect(
      page.getByRole("button", { name: /halt all agents/i })
    ).toBeVisible({ timeout: 10_000 });

    // Verify via API
    const status = await getKillSwitchStatus(request, company.id);
    expect(status.companyHalted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 8: Full halt → resume cycle verifies idempotency via API
  // -------------------------------------------------------------------------
  test("full halt-resume cycle: API state matches UI state at every step", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Step 1: Confirm not halted
    let status = await getKillSwitchStatus(request, company.id);
    expect(status.companyHalted).toBe(false);
    await expect(page.getByRole("button", { name: /halt all agents/i })).toBeVisible({ timeout: 10_000 });

    // Step 2: Halt via UI
    await page.getByRole("button", { name: /halt all agents/i }).click();
    await expect(page.locator("h2").filter({ hasText: /agents halted/i })).toBeVisible({ timeout: 10_000 });
    status = await getKillSwitchStatus(request, company.id);
    expect(status.companyHalted).toBe(true);

    // Step 3: Resume via UI
    await page.getByRole("button", { name: /resume all agents/i }).click();
    await expect(page.getByRole("button", { name: /halt all agents/i })).toBeVisible({ timeout: 10_000 });
    status = await getKillSwitchStatus(request, company.id);
    expect(status.companyHalted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 9: Kill switch via API is reflected in UI without browser action
  // -------------------------------------------------------------------------
  test("API halt is reflected in UI after page navigation", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    // Halt via API (simulates another user/system halting agents)
    await haltViaApi(request, company.id);

    // Navigate fresh to the security page
    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // UI should show halted state because it fetches status on load
    await expect(
      page.locator("h2").filter({ hasText: /agents halted/i })
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByRole("button", { name: /resume all agents/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Test 10: Security page also shows Security Policies section
  // -------------------------------------------------------------------------
  test("security page includes Security Policies section", async ({ page, request }) => {
    const company = await createCompany(request, `KillTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await page.goto(`/${company.issuePrefix}/security`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("h2").filter({ hasText: /security policies/i })
    ).toBeVisible({ timeout: 10_000 });

    // Add Policy button present
    await expect(
      page.getByRole("button", { name: /add policy/i })
    ).toBeVisible({ timeout: 10_000 });
  });
});
