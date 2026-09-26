/**
 * E2E: UX-2 (#783) — what shipped.
 *
 * Seeds an issue with a pull-request work product through the public API, then
 * opens issue detail (the Result block, above the description) and the
 * company-wide Shipped page, and asserts the PR link and its state on both.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PR_URL = `https://github.com/acme/web/pull/${Date.now() % 100_000}`;
const PR_TITLE = "Add a /health badge to the README";

async function ensureCompany(request: APIRequestContext) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Shipped-${Date.now()}` },
  });
  if (created.ok()) return (await created.json()) as { id: string; issuePrefix: string };
  // Single-company installs refuse a second company; reuse the one there is.
  const list = await request.get(`${BASE_URL}/api/companies`);
  expect(list.ok()).toBe(true);
  const companies = (await list.json()) as Array<{ id: string; issuePrefix: string }>;
  expect(companies.length).toBeGreaterThan(0);
  return companies[0]!;
}

test.describe("Shipped (UX-2)", () => {
  test("issue detail shows the PR in a Result block, and /shipped lists it", async ({ page, request }) => {
    const company = await ensureCompany(request);

    const issueRes = await request.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: { title: "Ship the health badge", status: "in_review" },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = (await issueRes.json()) as { id: string; identifier: string | null };

    const wpRes = await request.post(`${BASE_URL}/api/issues/${issue.id}/work-products`, {
      data: {
        type: "pull_request",
        provider: "github",
        title: PR_TITLE,
        url: PR_URL,
        status: "ready_for_review",
        isPrimary: true,
      },
    });
    expect(wpRes.ok(), await wpRes.text()).toBe(true);

    await page.goto(`${BASE_URL}/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const result = page.getByTestId("issue-result-block");
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.locator(`a[href="${PR_URL}"]`)).toContainText(PR_TITLE);
    await expect(result.getByTestId("work-product-state")).toHaveText("open");
    // "Without scrolling": the block is inside the first viewport.
    const box = await result.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport ? box.y + 40 < viewport.height : false).toBe(true);

    await page.goto(`${BASE_URL}/${company.issuePrefix}/shipped`);
    await expect(page.getByRole("heading", { name: "Shipped" })).toBeVisible({ timeout: 20_000 });
    const row = page.getByTestId("shipped-row").filter({ hasText: PR_TITLE }).first();
    await expect(row.locator(`a[href="${PR_URL}"]`)).toBeVisible();
    await expect(row).toContainText("Ship the health badge");
    await expect(row.getByTestId("shipped-usage")).toHaveText("not metered yet");
    await expect(page.getByTestId("shipped-month-total")).toContainText("shipped");
  });
});
