/**
 * E2E: phone floors — every main screen at 390×844 and 360×740.
 *
 * Seeds one company (five agents, one with a long name, a handful of issues, a
 * shipped document, a plan document, a comment thread and one finished run
 * from a fake Claude CLI) through the public API, then opens each main nav
 * screen, the hire form with Advanced open, the issue page, /workforce, the
 * agent Configuration tab, a run transcript, an open dialog and every Settings page, at both
 * phone widths with a fine pointer (plus 390 with touch), and audits the
 * whole page:
 *   - no horizontal page scroll,
 *   - no visible text under 12px,
 *   - no interactive element (link, button, tab, input, …) with a hit area
 *     under 44×44px,
 *   - no interactive element without an accessible name (an icon-only button
 *     whose label is hidden on phones must carry an aria-label),
 *   - no two interactive hit areas overlapping, within the same layer (fixed
 *     and sticky bars such as the bottom nav or a docked composer are compared
 *     only with their own contents, since what lies under them depends on the
 *     scroll position),
 *   - no checkbox, switch or radio stretched out of shape (its label, not the
 *     control, carries the 44px hit area).
 *
 * Inline links inside running text are exempt from the tap-target floor
 * (WCAG 2.5.8 "inline" exception). Anything else that has a justified reason to
 * break a floor goes in ALLOWLIST below, with the reason.
 *
 * Also covered: the bottom nav at 360px, the agent header at 360px (a long
 * name is not squeezed by the actions) and the toast stack on the issue page
 * (above the bottom nav and the docked composer).
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
import os from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const SHOTS_DIR = process.env.MOBILE_SHOTS_DIR?.trim() || null;
const REPORT_FILE = process.env.MOBILE_FLOORS_REPORT?.trim() || null;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;
const MIN_TAP = 44;
const MIN_FONT = 12;
const LONG_AGENT = "Ivy Longname-Worthington";
const COMPANY_SKILL = "Ryokan pricing cheatsheet";

test.use({ viewport: WIDTHS[0], hasTouch: true, isMobile: true });

/**
 * The page sweep runs with a fine pointer at both widths: a desktop browser
 * narrowed to phone width gets none of the `pointer: coarse` minimums, so it
 * is the stricter case and only the under-640px rules apply. One touch pass at
 * 390 checks that the coarse-pointer minimums do not create overlaps.
 */
const SWEEP_MODES = [
  { ...WIDTHS[0], touch: false },
  { ...WIDTHS[1], touch: false },
  { ...WIDTHS[0], touch: true },
] as const;

/**
 * Justified exceptions. Each entry matches a finding by page name (e.g.
 * "issue-360", or "*") and a substring of the finding.
 */
const ALLOWLIST: Array<{ page: string; match: string; reason: string }> = [
  // Empty on purpose: every finding of the sweep was fixed. Add an entry only
  // with a reason a reviewer would accept, e.g.
  // { page: "*", match: 'button "Copy code"', reason: "…" },
];

type Company = { id: string; issuePrefix: string; name: string };
type Seeded = { company: Company; agentId: string; issueRef: string; runAgentId: string; runId: string };

/**
 * A stand-in for the Claude CLI: prints a short stream-json session (a shell
 * command, a file read, a reply) so the run page has a readable transcript
 * with inline code, without a real model.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => undefined);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", model: "fake-model", session_id: "mobile-floors" });
out({ type: "assistant", message: { content: [{ type: "text", text: "Pulling the open issues first." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "curl -s http://127.0.0.1:3100/api/issues?status=todo,in_progress | head -n 40" } }] } });
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] } });
out({ type: "assistant", message: { content: [{ type: "text", text: "No open issues. Checking the proposal notes." }] } });
out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/tmp/workspace/notes/tanaka-family-proposal.md" } }] } });
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "# Tanaka family" }] } });
out({ type: "assistant", message: { content: [{ type: "text", text: "Nothing new is waiting. The proposal draft is up to date." }] } });
out({ type: "result", subtype: "success", result: "Nothing new is waiting.", usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0 }, total_cost_usd: 0 });
setTimeout(() => process.exit(0), 50);
`;

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
    [LONG_AGENT, "general"],
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
  // Shipped means accepted: a second deliverable whose issue is done, so
  // /shipped has a row while the first one still waits in Decisions.
  const accepted = await post<{ id: string }>(request, `/api/companies/${company.id}/issues`, {
    title: "Rail pass guide for the Tanaka family",
    status: "in_review",
    assigneeAgentId: agentIds[1],
  });
  await post(request, `/api/issues/${accepted.id}/work-products`, {
    type: "document",
    provider: "paperclip",
    title: "Tanaka Family — 10-Day Japan Rail Pass Guide",
    status: "ready_for_review",
    isPrimary: true,
  });
  const acceptRes = await request.patch(`/api/issues/${accepted.id}`, { data: { status: "done" } });
  expect(acceptRes.ok(), await acceptRes.text()).toBe(true);

  for (const [title, status] of [
    ["Competitor scan: warehouse picking grippers", "todo"],
    ["Weekly pipeline review for every open opportunity", "in_progress"],
    ["Refresh the pricing page copy", "backlog"],
    ["Ship the onboarding checklist", "done"],
  ] as const) {
    await post(request, `/api/companies/${company.id}/issues`, { title, status, assigneeAgentId: agentIds[2] });
  }

  // A Definition of Done on the issue: the Reviews tab renders real checkbox
  // rows, and the tap-target audit measures them.
  const dodRes = await request.put(`/api/companies/${company.id}/issues/${issue.id}/dod`, {
    data: {
      summary: "The proposal is ready to send to the Tanakas.",
      criteria: [
        { id: "itinerary", text: "Day-by-day itinerary for all 10 days", done: true },
        { id: "budget", text: "Every cost fits the $18k budget", done: false },
      ],
    },
  });
  expect(dodRes.ok(), await dodRes.text()).toBe(true);

  // A local company skill: /agents/new offers it in Advanced → Company skills,
  // and its label row is part of the tap-target audit.
  await post(request, `/api/companies/${company.id}/skills`, {
    name: COMPANY_SKILL,
    slug: "ryokan-pricing",
    description: "Currency conventions, seasonal surcharges and the usual price bands for ryokans.",
    markdown: `# ${COMPANY_SKILL}\n\n- Quote totals per night, tax included.\n`,
  });

  // A plan document on the issue: the issue page shows the Documents section.
  const docRes = await request.put(`/api/issues/${issue.id}/documents/plan`, {
    data: {
      title: "Plan",
      format: "markdown",
      body: "# Plan\n\n1. Shortlist ryokans in Kyoto and Hakone.\n2. Price the rail legs.\n3. Draft the day-by-day itinerary.",
    },
  });
  expect(docRes.ok(), await docRes.text()).toBe(true);

  // One finished run with a readable transcript, from a fake Claude CLI.
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-floors-claude-"));
  const script = path.join(scriptDir, "fake-claude.mjs");
  fs.writeFileSync(script, FAKE_CLAUDE, { mode: 0o755 });
  const runAgent = await post<{ id: string }>(request, `/api/companies/${company.id}/agents`, {
    name: "Theo",
    role: "general",
    title: "Research assistant",
    adapterType: "claude_local",
    adapterConfig: { command: script, cwd: scriptDir },
  });
  const run = await post<{ id: string }>(request, `/api/agents/${runAgent.id}/heartbeat/invoke`, {});
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/heartbeat-runs/${run.id}`);
        return res.ok() ? ((await res.json()) as { status: string }).status : `http ${res.status()}`;
      },
      // Stays inside the 180s beforeAll budget; the adapter tick is slow
      // under machine load even for the fake run.
      { timeout: 120_000, intervals: [500, 1000, 2000] },
    )
    .toMatch(/^(succeeded|failed|timed_out|cancelled)$/);

  return {
    company,
    agentId: agentIds[1]!,
    issueRef: issue.identifier ?? issue.id,
    runAgentId: runAgent.id,
    runId: run.id,
  };
}

type AuditResult = {
  overflow: number;
  overflowers: string[];
  small: string[];
  taps: string[];
  unnamed: string[];
  overlaps: string[];
  /** Checkboxes, switches and radios stretched out of shape (e.g. a 16×44 bar). */
  misshapen: string[];
};

/** Runs in the page: overflow, small text, small or unnamed targets, overlapping hit areas. */
async function audit(page: Page): Promise<AuditResult> {
  const viewportWidth = page.viewportSize()?.width ?? WIDTHS[0].width;
  return page.evaluate(
    ({ viewportWidth, minTap, minFont }) => {
      const doc = document.documentElement;
      const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - viewportWidth;

      const textOf = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      /** A practical accessible name: aria-label, aria-labelledby, label, text, alt, title, placeholder. */
      const accessibleName = (el: Element) => {
        const aria = el.getAttribute("aria-label")?.trim();
        if (aria) return aria;
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" ").trim();
          if (text) return text;
        }
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLButtonElement
        ) {
          const labels = Array.from(el.labels ?? []).map((label) => textOf(label)).join(" ").trim();
          if (labels) return labels;
          if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) && el.value) return el.value;
          if (el instanceof HTMLInputElement && el.type === "file") return "file";
        }
        const text = textOf(el);
        if (text) return text;
        const alt = Array.from(el.querySelectorAll("img[alt]")).map((img) => img.getAttribute("alt") ?? "").join(" ").trim();
        if (alt) return alt;
        return (el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
      };
      const describe = (el: Element) => `${el.tagName.toLowerCase()} "${accessibleName(el).slice(0, 40)}"`;
      const isShown = (el: Element) => {
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        if (el.closest("[aria-hidden='true'], .sr-only, [inert]")) return false;
        // Inside a closed <details> (content-visibility: hidden) or a hidden ancestor.
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
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
          let clipped = false;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== "visible") { clipped = true; break; }
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
      const targets: Element[] = [];
      for (const el of Array.from(document.body.querySelectorAll(selector))) {
        // Count the outermost interactive element once (a button inside a link, etc.).
        if (el.parentElement?.closest(selector)) continue;
        if (!isShown(el)) continue;
        if ((el as HTMLElement).closest("[contenteditable=true]")) continue;
        // The current breadcrumb: role=link for screen readers, but it goes nowhere.
        if (el.getAttribute("aria-disabled") === "true" && el.tagName === "SPAN") continue;
        targets.push(el);
      }

      const taps: string[] = [];
      const unnamed: string[] = [];
      for (const el of targets) {
        if (!accessibleName(el)) unnamed.push(`${el.tagName.toLowerCase()} class="${(el.getAttribute("class") ?? "").slice(0, 80)}"`);
        // WCAG 2.5.8 inline exception: links that sit inside a line of running text.
        if (el.tagName === "A" && el.closest("p, li, blockquote, td, .prose") && getComputedStyle(el).display === "inline") continue;
        const rect = el.getBoundingClientRect();
        // A label wrapping or pointing at a control (a checkbox, a Radix
        // checkbox button) widens its hit area: tapping the label activates it.
        const label =
          el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.labels?.[0] : null;
        const labelRect = label?.getBoundingClientRect();
        const w = Math.max(rect.width, labelRect?.width ?? 0);
        const h = Math.max(rect.height, labelRect?.height ?? 0);
        if (w + 0.5 < minTap || h + 0.5 < minTap) taps.push(`${Math.round(w)}x${Math.round(h)} ${describe(el)}`);
      }

      // Overlapping hit areas, compared within one layer: the nearest fixed or
      // sticky ancestor (or the page itself).
      const layerOf = (el: Element) => {
        for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
          const position = getComputedStyle(p).position;
          if (position === "fixed" || position === "sticky") return p;
        }
        return document.body;
      };
      const layers = targets.map(layerOf);
      // The part of a hit area that can actually be tapped: clipped by every
      // scrolling or overflow-hidden ancestor (a scrolled-away row of an inner
      // list is not under the content that follows the list).
      const tappableRect = (el: Element) => {
        const rect = el.getBoundingClientRect();
        let left = rect.left;
        let top = rect.top;
        let right = rect.right;
        let bottom = rect.bottom;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const style = getComputedStyle(p);
          if (style.position === "fixed" || style.position === "sticky") break;
          if (style.overflowX === "visible" && style.overflowY === "visible") continue;
          const clip = p.getBoundingClientRect();
          if (style.overflowX !== "visible") {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (style.overflowY !== "visible") {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
        }
        return { left, top, right, bottom };
      };
      const tappable = targets.map(tappableRect);
      const overlaps: string[] = [];
      for (let i = 0; i < targets.length; i += 1) {
        for (let j = i + 1; j < targets.length; j += 1) {
          if (layers[i] !== layers[j]) continue;
          const a = tappable[i]!;
          const b = tappable[j]!;
          const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ix > 3 && iy > 3) overlaps.push(`${Math.round(ix)}x${Math.round(iy)} ${describe(targets[i]!)} <> ${describe(targets[j]!)}`);
        }
      }

      // A checkbox, switch or radio keeps its square (or padded-square) shape:
      // a blanket min-height must not stretch it into a bar. Its label carries
      // the hit area instead.
      const misshapen: string[] = [];
      const shaped = "[role=checkbox], [role=switch], [role=radio], input[type=checkbox], input[type=radio]";
      for (const el of Array.from(document.body.querySelectorAll(shaped))) {
        if (!isShown(el)) continue;
        const rect = el.getBoundingClientRect();
        if (Math.abs(rect.width - rect.height) > 2) {
          misshapen.push(`${Math.round(rect.width)}x${Math.round(rect.height)} ${describe(el)}`);
        }
      }

      return { overflow, overflowers, small, taps, unnamed, overlaps, misshapen };
    },
    { viewportWidth, minTap: MIN_TAP, minFont: MIN_FONT },
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

async function settle(page: Page) {
  // Let late queries (badges, counts, live runs) land; live pages never go fully idle.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
}

type Target = {
  name: string;
  /** Under the company prefix, unless it starts with "/" (instance pages). */
  path: (s: Seeded) => string;
  ready: (page: Page, s: Seeded) => Locator;
  /** Puts the page in the state to audit (opens a collapsed section, …). */
  prepare?: (page: Page) => Promise<void>;
};

const main = (page: Page) => page.locator("#main-content");

// `ready` is seeded data (or, for Ask and Settings, data the server provisions
// for the company), so the audit never runs against a skeleton.
const PAGES: Target[] = [
  { name: "home", path: () => "dashboard", ready: (p) => main(p).getByText("Sora", { exact: true }) },
  { name: "ask", path: () => "cos", ready: (p) => main(p).getByText(/Your Chief of Staff is ready/) },
  { name: "work", path: () => "issues", ready: (p) => main(p).getByText(/Competitor scan: warehouse picking grippers/) },
  { name: "issue", path: (s) => `issues/${s.issueRef}`, ready: (p) => main(p).getByText(/Draft is attached as a document/) },
  // The issue's Reviews tab: Definition of Done criteria checkboxes + the
  // verdict timeline.
  {
    name: "issue-reviews",
    path: (s) => `issues/${s.issueRef}`,
    ready: (p) => main(p).getByText(/Draft is attached as a document/),
    prepare: async (p) => {
      await main(p).getByRole("tab", { name: "Reviews", exact: true }).click();
      await expect(main(p).getByText("Review timeline")).toBeVisible();
      await settle(p);
    },
  },
  { name: "team", path: () => "agents/all", ready: (p) => main(p).getByText("Maya", { exact: true }) },
  { name: "agent", path: (s) => `agents/${s.agentId}`, ready: (p) => main(p).getByText(/Draft a 10-day Japan proposal/) },
  // The agent config form: Field labels with hint icons above every input.
  { name: "agent-config", path: (s) => `agents/${s.agentId}/configuration`, ready: (p) => main(p).locator(`input[value="${LONG_AGENT}"]`) },
  { name: "decisions", path: () => "decisions", ready: (p) => main(p).getByText(/Review: Draft a 10-day Japan proposal/) },
  { name: "shipped", path: () => "shipped", ready: (p) => main(p).getByText(/Tanaka Family — 10-Day Japan/) },
  { name: "settings", path: () => "company/settings", ready: (p, s) => main(p).locator(`input[value="${s.company.name}"]`) },
  { name: "activity", path: () => "activity", ready: (p) => main(p).getByText(/Japan proposal/) },
  // The hire form with the collapsed Advanced section open.
  {
    name: "agent-new",
    path: () => "agents/new",
    ready: (p) => main(p).locator("summary", { hasText: "Advanced" }),
    prepare: async (p) => {
      const details = main(p).locator("details", { has: p.locator("summary", { hasText: "Advanced" }) }).first();
      if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
        await details.locator("summary").first().click();
      }
      await expect(details).toHaveAttribute("open", "");
      // The seeded company skill renders the checkbox rows this page audits.
      await expect(details.getByText(COMPANY_SKILL)).toBeVisible({ timeout: 15_000 });
    },
  },
  // An open dialog (New issue, from the agent header): Radix hides the page
  // behind it from assistive tech, so the audit covers the dialog itself.
  {
    name: "dialog",
    path: (s) => `agents/${s.agentId}`,
    ready: (p) => main(p).getByRole("button", { name: "Assign Task", exact: true }),
    prepare: async (p) => {
      await main(p).getByRole("button", { name: "Assign Task", exact: true }).click();
      await expect(p.getByRole("dialog")).toBeVisible();
      await settle(p);
    },
  },
  { name: "workforce", path: () => "workforce", ready: (p) => main(p).getByRole("heading", { level: 1 }) },
  // A finished run: the readable transcript with inline code.
  {
    name: "run",
    path: (s) => `agents/${s.runAgentId}/runs/${s.runId}`,
    ready: (p) => main(p).getByText(/Nothing new is waiting/),
  },
  // Every other Settings page (General is "settings" above). Their content is
  // provisioned by the server, so the first heading is the ready marker.
  ...[
    ["settings-access", "company/settings/access"],
    ["settings-invites", "company/settings/invites"],
    ["settings-billing", "billing"],
    ["settings-model-key", "company/settings/model-key"],
    ["settings-connections", "company/settings/connections"],
    ["settings-skills", "skills"],
    ["settings-environments", "company/settings/environments"],
    ["settings-adapters", "/instance/settings/adapters"],
    ["settings-schedules", "/instance/settings/heartbeats"],
    ["settings-import", "company/import"],
    ["settings-export", "company/export"],
    ["settings-evaluation", "evaluation"],
    ["settings-health", "company/settings/health"],
    ["settings-profile", "/instance/settings/profile"],
    ["settings-about", "/instance/settings/about"],
    ["settings-changelog", "/instance/settings/changelog"],
    ["settings-instance-general", "/instance/settings/general"],
    ["settings-instance-access", "/instance/settings/access"],
    ["settings-instance-plugins", "/instance/settings/plugins"],
    ["settings-instance-experimental", "/instance/settings/experimental"],
  ].map(([name, to]): Target => ({
    name: name!,
    path: () => to!,
    ready: (p) => main(p).getByRole("heading").first(),
  })),
];

test.describe("Phone floors on every main screen", () => {
  let seeded: Seeded;

  test.beforeEach(async ({ page }) => {
    // A pending web-font fetch holds the `load` event and can stall page.goto
    // for minutes on runners with slow egress; the UI falls back fine.
    await page.route(/fonts\.(gstatic|googleapis)\.com/, (route) => route.abort());
  });

  test.beforeAll(async ({ request }, testInfo) => {
    // Seeding waits for one fake run to finish.
    testInfo.setTimeout(180_000);
    seeded = await seed(request);
  });

  for (const mode of SWEEP_MODES) {
    test.describe(mode.touch ? "touch" : "fine pointer", () => {
      test.use({ hasTouch: mode.touch, isMobile: mode.touch });
      for (const target of PAGES) {
        const size = { width: mode.width, height: mode.height };
        const name = `${target.name}-${size.width}${mode.touch ? "-touch" : ""}`;
        test(`${name}: no sideways scroll, small text, small, unnamed or overlapping targets`, async ({ page }) => {
          await page.setViewportSize(size);
          const to = target.path(seeded);
          await page.goto(to.startsWith("/") ? to : `/${seeded.company.issuePrefix}/${to}`);
          await expect(target.ready(page, seeded).first()).toBeVisible({ timeout: 30_000 });
          await settle(page);
          await target.prepare?.(page);

          const result = await audit(page);
          record(name, result);
          await shoot(page, name);

          const keep = (findings: string[]) => findings.filter((f) => !allowed(name, f));
          expect.soft(result.overflow, `horizontal overflow in px; widest: ${result.overflowers.join(" | ")}`).toBeLessThanOrEqual(1);
          expect.soft(keep(result.small), "visible text under 12px").toEqual([]);
          expect.soft(keep(result.taps), "tap targets under 44px").toEqual([]);
          expect.soft(keep(result.unnamed), "interactive elements without an accessible name").toEqual([]);
          expect.soft(keep(result.overlaps), "overlapping hit areas").toEqual([]);
          expect.soft(keep(result.misshapen), "checkboxes, switches or radios out of shape").toEqual([]);
        });
      }
    });
  }

  test("access page at 390px: each member is a readable card with on-screen actions", async ({ page }) => {
    await page.setViewportSize(WIDTHS[0]);
    await page.goto(`/${seeded.company.issuePrefix}/company/settings/access`);
    await expect(main(page).getByRole("heading", { name: "Humans" })).toBeVisible({ timeout: 30_000 });
    await settle(page);

    // Below sm the five-column grid is replaced by stacked member cards; the
    // column header stays in the DOM but is CSS-hidden.
    await expect(main(page).getByText("User account")).toBeHidden();

    const cards = main(page).locator('[data-testid^="member-card-"]');
    await expect(cards.first()).toBeVisible();
    for (const card of await cards.all()) {
      // Identity, role and status stay visible — nothing truncated away.
      const box = (await card.boundingBox())!;
      expect(box.width, "member card fits the viewport").toBeLessThanOrEqual(WIDTHS[0].width);
      for (const name of ["Edit", "Remove"]) {
        const action = card.getByRole("button", { name, exact: true });
        await expect(action).toBeVisible();
        const actionBox = (await action.boundingBox())!;
        // Fully on screen: the card never clips the control.
        expect(actionBox.x + actionBox.width, `${name} button on screen`).toBeLessThanOrEqual(WIDTHS[0].width);
      }
    }
  });

  test("breadcrumb at 390px: a long workspace name does not clip the page label", async ({ page, request }) => {
    // ~40-char name: the parent crumb must truncate, never clip the page label.
    const longName = "Tanaka Family Travel Holdings Co. Ltd"; // 39
    const res = await request.post("/api/companies", { data: { name: longName } });
    expect(res.ok(), await res.text()).toBe(true);
    const company = (await res.json()) as Company;

    await page.setViewportSize(WIDTHS[0]);
    for (const target of [
      { path: "billing", label: "Billing" },
      { path: "workforce", label: "Workforce" },
      { path: "company/settings", label: "Settings" },
    ]) {
      await page.goto(`/${company.issuePrefix}/${target.path}`);
      const crumb = page.locator('[data-slot="breadcrumb-page"]', { hasText: target.label });
      await expect(crumb).toBeVisible({ timeout: 30_000 });
      // Fully on screen — not pushed past the edge.
      const box = (await crumb.boundingBox())!;
      expect(box.x + box.width, `${target.label} label on screen`).toBeLessThanOrEqual(WIDTHS[0].width);
      // And rendered in full — the workspace name absorbs all the truncation.
      expect(
        await crumb.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5),
        `${target.label} label not ellipsized`,
      ).toBe(true);
    }
  });

  test("bottom nav at 360px: labels at least 12px, shown in full, items at least 44px", async ({ page }) => {
    await page.setViewportSize(WIDTHS[1]);
    await page.goto(`/${seeded.company.issuePrefix}/dashboard`);
    const nav = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(nav).toBeVisible({ timeout: 30_000 });
    const items = await nav.locator("a, button").evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        // The label is the last text-only span; a badge count may come before it.
        const label = Array.from(el.querySelectorAll("span")).filter((span) => span.children.length === 0 && span.textContent?.trim()).at(-1);
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
      expect.soft(item.right, `${item.label} stays on screen`).toBeLessThanOrEqual(WIDTHS[1].width);
    }
  });

  test("agent header at 360px: a long name is not squeezed by the actions", async ({ page }) => {
    await page.setViewportSize(WIDTHS[1]);
    await page.goto(`/${seeded.company.issuePrefix}/agents/${seeded.agentId}`);
    const heading = main(page).getByRole("heading", { name: LONG_AGENT });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    // Shown in full: the heading is not truncated.
    expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5)).toBe(true);
    // The icon-only actions are named, 44px, and on screen.
    for (const name of ["Assign Task", "Wake now", "Pause", "More agent actions"]) {
      const button = main(page).getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect.soft(box.width, `${name} width`).toBeGreaterThanOrEqual(MIN_TAP);
      expect.soft(box.height, `${name} height`).toBeGreaterThanOrEqual(MIN_TAP);
      expect.soft(box.x + box.width, `${name} on screen`).toBeLessThanOrEqual(WIDTHS[1].width);
    }
  });

  test("issue page: a toast sits above the bottom nav and the docked composer", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/${seeded.company.issuePrefix}/issues/${seeded.issueRef}`);
    await expect(main(page).getByText(/Draft is attached as a document/)).toBeVisible({ timeout: 30_000 });
    const composer = page.getByTestId("issue-chat-composer-dock");
    await expect(composer).toBeVisible();
    await settle(page);

    // "Copy issue as markdown" is the one header action that always toasts.
    await page.getByRole("button", { name: "Copy issue as markdown" }).first().click();
    const toast = page.getByText("Copied to clipboard");
    await expect(toast).toBeVisible();
    // Dock the composer: scroll to the end, then nudge up so the bottom nav slides back in.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.mouse.wheel(0, -40);
    await expect(toast).toBeVisible();
    await expect
      .poll(async () => {
        const box = await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox();
        return box ? Math.round(box.y + box.height) : null;
      })
      .toBe(WIDTHS[0].height);
    const toastBox = (await toast.locator("xpath=ancestor::li[1]").boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    const navBox = (await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox())!;
    // The dock is sticky: docked at the bottom on a long thread, in flow on a short one.
    // Either way the toast must not cover it.
    const coversComposer = toastBox.y < composerBox.y + composerBox.height - 1 && toastBox.y + toastBox.height > composerBox.y + 1;
    expect(coversComposer, `toast ${JSON.stringify(toastBox)} covers the composer ${JSON.stringify(composerBox)}`).toBe(false);
    expect(toastBox.y + toastBox.height, "toast bottom above the nav").toBeLessThanOrEqual(navBox.y + 1);
    expect(toastBox.x).toBeGreaterThanOrEqual(0);
    expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(WIDTHS[0].width);
  });
});
