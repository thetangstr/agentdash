#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { validatePullRequestBody } from "./check-pr-process.mjs";

const VALID_BODY = `## Thinking Path

> - Paperclip is a control plane for autonomous AI companies.
> - Pull requests are the main review surface for code and process changes.
> - AgentDash needs fork-specific metadata so reviewers can catch upstream and prompt-surface risks.
> - This pull request adds an enforceable PR process check.
> - The benefit is consistent review context before expensive CI runs.

## What Changed

- Added a PR metadata validator.
- Wired the validator into policy CI.

## Verification

- node --test scripts/ci/check-pr-process.test.mjs

## Risks

- Low risk; this only changes PR validation and documentation. See [policy docs](./CONTRIBUTING.md).

## AgentDash Review

- **Upstream impact:** None - this is fork-local process enforcement.
- **Agent-facing prompt surfaces:** None - no agent behavior changes.
- **AgentDash-owned subsystem:** PR process and CI policy.

## Model Used

- Provider: OpenAI
- Model: GPT-5.5
- Context window: repo-local context
- Reasoning mode: high
- Tool use: shell and file edits

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have filled out AgentDash fork-safety review fields
`;

test("accepts a complete PR body with AgentDash fork-safety metadata", () => {
  const result = validatePullRequestBody(VALID_BODY);

  assert.deepEqual(result.errors, []);
});

test("rejects missing required sections", () => {
  const result = validatePullRequestBody(
    VALID_BODY.replace("## Model Used", "## Model"),
  );

  assert.match(result.errors.join("\n"), /Missing required section: Model Used/);
});

test("rejects template placeholders left in the thinking path", () => {
  const result = validatePullRequestBody(
    VALID_BODY.replace(
      "> - Pull requests are the main review surface for code and process changes.",
      "> - [Which subsystem or capability is involved]",
    ),
  );

  assert.match(result.errors.join("\n"), /Thinking Path.*placeholder/i);
});

test("rejects empty bullet sections", () => {
  const result = validatePullRequestBody(
    VALID_BODY.replace(
      "## Verification\n\n- node --test scripts/ci/check-pr-process.test.mjs",
      "## Verification\n\n-",
    ),
  );

  assert.match(result.errors.join("\n"), /Verification.*non-placeholder content/);
});

test("requires all AgentDash Review fields to include a reason", () => {
  const result = validatePullRequestBody(
    VALID_BODY.replace(
      "- **Agent-facing prompt surfaces:** None - no agent behavior changes.",
      "- **Agent-facing prompt surfaces:** None",
    ),
  );

  assert.match(
    result.errors.join("\n"),
    /AgentDash Review.*Agent-facing prompt surfaces/i,
  );
});
