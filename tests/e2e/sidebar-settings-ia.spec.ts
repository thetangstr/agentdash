/**
 * E2E: sidebar IA — the sidebar keeps work, Settings holds configuration.
 *
 * The sidebar has the six primary items, one collapsed "More" group (Goals,
 * Routines, Costs, Activity), and a footer with Settings and a Help menu
 * (Guides, Changelog, Health). No "Advanced". Configuration pages render
 * inside one grouped Settings navigation at their existing URLs, and the
 * Team page has "List | Org chart" tabs with /org still working.
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 * Set SIDEBAR_IA_SCREENSHOT_DIR to save screenshots of each surface.
 */

import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { resolveE2eServerPort } from "./e2e-port";

const PORT = resolveE2eServerPort(3399);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOT_DIR = process.env.SIDEBAR_IA_SCREENSHOT_DIR?.trim();

async function createCompany(request: APIRequestContext) {
  const created = await request.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Sidebar-IA-${Date.now()}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as { id: string; issuePrefix: string };
}

async function snap(page: Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
}

test.describe("sidebar keeps work, Settings holds configuration", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("sidebar: six primary items, More, Settings and Help — no Advanced", async ({ page, request }) => {
    const company = await createCompany(request);
    await page.goto(`${BASE_URL}/${company.issuePrefix}/dashboard`);
    const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "More", exact: true }) });
    await expect(sidebar).toBeVisible();

    for (const label of ["Home", "Ask", "Work", "Decisions", "Shipped", "Team", "Settings"]) {
      await expect(sidebar.getByRole("link", { name: label }).first()).toBeVisible();
    }
    await expect(sidebar.getByRole("button", { name: "Advanced", exact: true })).toHaveCount(0);

    const more = sidebar.getByRole("button", { name: "More", exact: true });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await snap(page, "after-sidebar-collapsed");
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    for (const label of ["Goals", "Routines", "Costs", "Activity"]) {
      await expect(sidebar.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    for (const label of ["Guides", "Org", "Skills", "Evaluation", "Billing", "Import", "Export", "Environments"]) {
      await expect(sidebar.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    }

    // The expanded state is remembered across a reload.
    await page.reload();
    await expect(page.getByRole("button", { name: "More", exact: true })).toHaveAttribute("aria-expanded", "true");

    await page.getByRole("button", { name: "Help", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Help" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Guides", "Changelog", "Health"]);
    await snap(page, "after-sidebar-help-menu");
    await menu.getByRole("menuitem", { name: "Guides" }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/guides$`));
  });

  test("Settings hub: grouped navigation, pages keep their URLs", async ({ page, request }) => {
    const company = await createCompany(request);
    await page.goto(`${BASE_URL}/${company.issuePrefix}/company/settings`);
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(nav).toBeVisible();
    for (const group of ["Workspace", "Agents", "Data", "Quality", "Account"]) {
      await expect(nav.getByText(group, { exact: true })).toBeVisible();
    }
    await snap(page, "after-settings-hub");

    // Pages that live outside /company/settings still render inside it.
    for (const [label, pathname] of [
      ["Billing", `/${company.issuePrefix}/billing`],
      ["Skills", `/${company.issuePrefix}/skills`],
      ["Export", `/${company.issuePrefix}/company/export`],
      ["Evaluation", `/${company.issuePrefix}/evaluation`],
    ] as const) {
      // Skills opens on /skills and, once its list loads, replaces the URL
      // with /skills/<first skill id>. If the next click lands before that
      // replace, the late redirect wins and the next URL assertion sees
      // /skills/<id> (the CI flake on this spec). Wait for the list and for
      // the URL to settle before moving on. (The list can come from the query
      // cache, so ask the API whether there is a first skill to land on rather
      // than waiting for the page's own request.)
      await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${pathname}(/.*)?$`));
      if (label === "Skills") {
        const listed = await request.get(`${BASE_URL}/api/companies/${company.id}/skills`);
        expect(listed.ok(), await listed.text()).toBe(true);
        const skills = (await listed.json()) as unknown[];
        if (Array.isArray(skills) && skills.length > 0) {
          await expect(page).toHaveURL(new RegExp(`${pathname}/[^/]+$`));
        }
      }
      await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
    }
  });

  // Lane F2: Settings means the workspace's settings. The footer link and the
  // legacy /settings URLs open the company's General page, not the
  // instance-admin page (deployment and auth, bootstrap invite, log censoring).
  test("footer Settings and legacy /settings open the workspace settings", async ({ page, request }) => {
    const company = await createCompany(request);
    await page.goto(`${BASE_URL}/${company.issuePrefix}/dashboard`);
    const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "More", exact: true }) });
    await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/company/settings$`));
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("link", { name: "General", exact: true }).first()).toHaveAttribute("aria-current", "page");

    await page.goto(`${BASE_URL}/${company.issuePrefix}/settings`);
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/company/settings$`));
    await page.goto(`${BASE_URL}/${company.issuePrefix}/settings/billing`);
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/billing$`));

    // Instance settings stay one click away for an instance admin (local_trusted).
    await expect(nav.getByText("Instance", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "General", exact: true })).toHaveCount(2);
  });

  test("Team: List | Org chart tabs, /org still works", async ({ page, request }) => {
    const company = await createCompany(request);
    await page.goto(`${BASE_URL}/${company.issuePrefix}/agents`);
    const tabs = page.getByRole("navigation", { name: "Team views" });
    await expect(tabs.getByRole("link")).toHaveText(["List", "Org chart"]);
    await expect(tabs.getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "page");
    await tabs.getByRole("link", { name: "Org chart" }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/org$`));
    await expect(
      page.getByRole("navigation", { name: "Team views" }).getByRole("link", { name: "Org chart" }),
    ).toHaveAttribute("aria-current", "page");
    await snap(page, "after-team-org-tab");
  });
});
