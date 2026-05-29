import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLaunchHarnessRequirements,
  buildHarnessSmokePlan,
  selectSmokeAgents,
  summarizeSmokeResults,
} from "./agent-harness-smoke.mjs";

test("builds harness smoke API endpoints from a private base URL", () => {
  const plan = buildHarnessSmokePlan({
    baseUrl: "http://100.64.0.10:3100/",
    companyId: "company-1",
    adapters: ["codex_local"],
  });

  assert.equal(plan.baseUrl, "http://100.64.0.10:3100");
  assert.equal(plan.agentsUrl, "http://100.64.0.10:3100/api/companies/company-1/agents");
  assert.equal(
    plan.testEnvironmentUrl("codex_local"),
    "http://100.64.0.10:3100/api/companies/company-1/adapters/codex_local/test-environment",
  );
});

test("selects launch-relevant agents and supports adapter filters", () => {
  const agents = [
    { id: "agent-1", name: "Codex", adapterType: "codex_local", status: "idle", adapterConfig: { model: "gpt" } },
    { id: "agent-2", name: "Claude", adapterType: "claude_local", status: "paused", adapterConfig: {} },
    { id: "agent-3", name: "Old", adapterType: "codex_local", status: "terminated", adapterConfig: {} },
    { id: "agent-4", name: "Pending", adapterType: "codex_local", status: "pending_approval", adapterConfig: {} },
  ];

  assert.deepEqual(
    selectSmokeAgents(agents, { adapters: ["codex_local"] }).map((agent) => agent.id),
    ["agent-1"],
  );
  assert.deepEqual(
    selectSmokeAgents(agents, { adapters: [] }).map((agent) => agent.id),
    ["agent-1", "agent-2"],
  );
});

test("summarizes smoke results and treats warnings as launch blockers by default", () => {
  const strict = summarizeSmokeResults([
    { agentId: "agent-1", agentName: "Codex", adapterType: "codex_local", status: "pass", checks: [] },
    { agentId: "agent-2", agentName: "Claude", adapterType: "claude_local", status: "warn", checks: [] },
  ]);
  const allowWarn = summarizeSmokeResults([
    { agentId: "agent-2", agentName: "Claude", adapterType: "claude_local", status: "warn", checks: [] },
  ], { allowWarn: true });

  assert.equal(strict.ok, false);
  assert.deepEqual(strict.summary, { pass: 1, warn: 1, fail: 0 });
  assert.equal(allowWarn.ok, true);
});

test("requires codex control-plane reachability evidence for launch smoke", () => {
  const normalized = applyLaunchHarnessRequirements({
    agentId: "agent-1",
    agentName: "Codex",
    adapterType: "codex_local",
    status: "pass",
    checks: [
      { code: "codex_hello_probe_passed", level: "info", message: "hello" },
    ],
  });

  assert.equal(normalized.status, "fail");
  assert.deepEqual(
    normalized.checks.at(-1),
    {
      code: "codex_control_plane_api_check_missing",
      level: "error",
      message: "codex_local launch smoke requires codex_control_plane_api_reachable evidence",
      hint: "Run saved-agent preflight after configuring PAPERCLIP_API_URL/trusted-local bypass or a callback bridge.",
    },
  );
});
