import { test, expect } from "@playwright/test";

/**
 * CUJ-3: Agent Factory — template → spawn → approval → agents created
 *
 * Each test creates its own isolated company via API so tests don't share state.
 * UI interactions are verified by their result (URL change, API state, visible text),
 * not just by button presence.
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

async function createTemplate(
  request: import("@playwright/test").APIRequestContext,
  companyId: string,
  slug: string,
  name: string
): Promise<{ id: string; name: string; slug: string }> {
  const res = await request.post(`${BASE}/api/companies/${companyId}/agent-templates`, {
    data: {
      name,
      slug,
      role: "engineer",
      adapterType: "claude_local",
      budgetMonthlyCents: 10000,
    },
  });
  expect(res.ok(), `POST /api/companies/${companyId}/agent-templates failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function createSpawnRequest(
  request: import("@playwright/test").APIRequestContext,
  companyId: string,
  templateId: string,
  quantity = 1
): Promise<{ spawnRequest: { id: string; approvalId: string }; approval: { id: string } }> {
  const res = await request.post(`${BASE}/api/companies/${companyId}/spawn-requests`, {
    data: { templateId, quantity, reason: "Test spawn" },
  });
  expect(res.ok(), `POST spawn-requests failed: ${await res.text()}`).toBe(true);
  return res.json();
}

async function approveSpawnRequest(
  request: import("@playwright/test").APIRequestContext,
  approvalId: string
): Promise<void> {
  const res = await request.post(`${BASE}/api/approvals/${approvalId}/approve`, {
    data: { comment: "Approved by e2e test" },
  });
  expect(res.ok(), `POST /api/approvals/${approvalId}/approve failed: ${await res.text()}`).toBe(true);
}

async function getAgents(
  request: import("@playwright/test").APIRequestContext,
  companyId: string
): Promise<Array<{ id: string; name: string; status: string }>> {
  const res = await request.get(`${BASE}/api/companies/${companyId}/agents`);
  expect(res.ok()).toBe(true);
  return res.json();
}

async function getSpawnRequests(
  request: import("@playwright/test").APIRequestContext,
  companyId: string
): Promise<Array<{ id: string; status: string; quantity: number }>> {
  const res = await request.get(`${BASE}/api/companies/${companyId}/spawn-requests`);
  expect(res.ok()).toBe(true);
  return res.json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("CUJ-3: Agent Factory", () => {
  // -------------------------------------------------------------------------
  // Test 1: Templates page renders with Create Template button
  // -------------------------------------------------------------------------
  test("templates page shows heading and Create Template button", async ({ page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await page.goto(`/${company.issuePrefix}/templates`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Page heading visible
    await expect(
      page.locator("h1").filter({ hasText: /agent templates/i })
    ).toBeVisible({ timeout: 10_000 });

    // Create Template button visible
    await expect(
      page.getByRole("button", { name: /create template/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Test 2: Create Template dialog opens and accepts input
  // -------------------------------------------------------------------------
  test("clicking Create Template opens dialog with form fields", async ({ page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await page.goto(`/${company.issuePrefix}/templates`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await page.getByRole("button", { name: /create template/i }).click();

    // Dialog must appear — verify form fields are present
    await expect(page.locator("input[placeholder='Frontend Engineer']")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("label", { hasText: /slug/i })).toBeVisible();
    await expect(page.locator("label", { hasText: /role/i })).toBeVisible();
    await expect(page.locator("label", { hasText: /adapter type/i })).toBeVisible();
    await expect(page.locator("label", { hasText: /monthly budget/i })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Test 3: Full template creation via UI — template appears in list
  // -------------------------------------------------------------------------
  test("creates a template via UI form and it appears in the templates list", async ({ page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    const templateName = `Test Eng ${Date.now()}`;

    await page.goto(`/${company.issuePrefix}/templates`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Open create dialog
    await page.getByRole("button", { name: /create template/i }).click();
    await expect(page.locator("input[placeholder='Frontend Engineer']")).toBeVisible({ timeout: 5_000 });

    // Fill name — slug auto-populates
    await page.locator("input[placeholder='Frontend Engineer']").fill(templateName);

    // Select role
    await page.locator("select").first().selectOption("engineer");

    // Set budget
    const budgetInput = page.locator("input[type='number']").last();
    await budgetInput.fill("200");

    // Submit
    await page.getByRole("button", { name: /create template/i }).last().click();

    // Dialog should close and template card should appear
    await expect(page.locator(`text=${templateName}`).first()).toBeVisible({ timeout: 10_000 });

    // Verify via API that template was actually persisted
    const res = await request.get(`${BASE}/api/companies/${company.id}/agent-templates`);
    const templates: Array<{ name: string }> = await res.json();
    expect(templates.some((t) => t.name === templateName)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: Template created via API appears in UI
  // -------------------------------------------------------------------------
  test("API-created template renders as a card with Spawn button", async ({ page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");
    const slug = `qa-bot-${Date.now()}`;
    const template = await createTemplate(request, company.id, slug, "QA Bot");

    await page.goto(`/${company.issuePrefix}/templates`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Template card visible
    await expect(page.locator(`text=${template.name}`).first()).toBeVisible({ timeout: 10_000 });

    // Spawn button on the card
    await expect(
      page.getByRole("button", { name: /spawn/i }).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // Test 5: Spawn dialog opens when Spawn button is clicked
  // -------------------------------------------------------------------------
  test("clicking Spawn button opens spawn dialog with quantity and reason fields", async ({ page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");
    const slug = `researcher-${Date.now()}`;
    await createTemplate(request, company.id, slug, "Researcher");

    await page.goto(`/${company.issuePrefix}/templates`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.locator("text=Researcher").first()).toBeVisible({ timeout: 10_000 });

    // Click Spawn
    await page.getByRole("button", { name: /spawn/i }).first().click();

    // Dialog content must appear
    await expect(page.locator("label", { hasText: /quantity/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("label", { hasText: /reason/i })).toBeVisible();
    // Dialog title references the template name
    await expect(page.locator("text=/Spawn from/i")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Test 6: Full spawn flow via UI — spawn request created and confirmed
  // -------------------------------------------------------------------------
  test("submitting spawn dialog creates a spawn request visible in API", async ({ page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");
    const slug = `dev-agent-${Date.now()}`;
    await createTemplate(request, company.id, slug, "Dev Agent");

    await page.goto(`/${company.issuePrefix}/templates`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.locator("text=Dev Agent").first()).toBeVisible({ timeout: 10_000 });

    // Click Spawn
    await page.getByRole("button", { name: /spawn/i }).first().click();
    await expect(page.locator("label", { hasText: /quantity/i })).toBeVisible({ timeout: 5_000 });

    // Fill quantity and reason
    await page.locator("input[type='number']").fill("2");
    await page.locator("textarea").fill("Need extra agents for e2e test");

    // Submit spawn
    await page.getByRole("button", { name: /spawn \d+ agent/i }).click();

    // UI must show success state
    await expect(
      page.locator("text=/spawn request created/i")
    ).toBeVisible({ timeout: 10_000 });

    // Verify via API the spawn request was persisted with quantity=2
    const spawnRequests = await getSpawnRequests(request, company.id);
    expect(spawnRequests.length).toBeGreaterThan(0);
    const req = spawnRequests.find((sr) => sr.quantity === 2);
    expect(req).toBeDefined();
    expect(req!.status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Test 7: Agents appear after spawn request is approved (API approval)
  // -------------------------------------------------------------------------
  test("approving a spawn request creates new agents visible in the agents list", async ({ page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");
    const slug = `analyst-${Date.now()}`;
    const template = await createTemplate(request, company.id, slug, "Analyst");

    const agentsBefore = await getAgents(request, company.id);
    const countBefore = agentsBefore.length;

    // Create and approve spawn request via API
    const { approval } = await createSpawnRequest(request, company.id, template.id, 2);
    await approveSpawnRequest(request, approval.id);

    // Verify via API that 2 new agents were created
    const agentsAfter = await getAgents(request, company.id);
    expect(agentsAfter.length).toBe(countBefore + 2);

    // Verify they show up in the agents list UI
    await page.goto(`/${company.issuePrefix}/agents/all`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The spawned agents are named after the template
    await expect(
      page.locator("text=Analyst").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Test 8: Spawn request status transitions from pending to fulfilled
  // -------------------------------------------------------------------------
  test("spawn request status becomes fulfilled after approval", async ({ page: _page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");
    const slug = `ops-agent-${Date.now()}`;
    const template = await createTemplate(request, company.id, slug, "Ops Agent");

    const { spawnRequest, approval } = await createSpawnRequest(request, company.id, template.id, 1);
    expect(spawnRequest.status ?? "pending").toBe("pending");

    await approveSpawnRequest(request, approval.id);

    // Check spawn request status
    const statusRes = await request.get(`${BASE}/api/companies/${company.id}/spawn-requests/${spawnRequest.id}`);
    const updated = await statusRes.json();
    expect(updated.status).toBe("fulfilled");
  });

  // -------------------------------------------------------------------------
  // Test 9: Templates page shows empty state for new company
  // -------------------------------------------------------------------------
  test("shows empty state message when company has no templates", async ({ page, request }) => {
    const company = await createCompany(request, `EmptyFactory-${Date.now()}`);
    await createAgent(request, company.id, "CEO");

    await page.goto(`/${company.issuePrefix}/templates`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("text=/no templates yet/i")
    ).toBeVisible({ timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Test 10: Template shows role, adapter, and budget metadata in card
  // -------------------------------------------------------------------------
  test("template card displays role, adapter type, and monthly budget", async ({ page, request }) => {
    const company = await createCompany(request, `FactoryTest-${Date.now()}`);
    await createAgent(request, company.id, "CEO");
    const slug = `full-meta-${Date.now()}`;
    await createTemplate(request, company.id, slug, "Full Meta Agent");

    await page.goto(`/${company.issuePrefix}/templates`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Role badge
    await expect(page.locator("text=engineer").first()).toBeVisible({ timeout: 10_000 });
    // Adapter type badge
    await expect(page.locator("text=claude_local").first()).toBeVisible({ timeout: 10_000 });
    // Budget display ($100/mo from 10000 cents)
    await expect(page.locator("text=/\\$100\\/mo/").first()).toBeVisible({ timeout: 10_000 });
  });
});
