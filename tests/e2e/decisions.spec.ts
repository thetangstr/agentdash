/**
 * E2E: UX-7 (#788) + one UX (doc/plans/2026-09-30-one-ux.md) — the Decisions
 * page and the redirects from the old Inbox and Approvals list URLs, the same
 * for every company. These tests navigate by page.goto — a full document
 * load, the real cold-load path — and assert where each URL settles.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { resolveE2eServerPort } from "./e2e-port";

const PORT = resolveE2eServerPort(3399);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function createCompany(request: APIRequestContext, productProfile?: string) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: {
      name: `E2E-Decisions-${Date.now()}`,
      ...(productProfile ? { productProfile } : {}),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as { id: string; issuePrefix: string };
}

async function expectHealthySettledUrl(page: Page, url: string, where: string) {
  // Wait on the URL itself: networkidle can settle before the post-skeleton
  // client-side Navigate commits on slow CI, so asserting pathname right
  // after it raced the redirect. Fall through to the assertion on timeout —
  // it reports the actual landing path.
  await page
    .waitForURL((u) => new URL(u).pathname === url, { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // The redirect is a client-side Navigate — on a slow runner networkidle
  // settles before React commits it, so wait for the URL itself, not just a
  // quiet network.
  await page.waitForURL(`**${url}`, { timeout: 15_000 }).catch(() => undefined);
  const pathname = new URL(page.url()).pathname;
  expect(pathname, `${where}: deep link was rewritten`).toBe(url);
  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  expect(body.trim().length, `${where}: rendered an empty page`).toBeGreaterThan(0);
  for (const bad of ["Company not found", "No company matches prefix", "Unexpected Application Error"]) {
    expect(body, `${where}: shows "${bad}"`).not.toContain(bad);
  }
}

test.describe("Decisions and the legacy list redirects", () => {
  test("default profile: inbox and approvals routes land on Decisions", async ({ page, request }) => {
    const company = await createCompany(request);
    const title = `Decide the launch date ${Date.now()}`;
    const issueRes = await request.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: { title, status: "todo", assigneeUserId: "local-board" },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);

    // The page itself, cold.
    await page.goto(`${BASE_URL}/${company.issuePrefix}/decisions`);
    await expectHealthySettledUrl(page, `/${company.issuePrefix}/decisions`, "typed /decisions");
    await expect(page.getByTestId("decisions")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("decisions")).toContainText(title);

    // Every inbox/approvals entry point redirects to it — cold load each.
    for (const [from, label] of [
      ["inbox", "typed /inbox"],
      ["inbox/mine", "typed /inbox/mine"],
      ["inbox/unread", "typed /inbox/unread"],
      ["inbox/company", "typed /inbox/company"],
      ["approvals", "typed /approvals"],
      ["approvals/all", "typed /approvals/all"],
      ["approvals/pending", "typed /approvals/pending"],
    ] as const) {
      await page.goto(`${BASE_URL}/${company.issuePrefix}/${from}`);
      await expectHealthySettledUrl(
        page,
        `/${company.issuePrefix}/decisions`,
        label,
      );
    }
  });

  // One UX (doc/plans/2026-09-30-one-ux.md): an MK company gets the same
  // Decisions page and the same redirects — its old bookmarks land here too.
  test("agentdash_mk: the same inbox and approvals routes land on Decisions", async ({
    page,
    request,
  }) => {
    const company = await createCompany(request, "agentdash_mk");

    await page.goto(`${BASE_URL}/${company.issuePrefix}/decisions`);
    await expectHealthySettledUrl(page, `/${company.issuePrefix}/decisions`, "MK typed /decisions");
    await expect(page.getByTestId("decisions")).toBeVisible({ timeout: 20_000 });

    for (const path of ["inbox", "inbox/mine", "inbox/unread", "inbox/company", "approvals/all", "approvals/pending"]) {
      await page.goto(`${BASE_URL}/${company.issuePrefix}/${path}`);
      await expectHealthySettledUrl(
        page,
        `/${company.issuePrefix}/decisions`,
        `MK typed /${path}`,
      );
    }
  });
});
