import { test, expect, navigateAndWait } from "./fixtures/test-helpers";

/**
 * CUJ-9: Skill Management
 *
 * CUJ-STATUS notes:
 *   - Skills page (list view): DONE
 *   - Skill Versions page (SkillVersions.tsx): DONE — lists installed company skills with trust-level badges
 *   - Version management UI (approve/publish/diff): NOT BUILT (P1)
 *   - Skills registry (global skills): DONE (skills-registry.ts)
 *   - Company skill install/update: DONE (company-skills.ts)
 *
 * Routes:
 *   - /:prefix/skills/*     → CompanySkills page
 *   - /:prefix/skill-versions → SkillVersions page
 *
 * API endpoints used for setup:
 *   - GET  /companies/:id/skills        → list installed company skills
 *   - GET  /companies/:id/skills/:id    → single skill detail
 *
 * Test strategy:
 *   1. Skills page loads with correct heading
 *   2. Skill Versions page loads with "Skill Versions" heading
 *   3. If skills are installed, trust-level badges render on Skill Versions page
 *   4. Each skill row on Skill Versions page is a link (navigates to /skills/:id)
 *   5. GET /companies/:id/skills API returns expected shape
 *   6. TODOs mark where version management UI testing would go
 */

test.describe("CUJ-9: Skill Management", () => {
  // ---------------------------------------------------------------------------
  // Test 1: Company Skills page loads with heading
  // ---------------------------------------------------------------------------
  test("company skills page loads with Skills heading", async ({ page, prefix }) => {
    await navigateAndWait(page, "/skills", prefix);

    // CompanySkills page renders an h1 with "Skills"
    await expect(
      page.locator("h1").filter({ hasText: /skill/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 2: Skill Versions page loads with "Skill Versions" heading
  // ---------------------------------------------------------------------------
  test("skill versions page loads with Skill Versions heading", async ({ page, prefix }) => {
    await navigateAndWait(page, "/skill-versions", prefix);

    await expect(
      page.locator("h2").filter({ hasText: /skill versions/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 3: Skill Versions page shows skills count or empty state
  // ---------------------------------------------------------------------------
  test("skill versions page shows installed skills count or empty state", async ({ page, company, prefix }) => {
    // Check current skill count via API
    const listRes = await page.request.get(`/api/companies/${company.id}/skills`);
    expect(listRes.ok()).toBe(true);
    const skills = await listRes.json();

    await navigateAndWait(page, "/skill-versions", prefix);

    if (skills.length === 0) {
      // EmptyState: "No skills installed yet."
      await expect(
        page.locator("text=No skills installed yet.").first()
      ).toBeVisible({ timeout: 10_000 });
    } else {
      // Shows count badge: "N skill(s)"
      await expect(
        page.locator(`text=/${skills.length} skill/i`).first()
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: Trust level badges render for installed skills
  //
  // This test requires at least one installed skill. If none exist, it is
  // skipped with a clear message.
  // ---------------------------------------------------------------------------
  test("trust level badges are visible for installed skills on skill versions page", async ({ page, company, prefix }) => {
    const listRes = await page.request.get(`/api/companies/${company.id}/skills`);
    expect(listRes.ok()).toBe(true);
    const skills = await listRes.json();

    if (skills.length === 0) {
      // No skills installed — cannot test badges, this is acceptable
      test.skip(true, "No skills installed in this company — trust badge test skipped");
      return;
    }

    await navigateAndWait(page, "/skill-versions", prefix);

    // Trust level badge text (one of: markdown_only, assets, scripts_executables, unvetted)
    await expect(
      page.locator("span").filter({ hasText: /markdown_only|assets|scripts_executables|unvetted/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Skill row is a link that navigates to the skill detail page
  // ---------------------------------------------------------------------------
  test("skill row on skill versions page links to skill detail", async ({ page, company, prefix }) => {
    const listRes = await page.request.get(`/api/companies/${company.id}/skills`);
    expect(listRes.ok()).toBe(true);
    const skills = await listRes.json();

    if (skills.length === 0) {
      test.skip(true, "No skills installed — link navigation test skipped");
      return;
    }

    await navigateAndWait(page, "/skill-versions", prefix);

    const firstSkill = skills[0];

    // The EntityRow renders as a link — click the skill name
    const skillLink = page.locator(`a[href*="/skills/${firstSkill.id}"]`).first();
    await expect(skillLink).toBeVisible({ timeout: 10_000 });

    await skillLink.click();

    // After navigation, URL should include /skills/:id
    await expect(page).toHaveURL(new RegExp(`/skills/${firstSkill.id}`), { timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Skill name appears on the Skill Versions page
  // ---------------------------------------------------------------------------
  test("first installed skill name is visible on the skill versions page", async ({ page, company, prefix }) => {
    const listRes = await page.request.get(`/api/companies/${company.id}/skills`);
    expect(listRes.ok()).toBe(true);
    const skills = await listRes.json();

    if (skills.length === 0) {
      test.skip(true, "No skills installed — name visibility test skipped");
      return;
    }

    await navigateAndWait(page, "/skill-versions", prefix);

    const firstName = skills[0].name;
    await expect(
      page.locator(`text=${firstName}`).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 7: GET /companies/:id/skills API returns expected shape
  // ---------------------------------------------------------------------------
  test("GET company skills API returns array with id, name, and trustLevel fields", async ({ page, company }) => {
    const res = await page.request.get(`/api/companies/${company.id}/skills`);
    expect(res.ok()).toBe(true);

    const skills = await res.json();
    expect(Array.isArray(skills)).toBe(true);

    // Validate shape of each skill if any exist
    for (const skill of skills) {
      expect(skill).toHaveProperty("id");
      expect(skill).toHaveProperty("name");
      // trustLevel is present (may be null if not set)
      expect("trustLevel" in skill).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 8: Skill source type (sourceType) is displayed on each row
  // ---------------------------------------------------------------------------
  test("skill source type is displayed in skill rows on skill versions page", async ({ page, company, prefix }) => {
    const listRes = await page.request.get(`/api/companies/${company.id}/skills`);
    expect(listRes.ok()).toBe(true);
    const skills = await listRes.json();

    if (skills.length === 0) {
      test.skip(true, "No skills installed — sourceType display test skipped");
      return;
    }

    await navigateAndWait(page, "/skill-versions", prefix);

    // SkillVersions trailing slot renders skill.sourceType as a text span
    const firstSourceType = skills[0].sourceType;
    if (firstSourceType) {
      await expect(
        page.locator(`text=${firstSourceType}`).first()
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  // ---------------------------------------------------------------------------
  // TODO: Version management UI — approve, publish, diff view
  //
  // The following behaviors are NOT built yet (CUJ-STATUS P1 gap):
  //   - Version list for a specific skill (no route exists in UI)
  //   - Approve/publish buttons on a version
  //   - Line-level diff view between versions
  //
  // When implemented, add tests here:
  //   - Navigate to /:prefix/skills/:id/versions → shows version list
  //   - Click "Approve" on a draft version → version status changes to "approved"
  //   - Click "Publish" on an approved version → version status changes to "published"
  //   - Click "Diff" between two versions → line diff renders
  // ---------------------------------------------------------------------------
});
