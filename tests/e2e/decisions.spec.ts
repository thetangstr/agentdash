/**
 * E2E: UX-7 (#788) — the Decisions page and the profile-aware redirects.
 *
 * The bug this guards: on a COLD deep link the product profile is still
 * resolving (companies fetch in flight, selection effect not yet run) and
 * the route switch used to read the null as "default profile", firing a
 * redirect to /decisions that rewrote the URL before MK could be seen. An
 * agentdash_mk bookmark like /ACME/inbox/unread landed on /inbox/mine.
 * These tests navigate by page.goto — a full document load, the real
 * cold-load path — and assert the final URL survives.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
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
  // The profile-aware redirect is a client-side Navigate that fires after the
  // companies query resolves — on a slow runner networkidle settles before
  // React commits it, so wait for the URL itself, not just a quiet network.
  await page.waitForURL(`**${url}`, { timeout: 15_000 }).catch(() => undefined);
  const pathname = new URL(page.url()).pathname;
  expect(pathname, `${where}: deep link was rewritten`).toBe(url);
  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  expect(body.trim().length, `${where}: rendered an empty page`).toBeGreaterThan(0);
  for (const bad of ["Company not found", "No company matches prefix", "Unexpected Application Error"]) {
    expect(body, `${where}: shows "${bad}"`).not.toContain(bad);
  }
}

test.describe("Decisions and profile-aware redirects", () => {
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

  test("agentdash_mk: cold deep links keep their URLs instead of bouncing to Decisions", async ({
    page,
    request,
  }) => {
    const company = await createCompany(request, "agentdash_mk");

    // Cold document loads — the profile must resolve before any redirect
    // fires, so each of these proves the switch waited instead of guessing.
    for (const path of ["inbox/unread", "inbox/company", "approvals/all", "approvals/pending"]) {
      await page.goto(`${BASE_URL}/${company.issuePrefix}/${path}`);
      await expectHealthySettledUrl(
        page,
        `/${company.issuePrefix}/${path}`,
        `MK typed /${path}`,
      );
    }

    // And MK's own redirects still happen once the profile is known.
    await page.goto(`${BASE_URL}/${company.issuePrefix}/decisions`);
    await expectHealthySettledUrl(
      page,
      `/${company.issuePrefix}/inbox/mine`,
      "MK typed /decisions",
    );
    await page.goto(`${BASE_URL}/${company.issuePrefix}/inbox`);
    await expectHealthySettledUrl(
      page,
      `/${company.issuePrefix}/inbox/mine`,
      "MK typed /inbox",
    );
  });
});
