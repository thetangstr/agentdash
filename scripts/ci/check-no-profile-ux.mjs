#!/usr/bin/env node
// AgentDash CI guard: one UX for every company (doc/plans/2026-09-30-one-ux.md).
//
// The UI must not branch on the company's product profile. This fails when a
// non-test source file under ui/src mentions `productProfile` or
// `agentdash_mk`, unless the file is on scripts/ci/profile-ux-allowlist.json.
// The allowlist records the files that still branched when the rule landed;
// it must only shrink. When a base ref is available (CI checks out full
// history), a file on this branch's allowlist that is not on the base
// branch's allowlist fails the check too — so the list cannot quietly grow.
//
// Server-side capability gates are fine and live in server/, via
// requireProductProfile; this guard only reads ui/src.
//
// Usage: node scripts/ci/check-no-profile-ux.mjs [--root <repo>] [--allowlist <file>] [--base <git-ref>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PATTERN = /productProfile|agentdash_mk/;
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ALLOWLIST_REL = "scripts/ci/profile-ux-allowlist.json";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--root" || key === "--allowlist" || key === "--base") {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

export function isTestFile(rel) {
  const base = path.basename(rel);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    rel.split("/").some((part) => part === "__tests__" || part === "__mocks__")
  );
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.has(path.extname(entry))) out.push(full);
  }
  return out;
}

export function parseAllowlist(text) {
  const parsed = JSON.parse(text);
  const files = Array.isArray(parsed) ? parsed : parsed.files;
  if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) {
    throw new Error(`${ALLOWLIST_REL} must be an array of paths, or an object with a "files" array`);
  }
  return files;
}

/** Offending files (repo-relative, posix) under ui/src that are not allowlisted. */
export function scan(root, allowlist) {
  const uiSrc = path.join(root, "ui", "src");
  const allowed = new Set(allowlist);
  const offenders = [];
  const matched = new Set();
  if (!existsSync(uiSrc)) return { offenders, stale: [...allowed] };
  for (const full of walk(uiSrc, [])) {
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (isTestFile(rel)) continue;
    const lines = readFileSync(full, "utf8").split("\n");
    const hits = [];
    lines.forEach((line, i) => {
      if (PATTERN.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
    if (hits.length === 0) continue;
    matched.add(rel);
    if (!allowed.has(rel)) offenders.push(...hits);
  }
  const stale = [...allowed].filter((rel) => !matched.has(rel));
  return { offenders, stale };
}

/** Allowlist entries on this branch that the base branch's allowlist lacks. */
export function grownEntries(current, base) {
  const baseSet = new Set(base);
  return current.filter((rel) => !baseSet.has(rel));
}

function readBaseAllowlist(root, ref) {
  try {
    const text = execFileSync("git", ["show", `${ref}:${ALLOWLIST_REL}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseAllowlist(text);
  } catch {
    return null; // no base ref, or the allowlist is new on this branch
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root ?? process.cwd());
  const allowlistPath = path.resolve(root, args.allowlist ?? ALLOWLIST_REL);
  const allowlist = parseAllowlist(readFileSync(allowlistPath, "utf8"));
  const { offenders, stale } = scan(root, allowlist);

  const baseRef =
    args.base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
  const base = readBaseAllowlist(root, baseRef);
  const grown = base ? grownEntries(allowlist, base) : [];

  let failed = false;
  if (offenders.length > 0) {
    failed = true;
    process.stderr.write(
      "The UI must not branch on the product profile (doc/plans/2026-09-30-one-ux.md).\n" +
        "Remove these productProfile / agentdash_mk references from ui/src; gate the\n" +
        "capability on the server with requireProductProfile instead:\n\n" +
        offenders.map((o) => `  - ${o}`).join("\n") +
        "\n",
    );
  }
  if (grown.length > 0) {
    failed = true;
    process.stderr.write(
      `\n${ALLOWLIST_REL} must only shrink. These entries are not on ${baseRef}:\n\n` +
        grown.map((g) => `  - ${g}`).join("\n") +
        "\n",
    );
  }
  if (stale.length > 0) {
    // Not a failure: parallel PRs clear files independently. It is a nudge to
    // shrink the list in the PR that cleared them.
    process.stdout.write(
      `Note: these allowlisted files no longer mention the profile; remove them from ${ALLOWLIST_REL}:\n` +
        stale.map((s) => `  - ${s}`).join("\n") +
        "\n",
    );
  }
  if (failed) process.exit(1);
  process.stdout.write(
    `No profile-driven UX outside the allowlist (${allowlist.length} allowlisted file${allowlist.length === 1 ? "" : "s"}).\n`,
  );
}

// Compare realpaths: a plain comparison silently skips main() when run through a symlink.
const invokedDirectly = (() => {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main();
}
