/**
 * E2E: mobile redesign, lane C — the More pages and Settings at 390×844.
 *
 * Seeds a company with goals (a parent and a child), a project, an agent, a
 * routine and a cost event through the public API, then opens each More page
 * and the Settings hubs on an iPhone-sized viewport and asserts:
 *   - no horizontal page scroll,
 *   - no visible text under 12px,
 *   - the bottom nav and the sidebar drawer items are at least 44px tall.
 *
 * Set MOBILE_SHOTS_DIR to also save a full-page screenshot of every page.
 *
 * The spec has no port of its own: every request and navigation is relative to
 * the config's baseURL, so run it on a free port with PAPERCLIP_E2E_PORT, e.g.
 *   PAPERCLIP_E2E_PORT=3842 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts mobile-more.spec.ts
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import fs from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const SHOTS_DIR = process.env.MOBILE_SHOTS_DIR?.trim() || null;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

type Company = { id: string; issuePrefix: string };

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function seedCompany(request: APIRequestContext): Promise<Company> {
  // Fail loudly: auditing someone else's company would test the wrong data.
  const company = await post<Company>(request, "/api/companies", {
    name: `E2E Mobile More ${Date.now()}`,
  });

  const parent = await post<{ id: string }>(request, `/api/companies/${company.id}/goals`, {
    title: "Grow the customer base in the Pacific Northwest region this year",
    level: "company",
    status: "active",
  });
  await post(request, `/api/companies/${company.id}/goals`, {
    title: "Launch a referral programme with a long descriptive title that has to wrap",
    level: "team",
    parentId: parent.id,
  });
  const project = await post<{ id: string }>(request, `/api/companies/${company.id}/projects`, {
    name: "Website relaunch with a deliberately long project name",
    description: "Rebuild the marketing site, migrate the blog and ship the new pricing page.",
    status: "in_progress",
  });
  const hire = await post<{ agent: { id: string }; approval?: { id: string } }>(
    request,
    `/api/companies/${company.id}/agent-hires`,
    {
      name: "Mobile Audit Worker",
      role: "engineer",
      title: "Engineer",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.stdout.write('done\\n')"] },
    },
  );
  if (hire.approval) {
    await post(request, `/api/approvals/${hire.approval.id}/approve`, {});
  }
  await post(request, `/api/companies/${company.id}/routines`, {
    title: "Weekly pipeline review for every open opportunity",
    projectId: project.id,
    assigneeAgentId: hire.agent.id,
  });
  await post(request, `/api/companies/${company.id}/cost-events`, {
    agentId: hire.agent.id,
    projectId: project.id,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    inputTokens: 120_000,
    outputTokens: 8_000,
    costCents: 412,
    occurredAt: new Date().toISOString(),
  });
  return company;
}

async function audit(page: Page) {
  const width = page.viewportSize()?.width ?? 390;
  return page.evaluate((viewportWidth) => {
    const doc = document.documentElement;
    // With mobile emulation the browser zooms out to fit wide content, which
    // also widens window.innerWidth; measure against the device width instead.
    const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - viewportWidth;
    const small: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const el = node.parentElement;
      if (!text || !el) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      // Skip screen-reader-only text and anything not laid out.
      if (rect.width <= 1 || rect.height <= 1) continue;
      if (el.closest("[aria-hidden='true'], .sr-only")) continue;
      // Off-canvas (the closed drawer, a nav that is hidden by transform).
      if (rect.right <= 0 || rect.left >= viewportWidth) continue;
      const size = Number.parseFloat(style.fontSize);
      if (size < 12) small.push(`${size}px "${text.slice(0, 40)}" <${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}">`);
    }
    return { overflow, small };
  }, width);
}

async function shoot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

// `ready` is seeded or page-specific text that only renders once the page's
// data has loaded, so the audit never runs against a skeleton.
const PAGES = [
  { name: "goals", path: "goals", ready: /Launch a referral programme/ },
  { name: "activity", path: "activity", ready: /Mobile Audit Worker/ },
  { name: "routines", path: "routines", ready: /Weekly pipeline review/ },
  { name: "costs", path: "costs", ready: /Website relaunch with a deliberately long project name/ },
  { name: "projects", path: "projects", ready: /Website relaunch/ },
  { name: "company-settings", path: "company/settings", ready: /Danger zone/i },
  { name: "instance-settings", path: "instance/settings/general", ready: /Backup retention/ },
] as const;

test.describe("Mobile More pages at 390×844", () => {
  let company: Company;

  test.beforeAll(async ({ request }) => {
    company = await seedCompany(request);
  });

  for (const target of PAGES) {
    test(`${target.name}: no horizontal scroll, no text under 12px`, async ({ page }) => {
      const url = target.path.startsWith("instance/")
        ? `/${target.path}`
        : `/${company.issuePrefix}/${target.path}`;
      await page.goto(url);
      await expect(page.locator("#main-content").getByText(target.ready).first()).toBeVisible({ timeout: 20_000 });

      // Polled, so content that renders after the ready marker is still audited.
      await expect
        .poll(async () => (await audit(page)).overflow, { message: "horizontal page overflow in px" })
        .toBeLessThanOrEqual(1);
      await expect
        .poll(async () => (await audit(page)).small, { message: "visible text under 12px" })
        .toEqual([]);
      await shoot(page, target.name);
    });
  }

  test("bottom nav, header and sidebar drawer tap targets are at least 44px", async ({ page }) => {
    // The Report button only renders when the instance has a GitHub credential;
    // stub its config so the header's tap target is always measured.
    await page.route("**/api/issue-reports/config", (route) =>
      route.fulfill({ json: { enabled: true, repo: "acme/web" } }),
    );
    await page.goto(`/${company.issuePrefix}/goals`);
    const nav = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(nav).toBeVisible({ timeout: 20_000 });
    const links = nav.locator("a, button");
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < count; i += 1) {
      const box = await links.nth(i).boundingBox();
      expect(box, `bottom nav item ${i}`).not.toBeNull();
      expect.soft(box!.height, `bottom nav item ${i} height`).toBeGreaterThanOrEqual(44);
      expect.soft(box!.width, `bottom nav item ${i} width`).toBeGreaterThanOrEqual(44);
    }

    // The status dot and the Report button live in the sticky header on
    // phones, not floating over content; the button is a 44px target.
    const cluster = page.getByTestId("mobile-status-cluster");
    await expect(cluster.getByTestId("connection-status")).toBeVisible();
    expect((await cluster.boundingBox())!.y).toBeLessThan(100);
    const report = cluster.getByTestId("report-issue-button");
    await expect(report).toBeVisible();
    const reportBox = await report.boundingBox();
    expect.soft(reportBox!.height, "report button height").toBeGreaterThanOrEqual(44);
    expect.soft(reportBox!.width, "report button width").toBeGreaterThanOrEqual(44);

    // Layout publishes the nav's live height for bottom-docked composers.
    const offset = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--mobile-bottom-nav-offset").trim(),
    );
    expect(offset).toContain("4rem");
    expect(await page.evaluate(() => document.documentElement.dataset.mobileBottomNav)).toBe("visible");

    await page.getByRole("button", { name: "Open sidebar" }).click();
    const drawerLinks = page.locator("[data-sidebar-nav-item]");
    await expect(drawerLinks.first()).toBeVisible();
    // Measure once the slide-in transition has brought the drawer fully on screen.
    await expect.poll(async () => (await drawerLinks.first().boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
    await shoot(page, "drawer");
    const drawerCount = await drawerLinks.count();
    for (let i = 0; i < drawerCount; i += 1) {
      const item = drawerLinks.nth(i);
      if (!(await item.isVisible())) continue;
      const box = await item.boundingBox();
      expect.soft(box!.height, `drawer item ${i} height`).toBeGreaterThanOrEqual(44);
    }
  });
});
