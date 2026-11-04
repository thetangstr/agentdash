#!/usr/bin/env node
// Deterministic executable substituted beneath the real claude_local adapter.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const env = process.env;
assert.equal(env.PAPERCLIP_E2E_SKIP_LLM, "true");
assert.equal(env.PAPERCLIP_TELEMETRY_DISABLED, "1");
assert.ok(env.HOME?.includes("native-evaluation-"));
const forbidden = Object.keys(env).filter((key) => /^(ANTHROPIC|OPENAI|MINIMAX|GEMINI|GOOGLE|AWS|AZURE|SENTRY|RESEND|SLACK|STRIPE).*(KEY|TOKEN|SECRET|CREDENTIAL)/i.test(key) && env[key]);
assert.deepEqual(forbidden, []);
assert.ok(env.PAPERCLIP_API_KEY && env.PAPERCLIP_RUN_ID && env.PAPERCLIP_TASK_ID && env.PAPERCLIP_AGENT_ID);
const base = new URL(env.PAPERCLIP_API_URL);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
assert.equal(base.port, env.NATIVE_SERVER_PORT);
const identity = { companyId: env.PAPERCLIP_COMPANY_ID, agentId: env.PAPERCLIP_AGENT_ID, issueId: env.PAPERCLIP_TASK_ID, runId: env.PAPERCLIP_RUN_ID };
const startedAt = new Date().toISOString();
const receipts = [];
const sanitize = (value) => Array.isArray(value) ? value.map(sanitize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !/^(env|apiKey|token|accessToken|refreshToken|secret|authorization)$/i.test(key)).map(([key, val]) => [key, sanitize(val)])) : value;
async function api(method, path, body, expected = [200, 201]) {
  const response = await fetch(new URL(`/api${path}`, base), { method, headers: { Authorization: `Bearer ${env.PAPERCLIP_API_KEY}`, "X-Paperclip-Run-Id": identity.runId, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = text; }
  // No authorization headers, environment maps or profile/runtime config are recorded.
  const recorded = path === "/agents/me" ? { id: value.id, companyId: value.companyId, role: value.role } : value;
  receipts.push({ at: new Date().toISOString(), method, path, status: response.status, response: sanitize(recorded) });
  assert.ok(expected.includes(response.status), `${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return value;
}
try {
  const me = await api("GET", "/agents/me");
  assert.equal(me.id, identity.agentId);
  assert.equal(me.companyId, identity.companyId);
  const issue = await api("GET", `/issues/${identity.issueId}`);
  assert.equal(issue.assigneeAgentId, identity.agentId);
  assert.equal(issue.executionRunId, identity.runId);
  const scenario = /native-case:([a-z-]+)/.exec(issue.description ?? "")?.[1];
  assert.ok(scenario, "Only explicit native-case tasks may run this executable");
  await api("POST", `/issues/${identity.issueId}/comments`, { body: "Deterministic fixture started with authenticated run identity." });
  await api("POST", `/issues/${identity.issueId}/checkout`, { agentId: identity.agentId, expectedStatuses: ["todo", "in_progress"] });
  const memoryPath = `/companies/${identity.companyId}/agents/${identity.agentId}/memory`;
  const memory = await api("GET", memoryPath);
  if (scenario === "correct") await api("PUT", memoryPath, { content: "native-continuity-v1: use result documents", expectedVersion: memory.memory?.version ?? null });
  else assert.match(memory.memory?.content ?? "", /native-continuity-v1/, "Later real run must read durable memory");
  // A real authenticated refusal proves the caller did not fall back to local board authority.
  await api("POST", `/companies/${identity.companyId}/evaluation/agents/${identity.agentId}/snapshot`, {}, [403]);
  if (scenario === "approval") {
    const approval = await api("POST", `/companies/${identity.companyId}/approvals`, { type: "request_board_approval", issueIds: [identity.issueId], payload: { title: "Synthetic downstream action requires permission", reason: "Fixture does not execute a downstream action until a board decision" } });
    await api("POST", `/approvals/${approval.id}/approve`, { decisionNote: "Agent self-approval must be refused" }, [403]);
    await api("PATCH", `/issues/${identity.issueId}`, { status: "blocked", comment: "Permission requested. No downstream action executed." });
  } else {
    const body = scenario === "wrong" ? "Convincing completion report, but wrong persisted output." : "Native output verified.\n";
    await api("PUT", `/issues/${identity.issueId}/documents/result`, { title: "Native result", format: "markdown", body });
    await api("GET", `/issues/${identity.issueId}/documents/result`);
    if (scenario === "correct") await api("POST", `/issues/${identity.issueId}/work-products`, { type: "document", provider: "native", title: "Verified native result", status: "ready_for_review", reviewState: "needs_board_review", isPrimary: true, metadata: { documentKey: "result" } });
    await api("PATCH", `/issues/${identity.issueId}`, { status: scenario === "correct" ? "in_review" : "done", comment: "All work is complete. The final result is excellent and ready for acceptance." });
  }
  appendFileSync(`${env.NATIVE_EVIDENCE_DIR}/runtime-receipts.jsonl`, JSON.stringify({ ...identity, scenario, startedAt, finishedAt: new Date().toISOString(), memoryPhase: scenario === "correct" ? "persistent-cold-write" : "persistent-warm-read", command: import.meta.url, providerCalls: 0, receipts }) + "\n");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: randomUUID(), result: "All work is complete. The final result is excellent and ready for acceptance.", usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
} catch (error) {
  appendFileSync(`${env.NATIVE_EVIDENCE_DIR}/runtime-receipts.jsonl`, JSON.stringify({ ...identity, startedAt, finishedAt: new Date().toISOString(), error: String(error), receipts }) + "\n");
  console.error(String(error)); process.exitCode = 1;
}
