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
        const skills = (await listed.json()) as Array<{ sourceBadge?: string | null; sourceLabel?: string | null; slug?: string | null }>;
        // The page hides bundled development skills (AgentDash c4-polish) —
        // the two shipped dev tools below — so the API list can be non-empty
        // while nothing visible exists to auto-select.
        const internalDevSlugs = new Set(["paperclip-dev", "terminal-bench-loop"]);
        const visible = Array.isArray(skills)
          ? skills.filter(
              (s) =>
                !(
                  s.sourceBadge === "paperclip" &&
                  s.sourceLabel === "Paperclip bundled" &&
                  s.slug != null &&
                  internalDevSlugs.has(s.slug)
                ),
            )
          : [];
        if (visible.length > 0) {
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

  // Founder request 2026-10-06: agents are visible in the left bar, grouped
  // by team (reporting line), each team collapsible and remembered.
  test("Team: agents listed in the sidebar, grouped by team, collapsible", async ({ page, request }) => {
    const company = await createCompany(request);
    async function hire(name: string, reportsTo: string | null) {
      const res = await request.post(`${BASE_URL}/api/companies/${company.id}/agent-hires`, {
        data: { name, role: "general", title: name, reportsTo, adapterType: "process", adapterConfig: { command: "true" } },
      });
      expect(res.ok(), await res.text()).toBe(true);
      const hire = (await res.json()) as { agent: { id: string }; approval?: { id: string } | null };
      if (hire.approval) {
        const approved = await request.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
          data: { decisionNote: "Approved for sidebar e2e setup." },
        });
        expect(approved.ok(), await approved.text()).toBe(true);
      }
      return hire.agent.id;
    }
    const lead = await hire("Casper", null);
    await hire("Maya", lead);
    await hire("Felix", null);

    await page.goto(`${BASE_URL}/${company.issuePrefix}/dashboard`);
    const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "More", exact: true }) });
    // Expanded by default: every agent is in the left bar.
    await expect(sidebar.getByRole("button", { name: "Hide agents" })).toHaveAttribute("aria-expanded", "true");
    for (const name of ["Casper", "Maya", "Felix"]) {
      await expect(sidebar.getByRole("link", { name, exact: true })).toBeVisible();
    }
    const casperTeam = sidebar.getByRole("button", { name: "Hide Casper's team" });
    await expect(casperTeam).toHaveAttribute("aria-expanded", "true");
    await snap(page, "after-team-groups-expanded");

    await casperTeam.click();
    await expect(sidebar.getByRole("button", { name: "Show Casper's team" })).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.getByRole("link", { name: "Maya", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Casper", exact: true })).toBeVisible();

    // Remembered across a reload.
    await page.reload();
    await expect(sidebar.getByRole("button", { name: "Show Casper's team" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Maya", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Felix", exact: true })).toBeVisible();
  });
});
