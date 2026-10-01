#!/usr/bin/env node
// The public docs' content scan (doc/plans/2026-10-01-public-docs-section.md,
// "Content rules"). Two rules, over every page docs/docs.json lists — whether
// or not the build bundles it, so a page cannot dodge the scan by being
// denylisted today and un-denylisted tomorrow — plus docs/docs.json itself and
// the generated files the site ships:
//
//   1. No forbidden token. Customer, instance and people identifiers, hashed in
//      scripts/docs/forbidden-tokens.mjs (the one list; the UI test uses
//      it too). A hit is reported as file:line only — never the token.
//   2. No "Paperclip" outside code, except on the one page that explains the
//      fork. AgentDash is a fork of Paperclip; identifiers that still carry the
//      upstream name (`PAPERCLIP_API_KEY`, `X-Paperclip-Run-Id`, the
//      `paperclipai` CLI) are real and are written as code, which this allows.
//      The retired upstream org link (`paperclip-ai`) is refused everywhere.
//
// Usage: node scripts/ci/check-docs-forbidden-tokens.mjs [file ...]
//   With no arguments: the nav's pages, docs/docs.json and the shipped
//   generated files. With files: just those (repo-relative or absolute).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { navPageEntries } from "../docs/build-search-index.mjs";
import { forbiddenTokenOffsets } from "../docs/forbidden-tokens.mjs";

/** The one page allowed to name the upstream project in prose. */
export const FORK_PAGE = "docs/start/about-this-fork.md";

/** Shipped alongside the pages: the nav, the search index, the slug list, the OpenAPI file. */
export const SHIPPED_FILES = [
  "docs/docs.json",
  "ui/src/generated/docs-search-index.json",
  "ui/src/generated/docs-routes.json",
  "docs/api/openapi.yaml",
];

// "Paperclip" as a word of its own: not part of an identifier such as
// X-Paperclip-Run-Id, @paperclipai/shared or PAPERCLIP_API_KEY (case-sensitive).
const PROSE_NAME = /(?<![\w@./-])Paperclip(?![\w-])/g;
const UPSTREAM_ORG = /paperclip-ai/gi;

/** Every page file the nav lists, repo-relative, in nav order, once. Unresolved entries are reported. */
export function navFiles(repoRoot) {
  const config = JSON.parse(readFileSync(path.join(repoRoot, "docs", "docs.json"), "utf8"));
  const files = [];
  const missing = [];
  for (const slug of new Set(navPageEntries(config))) {
    const file = [`${slug}.md`, `${slug}.mdx`].find((candidate) => existsSync(path.join(repoRoot, "docs", candidate)));
    if (file) files.push(`docs/${file}`);
    else missing.push(slug);
  }
  return { files, missing };
}

/**
 * Markdown with every fenced block and inline code span blanked to spaces,
 * newlines kept — so offsets and line numbers still point at the source.
 */
export function maskCode(markdown) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  return markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank);
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Findings for one file's text: `{ line, rule }`, sorted by line. `rule` is
 * "token" or "paperclip"; neither carries the matched text.
 */
export function scanText(rel, text) {
  const findings = [];
  for (const offset of forbiddenTokenOffsets(text)) findings.push({ line: lineAt(text, offset), rule: "token" });
  if (rel !== FORK_PAGE) {
    const prose = /\.mdx?$/.test(rel) ? maskCode(text) : text;
    for (const match of prose.matchAll(PROSE_NAME)) findings.push({ line: lineAt(text, match.index), rule: "paperclip" });
    for (const match of text.matchAll(UPSTREAM_ORG)) findings.push({ line: lineAt(text, match.index), rule: "paperclip" });
  }
  const seen = new Set();
  return findings
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
    .filter((finding) => {
      const key = `${finding.line}:${finding.rule}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const MESSAGES = {
  token: "forbidden token (see scripts/docs/forbidden-tokens.mjs)",
  paperclip: `names the upstream project outside code — write AgentDash, put an identifier in backticks, or move the sentence to ${FORK_PAGE}`,
};

export function formatFinding(rel, finding) {
  return `${rel}:${finding.line}: ${MESSAGES[finding.rule]}`;
}

export function run(repoRoot, requested = []) {
  const problems = [];
  let targets;
  if (requested.length > 0) {
    targets = requested.map((file) => path.relative(repoRoot, path.resolve(repoRoot, file)));
  } else {
    const { files, missing } = navFiles(repoRoot);
    for (const slug of missing) problems.push(`docs/docs.json: lists ${slug}, which has no .md or .mdx file`);
    targets = [...files, ...SHIPPED_FILES];
  }
  let scanned = 0;
  for (const rel of targets) {
    const full = path.join(repoRoot, rel);
    if (!existsSync(full)) {
      problems.push(`${rel}: missing`);
      continue;
    }
    scanned += 1;
    for (const finding of scanText(rel, readFileSync(full, "utf8"))) problems.push(formatFinding(rel, finding));
  }
  return { scanned, problems };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { scanned, problems } = run(repoRoot, process.argv.slice(2));
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`\n${problems.length} problem(s) in the public docs (${scanned} files scanned).`);
    process.exit(1);
  }
  console.log(`Public docs content scan: ${scanned} files, no forbidden token, no "Paperclip" outside code or ${FORK_PAGE}.`);
}

// Entry guard: resolve symlinks on both sides, or a symlinked invocation
// silently skips main() (scripts/entry-guard.test.mjs; cf. #666).
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  main();
}
