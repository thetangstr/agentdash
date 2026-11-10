#!/usr/bin/env node
/**
 * Keep `releases/` the one connected release log.
 *
 * Fails when:
 *  1. a stable `vYYYY.MDD.P` tag on `origin`, from v2026.512.0 on, has no
 *     `releases/<tag>.md`;
 *  2. a notes file has no parseable `> Released: YYYY-MM-DD` line and is not
 *     marked `> Withdrawn, never released.`, or its first `# ` heading is not
 *     the version in its file name (the pages and the Changelog key a note by
 *     that heading, every check here by the file name);
 *  3. `releases/README.md` does not link every notes file, or links one that
 *     does not exist;
 *  4. a note after LAST_FREEFORM_VERSION (the next stable cut on; withdrawn
 *     and upstream notes exempt) does not open with the sections What's new,
 *     For admins, Upgrade and Security, in that order, each keeping at least
 *     one bullet after the public-notes sanitizer
 *     (scripts/docs/public-release-notes.mjs). The sanitizer drops prose and
 *     withheld bullets, so a section of prose alone would publish empty on
 *     www.agentdash.cloud/releases and in the in-app Changelog;
 *  5. `releases/published.json`, the published list those pages fall back to
 *     (scripts/published-releases.mjs), is missing or invalid, or lists a
 *     version with no notes file, a withdrawn or upstream note, or no stable
 *     tag on the remote;
 *  6. a note after LAST_FREEFORM_VERSION whose stable tag is on the remote
 *     differs, byte for byte, from `releases/vX.md` in the tagged commit, or
 *     that commit has no such file. www.agentdash.cloud/releases is built from
 *     main while installs show the tag's copy, so a published note is frozen:
 *     a correction goes into the next release's notes. Stable releases are cut
 *     from a main commit that already contains their notes, which also
 *     satisfies release.yml's source-notes gate. This reads the tagged
 *     commit with local git only (CI checks out with fetch-depth 0, which
 *     brings the tags); a tag that is on the remote but not local fails.
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
import { parseRelease, WITHDRAWN_LINE as WITHDRAWN_NOTE_LINE } from "../docs/generate-api-changelog.mjs";
import { publicReleaseMarkdown } from "../docs/public-release-notes.mjs";
import { parsePublishedFile } from "../published-releases.mjs";

export const FIRST_CHECKED_TAG = "v2026.512.0";
/**
 * The last note written before the structured format. Every note after it
 * needs REQUIRED_SECTIONS; it and everything before it are historical and
 * exempt. No historical note is rewritten.
 */
export const LAST_FREEFORM_VERSION = "v2026.1105.0";
/** The first four `## ` headings of a structured note, in this order. */
export const REQUIRED_SECTIONS = ["What's new", "For admins", "Upgrade", "Security"];
const STABLE_TAG = /^v(\d{4})\.(\d{3,4})\.(\d+)$/;
const NOTES_FILE = /^v\d+\.\d+\.\d+\.md$/;
const RELEASED_LINE = /^>\s*Released:\s*(\d{4}-\d{2}-\d{2})\b/im;
const WITHDRAWN_LINE = new RegExp(WITHDRAWN_NOTE_LINE.source, "im");
const UPSTREAM_LINE = /^>\s*Upstream:/im;

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

/** The version in a note's first `# ` heading, or null. */
export function headingVersion(markdown) {
  const line = markdown.split(/\r?\n/).find((candidate) => candidate.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : null;
}

export function isUpstream(markdown) {
  return UPSTREAM_LINE.test(markdown);
}

/** True when a notes file must use the structured format (see LAST_FREEFORM_VERSION). */
export function needsStructure(file, markdown) {
  const key = stableKey(file.replace(/\.md$/, ""));
  if (!key || compareKeys(key, stableKey(LAST_FREEFORM_VERSION)) <= 0) return false;
  return !isWithdrawn(markdown) && !isUpstream(markdown);
}

/** Straight and curly apostrophes read the same; so do runs of spaces. */
function normalizeHeading(heading) {
  return heading.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, " ").trim();
}

/** `## ` headings outside fenced code, in order. */
function sectionHeadings(markdown) {
  const headings = [];
  let fence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    const match = !fence && /^##\s+(.+)$/.exec(line);
    if (match) headings.push(normalizeHeading(match[1]));
  }
  return headings;
}

/** Problems with a structured note: the four sections, in order, each with a public bullet. */
export function structureProblems(file, markdown) {
  const problems = [];
  const headings = sectionHeadings(markdown);
  const first = headings.slice(0, REQUIRED_SECTIONS.length);
  if (REQUIRED_SECTIONS.some((section, i) => first[i] !== section)) {
    const found = first.length > 0 ? first.map((h) => `"## ${h}"`).join(", ") : "no sections";
    problems.push(
      `releases/${file} must open with the sections ${REQUIRED_SECTIONS.map((s) => `"## ${s}"`).join(", ")}, in that order (found ${found})`,
    );
  }
  let sanitized;
  try {
    sanitized = publicReleaseMarkdown(markdown);
  } catch (error) {
    problems.push(`releases/${file} cannot be published: ${error.message}`);
    return problems;
  }
  const kept = new Map();
  for (const item of parseRelease(sanitized).items) {
    const section = normalizeHeading(item.section);
    kept.set(section, (kept.get(section) ?? 0) + 1);
  }
  for (const section of REQUIRED_SECTIONS) {
    if (headings.includes(section) && !kept.get(section)) {
      problems.push(
        `releases/${file}: "## ${section}" has no bullet left after the public-notes sanitizer ` +
          "(prose and withheld bullets are dropped); write at least one public bullet, or \"- No changes.\"",
      );
    }
  }
  return problems;
}

/**
 * Problems with releases/published.json. `text` is its contents, or null when
 * the file is missing.
 */
export function publishedProblems({ text, notes, tags }) {
  if (text === null) {
    return ["releases/published.json is missing (the published list www.agentdash.cloud/releases falls back to)"];
  }
  let versions;
  try {
    versions = parsePublishedFile(JSON.parse(text));
  } catch (error) {
    return [`releases/published.json is invalid: ${error instanceof SyntaxError ? "it is not valid JSON" : error.message}`];
  }
  const problems = [];
  const seen = new Set();
  const remote = new Set(tags);
  for (const version of versions) {
    if (seen.has(version)) {
      problems.push(`releases/published.json lists ${version} more than once`);
      continue;
    }
    seen.add(version);
    const markdown = notes[`${version}.md`];
    if (markdown === undefined) problems.push(`releases/published.json lists ${version}, which has no notes file releases/${version}.md`);
    else if (isWithdrawn(markdown)) problems.push(`releases/published.json lists ${version}, which is withdrawn`);
    else if (isUpstream(markdown)) problems.push(`releases/published.json lists ${version}, an inherited upstream note`);
    if (!remote.has(version)) problems.push(`releases/published.json lists ${version}, which is not a stable tag on the remote`);
  }
  return problems;
}

/** Notes files linked from the index as `](vX.Y.Z.md)`. */
export function linkedNotes(readme) {
  return new Set([...readme.matchAll(/\]\((?:\.\/)?(v\d+\.\d+\.\d+\.md)\)/g)].map((m) => m[1]));
}

/**
 * Reads a file from a tag's commit with local git only. The reader returns
 * the bytes, null when that commit has no such file, and throws when the tag
 * is not in the local repository.
 */
export function gitTaggedNoteReader(repoRoot, run = execFileSync) {
  const git = (args) => run("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  return (tag, relPath) => {
    const commit = `refs/tags/${tag}^{commit}`;
    try {
      git(["rev-parse", "--verify", "--quiet", commit]);
    } catch {
      throw new Error(`tag ${tag} is not in the local repository (git fetch --tags origin)`);
    }
    try {
      git(["cat-file", "-e", `${commit}:${relPath}`]);
    } catch {
      return null;
    }
    return git(["cat-file", "blob", `${commit}:${relPath}`]);
  };
}

/**
 * Problems with tagged structured notes: main's copy must be the tagged
 * commit's, byte for byte. `readTagged(tag, path)` is gitTaggedNoteReader's;
 * `readCurrent(file)` returns the working copy's bytes.
 */
export function taggedNoteProblems({ notes, tags, readTagged, readCurrent = (file) => Buffer.from(notes[file], "utf8") }) {
  const problems = [];
  const remote = new Set(tags);
  for (const [file, markdown] of Object.entries(notes)) {
    if (!needsStructure(file, markdown)) continue;
    const tag = file.replace(/\.md$/, "");
    if (!remote.has(tag)) continue;
    let tagged;
    try {
      tagged = readTagged(tag, `releases/${file}`);
    } catch (error) {
      problems.push(`releases/${file} cannot be compared with tag ${tag}: ${error.message}`);
      continue;
    }
    if (tagged === null) {
      problems.push(
        `tag ${tag} was cut from a commit without releases/${file}: cut stable releases from a main commit ` +
          'that contains their notes (see releases/README.md, "How releases are logged")',
      );
    } else if (!Buffer.from(readCurrent(file)).equals(Buffer.from(tagged))) {
      problems.push(
        `releases/${file} differs from the copy in tag ${tag}. Published notes are frozen ` +
          "(the public pages build from main, installs show the tag's copy): restore it and put the correction in the next release's notes",
      );
    }
  }
  return problems;
}

/**
 * @param {{ notes: Record<string, string>, readme: string | null, tags: string[], published?: string | null,
 *   readTagged?: (tag: string, path: string) => Buffer | null, readCurrent?: (file: string) => Buffer }} input
 *   notes: file name -> contents for every releases/v*.md
 *   published: contents of releases/published.json, null when it is missing,
 *   or undefined to skip that check
 *   readTagged / readCurrent: see taggedNoteProblems; without readTagged the
 *   tag comparison is skipped
 * @returns {string[]} problems, empty when the log is complete
 */
export function checkReleaseLog({ notes, readme, tags, published, readTagged, readCurrent }) {
  const problems = [];
  for (const tag of checkedTags(tags)) {
    if (!(`${tag}.md` in notes)) problems.push(`tag ${tag} has no notes file releases/${tag}.md`);
  }
  for (const [file, markdown] of Object.entries(notes)) {
    if (!isWithdrawn(markdown) && !releasedDate(markdown)) {
      problems.push(`releases/${file} has no "> Released: YYYY-MM-DD" line and is not marked "> Withdrawn, never released."`);
    }
    const heading = headingVersion(markdown);
    const expected = file.replace(/\.md$/, "");
    if (heading !== expected) {
      problems.push(`releases/${file} must start with the heading "# ${expected}" (found ${heading === null ? "no # heading" : `"# ${heading}"`})`);
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
  for (const [file, markdown] of Object.entries(notes)) {
    if (needsStructure(file, markdown)) problems.push(...structureProblems(file, markdown));
  }
  if (published !== undefined) problems.push(...publishedProblems({ text: published, notes, tags }));
  if (readTagged) problems.push(...taggedNoteProblems({ notes, tags, readTagged, readCurrent }));
  return problems;
}

export function readNotes(releasesDir) {
  const notes = {};
  for (const file of readdirSync(releasesDir).sort()) {
    if (NOTES_FILE.test(file)) notes[file] = readFileSync(path.join(releasesDir, file), "utf8");
  }
  return notes;
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readReadme(releasesDir) {
  return readOptional(path.join(releasesDir, "README.md"));
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
  const published = readOptional(path.join(releasesDir, "published.json"));
  const problems = checkReleaseLog({
    notes,
    readme: readReadme(releasesDir),
    tags,
    published,
    readTagged: gitTaggedNoteReader(repoRoot),
    readCurrent: (file) => readFileSync(path.join(releasesDir, file)),
  });
  const checked = checkedTags(tags);
  if (problems.length > 0) {
    console.error(`Release log is incomplete (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("See releases/README.md, \"How releases are logged\".");
    return 1;
  }
  const structuredFiles = Object.entries(notes).filter(([file, markdown]) => needsStructure(file, markdown)).map(([file]) => file);
  const structured = structuredFiles.length;
  const tagSet = new Set(tags);
  const frozen = structuredFiles.filter((file) => tagSet.has(file.replace(/\.md$/, ""))).length;
  console.log(
    `Release log OK: ${Object.keys(notes).length} notes files, all indexed; ` +
      `${checked.length} stable tags from ${FIRST_CHECKED_TAG} on ${tagsFile ? tagsFile : remote}, all with notes; ` +
      `${structured} structured note${structured === 1 ? "" : "s"} after ${LAST_FREEFORM_VERSION} (${frozen} tagged, identical to the tag); ` +
      `releases/published.json lists ${parsePublishedFile(JSON.parse(published)).length} published releases.`,
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
