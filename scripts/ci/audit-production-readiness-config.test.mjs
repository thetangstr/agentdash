import assert from "node:assert/strict";
import test from "node:test";

import { auditProductionReadinessConfig } from "./audit-production-readiness-config.mjs";

test("fails when target runner config is absent", () => {
  const result = auditProductionReadinessConfig({
    repository: "thetangstr/agentdash",
    variables: [],
    runners: [],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [] },
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
    repositorySecretCount: 0,
    repositoryVariableCount: 0,
    selfHostedRunnerCount: 0,
  });
});

test("fails when target runner labels point at GitHub-hosted runners", () => {
  const result = auditProductionReadinessConfig({
    variables: [{ name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["ubuntu-latest"]' }],
    runners: [],
    environments: [
      { name: "npm-canary", protection_rules: [] },
      { name: "npm-stable", protection_rules: [] },
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

  assert.equal(result.conclusion, "success");
  assert.equal(
    result.requirements.find((item) => item.id === "target-runner-available").status,
    "pass",
  );
});

test("passes when a matching self-hosted target runner is online and idle", () => {
  const result = auditProductionReadinessConfig({
    variables: [{ name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' }],
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

test("fails when release environments are missing", () => {
  const result = auditProductionReadinessConfig({
    variables: [{ name: "AGENTDASH_TARGET_RUNNER_LABELS", value: '["self-hosted","agentdash-target"]' }],
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
