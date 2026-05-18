import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTargetRunnerPreflight,
  isGitHubHostedLabelSet,
  parseRunnerLabels,
} from "./target-runner-preflight.mjs";

test("parses runner labels from JSON arrays", () => {
  assert.deepEqual(parseRunnerLabels('["self-hosted"," agentdash-target "]'), ["self-hosted", "agentdash-target"]);
  assert.deepEqual(parseRunnerLabels("not json"), []);
  assert.deepEqual(parseRunnerLabels('{"label":"self-hosted"}'), []);
});

test("recognizes GitHub-hosted single-label runners", () => {
  assert.equal(isGitHubHostedLabelSet(["ubuntu-latest"]), true);
  assert.equal(isGitHubHostedLabelSet(["macos-15"]), true);
  assert.equal(isGitHubHostedLabelSet(["self-hosted", "agentdash-target"]), false);
});

test("passes through GitHub-hosted runner labels without inventory", () => {
  const result = evaluateTargetRunnerPreflight({
    requestedLabels: '["ubuntu-latest"]',
  });

  assert.equal(result.conclusion, "success");
  assert.equal(result.preflightFailed, false);
  assert.deepEqual(result.runnerLabels, ["ubuntu-latest"]);
});

test("fails fast onto fallback labels when self-hosted inventory is unreadable", () => {
  const result = evaluateTargetRunnerPreflight({
    requestedLabels: '["self-hosted","agentdash-target"]',
    fallbackLabels: '["ubuntu-latest"]',
    runnerInventoryError: "HTTP 403: Resource not accessible by integration",
  });

  assert.equal(result.conclusion, "failure");
  assert.equal(result.preflightFailed, true);
  assert.deepEqual(result.runnerLabels, ["ubuntu-latest"]);
  assert.match(result.failure.firstFailure, /Could not inspect self-hosted target runner inventory/);
});

test("fails fast when configured self-hosted labels have no matching runner", () => {
  const result = evaluateTargetRunnerPreflight({
    requestedLabels: '["self-hosted","agentdash-target"]',
    runners: [
      {
        name: "builder",
        status: "online",
        busy: false,
        labels: ["self-hosted", "linux", "builder"],
      },
    ],
  });

  assert.equal(result.conclusion, "failure");
  assert.equal(result.preflightFailed, true);
  assert.deepEqual(result.runnerLabels, ["ubuntu-latest"]);
  assert.match(result.failure.firstFailure, /No self-hosted runner advertises labels/);
});

test("fails fast when matching self-hosted runners are offline", () => {
  const result = evaluateTargetRunnerPreflight({
    requestedLabels: '["self-hosted","agentdash-target"]',
    runners: [
      {
        name: "target-mac",
        status: "offline",
        busy: false,
        labels: ["self-hosted", "agentdash-target"],
      },
    ],
  });

  assert.equal(result.conclusion, "failure");
  assert.equal(result.preflightFailed, true);
  assert.match(result.failure.firstFailure, /none is online/);
});

test("uses configured self-hosted labels when a matching runner is online", () => {
  const result = evaluateTargetRunnerPreflight({
    requestedLabels: '["self-hosted","agentdash-target"]',
    runners: [
      {
        name: "target-mac",
        status: "online",
        busy: true,
        labels: ["self-hosted", "macOS", "agentdash-target"],
      },
    ],
  });

  assert.equal(result.conclusion, "success");
  assert.equal(result.preflightFailed, false);
  assert.deepEqual(result.runnerLabels, ["self-hosted", "agentdash-target"]);
  assert.equal(result.evidence.matchingRunners[0].name, "target-mac");
});
