import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIssueBody,
  computeFailureSignature,
  inferAreaLabel,
  normalizeFailureText,
  selectFailure,
} from "./file-target-test-issue.mjs";

const failingSummary = {
  profile: "browser",
  requestedRef: "codex/example",
  commit: "abc1234",
  osDescription: "Darwin test-host 25.0 arm64",
  runnerName: "target-mac",
  nodeVersion: "v24.11.0",
  pnpmVersion: "9.15.4",
  workflowRunUrl: "https://github.com/thetangstr/agentdash/actions/runs/1",
  artifactName: "target-machine-test-browser-1",
  conclusion: "failure",
  failure: {
    commandName: "e2e",
    command: "pnpm run test:e2e",
    exitCode: 1,
    logPath: "/tmp/target-test/logs/e2e.log",
    firstFailure: "FAIL tests/e2e/onboarding.spec.ts > rejects duplicate setup",
    errorHead: "FAIL tests/e2e/onboarding.spec.ts > rejects duplicate setup\nExpected 200, received 409",
  },
};

test("normalizeFailureText removes volatile values", () => {
  assert.equal(
    normalizeFailureText("run 8f14e45f-ea7c-4c59-9f5e-583aa0011223 at 2026-05-16T10:00:01.123Z after 1234ms"),
    "run <uuid> at <timestamp> after <duration>",
  );
});

test("selectFailure reads the normalized failure object", () => {
  assert.deepEqual(selectFailure(failingSummary), failingSummary.failure);
});

test("computeFailureSignature is stable across volatile details", () => {
  const first = computeFailureSignature(failingSummary);
  const second = computeFailureSignature({
    ...failingSummary,
    failure: {
      ...failingSummary.failure,
      errorHead: `${failingSummary.failure.errorHead}\nrun 8f14e45f-ea7c-4c59-9f5e-583aa0011223 after 1234ms`,
    },
  });

  assert.equal(first, second);
});

test("buildIssueBody includes marker, reproduction, and artifact context", () => {
  const signature = computeFailureSignature(failingSummary);
  const body = buildIssueBody(failingSummary, signature);

  assert.match(body, new RegExp(`target-machine-test-signature:${signature}`));
  assert.match(body, /git checkout codex\/example/);
  assert.match(body, /target-machine-test-browser-1/);
  assert.match(body, /pnpm run test:e2e/);
});

test("inferAreaLabel maps browser failures to e2e", () => {
  assert.equal(inferAreaLabel(failingSummary), "e2e");
});
