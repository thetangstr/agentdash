#!/usr/bin/env node
// Generate docs/api/changelog.md: the API-affecting lines of the release notes
// (doc/plans/2026-10-01-public-docs-section.md, PR 3b).
//
// Reads releases/v*.md, newest first, with the same rules the in-app
// Changelog uses (ui/src/lib/release-notes.ts — not importable here, it reads
// the notes through Vite's import.meta.glob, so its few regexes are ported
// below): the version is the `# ` line, the date is the leading YYYY-MM-DD of
// `> Released:`, a `> Withdrawn, never released` note is skipped. Notes marked
// `> Upstream:` describe releases of the project AgentDash was forked from,
// not AgentDash releases, and are skipped too.
//
// A "line" is one bullet of a note, at any depth, with its wrapped
// continuation lines. A line is kept when it names:
//   - an HTTP path: `/api/…`, or a method and a path (`POST /issues/:id/…`);
//   - a contract operationId (docs/api/contract.json);
//   - an HTTP status code;
//   - a header (`X-…`, `Authorization`, `WWW-Authenticate`, `Retry-After`,
//     `x-agent-key`, `Bearer`);
//   - a validator (`…Schema`);
//   - or one of the words route, endpoint, API, OpenAPI, contract.
// Every line of a section whose heading says Deprecated, Breaking or Removed
// (or Behaviour Change, the heading earlier notes used) is kept, because the
// versioning policy (docs/api/versioning.md) announces breaking changes there.
// Lines under Tests, Testing, Validation and Contributors are skipped: they
// describe the test suite, not the API. Bulleted and numbered items both count.
//
// The output is a public page and the notes are not written for one, so the
// same rule the route index applies to route files applies here to lines: a
// line that names the private product profile, the engagement, a customer or
// instance, or the upstream project is dropped and counted, by reason, in the
// page header.
// ui/src/lib/docs.test.ts scans the committed page for the hashed forbidden
// tokens like every other bundled page.
//
// The page is committed. scripts/ci/check-api-reference-drift.mjs regenerates
// it and fails when the committed copy differs, exactly as for the OpenAPI
// document. Dependency-free (node builtins only): it runs in the PR workflow's
// policy job, which has no install.
//
// Usage: node scripts/docs/generate-api-changelog.mjs [--check]

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API_CHANGELOG_REL = "docs/api/changelog.md";
const RELEASES_DIR_REL = "releases";
const CONTRACT_REL = "docs/api/contract.json";

/**
 * Why a line is withheld, checked in order; the first match is the reason the
 * header counts. Word-bounded where the token is short enough to sit inside an
 * ordinary word.
 */
export const WITHHELD_LINE_RULES = [
  { reason: "naming the private product profile", pattern: /agentdash[\s_-]?mk|(?<![a-z0-9])mk(?![a-z0-9])/i },
  { reason: "engagement-specific", pattern: /\bross\b/i },
  { reason: "naming a customer or instance", pattern: /mkthink|mkboard|mkmini/i },
  // The public pages name the upstream project on one page only (the plan's
  // content rules). A literal `X-Paperclip-…` header or `PAPERCLIP_…` variable
  // is an interface name and stays; any other spelling is withheld.
  { reason: "naming the upstream project", pattern: { test: (text) => /paperclip/i.test(stripInterfaceNames(text)) } },
];

/**
 * Section headings whose every line is kept: the policy's headings, and the
 * "Behaviour Change" headings earlier notes used for the same purpose.
 */
const ALWAYS_KEEP_SECTION = /deprecat|breaking|removed|behaviou?r change/i;
/** Section headings whose lines are never considered. */
const SKIP_SECTION = /^(tests?|testing|validation|contributors)\b/i;

/** The header and variable names that legitimately carry the upstream name. */
function stripInterfaceNames(text) {
  return text.replace(/\bX-Paperclip(?:-[A-Za-z0-9]+)+\b/gi, "").replace(/\bPAPERCLIP_[A-Z0-9_]+\b/g, "");
}

const STATUS_CODES = [200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 428, 429, 500, 501, 502, 503, 504];
// Not after `#` (a PR number), a digit, a letter, `.` or `,` (a version or a count like 1,404), `/` or `-`.
const STATUS_RE = new RegExp(`(?<![#\\w.,/-])(?:${STATUS_CODES.join("|")})(?![\\w%]|[.,]\\d)`);
const API_PATH_RE = /\/api(?:\/|\b)/;
const METHOD_PATH_RE = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+`?\//;
const HEADER_RE = /\bX-[A-Za-z][A-Za-z0-9-]*\b|\bWWW-Authenticate\b|\bAuthorization\b|\bRetry-After\b|\bx-agent-key\b|\bBearer\b/;
const VALIDATOR_RE = /\b[a-z][A-Za-z0-9]*Schema\b/;
// `API` is case-sensitive on its own (so "rapid" never matches); the rest are not.
const API_WORD_CASED = /\bAPIs?\b|\bOpenAPI\b/;
const OTHER_WORDS = /\b(?:routes?|endpoints?|contract)\b/i;

// ---------------------------------------------------------------------------
// Parsing (ported from ui/src/lib/release-notes.ts)
// ---------------------------------------------------------------------------

export function parseReleasedDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})\b/.exec(value.trim());
  if (!match) return null;
  return Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) ? null : match[1];
}

function versionParts(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

/** Newest first: release date, then version — as compareReleaseNotes. */
export function compareReleases(a, b) {
  const dateA = a.releasedAt ? Date.parse(`${a.releasedAt}T00:00:00Z`) : 0;
  const dateB = b.releasedAt ? Date.parse(`${b.releasedAt}T00:00:00Z`) : 0;
  if (dateA !== dateB) return dateB - dateA;
  const pa = versionParts(a.version);
  const pb = versionParts(b.version);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

/** Links to their text; bold and code are kept, they render on the page. */
export function cleanLine(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // PR attribution names a person: "(#531, @someone)" → "(#531)".
    .replace(/,\s*@[A-Za-z0-9-]+(?=[,)])/g, "")
    .replace(/\s*\(@[A-Za-z0-9-]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A note's bullets, at any depth, each with the section it is under and the
 * bold lead of its parent bullet (so a kept sub-bullet still says what it is
 * about).
 */
export function parseRelease(markdown) {
  const lines = markdown.split(/\r?\n/);
  const version = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() ?? "Unversioned";
  const releasedLine = lines.find((line) => /^>\s*Released:/i.test(line));
  const releasedAt = releasedLine ? parseReleasedDate(releasedLine.replace(/^>\s*Released:\s*/i, "")) : null;
  const withdrawn = lines.some((line) => /^>\s*Withdrawn, never released/i.test(line));
  const upstream = lines.some((line) => /^>\s*Upstream:/i.test(line));

  const items = [];
  let section = null;
  let current = null;
  let fence = false;
  const stack = []; // { indent, item }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      current = null;
      continue;
    }
    if (fence) continue;
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      current = null;
      stack.length = 0;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      current = null;
      continue;
    }
    const bullet = /^(\s*)(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet && section) {
      const indent = bullet[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1].item : null;
      current = { section, raw: bullet[2].trim(), parent };
      items.push(current);
      stack.push({ indent, item: current });
      continue;
    }
    if (current && line.trim() !== "" && /^\s+\S/.test(line)) {
      current.raw += ` ${line.trim()}`;
      continue;
    }
    if (line.trim() === "" || !/^\s/.test(line)) current = null;
  }
  return { version, releasedAt, withdrawn, upstream, items };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this line affect the API, by the rule in the header comment? */
export function isApiLine(text, operationIds = []) {
  if (API_PATH_RE.test(text) || METHOD_PATH_RE.test(text)) return true;
  if (STATUS_RE.test(text)) return true;
  if (HEADER_RE.test(text) || VALIDATOR_RE.test(text)) return true;
  if (API_WORD_CASED.test(text) || OTHER_WORDS.test(text)) return true;
  return operationIds.some((id) => new RegExp(`\\b${escapeRegExp(id)}\\b`).test(text));
}

/** The reason a line is withheld, or null. */
export function withheldReason(text) {
  for (const rule of WITHHELD_LINE_RULES) if (rule.pattern.test(text)) return rule.reason;
  return null;
}

function boldLead(raw) {
  const match = /^\*\*([^*]+?)\*\*/.exec(cleanLine(raw));
  return match ? match[1].replace(/[.:]\s*$/, "").trim() : null;
}

/**
 * Releases with their kept lines, newest first, and the counts the header
 * prints. `notes` is [{ file, markdown }].
 */
export function selectApiChanges(notes, operationIds = []) {
  const releases = [];
  const withheld = {};
  let considered = 0;
  let skippedUpstream = 0;
  let skippedWithdrawn = 0;
  const parsed = notes.map(({ markdown }) => parseRelease(markdown));
  for (const note of parsed.sort(compareReleases)) {
    if (note.withdrawn) {
      skippedWithdrawn += 1;
      continue;
    }
    if (note.upstream) {
      skippedUpstream += 1;
      continue;
    }
    considered += 1;
    const kept = [];
    for (const item of note.items) {
      if (SKIP_SECTION.test(item.section)) continue;
      // The heading is printed above the line, so it is checked like the line.
      const sectionReason = withheldReason(item.section);
      const text = cleanLine(item.raw);
      if (!ALWAYS_KEEP_SECTION.test(item.section) && !isApiLine(text, operationIds)) continue;
      // The parent's lead travels with a sub-bullet whose parent is not itself
      // kept, so the lead is checked as part of the line.
      const lead = item.parent && !isApiLine(cleanLine(item.parent.raw), operationIds) ? boldLead(item.parent.raw) : null;
      const reason = sectionReason ?? withheldReason(text) ?? (lead ? withheldReason(lead) : null);
      if (reason) {
        withheld[reason] = (withheld[reason] ?? 0) + 1;
        continue;
      }
      kept.push({ section: item.section, text: lead ? `**${lead}:** ${text}` : text });
    }
    releases.push({ version: note.version, releasedAt: note.releasedAt, kept });
  }
  return { releases, withheld, considered, skippedUpstream, skippedWithdrawn };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderApiChangelog(selection) {
  const { releases, withheld, considered, skippedUpstream, skippedWithdrawn } = selection;
  const withLines = releases.filter((release) => release.kept.length > 0);
  const keptCount = withLines.reduce((sum, release) => sum + release.kept.length, 0);
  const withheldCount = Object.values(withheld).reduce((sum, count) => sum + count, 0);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const out = [
    "---",
    "title: API changelog",
    'summary: "The API-affecting lines of every AgentDash release note, newest first. Generated from releases/*.md."',
    "---",
    "",
    "<!-- Generated by scripts/docs/generate-api-changelog.mjs. Do not edit by hand; run `node scripts/docs/generate-api-changelog.mjs`. -->",
    "",
    `**Generated** from \`releases/*.md\` by \`scripts/docs/generate-api-changelog.mjs\`: ${plural(keptCount, "line")} from ${plural(withLines.length, "release")}, out of ${plural(considered, "AgentDash release")} read. A line is kept when it names an \`/api/…\` path or a method and path, a contract operation, a status code, a header, a validator, or the words route, endpoint, API, OpenAPI or contract; every line under a Deprecated, Breaking, Removed or Behaviour Change heading is kept. Lines under Tests, Testing, Validation and Contributors are not read. ${plural(skippedWithdrawn, "withdrawn note")} and ${plural(skippedUpstream, "inherited upstream note")} are not AgentDash releases and are skipped.`,
    "",
    "This page selects lines by their words, so it can include a line about an internal route and can miss a change worded without any of them. The release notes are the record; [the versioning policy](/api/versioning) says how a change to [the contract](/api/reference) is announced.",
    "",
  ];
  if (withheldCount > 0) {
    const reasons = Object.entries(withheld)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${count} ${reason}`)
      .join(", ");
    out.push(`${plural(withheldCount, "line")} withheld (${reasons}): they matched the rule above but describe material that is not public.`, "");
  }
  for (const release of withLines) {
    out.push(`## ${release.version}${release.releasedAt ? ` — ${release.releasedAt}` : ""}`, "");
    let section = null;
    for (const line of release.kept) {
      if (line.section !== section) {
        if (section !== null) out.push("");
        section = line.section;
        out.push(`**${section}**`, "");
      }
      out.push(`- ${line.text}`);
    }
    out.push("");
  }
  const none = releases.filter((release) => release.kept.length === 0).map((release) => release.version);
  if (none.length > 0) out.push(`Releases with no API-affecting lines: ${none.join(", ")}.`, "");
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function readReleaseNotes(repoRoot) {
  const dir = path.join(repoRoot, RELEASES_DIR_REL);
  return readdirSync(dir)
    .filter((file) => /^v.*\.md$/.test(file))
    .sort()
    .map((file) => ({ file, markdown: readFileSync(path.join(dir, file), "utf8") }));
}

export function readOperationIds(repoRoot) {
  const file = path.join(repoRoot, CONTRACT_REL);
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, "utf8")).routes ?? []).map((route) => route.operationId).filter(Boolean);
}

export function buildApiChangelog(repoRoot) {
  const selection = selectApiChanges(readReleaseNotes(repoRoot), readOperationIds(repoRoot));
  return { markdown: renderApiChangelog(selection), selection };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { markdown, selection } = buildApiChangelog(repoRoot);
  const target = path.join(repoRoot, API_CHANGELOG_REL);
  const kept = selection.releases.reduce((sum, release) => sum + release.kept.length, 0);
  const withheld = Object.values(selection.withheld).reduce((sum, count) => sum + count, 0);
  if (process.argv.includes("--check")) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== markdown) {
      console.error(`${API_CHANGELOG_REL} is stale. Run: node scripts/docs/generate-api-changelog.mjs`);
      process.exit(1);
    }
    console.log(`${API_CHANGELOG_REL} is current.`);
    return;
  }
  writeFileSync(target, markdown);
  console.log(`Wrote ${API_CHANGELOG_REL} (${kept} lines kept, ${withheld} withheld).`);
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
