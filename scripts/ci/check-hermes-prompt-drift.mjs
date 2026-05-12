#!/usr/bin/env node
/**
 * Hermes prompt drift check.
 *
 * docs/agents/hermes-prompt.md is the canonical, reviewable record of the
 * Hermes agent's operating directives. The frontmatter claims:
 *
 *   This file is synced to the agent's `capabilities` field in the Paperclip
 *   agents DB and to the `KANBAN_GUIDANCE` injected into every dispatched worker.
 *
 * Without enforcement, that claim is dead text — the file can diverge from
 * the actual runtime prompt with no signal. This script asserts that when
 * the prompt is edited in a PR, the corresponding runtime surface(s) are
 * also edited (or a bypass flag is present).
 *
 * Runtime surfaces that consume the prompt content (current best-known list,
 * extend as new sync targets land):
 *   - server/src/onboarding-assets/hermes/ — bundled SKILL.md for Hermes agents
 *   - server/src/services/agent-creator-from-proposal.ts — KANBAN_GUIDANCE injection
 *
 * Trigger: a PR touches docs/agents/hermes-prompt.md (any status).
 *
 * Rule: when triggered, the same diff MUST also touch at least one runtime
 * surface OR carry a `[no-runtime-sync]` bypass flag (case-insensitive) in
 * the PR title or body. Bypass is logged loudly.
 *
 * Inputs (env): BASE_SHA, HEAD_SHA, PR_TITLE, PR_BODY (mirrors check-agents-md-drift.mjs).
 *
 * Exit codes:
 *   0 — pass (no trigger / properly synced / bypassed)
 *   1 — fail (trigger fired, no runtime surface touched, no bypass)
 *   2 — usage / internal error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TRIGGER_FILE = "docs/agents/hermes-prompt.md";
const BYPASS_FLAG = "[no-runtime-sync]";

// Runtime surfaces that should be edited when the prompt changes.
// Add entries here as additional sync targets are introduced.
const RUNTIME_SURFACES = [
  /^server\/src\/onboarding-assets\/hermes\//,
  /^server\/src\/services\/agent-creator-from-proposal\.ts$/,
  // Catch-all for any future sync script the project adds.
  /^scripts\/sync-hermes-prompt\./,
];

function parseArgs(argv) {
  const args = { diffFile: null, title: null, body: null };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--diff") {
      args.diffFile = value;
      i += 1;
    } else if (flag === "--title") {
      args.title = value;
      i += 1;
    } else if (flag === "--body") {
      args.body = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: check-hermes-prompt-drift.mjs [--diff <file>] [--title <s>] [--body <s>]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

function readDiffFromFile(filePath) {
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: (parts[0] ?? "").trim().slice(0, 1), path: (parts.at(-1) ?? "").trim() };
    });
}

function readDiffFromGit(baseSha, headSha) {
  const out = execFileSync(
    "git",
    ["diff", "--name-status", `${baseSha}...${headSha}`],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: (parts[0] ?? "").trim().slice(0, 1), path: (parts.at(-1) ?? "").trim() };
    });
}

function isBypassed(title, body) {
  return `${title ?? ""}\n${body ?? ""}`.toLowerCase().includes(BYPASS_FLAG.toLowerCase());
}

function main() {
  const args = parseArgs(process.argv);
  const title = args.title ?? process.env.PR_TITLE ?? "";
  const body = args.body ?? process.env.PR_BODY ?? "";

  let diff;
  if (args.diffFile) {
    diff = readDiffFromFile(args.diffFile);
  } else {
    const baseSha = process.env.BASE_SHA;
    const headSha = process.env.HEAD_SHA;
    if (!baseSha || !headSha) {
      process.stderr.write("BASE_SHA and HEAD_SHA env vars required (or --diff)\n");
      process.exit(2);
    }
    diff = readDiffFromGit(baseSha, headSha);
  }

  // Trigger: does the diff touch the prompt?
  const promptTouched = diff.some(({ path: p }) => p === TRIGGER_FILE);
  if (!promptTouched) {
    process.stdout.write(
      "[hermes-prompt-drift] Prompt file not touched in this PR. Skipping.\n",
    );
    process.exit(0);
  }

  if (isBypassed(title, body)) {
    process.stdout.write(
      `[hermes-prompt-drift] BYPASSED via ${BYPASS_FLAG} in PR title/body. ` +
        `Prompt changed without runtime-surface sync. Logged for audit.\n`,
    );
    process.exit(0);
  }

  // Did the diff also touch a runtime surface?
  const runtimeTouched = diff.some(({ path: p }) =>
    RUNTIME_SURFACES.some((re) => re.test(p)),
  );

  if (runtimeTouched) {
    process.stdout.write(
      "[hermes-prompt-drift] PASS — prompt and runtime surface(s) updated together.\n",
    );
    process.exit(0);
  }

  process.stderr.write(
    `[hermes-prompt-drift] FAIL — ${TRIGGER_FILE} changed but no runtime surface was updated.\n` +
      `\n` +
      `The prompt is supposed to be synced to:\n` +
      `  • server/src/onboarding-assets/hermes/*\n` +
      `  • server/src/services/agent-creator-from-proposal.ts (KANBAN_GUIDANCE)\n` +
      `  • Any scripts/sync-hermes-prompt.* helper\n` +
      `\n` +
      `Without a corresponding edit, the runtime prompt diverges from the doc.\n` +
      `Either: (a) update the runtime surface in this PR, (b) add a sync script,\n` +
      `or (c) add \`${BYPASS_FLAG}\` to the PR title/body if the drift is intentional\n` +
      `(e.g. doc-only typo fix). Bypass is logged.\n`,
  );
  process.exit(1);
}

main();
