#!/usr/bin/env node
/**
 * Keep `releases/` the one connected release log.
 *
 * Fails when:
 *  1. a stable `vYYYY.MDD.P` tag on `origin`, from v2026.512.0 on, has no
 *     `releases/<tag>.md`;
 *  2. a notes file has no parseable `> Released: YYYY-MM-DD` line and is not
 *     marked `> Withdrawn, never released.`;
 *  3. `releases/README.md` does not link every notes file, or links one that
 *     does not exist.
 *
 * Tags are read from the remote with `git ls-remote`, not from the local tag
 * list: CI checkouts can be shallow or tagless, and a developer checkout that
 * also fetches Paperclip's `upstream` remote carries Paperclip's tags
 * (v2026.512.0 … are theirs), which are not AgentDash releases. If the remote
 * cannot be read the check fails rather than passing on an empty tag list.
 *
 *   node scripts/ci/check-release-log.mjs
 *   node scripts/ci/check-release-log.mjs --remote origin
 *   node scripts/ci/check-release-log.mjs --tags-file tags.txt   # one tag per line, no network
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIRST_CHECKED_TAG = "v2026.512.0";
const STABLE_TAG = /^v(\d{4})\.(\d{3,4})\.(\d+)$/;
const NOTES_FILE = /^v\d+\.\d+\.\d+\.md$/;
const RELEASED_LINE = /^>\s*Released:\s*(\d{4}-\d{2}-\d{2})\b/im;
const WITHDRAWN_LINE = /^>\s*Withdrawn, never released/im;

function stableKey(tag) {
  const match = STABLE_TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareKeys(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Stable tags at or after FIRST_CHECKED_TAG. Canary/beta tags and v0.x are ignored. */
export function checkedTags(tags) {
  const floor = stableKey(FIRST_CHECKED_TAG);
  return [...new Set(tags)]
    .filter((tag) => {
      const key = stableKey(tag);
      return key && compareKeys(key, floor) >= 0;
    })
    .sort((a, b) => compareKeys(stableKey(a), stableKey(b)));
}

/** Parses `git ls-remote --tags` output into tag names (peeled `^{}` lines dropped). */
export function parseLsRemote(output) {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref) => ref && ref.startsWith("refs/tags/") && !ref.endsWith("^{}"))
    .map((ref) => ref.slice("refs/tags/".length));
}

/** Leading ISO date of the `> Released:` line, or null. */
export function releasedDate(markdown) {
  const match = RELEASED_LINE.exec(markdown);
  if (!match) return null;
  return Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) ? null : match[1];
}

export function isWithdrawn(markdown) {
  return WITHDRAWN_LINE.test(markdown);
}

/** Notes files linked from the index as `](vX.Y.Z.md)`. */
export function linkedNotes(readme) {
  return new Set([...readme.matchAll(/\]\((?:\.\/)?(v\d+\.\d+\.\d+\.md)\)/g)].map((m) => m[1]));
}

/**
 * @param {{ notes: Record<string, string>, readme: string | null, tags: string[] }} input
 *   notes: file name -> contents for every releases/v*.md
 * @returns {string[]} problems, empty when the log is complete
 */
export function checkReleaseLog({ notes, readme, tags }) {
  const problems = [];
  for (const tag of checkedTags(tags)) {
    if (!(`${tag}.md` in notes)) problems.push(`tag ${tag} has no notes file releases/${tag}.md`);
  }
  for (const [file, markdown] of Object.entries(notes)) {
    if (!isWithdrawn(markdown) && !releasedDate(markdown)) {
      problems.push(`releases/${file} has no "> Released: YYYY-MM-DD" line and is not marked "> Withdrawn, never released."`);
    }
  }
  if (readme === null) {
    problems.push("releases/README.md is missing");
  } else {
    const linked = linkedNotes(readme);
    for (const file of Object.keys(notes)) {
      if (!linked.has(file)) problems.push(`releases/README.md does not list releases/${file}`);
    }
    for (const file of linked) {
      if (!(file in notes)) problems.push(`releases/README.md links releases/${file}, which does not exist`);
    }
  }
  return problems;
}

export function readNotes(releasesDir) {
  const notes = {};
  for (const file of readdirSync(releasesDir).sort()) {
    if (NOTES_FILE.test(file)) notes[file] = readFileSync(path.join(releasesDir, file), "utf8");
  }
  return notes;
}

function readReadme(releasesDir) {
  try {
    return readFileSync(path.join(releasesDir, "README.md"), "utf8");
  } catch {
    return null;
  }
}

export function remoteTags(remote, cwd) {
  const output = execFileSync("git", ["ls-remote", "--tags", "--refs", remote], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseLsRemote(output);
}

function main(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const releasesDir = path.join(repoRoot, "releases");
  let remote = "origin";
  let tagsFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--remote") remote = argv[++i];
    else if (argv[i] === "--tags-file") tagsFile = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      return 2;
    }
  }

  let tags;
  if (tagsFile) {
    tags = readFileSync(tagsFile, "utf8").split("\n").map((t) => t.trim()).filter(Boolean);
  } else {
    try {
      tags = remoteTags(remote, repoRoot);
    } catch (error) {
      console.error(`check-release-log: could not read tags from remote "${remote}" (${error.message.trim()}).`);
      console.error("Refusing to pass on an empty tag list. Pass --tags-file to check offline.");
      return 1;
    }
  }

  const notes = readNotes(releasesDir);
  const problems = checkReleaseLog({ notes, readme: readReadme(releasesDir), tags });
  const checked = checkedTags(tags);
  if (problems.length > 0) {
    console.error(`Release log is incomplete (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("See releases/README.md, \"How releases are logged\".");
    return 1;
  }
  console.log(
    `Release log OK: ${Object.keys(notes).length} notes files, all indexed; ` +
      `${checked.length} stable tags from ${FIRST_CHECKED_TAG} on ${tagsFile ? tagsFile : remote}, all with notes.`,
  );
  return 0;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
