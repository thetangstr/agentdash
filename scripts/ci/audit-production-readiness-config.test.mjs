import assert from "node:assert/strict";
import test from "node:test";

import {
  auditProductionReadinessConfig,
  renderProductionReadinessSummary,
} from "./audit-production-readiness-config.mjs";

test("fails when target runner config is absent", () => {
  const result = auditProductionReadinessConfig({
    repository: "thetangstr/agentdash",
    variables: [],
    runners: [],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  assert.equal(result.conclusion, "failure");
  assert.match(
    result.requirements.find((item) => item.id === "target-runner-variable").message,
    /AGENTDASH_TARGET_RUNNER_LABELS is missing/,
  );
  assert.equal(
    result.requirements.find((item) => item.id === "target-runner-available").status,
    "fail",
  );
  assert.deepEqual(result.observations, {
    repositoryVariableCount: 0,
    variableInventoryError: null,
    variableContextProvided: false,
    selfHostedRunnerCount: 0,
    runnerInventoryError: null,
    environmentInventoryError: null,
    launchSmokeUrlConfigured: false,
    launchSmokeBillingRequired: false,
    launchSmokeLlmRequired: false,
  });
});

test("fails when target runner labels point at GitHub-hosted runners", () => {
  const result = auditProductionReadinessConfig({
    variables: [{ name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["ubuntu-latest"]' }],
    runners: [],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  assert.equal(result.conclusion, "failure");
  assert.match(
    result.requirements.find((item) => item.id === "target-runner-variable").message,
    /not real target-machine coverage/,
  );
});

test("can explicitly allow GitHub-hosted target validation", () => {
  const result = auditProductionReadinessConfig(
    {
      variables: [{ name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["ubuntu-latest"]' }],
      runners: [],
      environments: [
        { name: "npm-canary", protection_rules: [] },
        { name: "npm-stable", protection_rules: [] },
      ],
    },
    { allowGitHubHostedTarget: true },
  );

  assert.equal(result.conclusion, "failure");
  assert.equal(
    result.requirements.find((item) => item.id === "target-runner-available").status,
    "pass",
  );
  assert.equal(
    result.requirements.find((item) => item.id === "launch-smoke-url-variable").status,
    "fail",
  );
});

test("passes when a matching self-hosted target runner is online and idle", () => {
  const result = auditProductionReadinessConfig({
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "true" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "true" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "macOS", "ARM64", "agentdash-target"],
      },
    ],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  assert.equal(result.conclusion, "success");
  assert.equal(
    result.requirements.find((item) => item.id === "target-runner-available").message,
    "A matching self-hosted target runner is online and idle.",
  );
});

test("fails structurally when runner inventory cannot be inspected", () => {
  const result = auditProductionReadinessConfig({
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "true" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "true" },
    ],
    runners: [],
    runnerInventoryError: "Resource not accessible by integration",
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  assert.equal(result.conclusion, "failure");
  assert.match(
    result.requirements.find((item) => item.id === "target-runner-available").message,
    /Could not inspect self-hosted target runner inventory/,
  );
  assert.equal(result.observations.selfHostedRunnerCount, null);
});

test("fails when release environments are missing", () => {
  const result = auditProductionReadinessConfig({
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "true" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "true" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
    environments: [],
  });

  assert.equal(result.conclusion, "failure");
  assert.deepEqual(
    result.requirements.filter((item) => item.id === "release-environment").map((item) => item.status),
    ["fail", "fail"],
  );
});

test("fails when launch smoke URL is missing or local", () => {
  const missing = auditProductionReadinessConfig({
    variables: [{ name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' }],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });
  assert.equal(
    missing.requirements.find((item) => item.id === "launch-smoke-url-variable").status,
    "fail",
  );

  const local = auditProductionReadinessConfig({
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "http://127.0.0.1:3100" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "true" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "true" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });
  assert.match(
    local.requirements.find((item) => item.id === "launch-smoke-url-variable").message,
    /https URL/,
  );
});

test("requires production launch smoke to prove billing and real LLM paths", () => {
  const missing = auditProductionReadinessConfig({
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  assert.equal(missing.conclusion, "failure");
  assert.equal(
    missing.requirements.find((item) => item.id === "launch-smoke-billing-required").status,
    "fail",
  );
  assert.equal(
    missing.requirements.find((item) => item.id === "launch-smoke-llm-required").status,
    "fail",
  );

  const disabled = auditProductionReadinessConfig({
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "false" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "FALSE" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  assert.match(
    disabled.requirements.find((item) => item.id === "launch-smoke-billing-required").message,
    /must be set to "true"/,
  );
  assert.match(
    disabled.requirements.find((item) => item.id === "launch-smoke-llm-required").message,
    /must be set to "true"/,
  );
  assert.equal(disabled.observations.launchSmokeBillingRequired, false);
  assert.equal(disabled.observations.launchSmokeLlmRequired, false);
});

test("reports repository variable permission failures as structured audit failures", () => {
  const result = auditProductionReadinessConfig({
    variableInventoryError: "failed to get variables: HTTP 403: Resource not accessible by integration",
    variables: [],
    runners: [],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  assert.equal(result.conclusion, "failure");
  assert.match(
    result.requirements.find((item) => item.id === "repository-variables-readable").message,
    /Could not inspect repository Actions variables/,
  );
  assert.match(
    result.requirements.find((item) => item.id === "target-runner-variable").message,
    /Could not verify repository variable AGENTDASH_TARGET_RUNNER_LABELS/,
  );
  assert.match(
    result.requirements.find((item) => item.id === "launch-smoke-url-variable").message,
    /Could not verify repository variable AGENTDASH_LAUNCH_SMOKE_BASE_URL/,
  );
  assert.match(
    result.requirements.find((item) => item.id === "launch-smoke-billing-required").message,
    /Could not verify repository variable AGENTDASH_LAUNCH_SMOKE_BILLING/,
  );
  assert.match(
    result.requirements.find((item) => item.id === "launch-smoke-llm-required").message,
    /Could not verify repository variable AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM/,
  );
  assert.equal(result.observations.variableInventoryError?.includes("HTTP 403"), true);
});

test("uses Actions vars context when repository variable inventory is unreadable", () => {
  const result = auditProductionReadinessConfig({
    variableInventoryError: "failed to get variables: HTTP 403: Resource not accessible by integration",
    variableContextProvided: true,
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "true" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "true" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "macOS", "ARM64", "agentdash-target"],
      },
    ],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  assert.equal(result.conclusion, "success");
  assert.equal(
    result.requirements.some((item) => item.id === "repository-variables-readable"),
    false,
  );
  assert.equal(
    result.requirements.find((item) => item.id === "target-runner-variable").status,
    "pass",
  );
  assert.equal(
    result.requirements.find((item) => item.id === "launch-smoke-url-variable").status,
    "pass",
  );
  assert.equal(result.observations.variableContextProvided, true);
  assert.equal(result.observations.variableInventoryError?.includes("HTTP 403"), true);
});

test("reports release environment permission failures as structured audit failures", () => {
  const result = auditProductionReadinessConfig({
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "true" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "true" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
    environments: [],
    environmentInventoryError: "failed to get environments: HTTP 403",
  });

  assert.equal(result.conclusion, "failure");
  assert.match(
    result.requirements.find((item) => item.id === "release-environment").message,
    /Could not inspect GitHub release environments/,
  );
  assert.equal(result.observations.environmentInventoryError?.includes("HTTP 403"), true);
});

test("fails when the stable release environment has no required reviewers", () => {
  const result = auditProductionReadinessConfig({
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "true" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "true" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [] },
    ],
  });

  assert.equal(result.conclusion, "failure");
  assert.equal(
    result.requirements.find((item) => item.id === "stable-release-environment-protected").status,
    "fail",
  );
  assert.match(
    result.requirements.find((item) => item.id === "stable-release-environment-protected").message,
    /does not require reviewer approval/,
  );
});

test("renders an actionable GitHub job summary for missing external gates", () => {
  const result = auditProductionReadinessConfig({
    repository: "thetangstr/agentdash",
    checkedAt: "2026-05-18T10:00:00.000Z",
    variables: [],
    runners: [],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [] },
    ],
  });

  const summary = renderProductionReadinessSummary(result);

  assert.match(summary, /Production Readiness Config Audit/);
  assert.match(summary, /gh variable set AGENTDASH_TARGET_RUNNER_LABELS --repo thetangstr\/agentdash/);
  assert.match(summary, /gh variable set AGENTDASH_LAUNCH_SMOKE_BASE_URL --repo thetangstr\/agentdash/);
  assert.match(summary, /gh variable set AGENTDASH_LAUNCH_SMOKE_BILLING --repo thetangstr\/agentdash/);
  assert.match(summary, /gh variable set AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM --repo thetangstr\/agentdash/);
  assert.match(summary, /launch_smoke_base_url/);
  assert.match(summary, /target-runner-variable/);
  assert.match(summary, /stable-release-environment-protected/);
  assert.match(summary, /npm-stable/);
  assert.match(summary, /launch-smoke-billing-required/);
  assert.match(summary, /launch-smoke-llm-required/);
});

test("renders success guidance when automated config gates pass", () => {
  const result = auditProductionReadinessConfig({
    repository: "thetangstr/agentdash",
    checkedAt: "2026-05-18T10:00:00.000Z",
    variables: [
      { name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' },
      { name: "AGENTDASH_LAUNCH_SMOKE_BASE_URL", value: "https://agentdash.example.com" },
      { name: "AGENTDASH_LAUNCH_SMOKE_BILLING", value: "true" },
      { name: "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM", value: "true" },
    ],
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [{ type: "required_reviewers" }] },
    ],
  });

  const summary = renderProductionReadinessSummary(result);

  assert.equal(result.conclusion, "success");
  assert.match(summary, /All automated config requirements passed/);
  assert.doesNotMatch(summary, /Failed Requirement IDs/);
});
