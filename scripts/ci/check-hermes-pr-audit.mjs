#!/usr/bin/env node
/**
 * Hermes PR audit — enforces the directives in docs/agents/hermes-prompt.md.
 *
 * Mirrors the agents-md drift-check pattern. Runs on every PR; the audit
 * rules apply only when at least one commit in the PR is Hermes-authored
 * (commit author email matches the Hermes identity, or commit body carries
 * a `Co-Authored-By: Hermes` trailer). Manual / human PRs are a no-op.
 *
 * Failure modes enforced (each maps to a Hermes directive):
 *
 *   D1 (no dead code):
 *     - No "Copy this file to:" / "Then register in" / similar scaffolding
 *       strings in committed source files.
 *     - When a new file appears under server/src/routes/ matching *.ts (not
 *       test/spec), grep the diff for an import of its exported route
 *       function in server/src/app.ts. If absent, fail.
 *
 *   D2 (test gate on sensitive surfaces):
 *     - When the diff touches any sensitive path (access/auth/onboarding-
 *       orchestrator/adapters/requireTier/billing-cap), require at least
 *       one test file change in the same PR.
 *
 *   D4 (no regex node_modules patches; no absolute paths in patches):
 *     - Any new file under patches/ must use relative a/ b/ paths (no
 *       /Users/, /home/, /root/ in header).
 *
 *   D5 (PR + regression suite output):
 *     - PR body must contain a "## Regression suite" heading with non-empty
 *       content beneath it (mirrors the literal flow in hermes-prompt.md).
 *
 * Bypass: include `[skip-hermes-audit]` (case-insensitive) in PR title or body.
 * Bypass is logged loudly so it can't be used silently.
 *
 * Inputs (env):
 *   BASE_SHA                  base commit SHA   (required for diff mode)
 *   HEAD_SHA                  head commit SHA   (required for diff mode)
 *   PR_TITLE                  PR title          (optional)
 *   PR_BODY                   PR body           (optional)
 *
 * Inputs (CLI flags, for self-tests; override env):
 *   --diff <path>             read newline-separated `<status>\t<path>` from file
 *   --commits <path>          read newline-separated `<author-email>\t<body>` per commit
 *   --title <string>          override PR_TITLE
 *   --body <string>           override PR_BODY
 *
 * Exit codes:
 *   0 — pass (Hermes opt-out / not Hermes-authored / all rules satisfied)
 *   1 — fail (audit found a violation)
 *   2 — usage / internal error
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BYPASS_FLAG = "[skip-hermes-audit]";

// Commit signals for "this PR contains Hermes work."
// Match on either the author email or a Co-Authored-By trailer.
const HERMES_EMAIL_PATTERNS = [
  /hermes@/i,
  /@maxiaoers?-mini\.lan/i, // legacy Hermes hostname before identity fix
];
const HERMES_COAUTHOR_RE = /Co-Authored-By:\s*Hermes\b/i;

// Forbidden scaffolding strings (D1).
const SCAFFOLDING_PATTERNS = [
  /Copy this file to:/i,
  /Then register in app\.ts/i,
  /Then register in.*\.tsx?\b/i,
  /Paste this into.*\.ts/i,
];

// File globs that count as "source" (audited for scaffolding strings).
function isAuditedSource(filePath) {
  if (!filePath) return false;
  if (filePath.includes("__tests__/")) return false;
  if (/\.(test|spec)\.[jt]sx?$/i.test(filePath)) return false;
  return /^(server|ui|cli|packages)\/.*\.[jt]sx?$/.test(filePath);
}

// Sensitive surfaces (D2) — touching any of these requires a test diff.
const SENSITIVE_PATH_PATTERNS = [
  /^server\/src\/services\/access[^/]*\.ts$/,
  /^server\/src\/services\/access\//,
  /^server\/src\/middleware\/auth\.ts$/,
  /^server\/src\/auth\//,
  /^server\/src\/services\/onboarding-orchestrator\.ts$/,
  /^server\/src\/services\/cos-/,
  /^packages\/adapters\//,
  /^server\/src\/middleware\/require-tier\.ts$/,
  /^server\/src\/routes\/billing\.ts$/,
  /^server\/src\/services\/billing[^/]*\.ts$/,
  /^server\/src\/services\/entitlement-sync\.ts$/,
  /^server\/src\/services\/seat-quantity-syncer\.ts$/,
];

// New-route detection (D1 wire-up evidence).
function isNewRouteFile(status, filePath) {
  if (status !== "A") return false;
  if (!filePath) return false;
  if (filePath.includes("__tests__/")) return false;
  if (/\.(test|spec)\.[jt]sx?$/i.test(filePath)) return false;
  return /^server\/src\/routes\/[^/]+\.ts$/.test(filePath);
}

// Test diff detection (D2).
function isTestFile(filePath) {
  if (!filePath) return false;
  return (
    filePath.includes("__tests__/") ||
    /\.(test|spec)\.[jt]sx?$/i.test(filePath) ||
    /^tests\/e2e\//.test(filePath)
  );
}

// New patch file detection (D4).
function isNewPatchFile(status, filePath) {
  if (status !== "A") return false;
  return /^patches\/.+\.patch$/.test(filePath ?? "");
}

// ---------------------------------------------------------------------------
// CLI / env arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { diffFile: null, commitsFile: null, title: null, body: null };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--diff") {
      args.diffFile = value;
      i += 1;
    } else if (flag === "--commits") {
      args.commitsFile = value;
      i += 1;
    } else if (flag === "--title") {
      args.title = value;
      i += 1;
    } else if (flag === "--body") {
      args.body = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: check-hermes-pr-audit.mjs [--diff <file>] [--commits <file>] [--title <s>] [--body <s>]\n",
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
      const [status, ...rest] = line.split("\t");
      return { status: (status ?? "").trim(), path: rest.join("\t").trim() };
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
      // git diff --name-status output: "A\tpath" / "M\tpath" / "R100\told\tnew"
      const parts = line.split("\t");
      const status = (parts[0] ?? "").trim().slice(0, 1); // R100 → R
      const path = (parts[parts.length - 1] ?? "").trim();
      return { status, path };
    });
}

function readCommitsFromFile(filePath) {
  const raw = readFileSync(filePath, "utf8");
  // Format: <author-email>\t<body>  (body may contain literal \n which we keep)
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, ...rest] = line.split("\t");
      return { authorEmail: (email ?? "").trim(), body: rest.join("\t") };
    });
}

function readCommitsFromGit(baseSha, headSha) {
  // Get one record per commit in BASE..HEAD: author-email + full body.
  const sep = "<<<HERMES_AUDIT_SEP>>>";
  const out = execFileSync(
    "git",
    ["log", `${baseSha}..${headSha}`, `--format=%H%x09%ae%x09%B${sep}`],
    { encoding: "utf8" },
  );
  return out
    .split(sep)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [headerLine, ...bodyLines] = chunk.split("\n");
      const [, email] = (headerLine ?? "").split("\t");
      return { authorEmail: (email ?? "").trim(), body: bodyLines.join("\n") };
    });
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function hasHermesCommit(commits) {
  return commits.some((c) => {
    if (HERMES_EMAIL_PATTERNS.some((re) => re.test(c.authorEmail))) return true;
    if (HERMES_COAUTHOR_RE.test(c.body)) return true;
    return false;
  });
}

function isBypassed(title, body) {
  const haystack = `${title ?? ""}\n${body ?? ""}`.toLowerCase();
  return haystack.includes(BYPASS_FLAG.toLowerCase());
}

function readWorkingTreeFile(filePath) {
  // Best-effort. In CI we run from the PR head checkout; the file exists.
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function checkScaffoldingStrings(diff) {
  const failures = [];
  for (const { status, path: p } of diff) {
    if (status === "D") continue;
    if (!isAuditedSource(p)) continue;
    const content = readWorkingTreeFile(p);
    if (content == null) continue;
    for (const re of SCAFFOLDING_PATTERNS) {
      if (re.test(content)) {
        failures.push(
          `  - ${p}: contains scaffolding text matching ${re.toString()}`,
        );
        break;
      }
    }
  }
  return failures;
}

function checkNewRouteWireUp(diff) {
  const failures = [];
  const newRoutes = diff.filter(({ status, path: p }) => isNewRouteFile(status, p));
  if (newRoutes.length === 0) return failures;

  const appTs = readWorkingTreeFile("server/src/app.ts") ?? "";
  for (const { path: p } of newRoutes) {
    // Derive the exported route fn name from the file path:
    //   server/src/routes/agent-research.ts → agentResearchRoutes (heuristic)
    // We don't know the actual export name, so we grep for the bare module name
    // (post-import path) AND for any "Routes" function call. If neither
    // appears in app.ts, flag.
    const moduleName = path.basename(p, ".ts"); // "agent-research"
    const moduleImportFragment = `routes/${moduleName}`;
    const routesFnHeuristic = moduleName.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "Routes";

    const importMatches = appTs.includes(moduleImportFragment);
    const callMatches = appTs.includes(routesFnHeuristic);
    if (!importMatches && !callMatches) {
      failures.push(
        `  - ${p}: new route file added but no reference to "${moduleImportFragment}" or "${routesFnHeuristic}" in server/src/app.ts`,
      );
    }
  }
  return failures;
}

function checkSensitiveSurfaceTests(diff) {
  const touchedSensitive = diff.filter(({ status, path: p }) => {
    if (status === "D") return false;
    return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
  });
  if (touchedSensitive.length === 0) return [];

  const hasTestDiff = diff.some(({ path: p }) => isTestFile(p));
  if (hasTestDiff) return [];

  return [
    `  - Sensitive paths touched without any test file in the same PR:`,
    ...touchedSensitive.map(({ path: p }) => `      • ${p}`),
    `    Add a test under __tests__/ or tests/e2e/.`,
  ];
}

function checkPatchAbsolutePaths(diff) {
  const failures = [];
  const newPatches = diff.filter(({ status, path: p }) => isNewPatchFile(status, p));
  for (const { path: p } of newPatches) {
    const content = readWorkingTreeFile(p);
    if (content == null) continue;
    // Only inspect lines that start with "---" or "+++" (diff headers).
    const badLines = content
      .split("\n")
      .filter((line) => /^(\+\+\+|---)\s/.test(line))
      .filter((line) => /\s(\/Users\/|\/home\/|\/root\/)/.test(line));
    if (badLines.length > 0) {
      failures.push(
        `  - ${p}: patch header contains absolute developer-local path:`,
        ...badLines.map((line) => `      ${line}`),
        `    Regenerate via \`pnpm patch <pkg> --edit-dir /tmp/<dir>\` so headers use relative a/ b/ paths.`,
      );
    }
  }
  return failures;
}

function checkRegressionSuiteSection(body) {
  const text = body ?? "";
  // Locate a heading like "## Regression suite" (any level >= 2). Then capture
  // everything from the line AFTER the heading up to (but not including) the
  // next ^##+ heading, OR end of input. JS regex has no \Z, so we split on the
  // heading and inspect the trailing section explicitly.
  const headingRe = /^[ \t]*#{2,}[ \t]*Regression[ \t]+suite[ \t]*$/im;
  const headingMatch = text.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) {
    return [
      `  - PR body has no "## Regression suite" heading.`,
      `    Add the heading with the tail of \`pnpm -r typecheck && pnpm test:run && pnpm build\`.`,
    ];
  }
  // After the heading line, find the next ^##+ heading (if any).
  const after = text.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = after.match(/^[ \t]*#{2,}[ \t]+\S/m);
  const section = (nextHeading && nextHeading.index !== undefined
    ? after.slice(0, nextHeading.index)
    : after
  ).trim();
  if (section.length < 40) {
    return [
      `  - "## Regression suite" heading found but content is too short (${section.length} chars).`,
      `    Paste the tail of each of typecheck / test:run / build.`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const title = args.title ?? process.env.PR_TITLE ?? "";
  const body = args.body ?? process.env.PR_BODY ?? "";

  let diff;
  let commits;
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

  if (args.commitsFile) {
    commits = readCommitsFromFile(args.commitsFile);
  } else if (process.env.BASE_SHA && process.env.HEAD_SHA) {
    commits = readCommitsFromGit(process.env.BASE_SHA, process.env.HEAD_SHA);
  } else {
    commits = [];
  }

  // Bypass — log loudly.
  if (isBypassed(title, body)) {
    process.stdout.write(
      `[hermes-audit] BYPASSED via ${BYPASS_FLAG} in PR title/body. Skipping audit.\n`,
    );
    process.exit(0);
  }

  // Only audit when at least one commit is Hermes-authored.
  if (!hasHermesCommit(commits)) {
    process.stdout.write(
      "[hermes-audit] No Hermes-authored commits in this PR. Skipping audit.\n",
    );
    process.exit(0);
  }

  process.stdout.write(
    `[hermes-audit] Hermes commits detected in PR. Running audit on ${diff.length} changed paths.\n`,
  );

  const allFailures = [];

  const scaffolding = checkScaffoldingStrings(diff);
  if (scaffolding.length > 0) {
    allFailures.push(
      "D1: scaffolding text found in committed source (forbidden by Hermes directive 1):",
      ...scaffolding,
    );
  }

  const wireUp = checkNewRouteWireUp(diff);
  if (wireUp.length > 0) {
    allFailures.push(
      "D1: new route file(s) added but not wired into server/src/app.ts:",
      ...wireUp,
    );
  }

  const sensitive = checkSensitiveSurfaceTests(diff);
  if (sensitive.length > 0) {
    allFailures.push(
      "D2: sensitive surface touched without test diff:",
      ...sensitive,
    );
  }

  const patchPaths = checkPatchAbsolutePaths(diff);
  if (patchPaths.length > 0) {
    allFailures.push(
      "D4: patch file contains absolute developer-local path:",
      ...patchPaths,
    );
  }

  const regression = checkRegressionSuiteSection(body);
  if (regression.length > 0) {
    allFailures.push(
      "D5: PR body missing regression-suite output:",
      ...regression,
    );
  }

  if (allFailures.length > 0) {
    process.stderr.write(
      "[hermes-audit] FAIL — one or more directives violated:\n",
    );
    for (const line of allFailures) {
      process.stderr.write(`${line}\n`);
    }
    process.stderr.write(
      `\nSee docs/agents/hermes-prompt.md for the full directive list.\n` +
        `If this audit blocks a legitimate PR (e.g. a one-off prompt fix), add ` +
        `\`${BYPASS_FLAG}\` to the PR title or body. Bypass is logged.\n`,
    );
    process.exit(1);
  }

  process.stdout.write("[hermes-audit] PASS — all Hermes directives satisfied.\n");
  process.exit(0);
}

main();
