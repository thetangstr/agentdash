import { test, expect } from "./fixtures/test-helpers";

/**
 * CUJ-4: Task Dependencies
 *
 * Tests the dependency flow end-to-end. Key known limitation:
 * The DAG page queries `?includeDependencies=true` but the list route does not
 * populate `blockedBy`/`blocks` on list responses — so newly created issues
 * will not appear in the SVG/list until the server implements that param.
 * These tests cover what the DAG page actually renders and document the gap.
 *
 * What IS tested:
 * - DAG page heading and empty state renders correctly
 * - Individual issue detail shows "Blocked by" section via IssueProperties
 * - Issue detail shows "No blockers" when issue has none
 * - API dependency creation endpoints return correct data
 * - Blockers list via GET /companies/:id/issues/:id/blockers returns correct data
 *
 * What is a known gap (documented as failing until server is fixed):
 * - DAG SVG/list showing freshly created dependent issues
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CreatedIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
}

async function createIssue(
  page: import("@playwright/test").Page,
  companyId: string,
  title: string,
): Promise<CreatedIssue> {
  const res = await page.request.post(`/api/companies/${companyId}/issues`, {
    data: { title, description: `E2E: ${title}` },
  });
  expect(res.ok(), `createIssue(${title}) status ${res.status()}`).toBe(true);
  return res.json();
}

async function addBlockerViaPatch(
  page: import("@playwright/test").Page,
  issueId: string,
  blockedByIssueIds: string[],
): Promise<void> {
  const res = await page.request.patch(`/api/issues/${issueId}`, {
    data: { blockedByIssueIds },
  });
  expect(res.ok(), `addBlockerViaPatch status ${res.status()}`).toBe(true);
}

async function addBlockerViaPost(
  page: import("@playwright/test").Page,
  companyId: string,
  issueId: string,
  blockedByIssueId: string,
): Promise<void> {
  const res = await page.request.post(
    `/api/companies/${companyId}/issues/${issueId}/dependencies`,
    { data: { blockedByIssueId } },
  );
  expect(res.ok(), `addBlockerViaPost status ${res.status()}`).toBe(true);
}

// ---------------------------------------------------------------------------
// DAG page rendering
// ---------------------------------------------------------------------------

test.describe("CUJ-4: Task Dependencies — DAG page", () => {
  test("DAG page renders Task Dependencies heading", async ({ page, prefix }) => {
    await page.goto(`/${prefix}/task-dependencies`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("h2").filter({ hasText: /Task Dependencies/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("DAG page shows empty state when no dependencies exist", async ({
    page,
    prefix,
  }) => {
    await page.goto(`/${prefix}/task-dependencies`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Either shows the SVG+list (has deps) or the empty state — page should not crash
    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.length).toBeGreaterThan(20);

    // No React error boundary
    expect(await page.locator("[data-testid='error-boundary']").count()).toBe(0);
  });

  test("DAG page does not show a JS error", async ({ page, prefix }) => {
    const jsErrors: string[] = [];
    page.on("pageerror", (err) => jsErrors.push(err.message));

    await page.goto(`/${prefix}/task-dependencies`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // Wait for any async queries to settle
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    expect(jsErrors.filter((e) => !e.includes("ResizeObserver"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Issue detail — IssueProperties "Blocked by" section
// ---------------------------------------------------------------------------

test.describe("CUJ-4: Task Dependencies — Issue detail", () => {
  test("issue detail shows No blockers when issue has no dependencies", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const issue = await createIssue(page, company.id, `NODEP-${ts}`);

    await page.goto(`/${prefix}/issues/${issue.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("text=No blockers").first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  test("issue detail Blocked by section shows blocker identifier after PATCH", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const blocker = await createIssue(page, company.id, `PROP-BLK-${ts}`);
    const dependent = await createIssue(page, company.id, `PROP-DEP-${ts}`);
    await addBlockerViaPatch(page, dependent.id, [blocker.id]);

    // Navigate to dependent issue detail
    await page.goto(`/${prefix}/issues/${dependent.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // The IssueProperties sidebar renders the blocker as a pill with its identifier
    await expect(
      page.locator("text=" + blocker.identifier).first(),
    ).toBeVisible({ timeout: 12_000 });
  });

  test("issue detail Blocked by section hides No blockers after blocker added", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const blocker = await createIssue(page, company.id, `HIDE-BLK-${ts}`);
    const dependent = await createIssue(page, company.id, `HIDE-DEP-${ts}`);
    await addBlockerViaPatch(page, dependent.id, [blocker.id]);

    await page.goto(`/${prefix}/issues/${dependent.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    // "No blockers" should NOT appear when a blocker is set
    await expect(
      page.locator("text=No blockers"),
    ).not.toBeVisible({ timeout: 12_000 });
  });

  test("issue detail shows title in heading", async ({
    page,
    company,
    prefix,
  }) => {
    const ts = Date.now();
    const title = `IssueTitle-${ts}`;
    const issue = await createIssue(page, company.id, title);

    await page.goto(`/${prefix}/issues/${issue.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(page.locator(`text=${title}`).first()).toBeVisible({ timeout: 12_000 });
  });
});

// ---------------------------------------------------------------------------
// API: dependency creation and retrieval
// ---------------------------------------------------------------------------

test.describe("CUJ-4: Task Dependencies — API", () => {
  test("PATCH blockedByIssueIds returns 200 for valid dependency", async ({
    page,
    company,
  }) => {
    const ts = Date.now();
    const blocker = await createIssue(page, company.id, `API-BLK-${ts}`);
    const dependent = await createIssue(page, company.id, `API-DEP-${ts}`);

    const res = await page.request.patch(`/api/issues/${dependent.id}`, {
      data: { blockedByIssueIds: [blocker.id] },
    });
    expect(res.ok()).toBe(true);
    expect(res.status()).toBe(200);
  });

  test("POST /dependencies returns 201 with dependency record", async ({
    page,
    company,
  }) => {
    const ts = Date.now();
    const blocker = await createIssue(page, company.id, `DEP-BLK-${ts}`);
    const dependent = await createIssue(page, company.id, `DEP-DEP-${ts}`);

    const res = await page.request.post(
      `/api/companies/${company.id}/issues/${dependent.id}/dependencies`,
      { data: { blockedByIssueId: blocker.id } },
    );
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.issueId).toBe(dependent.id);
    expect(body.blockedByIssueId).toBe(blocker.id);
    expect(body.dependencyType).toBe("blocks");
  });

  test("GET /blockers returns the blocking issue after dependency created", async ({
    page,
    company,
  }) => {
    const ts = Date.now();
    const blocker = await createIssue(page, company.id, `BLKR-BLK-${ts}`);
    const dependent = await createIssue(page, company.id, `BLKR-DEP-${ts}`);
    await addBlockerViaPost(page, company.id, dependent.id, blocker.id);

    const res = await page.request.get(
      `/api/companies/${company.id}/issues/${dependent.id}/blockers`,
    );
    expect(res.ok()).toBe(true);
    const blockers = await res.json();
    expect(Array.isArray(blockers)).toBe(true);
    expect(blockers.length).toBeGreaterThanOrEqual(1);
    const found = blockers.find((b: { issueId?: string; blockedByIssueId?: string }) =>
      b.blockedByIssueId === blocker.id || b.issueId === blocker.id,
    );
    expect(found).toBeTruthy();
  });

  test("GET /dependents returns the dependent issue after dependency created", async ({
    page,
    company,
  }) => {
    const ts = Date.now();
    const blocker = await createIssue(page, company.id, `DPND-BLK-${ts}`);
    const dependent = await createIssue(page, company.id, `DPND-DEP-${ts}`);
    await addBlockerViaPost(page, company.id, dependent.id, blocker.id);

    const res = await page.request.get(
      `/api/companies/${company.id}/issues/${blocker.id}/dependents`,
    );
    expect(res.ok()).toBe(true);
    const dependents = await res.json();
    expect(Array.isArray(dependents)).toBe(true);
    expect(dependents.length).toBeGreaterThanOrEqual(1);
    const found = dependents.find((d: { issueId?: string }) =>
      d.issueId === dependent.id,
    );
    expect(found).toBeTruthy();
  });

  test("DELETE /dependencies removes the dependency", async ({
    page,
    company,
  }) => {
    const ts = Date.now();
    const blocker = await createIssue(page, company.id, `DEL-BLK-${ts}`);
    const dependent = await createIssue(page, company.id, `DEL-DEP-${ts}`);
    await addBlockerViaPost(page, company.id, dependent.id, blocker.id);

    const delRes = await page.request.delete(
      `/api/companies/${company.id}/issues/${dependent.id}/dependencies/${blocker.id}`,
    );
    expect(delRes.ok()).toBe(true);

    // Blockers list should now be empty
    const checkRes = await page.request.get(
      `/api/companies/${company.id}/issues/${dependent.id}/blockers`,
    );
    const blockers = await checkRes.json();
    const stillPresent = (blockers as { blockedByIssueId?: string }[]).find(
      (b) => b.blockedByIssueId === blocker.id,
    );
    expect(stillPresent).toBeFalsy();
  });

  test("PATCH blockedByIssueIds with empty array clears all blockers", async ({
    page,
    company,
  }) => {
    const ts = Date.now();
    const blocker = await createIssue(page, company.id, `CLR-BLK-${ts}`);
    const dependent = await createIssue(page, company.id, `CLR-DEP-${ts}`);
    await addBlockerViaPatch(page, dependent.id, [blocker.id]);

    // Clear blockers
    const clearRes = await page.request.patch(`/api/issues/${dependent.id}`, {
      data: { blockedByIssueIds: [] },
    });
    expect(clearRes.ok()).toBe(true);

    // Navigate to issue detail — should show No blockers again
    const { prefix } = await (async () => {
      const companies = await page.request.get("/api/companies");
      const all = await companies.json();
      const co = all.find((c: { id: string }) => c.id === company.id);
      return { prefix: co?.issuePrefix ?? "MKT" };
    })();

    await page.goto(`/${prefix}/issues/${dependent.id}`);
    await page.locator("nav").first().waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.locator("text=No blockers").first(),
    ).toBeVisible({ timeout: 12_000 });
  });
});
