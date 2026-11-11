#!/usr/bin/env node
// The published GitHub Release body must be the release notes file.
//
//   node scripts/check-release-body.mjs --tag v2026.1108.0 --notes releases/v2026.1108.0.md [--repo owner/name] [--attempts 3]
//
// The notes in releases/vX.md feed three readers: the GitHub Release body
// (scripts/create-github-release.sh), an install's in-app Changelog (built
// from the tagged source) and the public pages at www.agentdash.cloud/releases
// (built from main). release.yml runs this in its last job,
// refresh_release_site, once the image digest is recorded in the body; a
// failure there fails that job only, never the image jobs. --attempts retries
// a failed read or a mismatch with a growing pause (10 s, then 20 s, ...), in
// case GitHub still serves the body from before the last edit.
//
// It reads the release with
// `gh release view <tag> --json body,isDraft,isPrerelease,tagName`, removes the
// trailing "## Container image" section that create-github-release.sh appends
// (scripts/release-image.mjs), normalizes line endings and trailing
// whitespace, and requires what is left to equal the notes file. A draft, a
// prerelease or a different tag fails too. On a mismatch it names the first
// differing line; both texts are public, but neither is printed in full.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE_SECTION_HEADING = "## Container image";
const STABLE_TAG = /^v\d{4}\.\d{3,4}\.\d+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** CRLF to LF, and no trailing whitespace at the end of the text. */
export function normalizeBody(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/**
 * The body without the generated image section. Only a section that is the
 * last `## ` heading in the body is removed, so notes that happen to mention
 * the heading elsewhere are compared in full.
 */
export function stripImageSection(body) {
  const lines = normalizeBody(body).split("\n");
  const start = lines.lastIndexOf(IMAGE_SECTION_HEADING);
  if (start === -1) return lines.join("\n");
  if (lines.slice(start + 1).some((line) => /^##\s/.test(line))) return lines.join("\n");
  return normalizeBody(lines.slice(0, start).join("\n"));
}

function excerpt(line) {
  if (line === undefined) return "(end of text)";
  return JSON.stringify(line.length > 120 ? `${line.slice(0, 117)}...` : line);
}

/**
 * @param {{ tag: string, notes: string, release: { body?: string, isDraft?: boolean, isPrerelease?: boolean, tagName?: string } }} input
 * @returns {string[]} problems, empty when the body is the notes
 */
export function compareReleaseBody({ tag, notes, release }) {
  const problems = [];
  if (release.tagName !== tag) problems.push(`the GitHub Release is for tag ${release.tagName ?? "(none)"}, expected ${tag}`);
  if (release.isDraft !== false) problems.push(`the GitHub Release ${tag} is a draft, not published`);
  if (release.isPrerelease !== false) problems.push(`the GitHub Release ${tag} is marked as a prerelease`);
  const expected = normalizeBody(notes);
  const actual = stripImageSection(release.body);
  if (expected === "") problems.push("the release notes file is empty");
  if (actual !== expected) {
    const want = expected.split("\n");
    const got = actual.split("\n");
    let line = 0;
    while (line < want.length && line < got.length && want[line] === got[line]) line += 1;
    problems.push(
      `the GitHub Release body differs from the notes file at line ${line + 1}: ` +
        `notes ${excerpt(want[line])}, release ${excerpt(got[line])}`,
    );
  }
  return problems;
}

/** Runs `gh release view`; `run` is injectable for tests. */
export function viewRelease({ tag, repo, run = execFileSync }) {
  const args = ["release", "view", tag, "--json", "body,isDraft,isPrerelease,tagName"];
  if (repo) args.push("-R", repo);
  const output = run("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(output);
}

function parseArgs(argv) {
  const options = { tag: null, notes: null, repo: null, attempts: 1, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--attempts") {
      options.attempts = Number(argv[++i]);
      if (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 10) throw new Error("--attempts must be a whole number from 1 to 10");
    } else if (arg === "--tag") options.tag = argv[++i];
    else if (arg === "--notes") options.notes = argv[++i];
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const USAGE = "Usage: node scripts/check-release-body.mjs --tag vYYYY.MDD.P --notes releases/vYYYY.MDD.P.md [--repo owner/name] [--attempts N]";

/** One read and comparison: the problems, or [] when the body matches. */
function attempt({ tag, repo, notes, run }) {
  let release;
  try {
    release = viewRelease({ tag, repo, run });
  } catch (err) {
    const detail = String(err?.stderr ?? err?.message ?? "").trim().split("\n")[0];
    return [`could not read the GitHub Release ${tag}${detail ? ` (${detail})` : ""}`];
  }
  return compareReleaseBody({ tag, notes, release });
}

export async function main(argv, { run, log = console.log, error = console.error, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    error(`check-release-body: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  if (!STABLE_TAG.test(options.tag ?? "") || !options.notes) {
    error(`check-release-body: --tag must be a stable vYYYY.MDD.P tag and --notes a file.\n${USAGE}`);
    return 2;
  }
  if (options.repo && !REPO_RE.test(options.repo)) {
    error("check-release-body: --repo must look like owner/name.");
    return 2;
  }
  let notes;
  try {
    notes = readFileSync(options.notes, "utf8");
  } catch {
    error(`check-release-body: cannot read the notes file ${options.notes}.`);
    return 1;
  }
  let problems = [];
  for (let n = 1; n <= options.attempts; n += 1) {
    problems = attempt({ tag: options.tag, repo: options.repo, notes, run });
    if (problems.length === 0) {
      log(`GitHub Release ${options.tag} is published and its body matches ${options.notes}${n > 1 ? ` (attempt ${n})` : ""}.`);
      return 0;
    }
    if (n < options.attempts) {
      error(`check-release-body: attempt ${n} of ${options.attempts} failed (${problems[0]}); retrying in ${n * 10} s.`);
      await sleep(n * 10_000);
    }
  }
  error(`check-release-body: the GitHub Release ${options.tag} does not match ${options.notes}:`);
  for (const problem of problems) error(`  - ${problem}`);
  error("The notes are frozen once tagged: edit the GitHub Release body to match the notes file, then rerun this job.");
  return 1;
}

// Entry guard: resolve symlinks on both sides (scripts/entry-guard.test.mjs; cf. #666).
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
