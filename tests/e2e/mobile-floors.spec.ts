/**
 * E2E: phone floors — every main screen at 390×844.
 *
 * Seeds one company (five agents, a handful of issues, a shipped document and
 * a comment thread) through the public API, then opens each main nav screen on
 * an iPhone-sized viewport and audits the whole page for the three phone floors:
 *   - no horizontal page scroll,
 *   - no visible text under 12px,
 *   - no interactive element (link, button, tab, input, …) with a hit area
 *     under 44×44px.
 *
 * Inline links inside running text are exempt from the tap-target floor
 * (WCAG 2.5.8 "inline" exception). Anything else that has a justified reason to
 * be smaller goes in ALLOWLIST below, with the reason.
 *
 * Set MOBILE_FLOORS_REPORT=<file.json> to write every finding (before the
 * allowlist) to a file; MOBILE_SHOTS_DIR saves a full-page screenshot per page.
 *
 * Run it on a free port:
 *   PAPERCLIP_E2E_PORT=3846 pnpm exec playwright test \
 *     --config tests/e2e/playwright.config.ts mobile-floors.spec.ts
 *
 * Requires local_trusted deployment mode (playwright.config.ts webServer env).
 */

import fs from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const SHOTS_DIR = process.env.MOBILE_SHOTS_DIR?.trim() || null;
const REPORT_FILE = process.env.MOBILE_FLOORS_REPORT?.trim() || null;
const PHONE = { width: 390, height: 844 };
const MIN_TAP = 44;
const MIN_FONT = 12;

test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

/**
 * Justified exceptions. Each entry matches a finding by page (or "*") and a
 * substring of the finding's description.
 */
const ALLOWLIST: Array<{ page: string; match: string; reason: string }> = [
  // Empty on purpose: every finding of the first sweep was fixed. Add an entry
  // only with a reason a reviewer would accept, e.g.
  // { page: "issue", match: 'button "Copy code"', reason: "…" },
];

type Company = { id: string; issuePrefix: string };
type Seeded = { company: Company; agentId: string; issueRef: string };

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function seed(request: APIRequestContext): Promise<Seeded> {
  const company = await post<Company>(request, "/api/companies", { name: `E2E Mobile Floors ${Date.now()}` });

  const agentIds: string[] = [];
  for (const [name, title] of [
    ["Chief of Staff", "chief_of_staff"],
    ["Ivy", "general"],
    ["Reid", "general"],
    ["Sora", "pm"],
    ["Maya", "general"],
  ] as const) {
    const agent = await post<{ id: string }>(request, `/api/companies/${company.id}/agents`, {
      name,
      role: "general",
      title,
      adapterType: "process",
      // Addressed over the API, never run; process.execPath is the sibling specs' convention.
      adapterConfig: { command: process.execPath },
    });
    agentIds.push(agent.id);
  }

  const issue = await post<{ id: string; identifier: string | null }>(request, `/api/companies/${company.id}/issues`, {
    title: "Draft a 10-day Japan proposal for the Tanaka family inquiry",
    status: "in_review",
    assigneeAgentId: agentIds[1],
    description:
      "Ken and Aiko Tanaka with two kids, 10 days in Japan in late March for cherry blossoms. Budget about $18k excluding flights. https://example.com/a/very/long/url/that/should/wrap/instead/of/pushing/the/page/sideways/on/a/phone",
  });
  await post(request, `/api/issues/${issue.id}/work-products`, {
    type: "document",
    provider: "paperclip",
    title: "Tanaka Family — 10-Day Japan Cherry Blossom Proposal",
    status: "ready_for_review",
    isPrimary: true,
  });
  for (const body of [
    "Started on this. Pulling hotels and pricing first.",
    "Draft is attached as a document. Two ryokans do not publish pricing; I noted the signals I could find.",
  ]) {
    await post(request, `/api/issues/${issue.id}/comments`, { body });
  }
  for (const [title, status] of [
    ["Competitor scan: warehouse picking grippers", "todo"],
    ["Weekly pipeline review for every open opportunity", "in_progress"],
    ["Refresh the pricing page copy", "backlog"],
    ["Ship the onboarding checklist", "done"],
  ] as const) {
    await post(request, `/api/companies/${company.id}/issues`, { title, status, assigneeAgentId: agentIds[2] });
  }

  return { company, agentId: agentIds[1]!, issueRef: issue.identifier ?? issue.id };
}

type AuditResult = { overflow: number; overflowers: string[]; small: string[]; taps: string[] };

/** Runs in the page: horizontal overflow, small text and small tap targets. */
async function audit(page: Page): Promise<AuditResult> {
  return page.evaluate(
    ({ viewportWidth, minTap, minFont }) => {
      const doc = document.documentElement;
      const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - viewportWidth;

      const describe = (el: Element) => {
        const text = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
        const testId = el.getAttribute("data-testid");
        return `${el.tagName.toLowerCase()}${testId ? `[data-testid=${testId}]` : ""} "${text}"`;
      };
      const isShown = (el: Element) => {
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        if (el.closest("[aria-hidden='true'], .sr-only, [inert]")) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        // Off-canvas: the closed drawer, a nav hidden by transform.
        if (rect.right <= 0 || rect.left >= viewportWidth) return false;
        return true;
      };

      // What pokes out past the right edge, outermost elements only.
      const overflowers: string[] = [];
      if (overflow > 1) {
        for (const el of Array.from(document.body.querySelectorAll("*"))) {
          const rect = el.getBoundingClientRect();
          if (rect.right <= viewportWidth + 1 || rect.width <= 1) continue;
          // Skip descendants of something already clipped horizontally.
          let clipped = false;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if (ox !== "visible") { clipped = true; break; }
          }
          if (clipped) continue;
          overflowers.push(`${Math.round(rect.right)}px ${describe(el)} class="${(el.getAttribute("class") ?? "").slice(0, 80)}"`);
          if (overflowers.length >= 8) break;
        }
      }

      const small: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const el = node.parentElement;
        if (!text || !el || !isShown(el)) continue;
        const size = Number.parseFloat(getComputedStyle(el).fontSize);
        if (size < minFont) small.push(`${size}px <${el.tagName.toLowerCase()}> "${text.slice(0, 40)}"`);
      }

      const taps: string[] = [];
      const selector = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "select",
        "textarea",
        "summary",
        "[role=button]",
        "[role=tab]",
        "[role=link]",
        "[role=menuitem]",
        "[role=checkbox]",
        "[role=switch]",
        "[role=radio]",
        "[role=combobox]",
      ].join(",");
      const seen = new Set<Element>();
      for (const el of Array.from(document.body.querySelectorAll(selector))) {
        // Count the outermost interactive element once (a button inside a link, etc.).
        if (el.parentElement?.closest(selector)) continue;
        if (seen.has(el) || !isShown(el)) continue;
        seen.add(el);
        if ((el as HTMLElement).closest("[contenteditable=true]")) continue;
        // The current breadcrumb: role=link for screen readers, but it goes nowhere.
        if (el.getAttribute("aria-disabled") === "true" && el.tagName === "SPAN") continue;
        // WCAG 2.5.8 inline exception: links that sit inside a line of running text.
        if (el.tagName === "A" && el.closest("p, li, blockquote, td, .prose") && getComputedStyle(el).display === "inline") continue;
        const rect = el.getBoundingClientRect();
        // The hit area of a child that is bigger than its box (a label wrapping a checkbox).
        const label = el.tagName === "INPUT" && el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        const labelRect = label?.getBoundingClientRect();
        const w = Math.max(rect.width, labelRect?.width ?? 0);
        const h = Math.max(rect.height, labelRect?.height ?? 0);
        if (w + 0.5 < minTap || h + 0.5 < minTap) taps.push(`${Math.round(w)}x${Math.round(h)} ${describe(el)}`);
      }

      return { overflow, overflowers, small, taps };
    },
    { viewportWidth: PHONE.width, minTap: MIN_TAP, minFont: MIN_FONT },
  );
}

/** Merged per test: a failing test restarts the worker, so nothing in memory survives. */
function record(name: string, result: AuditResult) {
  if (!REPORT_FILE) return;
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  let report: Record<string, AuditResult> = {};
  try {
    report = JSON.parse(fs.readFileSync(REPORT_FILE, "utf8")) as Record<string, AuditResult>;
  } catch {
    // First page of the run.
  }
  report[name] = result;
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
}

function allowed(pageName: string, finding: string) {
  return ALLOWLIST.some((entry) => (entry.page === "*" || entry.page === pageName) && finding.includes(entry.match));
}

async function shoot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `floors-${name}.png`), fullPage: true });
}

type Target = { name: string; path: (s: Seeded) => string; ready: RegExp };

// `ready` only renders once the page's data has loaded, so the audit never runs on a skeleton.
const PAGES: Target[] = [
  { name: "home", path: () => "dashboard", ready: /Agent fleet/ },
  { name: "ask", path: () => "cos", ready: /Chief of Staff|Ask/ },
  { name: "work", path: () => "issues", ready: /Competitor scan: warehouse picking grippers/ },
  { name: "issue", path: (s) => `issues/${s.issueRef}`, ready: /Draft is attached as a document/ },
  { name: "team", path: () => "agents/all", ready: /Maya/ },
  { name: "agent", path: (s) => `agents/${s.agentId}`, ready: /Ivy/ },
  { name: "decisions", path: () => "decisions", ready: /Decisions/ },
  { name: "shipped", path: () => "shipped", ready: /Shipped/ },
  { name: "settings", path: () => "company/settings", ready: /Danger zone/i },
  { name: "activity", path: () => "activity", ready: /Japan proposal|created/i },
];

test.describe("Phone floors on every main screen (390×844)", () => {
  let seeded: Seeded;

  test.beforeAll(async ({ request }) => {
    seeded = await seed(request);
  });

  for (const target of PAGES) {
    test(`${target.name}: no sideways scroll, no text under 12px, no tap target under 44px`, async ({ page }) => {
      await page.goto(`/${seeded.company.issuePrefix}/${target.path(seeded)}`);
      await expect(page.locator("#main-content").getByText(target.ready).first()).toBeVisible({ timeout: 30_000 });
      // Let late queries (badges, counts, live runs) settle before measuring.
      await page.waitForLoadState("networkidle").catch(() => undefined);

      const result = await audit(page);
      record(target.name, result);
      await shoot(page, target.name);

      expect.soft(result.overflow, `horizontal overflow in px; widest: ${result.overflowers.join(" | ")}`).toBeLessThanOrEqual(1);
      expect.soft(result.small.filter((f) => !allowed(target.name, f)), "visible text under 12px").toEqual([]);
      expect.soft(result.taps.filter((f) => !allowed(target.name, f)), "tap targets under 44px").toEqual([]);
    });
  }

  test("bottom nav at 360px: labels at least 12px, shown in full, items at least 44px", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/${seeded.company.issuePrefix}/dashboard`);
    const nav = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(nav).toBeVisible({ timeout: 30_000 });
    const items = await nav.locator("a, button").evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        const label = Array.from(el.querySelectorAll("span")).find((span) => span.children.length === 0 && span.textContent?.trim());
        return {
          label: label?.textContent?.trim() ?? "",
          font: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0,
          clipped: label ? label.scrollWidth > label.clientWidth + 0.5 : true,
          width: rect.width,
          height: rect.height,
          right: rect.right,
        };
      }),
    );
    expect(items.map((item) => item.label)).toEqual(["Home", "Work", "Ask", "Decisions", "Team"]);
    for (const item of items) {
      expect.soft(item.font, `${item.label} label font`).toBeGreaterThanOrEqual(MIN_FONT);
      expect.soft(item.clipped, `${item.label} label is cut off`).toBe(false);
      expect.soft(item.height, `${item.label} height`).toBeGreaterThanOrEqual(MIN_TAP);
      expect.soft(item.width, `${item.label} width`).toBeGreaterThanOrEqual(MIN_TAP);
      expect.soft(item.right, `${item.label} stays on screen`).toBeLessThanOrEqual(360);
    }
  });
});
