#!/usr/bin/env node
/**
 * Enforces the "agent-facing feature convention" documented in repo-root
 * AGENTS.md (`AgentDash Fork: Adding Agent-Facing Features`).
 *
 * Trigger: a PR adds NEW files (git status A) under any of:
 *   - server/src/routes/**.ts          (excluding *.test.ts / *.spec.ts)
 *   - server/src/services/**.ts        (excluding *.test.ts / *.spec.ts)
 *   - packages/db/src/schema/**.ts     (excluding index.ts and *.test.ts / *.spec.ts)
 *
 * Rule: when triggered, the same diff MUST also touch (any status: A/M/D/R) at
 * least one of the four prompt surfaces:
 *   - server/src/onboarding-assets/default/AGENTS.md
 *   - server/src/onboarding-assets/ceo/AGENTS.md
 *   - server/src/onboarding-assets/chief_of_staff/AGENTS.md
 *   - server/src/services/agent-creator-from-proposal.ts
 *
 * Bypass: include `[no-prompt-update]` (case-insensitive) in the PR title or body.
 *
 * Inputs (env):
 *   BASE_SHA                  base commit SHA  (required for "diff" mode)
 *   HEAD_SHA                  head commit SHA  (required for "diff" mode)
 *   PR_TITLE                  PR title         (optional)
 *   PR_BODY                   PR body          (optional)
 *
 * Inputs (CLI flags, override env — used by local self-tests):
 *   --diff <path>             read newline-separated `<status>\t<path>` lines
 *                             from the file instead of running git diff
 *   --title <string>          override PR_TITLE
 *   --body <string>           override PR_BODY
 *
 * Exit codes:
 *   0 — pass (no trigger / opted out / properly updated)
 *   1 — fail (trigger fired, no prompt surface touched, no bypass flag)
 *   2 — usage / internal error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BYPASS_FLAG = "[no-prompt-update]";

const PROMPT_SURFACES = [
  "server/src/onboarding-assets/default/AGENTS.md",
  "server/src/onboarding-assets/ceo/AGENTS.md",
  "server/src/onboarding-assets/chief_of_staff/AGENTS.md",
  "server/src/services/agent-creator-from-proposal.ts",
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
        "Usage: check-agents-md-drift.mjs [--diff <file>] [--title <s>] [--body <s>]\n",
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
    .filter((line) => line.length > 0);
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
    .filter((line) => line.length > 0);
}

/**
 * Parse a `git diff --name-status` line.
 * Statuses: A (added), M (modified), D (deleted), R### (renamed), C### (copied).
 * Renames/copies emit two paths; we treat the second (destination) path as the
 * affected file. For status A/M/D there's only one path.
 */
function parseDiffLine(line) {
  const parts = line.split(/\t/);
  if (parts.length < 2) return null;
  const status = parts[0];
  const path = parts[parts.length - 1];
  return { status, path };
}

function isTestFile(p) {
  return /\.(test|spec)\.[mc]?[tj]sx?$/.test(p);
}

function isAgentFacingTrigger(entry) {
  if (!entry || entry.status[0] !== "A") return false;
  const p = entry.path;
  if (!p.endsWith(".ts")) return false;
  if (isTestFile(p)) return false;

  if (p.startsWith("server/src/routes/")) return true;
  if (p.startsWith("server/src/services/")) {
    // Don't treat the agent-creator-from-proposal.ts file itself as a trigger
    // when newly added — it's a prompt surface, not a generic service.
    if (p === "server/src/services/agent-creator-from-proposal.ts") return false;
    return true;
  }
  if (p.startsWith("packages/db/src/schema/")) {
    if (p === "packages/db/src/schema/index.ts") return false;
    return true;
  }
  return false;
}

function isPromptSurfaceTouch(entry) {
  if (!entry) return false;
  return PROMPT_SURFACES.includes(entry.path);
}

function hasBypassFlag(title, body) {
  const haystack = `${title || ""}\n${body || ""}`.toLowerCase();
  return haystack.includes(BYPASS_FLAG.toLowerCase());
}

function formatList(items) {
  return items.map((p) => `  - ${p}`).join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const title = args.title ?? process.env.PR_TITLE ?? "";
  const body = args.body ?? process.env.PR_BODY ?? "";

  let diffLines;
  if (args.diffFile) {
    diffLines = readDiffFromFile(args.diffFile);
  } else {
    const baseSha = process.env.BASE_SHA;
    const headSha = process.env.HEAD_SHA;
    if (!baseSha || !headSha) {
      process.stderr.write(
        "BASE_SHA and HEAD_SHA env vars are required when --diff is not provided.\n",
      );
      process.exit(2);
    }
    diffLines = readDiffFromGit(baseSha, headSha);
  }

  const entries = diffLines
    .map(parseDiffLine)
    .filter((e) => e !== null);

  const triggers = entries.filter(isAgentFacingTrigger).map((e) => e.path);
  const promptTouched = entries.some(isPromptSurfaceTouch);

  if (triggers.length === 0) {
    process.stdout.write(
      "Agent-facing feature check passed (no trigger files in diff).\n",
    );
    process.exit(0);
  }

  if (hasBypassFlag(title, body)) {
    process.stdout.write(
      `Agent-facing feature check passed (bypass flag '${BYPASS_FLAG}' present in PR title/body).\n` +
        `Trigger files detected:\n${formatList(triggers)}\n`,
    );
    process.exit(0);
  }

  if (promptTouched) {
    process.stdout.write(
      `Agent-facing feature check passed (trigger files detected, prompt surfaces updated).\n` +
        `Trigger files:\n${formatList(triggers)}\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    [
      "Agent-facing feature check FAILED.",
      "",
      "This PR adds new files that look like agent-facing infrastructure:",
      formatList(triggers),
      "",
      "But it does not update any of the four agent prompt surfaces:",
      formatList(PROMPT_SURFACES),
      "",
      "When AgentDash adds a feature that requires agent behavior changes —",
      "new endpoints, state transitions, gates, failure modes — every agent",
      "must learn about it regardless of adapter. Update the four prompt",
      "surfaces above (or touch them with an explanatory comment if the new",
      "behavior genuinely doesn't apply).",
      "",
      `If the change truly does not need a prompt update, include '${BYPASS_FLAG}'`,
      "(case-insensitive) in the PR title or body to bypass this check.",
      "",
      "See repo-root AGENTS.md (`AgentDash Fork: Adding Agent-Facing Features`)",
      "for the full convention.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

main();
