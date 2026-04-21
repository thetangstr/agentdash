import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-8: Security Policy Configuration
 *
 * CUJ-STATUS notes:
 *   - Create security policies: DONE (5 types: resource_access, action_limit, data_boundary, rate_limit, blast_radius)
 *   - Policy targeting (company, role, agent): DONE
 *   - Deactivate/reactivate policies: DONE (POST /security-policies/:id/deactivate)
 *   - Kill switch panel: DONE (see kill-switch.spec.ts for halt/resume flow)
 *   - "Add Policy" button dialog: NOT BUILT — button renders but has no handler
 *
 * This suite focuses on CUJ-8-specific behaviors:
 *   1. Security page heading and layout
 *   2. Policy created via API appears in the policy table
 *   3. Policy shows correct type, effect, and active status badges
 *   4. Deactivate policy via API and verify status updates in UI
 *   5. "Add Policy" button presence (dead button documented as TODO)
 *   6. Kill switch panel is present (halt/resume covered in kill-switch.spec.ts)
 */

test.describe("CUJ-8: Security Policies", () => {
  // ---------------------------------------------------------------------------
  // Test 1: Security & Governance heading renders
  // ---------------------------------------------------------------------------
  test("security page shows Security and Governance heading", async ({ page, prefix }) => {
    await navigateAndWait(page, "/security", prefix);

    await expect(
      page.locator("h1").filter({ hasText: /security.*governance/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 2: Kill switch panel is present (halt/resume not duplicated here —
  // see kill-switch.spec.ts for the full halt/resume flow)
  // ---------------------------------------------------------------------------
  test("kill switch panel is visible on the security page", async ({ page, prefix }) => {
    await navigateAndWait(page, "/security", prefix);

    // Kill switch section heading
    await expect(
      page.locator("h2").filter({ hasText: /kill switch|agents halted/i }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Halt or resume button must exist and be enabled (not just rendered)
    const haltBtn = page.locator("button").filter({ hasText: /halt all agents|resume all agents/i }).first();
    await expect(haltBtn).toBeVisible({ timeout: 10_000 });
    await expect(haltBtn).toBeEnabled();
  });

  // ---------------------------------------------------------------------------
  // Test 3: "Security Policies" section heading and "Add Policy" button render
  //
  // NOTE: The "Add Policy" button has no click handler as of the current build.
  // This test verifies it is present. A TODO marks where dialog testing goes
  // once the handler is implemented.
  // ---------------------------------------------------------------------------
  test("Security Policies section heading and Add Policy button are visible", async ({ page, prefix }) => {
    await navigateAndWait(page, "/security", prefix);

    await expect(
      page.locator("h2").filter({ hasText: /security policies/i }).first()
    ).toBeVisible({ timeout: 10_000 });

    const addBtn = page.locator("button").filter({ hasText: /add policy/i }).first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await expect(addBtn).toBeEnabled();

    // TODO: When the "Add Policy" dialog handler is implemented:
    // await addBtn.click();
    // await expect(page.locator("dialog, [role='dialog']").first()).toBeVisible();
    // Fill in policy type, effect, name and submit — then verify row appears in table.
  });

  // ---------------------------------------------------------------------------
  // Test 4: Policy created via API appears in the policies table
  // ---------------------------------------------------------------------------
  test("policy created via API appears in the security policies table", async ({ page, company, prefix }) => {
    const policyName = `E2E-Policy-${Date.now()}`;

    // Create policy via API — rules array is required (not-null constraint)
    const res = await page.request.post(
      `/api/companies/${company.id}/security-policies`,
      {
        data: {
          name: policyName,
          policyType: "action_limit",
          targetType: "company",
          effect: "deny",
          priority: 10,
          rules: [{ action: "any", maxPerHour: 5 }],
          isActive: true,
        },
      }
    );
    expect(res.ok(), `create security policy should succeed, got ${res.status()}`).toBe(true);
    const policy = await res.json();
    expect(policy.id).toBeTruthy();

    // Navigate and verify it appears
    await navigateAndWait(page, "/security", prefix);

    await expect(
      page.locator(`text=${policyName}`).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Policy table shows correct type badge and effect badge
  // ---------------------------------------------------------------------------
  test("policy table renders type and effect badges for a created policy", async ({ page, company, prefix }) => {
    const policyName = `E2E-Badges-${Date.now()}`;

    const res = await page.request.post(
      `/api/companies/${company.id}/security-policies`,
      {
        data: {
          name: policyName,
          policyType: "rate_limit",
          targetType: "company",
          effect: "deny",
          priority: 5,
          rules: [{ action: "any", maxPerMinute: 100 }],
          isActive: true,
        },
      }
    );
    expect(res.ok()).toBe(true);

    await navigateAndWait(page, "/security", prefix);

    // Type badge: "rate_limit" rendered in a <span>
    await expect(
      page.locator("span").filter({ hasText: "rate_limit" }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Effect badge: "deny" rendered in a <span>
    await expect(
      page.locator("span").filter({ hasText: "deny" }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Status badge: "Active" for isActive=true
    await expect(
      page.locator("span").filter({ hasText: "Active" }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Deactivate policy via API — policy disappears from active-only UI list
  //
  // NOTE: The security page list fetches /security-policies with no filter,
  // which returns ONLY active policies (isActive=true by default). After
  // deactivation, the policy correctly disappears from the UI. The API also
  // supports ?isActive=false to retrieve inactive policies. This test verifies:
  //   a) Deactivation API succeeds and returns isActive=false
  //   b) GET ?isActive=false returns the deactivated policy
  //   c) The default UI list no longer shows the deactivated policy name
  // ---------------------------------------------------------------------------
  test("deactivated policy is removed from active list and retrievable with isActive=false", async ({ page, company, prefix }) => {
    const policyName = `E2E-Deactivate-${Date.now()}`;

    // Create active policy — rules array is required
    const createRes = await page.request.post(
      `/api/companies/${company.id}/security-policies`,
      {
        data: {
          name: policyName,
          policyType: "blast_radius",
          targetType: "company",
          effect: "deny",
          priority: 20,
          rules: [{ action: "any", maxAffectedResources: 10 }],
          isActive: true,
        },
      }
    );
    expect(createRes.ok()).toBe(true);
    const policy = await createRes.json();

    // Verify it appears in active list via API before deactivation
    const beforeRes = await page.request.get(
      `/api/companies/${company.id}/security-policies`
    );
    const activeBefore = await beforeRes.json();
    expect(activeBefore.some((p: { id: string }) => p.id === policy.id)).toBe(true);

    // Deactivate via API
    const deactivateRes = await page.request.post(
      `/api/companies/${company.id}/security-policies/${policy.id}/deactivate`
    );
    expect(
      deactivateRes.ok(),
      `deactivate policy should succeed, got ${deactivateRes.status()}`
    ).toBe(true);
    const deactivated = await deactivateRes.json();
    expect(deactivated.isActive).toBe(false);

    // Verify it no longer appears in default (active-only) list
    const afterRes = await page.request.get(
      `/api/companies/${company.id}/security-policies`
    );
    const activeAfter = await afterRes.json();
    expect(activeAfter.some((p: { id: string }) => p.id === policy.id)).toBe(false);

    // Verify it IS retrievable with ?isActive=false filter
    const inactiveRes = await page.request.get(
      `/api/companies/${company.id}/security-policies?isActive=false`
    );
    expect(inactiveRes.ok()).toBe(true);
    const inactive = await inactiveRes.json();
    const found = inactive.find((p: { id: string }) => p.id === policy.id);
    expect(found).toBeTruthy();
    expect(found.isActive).toBe(false);

    // Navigate to security page — deactivated policy name should NOT be visible
    // (since the UI renders only the active list by default)
    await navigateAndWait(page, "/security", prefix);
    await expect(
      page.locator(`text=${policyName}`)
    ).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Empty state renders when company has no policies
  //
  // NOTE: This test uses a fresh company lookup — the default test company may
  // already have policies from other tests, so we verify the empty-state text
  // only when the policy list is empty. We check API first.
  // ---------------------------------------------------------------------------
  test("security page shows policy table or empty state message", async ({ page, company, prefix }) => {
    // Check current policy count via API
    const listRes = await page.request.get(
      `/api/companies/${company.id}/security-policies`
    );
    expect(listRes.ok()).toBe(true);
    const policies = await listRes.json();

    await navigateAndWait(page, "/security", prefix);

    if (policies.length === 0) {
      // Empty state
      await expect(
        page.locator("text=No security policies configured.").first()
      ).toBeVisible({ timeout: 10_000 });
    } else {
      // Table with at least one policy row
      await expect(
        page.locator("table").first()
      ).toBeVisible({ timeout: 10_000 });

      // Table should have a Name column header
      await expect(
        page.locator("th").filter({ hasText: "Name" }).first()
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 8: Verify GET /security-policies API returns correct shape
  // ---------------------------------------------------------------------------
  test("GET security-policies API returns array with expected fields", async ({ page, company }) => {
    const policyName = `E2E-APIShape-${Date.now()}`;

    const createRes = await page.request.post(
      `/api/companies/${company.id}/security-policies`,
      {
        data: {
          name: policyName,
          policyType: "data_boundary",
          targetType: "company",
          effect: "deny",
          priority: 1,
          rules: [{ action: "read", resource: "pii" }],
          isActive: true,
        },
      }
    );
    expect(createRes.ok(), `create policy for shape test should succeed, got ${createRes.status()}`).toBe(true);

    const res = await page.request.get(
      `/api/companies/${company.id}/security-policies`
    );
    expect(res.ok()).toBe(true);
    const policies = await res.json();
    expect(Array.isArray(policies)).toBe(true);
    expect(policies.length).toBeGreaterThan(0);

    // Every policy must have required fields
    for (const p of policies) {
      expect(p).toHaveProperty("id");
      expect(p).toHaveProperty("policyType");
      expect(p).toHaveProperty("targetType");
      expect(p).toHaveProperty("effect");
      expect(p).toHaveProperty("isActive");
    }
  });
});
