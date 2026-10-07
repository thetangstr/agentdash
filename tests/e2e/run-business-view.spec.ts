/**
 * AgentDash: the run page's Business view (doc/RUN-BUSINESS-VIEW.md).
 *
 * One finished run from a fake Claude CLI, attached to an issue. The spec
 * checks the plain-summary fallback (no timeline document), the "newer
 * format" fallback, the milestone timeline from an `ac.milestone-timeline/v1`
 * issue document (stages, SIMULATED labels, the inferred cue, a "Log line n"
 * link into Raw) and that the viewer's chosen view persists.
 *
 * With BUSINESS_VIEW_SCREENSHOT_DIR set it also saves desktop and phone
 * screenshots in light and dark, Readable (the old default) and Business.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { SAMPLE_MILESTONE_TIMELINE } from "../../ui/src/fixtures/milestoneTimelineFixture";
// A real Track C artefact (ac_travel_mvp f869eeeb, trimmed): multi-line strings
// that JSON writes as `\n`, the case the document PUT used to corrupt.
const realArtefact = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "ui/src/fixtures/milestone-timeline-p9-at-2026-10-06-4.trimmed.json"), "utf8"),
) as {
  label: string;
  agency: { agentdash: Record<string, string> } & Record<string, unknown>;
  events: Array<{ lane: string }>;
} & Record<string, unknown>;

const FAKE_CLAUDE = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => undefined);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const steps = [
  { type: "system", subtype: "init", model: "fake-model", session_id: "business-view" },
  { type: "assistant", message: { content: [{ type: "text", text: "Pulling the open issues first." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "curl -s http://127.0.0.1:3100/api/issues?status=todo | head -n 40" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/tmp/workspace/notes/tanaka-family-proposal.md" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "# Tanaka family" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Nothing new is waiting. The proposal draft is up to date." }] } },
  { type: "result", subtype: "success", result: "Nothing new is waiting.", usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0 }, total_cost_usd: 0.0042 },
];
// One line per log row (a short pause between writes), so each step has its own seq.
let i = 0;
const next = () => {
  if (i >= steps.length) return setTimeout(() => process.exit(0), 50);
  out(steps[i++]);
  setTimeout(next, 60);
};
next();
`;

type Company = { id: string; issuePrefix: string };
type Seeded = { company: Company; agentId: string; issueId: string; runId: string; seqOfFirstReply: number };

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function seed(request: APIRequestContext): Promise<Seeded> {
  const company = await post<Company>(request, "/api/companies", { name: `E2E Business View ${Date.now()}` });
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "business-view-claude-"));
  const script = path.join(scriptDir, "fake-claude.mjs");
  fs.writeFileSync(script, FAKE_CLAUDE, { mode: 0o755 });
  const agent = await post<{ id: string }>(request, `/api/companies/${company.id}/agents`, {
    name: "Maya",
    role: "general",
    title: "Travel agent",
    adapterType: "claude_local",
    adapterConfig: { command: script, cwd: scriptDir },
  });
  // Assigned to the agent: a run for an issue someone else owns is cancelled.
  const issue = await post<{ id: string }>(request, `/api/companies/${company.id}/issues`, {
    title: "Kyoto ryokan package for the Tanaka family",
    status: "todo",
    assigneeAgentId: agent.id,
  });
  // The assignment may already have queued a run for the issue; otherwise wake one.
  const findIssueRun = async () => {
    const res = await request.get(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
    if (!res.ok()) return null;
    const runs = (await res.json()) as Array<{ id: string; contextSnapshot?: { issueId?: string } | null }>;
    return runs.find((run) => run.contextSnapshot?.issueId === issue.id)?.id ?? null;
  };
  let runId = await findIssueRun();
  if (!runId) {
    const wake = await post<{ id?: string; runId?: string }>(request, `/api/agents/${agent.id}/wakeup`, {
      source: "on_demand",
      reason: "e2e business view",
      payload: { issueId: issue.id },
    });
    runId = wake.id ?? wake.runId ?? (await findIssueRun());
  }
  expect(runId, "a run for the issue").toBeTruthy();
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/heartbeat-runs/${runId}`);
        return res.ok() ? ((await res.json()) as { status: string }).status : `http ${res.status()}`;
      },
      { timeout: 120_000, intervals: [500, 1000, 2000] },
    )
    .toMatch(/^(succeeded|failed|timed_out|cancelled)$/);

  // The seq of the log row that carries the agent's first reply: the
  // timeline's "Log line" link must land on it in Raw.
  const logRes = await request.get(`/api/heartbeat-runs/${runId}/log?limitBytes=256000`);
  expect(logRes.ok(), await logRes.text()).toBe(true);
  const { content } = (await logRes.json()) as { content: string };
  const rows = content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { chunk: string; seq?: number });
  const replyRow = rows.find((row) => row.chunk.includes("Pulling the open issues first."));
  expect(replyRow?.seq, "run log rows carry seq").toEqual(expect.any(Number));

  return { company, agentId: agent.id, issueId: issue.id, runId: runId!, seqOfFirstReply: replyRow!.seq! };
}

function timelineBody(seeded: Seeded, schema = "ac.milestone-timeline/v1") {
  const events = SAMPLE_MILESTONE_TIMELINE.events.map((event) =>
    event.id === "a-2" ? { ...event, source: { file: "agency-run-log.ndjson", ref: `seq=${seeded.seqOfFirstReply}` } } : event,
  );
  const json = {
    ...SAMPLE_MILESTONE_TIMELINE,
    schema,
    events,
    agentdash: { companyId: seeded.company.id, agentId: seeded.agentId, heartbeatRunId: seeded.runId, issueId: seeded.issueId },
  };
  return "```json\n" + JSON.stringify(json, null, 2) + "\n```";
}

async function putTimeline(request: APIRequestContext, seeded: Seeded, schema?: string) {
  const url = `/api/issues/${seeded.issueId}/documents/milestone-timeline-${seeded.runId}`;
  // A second write to the same key is an update and names the revision it replaces.
  const existing = await request.get(url);
  const baseRevisionId = existing.ok() ? ((await existing.json()) as { latestRevisionId: string }).latestRevisionId : null;
  const res = await request.put(url, {
    data: { title: "Business log", format: "markdown", body: timelineBody(seeded, schema), baseRevisionId },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/** PUT any body to the run's timeline key, with baseRevisionId on an update. */
async function putTimelineBody(request: APIRequestContext, seeded: Seeded, body: string) {
  const url = `/api/issues/${seeded.issueId}/documents/milestone-timeline-${seeded.runId}`;
  const existing = await request.get(url);
  const baseRevisionId = existing.ok() ? ((await existing.json()) as { latestRevisionId: string }).latestRevisionId : null;
  const res = await request.put(url, { data: { title: "Business log", format: "markdown", body, baseRevisionId } });
  expect(res.ok(), await res.text()).toBe(true);
  const stored = await request.get(url);
  return ((await stored.json()) as { body: string }).body;
}

function realArtefactFor(seeded: Seeded) {
  return {
    ...realArtefact,
    agency: {
      ...realArtefact.agency,
      agentdash: {
        ...realArtefact.agency.agentdash,
        companyId: seeded.company.id,
        agentId: seeded.agentId,
        heartbeatRunId: seeded.runId,
        issueId: seeded.issueId,
      },
    },
  };
}

const runUrl = (s: Seeded) => `/${s.company.issuePrefix}/agents/${s.agentId}/runs/${s.runId}`;
const modeButton = (page: Page, mode: string) => page.locator(`button[data-transcript-mode="${mode}"]`).first();

async function shoot(page: Page, name: string) {
  const dir = process.env.BUSINESS_VIEW_SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const [label, viewport] of [
    ["desktop", { width: 1366, height: 1000 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.evaluate((t) => {
        localStorage.setItem("agentdash.theme", t);
        document.documentElement.classList.toggle("dark", t === "dark");
      }, theme);
      await page.getByText(/^Transcript \(\d+\)$/).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(dir, `${name}-${label}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.evaluate(() => {
    localStorage.setItem("agentdash.theme", "light");
    document.documentElement.classList.remove("dark");
  });
}

test.describe("run page Business view", () => {
  test.describe.configure({ mode: "serial" });
  let seeded: Seeded;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    seeded = await seed(request);
  });

  test("a first-time viewer gets the plain summary, and the chosen view persists", async ({ page }) => {
    await page.goto(runUrl(seeded));
    await page.evaluate(() => localStorage.removeItem("agentdash.runTranscriptMode"));
    await page.reload();

    const summary = page.locator('[data-business-source="summary"]');
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(modeButton(page, "business")).toHaveAttribute("aria-pressed", "true");
    await expect(summary.locator("[data-business-result]")).toContainText("Nothing new is waiting");
    await expect(summary).toContainText("What the agent did");
    await expect(summary.locator('[data-business-outcome="done"]')).toBeVisible();
    // No stage labels for a run without a timeline.
    await expect(summary).not.toContainText("Negotiation");

    // "Before": Readable was the run page's default until this change.
    await modeButton(page, "readable").click();
    await expect(page.locator('[data-transcript-mode="readable"]').first()).toBeVisible();
    await shoot(page, "before-readable");

    await page.reload();
    await expect(modeButton(page, "readable")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
    expect(await page.evaluate(() => localStorage.getItem("agentdash.runTranscriptMode"))).toBe("readable");

    await modeButton(page, "business").click();
    await expect(summary).toBeVisible();
    await shoot(page, "after-business-summary");
  });

  test("a timeline in a newer format falls back to the summary with a note", async ({ page, request }) => {
    await putTimeline(request, seeded, "ac.milestone-timeline/v2");
    await page.goto(runUrl(seeded));
    const summary = page.locator('[data-business-source="summary"]');
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(summary).toContainText("newer format");
  });

  test("a v1 timeline renders the stages, simulated labels, inferred cue and log-line links", async ({ page, request }) => {
    await putTimeline(request, seeded);
    await page.goto(runUrl(seeded));
    const timeline = page.locator('[data-business-source="timeline"]');
    await expect(timeline).toBeVisible({ timeout: 30_000 });
    for (const label of ["Discover", "Proposal", "Negotiation", "Agreement", "Execution", "Settlement"]) {
      await expect(timeline.locator(`[data-business-stage]`, { hasText: label })).toBeVisible();
    }
    await expect(timeline.locator("[data-business-simulated-banner]")).toContainText("Stripe TEST mode");
    await expect(timeline.locator("[data-business-simulated-label]").first()).toBeVisible();
    await expect(timeline.locator('[data-basis="inferred"]')).toContainText("stage inferred");
    await expect(timeline.locator('[data-business-outcome-label="refused"]')).toBeVisible();
    await expect(timeline).toContainText("Clockchain: anchored · ledger ledger-77 · block 1203");
    await shoot(page, "after-business-timeline");

    await timeline.locator(`[data-business-event="a-2"] [data-business-log-link="${seeded.seqOfFirstReply}"]`).click();
    const raw = page.locator('div[data-transcript-mode="raw"]');
    await expect(raw).toBeVisible({ timeout: 15_000 });
    const focused = raw.locator('[data-raw-focused="true"]');
    await expect(focused).toBeVisible({ timeout: 15_000 });
    await expect(focused).toContainText("Pulling the open issues first.");
    await expect(focused).toBeInViewport();
    // Following a link does not change the saved view (this context saved none).
    expect(await page.evaluate(() => localStorage.getItem("agentdash.runTranscriptMode"))).not.toBe("raw");
    await page.reload();
    await expect(page.locator('[data-business-source="timeline"]')).toBeVisible({ timeout: 30_000 });
  });
  test("a real Track C artefact survives the document PUT, fenced or bare, and renders", async ({ page, request }) => {
    const artefact = realArtefactFor(seeded);
    const plain = JSON.stringify(artefact);
    expect(plain).toContain("\\n");

    // Bare JSON: stored byte for byte.
    const bare = await putTimelineBody(request, seeded, plain);
    expect(JSON.parse(bare)).toEqual(artefact);

    // Plain JSON in a ```json fence: the code block is stored literally.
    const fencedBody = "```json\n" + plain + "\n```";
    const fenced = await putTimelineBody(request, seeded, fencedBody);
    expect(fenced).toBe(fencedBody);

    await page.goto(runUrl(seeded));
    const timeline = page.locator('[data-business-source="timeline"]');
    await expect(timeline).toBeVisible({ timeout: 30_000 });
    await expect(timeline).toContainText(realArtefact.label);
    await expect(timeline.locator("[data-business-provenance]")).toContainText("Business log posted by");
    await expect(timeline).toContainText("Clockchain: not logged yet · covered by");
    await expect(timeline.locator("[data-business-simulated-label]").first()).toBeVisible();
    const agencyEvents = realArtefact.events.filter((event) => event.lane === "agency").length;
    await expect(timeline.locator("li[data-business-event]").filter({ visible: true })).toHaveCount(agencyEvents);
    await shoot(page, "after-business-real-artefact");
  });
});
