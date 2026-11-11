#!/usr/bin/env node
// Portable, offline native execution fixture. Requires the repository's installed dependencies/browser cache.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const fixtureStartedAt = new Date().toISOString();
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const evidence = path.resolve(option("--evidence-dir", path.join(os.tmpdir(), `native-evaluation-evidence-${Date.now()}`)));
const port = Number(option("--port", "3487"));
const dbPort = Number(option("--db-port", String(port + 20000)));
assert.ok(port >= 3400 && port <= 4999 && dbPort >= 23000 && dbPort <= 29999, "Dedicated fixture port ranges required");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const hash = (text) => createHash("sha256").update(text).digest("hex");
const write = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const sourceFiles = ["scripts/native-evaluation-runtime.mjs", "tests/e2e/fixtures/native-evaluation/claude.mjs", "tests/e2e/fixtures/native-evaluation/network-fence.mjs", "tests/e2e/fixtures/native-evaluation/rubric.json", "server/src/onboarding-assets/default/AGENTS.md", "server/src/services/agent-creator-from-proposal.ts"];
write("source-manifest.json", { capturedAt: new Date().toISOString(), files: sourceFiles.map((file) => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) })), actualExpandedRunPromptDigest: "unavailable", note: "Content hashes identify fixture and prompt sources. Run IDs, adapter config, profile revision and runtime context are captured separately." });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function portFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  await new Promise((resolve) => server.close(resolve));
}
await portFree(port); await portFree(dbPort); await portFree(port + 10000);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-evaluation-home-"));
const bin = path.join(home, "bin"); fs.mkdirSync(bin);
fs.symlinkSync(process.execPath, path.join(bin, "node"));
const denied = path.join(bin, "deny-provider");
fs.writeFileSync(denied, '#!/bin/sh\nprintf "%s\\n" "Provider executable disabled by native evaluation fixture" >&2\nexit 97\n', { mode: 0o700 });
for (const name of ["claude", "codex", "hermes", "gemini", "opencode", "pi", "cursor", "agent", "acpx", "openclaw", "curl", "wget"]) fs.symlinkSync(denied, path.join(bin, name));
const env = {
  HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: home, LANG: "en_US.UTF-8", TERM: "dumb",
  PAPERCLIP_HOME: path.join(home, "paperclip"), PAPERCLIP_INSTANCE_ID: "native-evaluation",
  PAPERCLIP_CONFIG: path.join(home, "paperclip/instances/native-evaluation/config.json"),
  PORT: String(port), PAPERCLIP_EMBEDDED_POSTGRES_PORT: String(dbPort),
  PAPERCLIP_DEPLOYMENT_MODE: "local_trusted", PAPERCLIP_DEPLOYMENT_EXPOSURE: "private", PAPERCLIP_BIND: "loopback",
  PAPERCLIP_UI_DEV_MIDDLEWARE: "true", SERVE_UI: "true", PAPERCLIP_E2E_SKIP_LLM: "true",
  PAPERCLIP_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", PAPERCLIP_DB_BACKUP_ENABLED: "false",
  HEARTBEAT_SCHEDULER_ENABLED: "false", RUN_HEALER_ENABLED: "false",
  AGENTDASH_EVALUATION_INGEST_ENABLED: "false", AGENTDASH_EVALUATION_SNAPSHOT_ENABLED: "false",
  AGENTDASH_DIGEST_ENABLED: "false", AGENTDASH_BILLING_DISABLED: "true", AGENTDASH_RATE_LIMIT_DISABLED: "true",
  AGENTDASH_ADAPTER_ENV_BYPASS: "true", AGENTDASH_ALLOW_MULTI_COMPANY: "true", AGENTDASH_DEFAULT_ADAPTER: "claude_local",
  AGENTDASH_CODEX_COMMAND: denied, AGENTDASH_HERMES_COMMAND: denied,
  PAPERCLIP_MIGRATION_PROMPT: "never", PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
  NATIVE_SERVER_PORT: String(port), NATIVE_EVIDENCE_DIR: evidence,
  NODE_OPTIONS: `--import=${path.join(root, "tests/e2e/fixtures/native-evaluation/network-fence.mjs")}`,
};
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const log = fs.openSync(path.join(evidence, "server.log"), "a", 0o600);
const server = spawn(process.execPath, [tsx, path.join(root, "cli/src/index.ts"), "onboard", "--yes", "--run"], { cwd: home, env, stdio: ["ignore", log, log], detached: true });
const base = `http://127.0.0.1:${port}`;
write("server.json", { pid: server.pid, base, home, config: env.PAPERCLIP_CONFIG, startedAt: new Date().toISOString(), command: [process.execPath, tsx, path.join(root, "cli/src/index.ts"), "onboard", "--yes", "--run"], environment: env, environmentHash: hash(JSON.stringify(env)), defaultProviderCommands: "fail-fast shims", networkPolicy: "Node TCP/fetch loopback only", ownerIdentity: "local-board (automated)" });
let browser;
let success = false;
try {
  let healthy = false;
  for (let i = 0; i < 180; i++) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    try { const response = await fetch(`${base}/api/health`); if (response.ok) { healthy = true; break; } } catch {}
    await wait(1000);
  }
  assert.ok(healthy, "Isolated server did not become healthy");
  if (args.includes("--start-only")) { success = true; console.log(JSON.stringify({ base, evidence, home, pid: server.pid })); server.unref(); process.exit(0); }
  const cache = option("--browser", null);
  browser = await chromium.launch({ headless: true, ...(cache ? { executablePath: cache } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Browser external requests are blocked too. Source and evidence stay on loopback.
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  write("browser.json", { version: browser.version(), executablePath: cache ?? chromium.executablePath() });
  const raw = [];
  const uiActions = [];
  async function uiAction(label, action) {
    const startedAt = new Date().toISOString();
    await action();
    uiActions.push({ label, startedAt, finishedAt: new Date().toISOString() });
    write("browser-action-receipts.json", uiActions);
  }
  const sanitize = (value) => Array.isArray(value) ? value.map(sanitize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !/^(env|apiKey|token|accessToken|refreshToken|secret|authorization)$/i.test(key)).map(([key, val]) => [key, sanitize(val)])) : value;
  async function api(method, url, body, expected = [200, 201]) {
    const response = await context.request.fetch(`${base}/api${url}`, { method, ...(body ? { data: body } : {}) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    raw.push({ at: new Date().toISOString(), method, url, status: response.status(), response: sanitize(data) });
    write("owner-api-receipts.json", raw);
    assert.ok(expected.includes(response.status()), `${method} ${url}: ${response.status()} ${text.slice(0, 350)}`);
    return data;
  }
  await page.goto(`${base}/company-create`);
  await uiAction("Fill workspace name", () => page.getByLabel("Workspace name").fill(`Synthetic native evaluation ${Date.now()}`));
  await uiAction("Create workspace", () => page.getByRole("button", { name: "Continue", exact: true }).click());
  await page.waitForURL(/\/setup\?companyId=/, { timeout: 30000 });
  const companyId = new URL(page.url()).searchParams.get("companyId");
  const company = await api("GET", `/companies/${companyId}`);
  await page.screenshot({ path: path.join(evidence, "01-workspace-setup.png"), fullPage: true });
  await uiAction("Complete workspace setup", () => page.getByRole("button", { name: "Continue to your Chief of Staff" }).click());
  await page.waitForURL(/\/cos$/, { timeout: 30000 });
  const existing = await api("GET", `/companies/${companyId}/agents`);
  for (const agent of existing) await api("PATCH", `/agents/${agent.id}`, { status: "paused", adapterType: "claude_local", adapterConfig: { command: denied, cwd: home }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } } });
  const command = path.join(root, "tests/e2e/fixtures/native-evaluation/claude.mjs");
  const agent = await api("POST", `/companies/${companyId}/agents`, { name: "Native proof worker", role: "engineer", adapterType: "claude_local", adapterConfig: { command, cwd: home, timeoutSec: 60, model: "deterministic-native-fixture", env: { HOME: home, PATH: env.PATH, PAPERCLIP_E2E_SKIP_LLM: "true", PAPERCLIP_TELEMETRY_DISABLED: "1", NATIVE_SERVER_PORT: String(port), NATIVE_EVIDENCE_DIR: evidence, NODE_OPTIONS: env.NODE_OPTIONS } }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, intervalSec: 0 } } });
  const profileBase = `/companies/${companyId}/agents/${agent.id}/profile`;
  const draft = await api("POST", `${profileBase}/revisions`, {});
  const expectedText = "Native output verified.\n";
  const exact = { kind: "record", record: `document.sha256:result:${hash(expectedText)}` };
  const responsibility = (key, checks) => ({ key, title: key, outcome: "Observable native output", stakeholders: [], obligation: { kind: "assigned" }, deliverable: { what: "Exact native result", destination: "Issue result document" }, escalation: { when: "Approval or output proof missing" }, performance: { criteria: checks.map((check, i) => ({ id: `${key}-${i}`, text: "Required proof", source: "human", check })), coverage: [], outcomeLinks: [], expectedHumanSteps: ["sign_off"], judges: { automated: [] } } });
  const body = { ...draft.body, identity: { ...draft.body.identity, name: agent.name }, responsibilities: [responsibility("exact-output", [{ kind: "record", record: `document.sha256:result:${hash("Seed requiring owner correction")}` }]), responsibility("pending-output", [exact, { kind: "record", record: "unsupported.external-quality" }])] };
  const savedResponse = await context.request.patch(`${base}/api${profileBase}/revisions/${draft.id}`, { headers: { "If-Match": draft.bodyHash }, data: { body, provenance: { "/responsibilities": { state: "owner_confirmed" } } } });
  assert.ok(savedResponse.ok(), await savedResponse.text());
  const saved = await savedResponse.json();
  raw.push({ at: new Date().toISOString(), method: "PATCH", url: `${profileBase}/revisions/${draft.id}`, status: savedResponse.status(), response: sanitize(saved) });
  write("owner-api-receipts.json", raw);
  const proposed = await api("POST", `${profileBase}/revisions/${draft.id}/propose`, {});
  const approval = { id: proposed.approvalId ?? proposed.approval?.id ?? proposed.revision?.approvalId };
  await api("POST", `/approvals/${approval.id}/approve`, { decisionNote: "Synthetic local owner approves fixture profile" });
  for (let i = 0; i < 40; i++) { const state = await api("GET", profileBase); if (state.active?.id === draft.id) break; await wait(250); }
  const applied = await api("GET", profileBase);
  assert.equal(applied.active?.id, draft.id, "Profile must apply through real approval lifecycle");
  await page.goto(`${base}/${company.issuePrefix}/agents/${agent.id}/profile`);
  await page.getByTestId("agent-profile-tab").waitFor();
  await uiAction("Open profile draft", () => page.getByRole("button", { name: "Draft changes", exact: true }).click());
  await page.getByTestId("agent-profile-editor").waitFor();
  await uiAction("Fill document key", () => page.getByLabel("Document key", { exact: true }).first().fill("result"));
  await uiAction("Fill exact expected text", () => page.getByLabel("Expected text", { exact: true }).first().fill(expectedText));
  await uiAction("Change required criterion text", () => page.getByLabel("Criterion text", { exact: true }).first().fill("Exact persisted result required"));
  await page.screenshot({ path: path.join(evidence, "02-owner-profile.png"), fullPage: true });
  const saveWait = page.waitForResponse((response) => response.url().includes(`${profileBase}/revisions/`) && response.request().method() === "PATCH");
  await uiAction("Save changed profile draft", () => page.getByRole("button", { name: "Save draft", exact: true }).click());
  const uiSaveResponse = await saveWait;
  assert.ok(uiSaveResponse.ok(), await uiSaveResponse.text());
  const uiSaved = await uiSaveResponse.json();
  assert.equal(uiSaved.body.responsibilities[0].performance.criteria[0].check.record, exact.record);
  assert.equal(uiSaved.body.responsibilities[0].performance.criteria[0].text, "Exact persisted result required");
  raw.push({ at: new Date().toISOString(), method: "PATCH", url: `${profileBase}/revisions/${uiSaved.id}`, origin: "browser Save draft", status: uiSaveResponse.status(), response: sanitize(uiSaved) });
  await uiAction("Request profile approval", () => page.getByRole("button", { name: "Request approval", exact: true }).click());
  const proposalWait = page.waitForResponse((response) => response.url().endsWith(`/revisions/${uiSaved.id}/propose`) && response.request().method() === "POST");
  await uiAction("Send changed draft for approval", () => page.getByTestId("agent-profile-send-for-approval").click());
  const uiProposalResponse = await proposalWait;
  assert.ok(uiProposalResponse.ok(), await uiProposalResponse.text());
  const uiProposal = await uiProposalResponse.json();
  raw.push({ at: new Date().toISOString(), method: "POST", url: `${profileBase}/revisions/${uiSaved.id}/propose`, origin: "browser Send for approval", status: uiProposalResponse.status(), response: sanitize(uiProposal) });
  await api("POST", `/approvals/${uiProposal.approvalId}/approve`, { decisionNote: "Synthetic owner applies browser-edited criteria" });
  let activeUiProfile;
  for (let i = 0; i < 40; i++) { activeUiProfile = await api("GET", profileBase); if (activeUiProfile.active?.id === uiSaved.id) break; await wait(250); }
  assert.equal(activeUiProfile.active?.id, uiSaved.id);
  assert.equal(activeUiProfile.active.body.responsibilities[0].performance.criteria[0].check.record, exact.record);
  write("owner-ui-profile.json", { savedRevision: sanitize(uiSaved), proposed: uiProposal, applied: sanitize(activeUiProfile) });
  const rubric = JSON.parse(fs.readFileSync(path.join(root, "tests/e2e/fixtures/native-evaluation/rubric.json"), "utf8"));
  const rubricHash = hash(fs.readFileSync(path.join(root, "tests/e2e/fixtures/native-evaluation/rubric.json")));
  write("rubric.json", rubric);
  const cases = [];
  for (const scenario of ["correct", "wrong", "approval", "missing", "unverified"]) {
    const startedAt = new Date().toISOString();
    const issue = await api("POST", `/companies/${companyId}/issues`, { title: `Native ${scenario}`, description: `native-case:${scenario}\nDeterministic isolated fixture.`, status: "backlog", ...(scenario === "correct" ? { assigneeAgentId: agent.id } : {}) });
    if (scenario === "correct") {
      const mappingUrl = `/companies/${companyId}/issues/${issue.id}/responsibility`;
      assert.equal((await api("GET", mappingUrl)).current, null);
      await page.goto(`${base}/${company.issuePrefix}/issues/${issue.identifier}`);
      await uiAction("Open task Reviews", () => page.getByRole("tab", { name: "Reviews", exact: true }).click());
      await uiAction("Select active responsibility", () => page.getByLabel("Active responsibility", { exact: true }).selectOption("exact-output"));
      const mappingWait = page.waitForResponse((response) => response.url().endsWith(mappingUrl) && response.request().method() === "POST");
      await uiAction("Map initially unmapped task", () => page.getByRole("button", { name: "Map responsibility", exact: true }).click());
      const mappingResponse = await mappingWait;
      assert.ok(mappingResponse.ok(), await mappingResponse.text());
      raw.push({ at: new Date().toISOString(), method: "POST", url: mappingUrl, origin: "browser Map responsibility", status: mappingResponse.status(), response: sanitize(await mappingResponse.json()) });
      const mapped = await api("GET", mappingUrl);
      assert.equal(mapped.current.profileRevisionId, uiSaved.id);
      assert.equal(mapped.current.responsibilityKey, "exact-output");
      assert.equal((await api("GET", `/issues/${issue.id}`)).executionRunId, null, "Backlog task must remain undispatched until mapping completes");
      await page.getByText("Responsibility mapped. Acceptance requires separate evidence.").waitFor();
      await page.screenshot({ path: path.join(evidence, "02b-owner-mapping.png"), fullPage: true });
    } else await api("POST", `/companies/${companyId}/issues/${issue.id}/responsibility`, { agentId: agent.id, responsibilityKey: scenario === "unverified" ? "pending-output" : "exact-output" });
    if (scenario === "missing") {
      // Paused per-task worker cannot start. No wake request is sent.
      await api("PATCH", `/agents/${agent.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } } });
    }
    await api("PATCH", `/issues/${issue.id}`, { status: "todo", assigneeAgentId: agent.id });
    let run = null;
    if (scenario !== "missing") {
      for (let i = 0; i < 90; i++) {
        const runs = await api("GET", `/companies/${companyId}/heartbeat-runs?agentId=${agent.id}&limit=100`);
        const matching = runs.filter((item) => item.contextSnapshot?.issueId === issue.id || item.contextSnapshot?.taskId === issue.id);
        if (matching.length > 1) throw new Error("Duplicate execution for one task");
        run = matching[0] ?? null;
        if (run && ["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) break;
        await wait(500);
      }
      assert.equal(run?.status, "succeeded", JSON.stringify(run));
      assert.equal(run?.exitCode, 0);
    }
    let observed = await api("GET", `/issues/${issue.id}`);
    const docs = await api("GET", `/issues/${issue.id}/documents`);
    if (scenario === "correct") {
      await page.goto(`${base}/${company.issuePrefix}/issues/${issue.identifier}`);
      await page.getByTestId("issue-result-block").waitFor();
      await page.getByText("Native output verified.", { exact: true }).waitFor();
      const accepted = page.waitForResponse((response) => (response.url().endsWith(`/api/issues/${issue.id}`) || response.url().endsWith(`/api/issues/${issue.identifier}`)) && response.request().method() === "PATCH");
      await uiAction("Accept native result as simulated owner", () => page.getByRole("button", { name: "Accept", exact: true }).click());
      const acceptanceResponse = await accepted;
      assert.ok(acceptanceResponse.ok(), await acceptanceResponse.text());
      raw.push({ at: new Date().toISOString(), method: "PATCH", url: `/issues/${issue.id}`, origin: "browser simulated local-board Result Accept", request: JSON.parse(acceptanceResponse.request().postData()), response: sanitize(await acceptanceResponse.json()), status: acceptanceResponse.status() });
      write("owner-api-receipts.json", raw);
      await wait(500);
      observed = await api("GET", `/issues/${issue.id}`);
    }
    await page.goto(`${base}/${company.issuePrefix}/issues/${issue.identifier}`);
    await page.getByTestId("issue-detail-tabs").waitFor();
    await page.screenshot({ path: path.join(evidence, `case-${scenario}.png`), fullPage: true });
    cases.push({ scenario, companyId, agentId: agent.id, issueId: issue.id, identifier: issue.identifier, runId: run?.id ?? null, startedAt, finishedAt: new Date().toISOString(), observed, documents: docs, execution: scenario === "missing" ? "never-started" : scenario === "correct" ? "persistent-cold-write" : "persistent-warm-read", taskContract: scenario === "wrong" ? "one-off task/run within persistent worker" : "persistent worker" });
    if (scenario === "missing") await api("PATCH", `/agents/${agent.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, intervalSec: 0 } } });
  }
  await api("POST", `/companies/${companyId}/evaluation/ingest/run?backfill=true`, {});
  const snapshot = await api("POST", `/companies/${companyId}/evaluation/agents/${agent.id}/snapshot`, {});
  const card = await api("GET", `/companies/${companyId}/evaluation/agents/${agent.id}`);
  const caseRows = await api("GET", `/companies/${companyId}/evaluation/agents/${agent.id}/cases?limit=500`);
  const evaluationBase = `/companies/${companyId}/evaluation/agents/${agent.id}`;
  assert.equal(snapshot.verify.status, "agree");
  assert.equal(card.card.formulaVersion, rubric.formulaVersion);
  assert.deepEqual(card.card.worker.acceptance.body.facts.automatedAcceptance, rubric.automatedAcceptance);
  const obligations = card.card.worker.obligations.body.responsibilities;
  assert.equal(obligations.reduce((sum, row) => sum + row.owed, 0), rubric.owed);
  assert.equal(card.card.worker.cost.body.humanReviewActions, 0);
  assert.equal(card.card.worker.cost.body.humanCorrections, 0);
  const runs = await api("GET", `/companies/${companyId}/heartbeat-runs?agentId=${agent.id}&limit=100`);
  assert.equal(runs.length, 4);
  const runtime = fs.readFileSync(path.join(evidence, "runtime-receipts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(runtime.length, 4);
  for (const item of cases) {
    const expected = rubric.cases[item.scenario];
    assert.equal(item.observed.status, expected.issueStatus);
    const obligation = caseRows.rows.find((row) => row.section === "obligations" && row.item?.id === item.issueId);
    assert.equal(obligation?.state, expected.obligation);
    const acceptance = caseRows.rows.find((row) => row.fact === "automated" && row.item?.id === item.issueId);
    assert.equal(acceptance?.state ?? null, expected.automatedAcceptance);
    const actualRuns = runs.filter((run) => run.contextSnapshot?.issueId === item.issueId || run.contextSnapshot?.taskId === item.issueId);
    assert.equal(actualRuns.length, expected.runs);
    item.expected = expected;
    item.measuredDurationMs = Date.parse(item.finishedAt) - Date.parse(item.startedAt);
    if (item.scenario === "missing") { assert.equal(item.documents.length, 0); continue; }
    const receipt = runtime.find((row) => row.runId === item.runId);
    assert.ok(receipt && !receipt.error);
    assert.equal(receipt.receipts.find((row) => row.path === "/agents/me").response.id, agent.id);
    assert.ok(receipt.receipts.some((row) => row.path.endsWith("/snapshot") && row.status === 403));
    if (item.scenario !== "correct") assert.match(receipt.receipts.find((row) => row.method === "GET" && row.path.endsWith("/memory")).response.memory.content, /native-continuity-v1/);
    if (item.scenario === "approval") {
      const permission = receipt.receipts.find((row) => row.method === "POST" && row.path.endsWith("/approvals"));
      assert.equal(permission.response.status, "pending");
      assert.ok(receipt.receipts.some((row) => row.path.endsWith("/approve") && row.status === 403));
      const currentPermission = await api("GET", `/approvals/${permission.response.id}`);
      assert.equal(currentPermission.status, "pending");
      assert.equal(item.documents.length, 0);
    } else {
      const document = await api("GET", `/issues/${item.issueId}/documents/result`);
      assert.equal(hash(document.body) === hash(expectedText), item.scenario !== "wrong");
      item.outputDigest = hash(document.body);
      item.outputRevisionId = document.latestRevisionId;
    }
  }
  // Prove current-head invalidation before ingestion, while pinned historical replay stays stable.
  const correct = cases.find((item) => item.scenario === "correct");
  const original = await api("GET", `/issues/${correct.issueId}/documents/result`);
  await api("PUT", `/issues/${correct.issueId}/documents/result`, { format: "markdown", body: "Changed after captured evidence", baseRevisionId: original.latestRevisionId });
  const staleCurrent = await api("GET", `${evaluationBase}/compute`);
  const staleStored = await api("GET", `${evaluationBase}?version=1`);
  const pinnedVerify = await api("GET", `${evaluationBase}/verify?version=1`);
  assert.equal(staleCurrent.card.nativeOutputStatus, "stale");
  assert.equal(staleCurrent.card.worker.acceptance.visibility, "not_visible");
  assert.equal(staleStored.card.nativeOutputStatus, "stale");
  assert.equal(staleStored.card.stored.cardHash, snapshot.snapshot.cardHash);
  assert.equal(pinnedVerify.verify.status, "agree");
  const changed = await api("GET", `/issues/${correct.issueId}/documents/result`);
  await api("PUT", `/issues/${correct.issueId}/documents/result`, { format: "markdown", body: expectedText, baseRevisionId: changed.latestRevisionId });
  const restoredBeforeIngest = await api("GET", `${evaluationBase}/compute`);
  assert.equal(restoredBeforeIngest.card.nativeOutputStatus, "stale", "Same bytes in a different revision require fresh evidence");
  await api("POST", `/companies/${companyId}/evaluation/ingest/run?backfill=true`, {});
  const finalSnapshot = await api("POST", `${evaluationBase}/snapshot`, {});
  const restoredCurrent = await api("GET", `${evaluationBase}/compute`);
  assert.equal(restoredCurrent.card.nativeOutputStatus, "current");
  assert.deepEqual(restoredCurrent.card.worker.acceptance.body.facts.automatedAcceptance, rubric.automatedAcceptance);
  write("head-freshness.json", { staleCurrent, staleStored, pinnedVerify, restoredBeforeIngest, finalSnapshot, restoredCurrent });
  await page.goto(`${base}/${company.issuePrefix}/agents/${agent.id}/performance`);
  await page.getByTestId("agent-card").waitFor();
  await page.screenshot({ path: path.join(evidence, "03-evaluation.png"), fullPage: true });
  write("result.json", { status: "completed", cases, snapshot, card, caseRows, profileRevisionId: uiSaved.id, profileBodyHash: uiSaved.bodyHash, configHash: hash(JSON.stringify(agent.adapterConfig)), consoleErrors, rubricVersion: rubric.version, rubricHash, fixtureStartedAt, fixtureFinishedAt: new Date().toISOString(), measuredDurationMs: Date.now() - Date.parse(fixtureStartedAt), measuredOwnerApiMutations: raw.filter((r) => r.method !== "GET").length, measuredCompletedUiActions: uiActions.length, actionCountsOverlap: "Browser Result Accept is also recorded as an API mutation; counts must not be summed", humanCalibration: "pending", humanEffortMinutes: "unavailable", assistantCosts: "unavailable", assistantTokens: "unavailable", fixtureProviderCalls: { value: 0, basis: "Verified by deterministic executable construction and fail-closed loopback/provider-command guards", independentNetworkMetering: "unavailable" } });
  write("fixture-location.json", { base, companyId, agentId: agent.id, prefix: company.issuePrefix, issues: cases.map((c) => ({ scenario: c.scenario, url: `${base}/${company.issuePrefix}/issues/${c.identifier}` })) });
  success = true;
  console.log(JSON.stringify({ status: "completed", base, evidence }));
} finally {
  await browser?.close();
  if (args.includes("--keep-server") && success) server.unref();
  else { try { process.kill(-server.pid, "SIGTERM"); } catch {} }
}
