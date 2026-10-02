/**
 * E2E: mobile lists (lane B) — the list pages at phone width (390×844).
 *
 * Seeds one company with a small org (long agent names, a manager and two
 * reports), two issues and a shipped document through the public API, then
 * checks each page at 390px:
 *   - no page scrolls sideways (Team, Org chart, Work, Shipped, Home, Decisions);
 *   - every agent name on the Team list is shown in full, not cut to "Chi…";
 *   - the Work toolbar fits: full-width search, "Filter & view" and "+";
 *   - the org chart is a stacked, indented tree, not the pan-and-zoom canvas.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 * Set MOBILE_LISTS_SCREENSHOT_DIR to save a 390px screenshot of each page.
 */

import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOT_DIR = process.env.MOBILE_LISTS_SCREENSHOT_DIR?.trim();

const MANAGER = "Christopher Montgomery-Alexander";
const REPORTS = ["Harper Delacroix-Whitfield", "Quinn Ashworth-Barrington"];

type Seeded = { prefix: string; agentNames: string[] };

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(`${BASE_URL}${url}`, { data });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function seed(request: APIRequestContext): Promise<Seeded> {
  const company = await post<{ id: string; issuePrefix: string }>(request, "/api/companies", {
    name: `E2E-Mobile-Lists-${Date.now()}`,
  });
  const agent = (name: string, title: string, reportsTo: string | null) =>
    post<{ id: string; name: string }>(request, `/api/companies/${company.id}/agents`, {
      name,
      role: "general",
      title,
      reportsTo,
      adapterType: "process",
      // Addressed over the API, never run; process.execPath is the sibling specs' convention.
      adapterConfig: { command: process.execPath },
    });
  const manager = await agent(MANAGER, "deployment_lead", null);
  await agent(REPORTS[0]!, "sales_support", manager.id);
  await agent(REPORTS[1]!, "research_analyst", manager.id);

  await post(request, `/api/companies/${company.id}/issues`, {
    title: "Competitor scan: warehouse picking grippers",
    status: "todo",
  });
  const issue = await post<{ id: string }>(request, `/api/companies/${company.id}/issues`, {
    title: "One-page product brief: new gripper",
    status: "in_review",
  });
  await post(request, `/api/issues/${issue.id}/work-products`, {
    type: "document",
    provider: "agentdash",
    title: "Product brief: warehouse picking gripper (draft for review by the whole team)",
    status: "ready_for_review",
    isPrimary: true,
  });

  const agents = (await (await request.get(`${BASE_URL}/api/companies/${company.id}/agents`)).json()) as Array<{
    name: string;
    status: string;
  }>;
  return {
    prefix: company.issuePrefix,
    agentNames: agents.filter((a) => a.status !== "terminated").map((a) => a.name),
  };
}

async function snap(page: Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
}

/** The page never scrolls sideways: nothing is wider than the 390px viewport. */
async function expectNoHorizontalOverflow(page: Page, where: string) {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(metrics.doc, `${where}: document is ${metrics.doc}px wide at ${metrics.viewport}px`).toBeLessThanOrEqual(
    metrics.viewport,
  );
  expect(metrics.body, `${where}: body is ${metrics.body}px wide at ${metrics.viewport}px`).toBeLessThanOrEqual(
    metrics.viewport,
  );
}

test.describe("mobile lists at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  let seeded: Seeded;
  test.beforeAll(async ({ request }) => {
    seeded = await seed(request);
  });

  test("Team: two-line cards show every agent's full name; the toolbar is New agent plus ⋯", async ({ page }) => {
    await page.goto(`${BASE_URL}/${seeded.prefix}/agents/all`);
    const cards = page.getByTestId("agent-phone-card");
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    await expect(cards).toHaveCount(seeded.agentNames.length);

    const names = page.getByTestId("agent-phone-name");
    for (const name of [MANAGER, ...REPORTS]) {
      const node = names.filter({ hasText: name });
      await expect(node).toHaveText(name);
      await expect(node).toBeVisible();
      // Full text visible: nothing clipped or ellipsised.
      const clipped = await node.evaluate((el) => ({
        overflow: el.scrollWidth > el.clientWidth + 1,
        ellipsis: getComputedStyle(el).textOverflow === "ellipsis",
      }));
      expect(clipped, name).toEqual({ overflow: false, ellipsis: false });
    }

    const toolbar = page.getByTestId("agents-phone-toolbar");
    await expect(toolbar.getByRole("button", { name: "New agent" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "More agent actions" })).toBeVisible();
    for (const control of [
      toolbar.getByRole("button", { name: "New agent" }),
      toolbar.getByRole("button", { name: "More agent actions" }),
    ]) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await toolbar.getByRole("button", { name: "More agent actions" }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "Show terminated" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Set up a role" })).toBeVisible();
    await page.keyboard.press("Escape");

    await expectNoHorizontalOverflow(page, "Team");
    await snap(page, "after-team");
  });

  test("Org chart: a stacked, indented tree with Import/Export in ⋯", async ({ page }) => {
    await page.goto(`${BASE_URL}/${seeded.prefix}/org`);
    const tree = page.getByTestId("org-chart-phone-tree");
    await expect(tree).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("org-chart-viewport")).toHaveCount(0);

    const manager = tree.getByTestId("org-chart-phone-node").filter({ hasText: MANAGER }).first();
    const managerCard = manager.locator("> a");
    const managerBox = (await managerCard.boundingBox())!;
    let previousBottom = managerBox.y + managerBox.height;
    for (const name of REPORTS) {
      const report = manager.locator('[data-testid="org-chart-phone-node"]').filter({ hasText: name }).locator("> a");
      await expect(report).toBeVisible();
      const box = (await report.boundingBox())!;
      // Stacked top to bottom, and indented under the manager.
      expect(box.y).toBeGreaterThanOrEqual(previousBottom);
      expect(box.x).toBeGreaterThan(managerBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      // Readable: a real card, not a 0.3× canvas thumbnail.
      expect(box.height).toBeGreaterThanOrEqual(44);
      previousBottom = box.y + box.height;
    }

    await page.getByRole("button", { name: "More org chart actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Import company" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Export company" })).toBeVisible();
    await page.keyboard.press("Escape");

    await expectNoHorizontalOverflow(page, "Org chart");
    await snap(page, "after-orgchart");
  });

  test("Work: full-width search, one Filter & view button and +, list view only", async ({ page }) => {
    await page.goto(`${BASE_URL}/${seeded.prefix}/issues`);
    const toolbar = page.getByTestId("issues-phone-toolbar");
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("One-page product brief: new gripper")).toBeVisible();

    // The view toggles and the separate icon buttons are gone.
    await expect(page.locator('[title="List view"]')).toHaveCount(0);
    await expect(page.locator('[title="Board view"]')).toHaveCount(0);
    await expect(page.locator('[title="Sort"]')).toHaveCount(0);
    await expect(page.locator('[title="Group"]')).toHaveCount(0);

    // The toolbar fits inside the viewport, and the search spans it.
    const toolbarBox = (await toolbar.boundingBox())!;
    expect(toolbarBox.x).toBeGreaterThanOrEqual(0);
    expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(390);
    const search = toolbar.getByRole("textbox", { name: "Search issues" });
    const searchBox = (await search.boundingBox())!;
    expect(searchBox.width).toBeGreaterThanOrEqual(toolbarBox.width - 1);
    expect(searchBox.height).toBeGreaterThanOrEqual(44);
    const filterAndView = toolbar.getByRole("button", { name: "Filter & view" });
    const create = toolbar.getByRole("button", { name: "New Issue" });
    for (const control of [filterAndView, create]) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }

    await expectNoHorizontalOverflow(page, "Work");
    await snap(page, "after-work");

    await filterAndView.click();
    const sheet = page.getByTestId("issues-phone-view-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("region", { name: "Sort" })).toBeVisible();
    await expect(sheet.getByRole("region", { name: "Group" })).toBeVisible();
    await expect(sheet.getByText("Filters", { exact: true })).toBeVisible();
    await snap(page, "after-work-sheet");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("Shipped: compact cards with tokens behind a tap", async ({ page }) => {
    await page.goto(`${BASE_URL}/${seeded.prefix}/shipped`);
    const row = page.getByTestId("shipped-row").first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute("data-compact", "true");
    await expect(row.getByTestId("shipped-usage")).toHaveCount(0);
    await row.getByTestId("shipped-usage-toggle").click();
    await expect(row.getByTestId("shipped-usage")).toBeVisible();
    await row.getByTestId("shipped-usage-toggle").click();

    await expectNoHorizontalOverflow(page, "Shipped");
    await snap(page, "after-shipped");
  });

  test("Home and Decisions with work waiting: no sideways scroll", async ({ page }) => {
    await page.goto(`${BASE_URL}/${seeded.prefix}/dashboard`);
    await expect(page.getByTestId("home")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("home-shipped").getByTestId("shipped-row").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "Home");
    await snap(page, "after-home-busy");

    await page.goto(`${BASE_URL}/${seeded.prefix}/decisions`);
    await expect(page.getByTestId("decisions")).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, "Decisions");
  });

  test("Home and Decisions when empty: one compact line each, not a ~300px card", async ({ page, request }) => {
    const empty = await post<{ issuePrefix: string }>(request, "/api/companies", {
      name: `E2E-Mobile-Empty-${Date.now()}`,
    });

    await page.goto(`${BASE_URL}/${empty.issuePrefix}/dashboard`);
    await expect(page.getByTestId("home")).toBeVisible({ timeout: 20_000 });
    for (const block of ["home-waiting", "home-working", "home-shipped"]) {
      const line = page.getByTestId(block).getByTestId("home-empty-line");
      await expect(line, block).toBeVisible();
      expect((await line.boundingBox())!.height, block).toBeLessThanOrEqual(64);
    }
    await expectNoHorizontalOverflow(page, "Home (empty)");
    await snap(page, "after-home");

    await page.goto(`${BASE_URL}/${empty.issuePrefix}/decisions`);
    const decisionsEmpty = page.getByTestId("decisions-empty");
    await expect(decisionsEmpty).toBeVisible({ timeout: 20_000 });
    await expect(decisionsEmpty).toHaveAttribute("data-compact", "true");
    expect((await decisionsEmpty.boundingBox())!.height).toBeLessThanOrEqual(64);
    await expectNoHorizontalOverflow(page, "Decisions (empty)");
    await snap(page, "after-decisions");
  });
});
