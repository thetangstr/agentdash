/**
 * E2E: #845 — Company Access → Edit member dialog must fit the viewport.
 *
 * The dialog holds a role select, a status select, the implicit-grants box and one
 * card per permission (joins:approve is last). It used to have no max height, so
 * on short or narrow screens Save and the last grants were clipped off-screen with
 * no way to scroll. It now caps its height, scrolls the body and pins the footer.
 *
 * For each viewport: open the dialog on a desktop layout (the member table itself
 * is a fixed-width grid), shrink the viewport, reach and toggle the last grant,
 * then check Save is fully on-screen, sends the update and closes the dialog.
 *
 * The update response is stubbed with page.route. In local_trusted mode the only
 * human member is the implicit board actor itself, and the server refuses edits to
 * your own membership (getProtectedMemberReason in server/src/routes/access.ts:
 * 403 "You cannot remove yourself."). A second human can't be seeded here either:
 * accepting an invite as that same actor is a 409 ("You already belong to this
 * company"). This spec is about the dialog layout, not member authorization, which
 * the access route tests cover.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resolveE2eServerPort } from "./e2e-port";

// The app's service worker would proxy API calls past page.route.
test.use({ serviceWorkers: "block" });

const PORT = resolveE2eServerPort(3399);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function ensureCompany(request: APIRequestContext) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Access-${Date.now()}` },
  });
  if (created.ok()) return (await created.json()) as { id: string; issuePrefix: string };
  const list = await request.get(`${BASE_URL}/api/companies`);
  expect(list.ok()).toBe(true);
  const companies = (await list.json()) as Array<{ id: string; issuePrefix: string }>;
  expect(companies.length).toBeGreaterThan(0);
  return companies[0]!;
}

const VIEWPORTS = [
  { name: "wide desktop", width: 2000, height: 1083 },
  { name: "short desktop", width: 1280, height: 520 },
  { name: "narrow phone", width: 360, height: 640 },
];

test.describe("Company Access edit-member dialog (#845)", () => {
  for (const viewport of VIEWPORTS) {
    test(`Save and the last grant are reachable on a ${viewport.name} (${viewport.width}x${viewport.height})`, async ({ page, request }) => {
      const company = await ensureCompany(request);
      const membersRes = await request.get(`${BASE_URL}/api/companies/${company.id}/members`);
      expect(membersRes.ok()).toBe(true);
      const memberIds = ((await membersRes.json()) as { members: Array<{ id: string }> }).members.map((m) => m.id);
      expect(memberIds.length).toBeGreaterThan(0);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${BASE_URL}/${company.issuePrefix}/company/settings/access`);
      const editButton = page.getByRole("button", { name: "Edit", exact: true }).first();
      await expect(editButton).toBeVisible({ timeout: 20_000 });
      await editButton.click();

      const dialog = page.getByRole("dialog", { name: "Edit member" });
      await expect(dialog).toBeVisible();

      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      // The dialog never grows past the viewport.
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

      // The last grant scrolls into view inside the dialog body and can be toggled.
      const lastGrant = dialog.locator("label", { hasText: "joins:approve" }).getByRole("checkbox");
      await lastGrant.scrollIntoViewIfNeeded();
      await expect(lastGrant).toBeInViewport();
      // Toggle it and back, so the grants sent below match what was loaded.
      const before = (await lastGrant.getAttribute("aria-checked")) ?? "false";
      await lastGrant.click();
      await expect(lastGrant).not.toHaveAttribute("aria-checked", before);
      await lastGrant.click();
      await expect(lastGrant).toHaveAttribute("aria-checked", before);

      // Save stays pinned on-screen while the body is scrolled.
      const save = dialog.getByRole("button", { name: "Save access" });
      await expect(save).toBeInViewport({ ratio: 1 });

      const sent: Array<{ memberId: string; body: unknown }> = [];
      await page.route(
        (url) => url.pathname.startsWith(`/api/companies/${company.id}/members/`)
          && url.pathname.endsWith("/role-and-grants"),
        async (route) => {
          const patch = route.request();
          if (patch.method() !== "PATCH") return route.fallback();
          const memberId = new URL(patch.url()).pathname.split("/").at(-2) ?? "";
          const body = patch.postDataJSON() as Record<string, unknown>;
          sent.push({ memberId, body });
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ id: memberId, companyId: company.id, ...body }),
          });
        },
      );

      await save.click();
      await expect.poll(() => sent.length).toBe(1);
      expect(memberIds).toContain(sent[0]!.memberId);
      expect(sent[0]!.body).toEqual(
        expect.objectContaining({ status: "active", grants: expect.any(Array) }),
      );
      await expect(dialog).toBeHidden();
      await expect(page.getByText("Member updated")).toBeVisible();
    });
  }
});
