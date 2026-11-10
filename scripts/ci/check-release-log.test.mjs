import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  LAST_FREEFORM_VERSION,
  checkReleaseLog,
  checkedTags,
  gitTaggedNoteReader,
  headingVersion,
  isUpstream,
  isWithdrawn,
  linkedNotes,
  needsStructure,
  parseLsRemote,
  publishedProblems,
  readNotes,
  releasedDate,
  structureProblems,
} from "./check-release-log.mjs";

// Every test here uses fixtures. None reads the repository's own releases/ or
// its tags: those change with every release, and the CI step
// (`node scripts/ci/check-release-log.mjs`) checks the live log.
const SCRIPTS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const note = (version, released = "2026-09-22") => `# ${version}\n\n> Released: ${released}\n\n## Fixed\n\n- A thing\n`;
const readmeFor = (...files) => files.map((file) => `| [${file.replace(/\.md$/, "")}](${file}) |`).join("\n");

test("reads the leading date from a Released line with trailing prose", () => {
  assert.equal(releasedDate("# v\n\n> Released: 2026-09-14 as v2026.914.0.\n"), "2026-09-14");
  assert.equal(releasedDate("> Released: 2026-09-05 as v2026.904.0. Version date 2026-09-04."), "2026-09-05");
  assert.equal(releasedDate("> Released: 2026-09-15."), "2026-09-15");
  assert.equal(releasedDate("> Released: soon"), null);
  assert.equal(releasedDate("Released: 2026-09-15"), null);
  assert.equal(releasedDate("# v\n\nno date here\n"), null);
});

test("recognises withdrawn notes", () => {
  assert.equal(isWithdrawn("# v2026.902.1\n\n> Withdrawn, never released. Cancelled at the gate.\n"), true);
  assert.equal(isWithdrawn(note("v2026.902.0")), false);
});

test("checks only stable tags from v2026.512.0 on", () => {
  assert.deepEqual(
    checkedTags([
      "v0.3.1",
      "v2026.428.0",
      "v2026.512.0",
      "canary/v2026.923.0-canary.0",
      "beta/v2026.921.0-beta.0",
      "agentdash-connect-v0.1.5",
      "v2026.1001.0",
      "v2026.923.0",
      "v2026.923.0",
    ]),
    ["v2026.512.0", "v2026.923.0", "v2026.1001.0"],
  );
});

test("parses ls-remote output and drops peeled refs", () => {
  const output = [
    "abc123\trefs/tags/v2026.923.0",
    "def456\trefs/tags/v2026.923.0^{}",
    "0123ab\trefs/tags/canary/v2026.924.0-canary.0",
    "",
  ].join("\n");
  assert.deepEqual(parseLsRemote(output), ["v2026.923.0", "canary/v2026.924.0-canary.0"]);
});

test("passes a complete log", () => {
  const notes = { "v2026.922.0.md": note("v2026.922.0"), "v2026.923.0.md": note("v2026.923.0", "2026-09-23.") };
  const problems = checkReleaseLog({
    notes,
    readme: readmeFor("v2026.923.0.md", "v2026.922.0.md"),
    tags: ["v2026.922.0", "v2026.923.0", "canary/v2026.924.0-canary.0"],
  });
  assert.deepEqual(problems, []);
});

test("fails when a stable tag has no notes file", () => {
  const problems = checkReleaseLog({
    notes: { "v2026.923.0.md": note("v2026.923.0") },
    readme: readmeFor("v2026.923.0.md"),
    tags: ["v2026.923.0", "v2026.924.0"],
  });
  assert.deepEqual(problems, ["tag v2026.924.0 has no notes file releases/v2026.924.0.md"]);
});

test("fails when a notes file has no parseable Released date, unless withdrawn", () => {
  const notes = {
    "v2026.923.0.md": "# v2026.923.0\n\n> Released: September\n",
    "v2026.902.1.md": "# v2026.902.1\n\n> Withdrawn, never released. Cancelled at the gate.\n",
  };
  const problems = checkReleaseLog({ notes, readme: readmeFor("v2026.923.0.md", "v2026.902.1.md"), tags: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /v2026\.923\.0\.md has no "> Released: YYYY-MM-DD" line/);
});

test("fails when the index misses a notes file or links a missing one", () => {
  const problems = checkReleaseLog({
    notes: { "v2026.922.0.md": note("v2026.922.0"), "v2026.923.0.md": note("v2026.923.0") },
    readme: readmeFor("v2026.923.0.md", "v2026.999.0.md"),
    tags: [],
  });
  assert.deepEqual(problems, [
    "releases/README.md does not list releases/v2026.922.0.md",
    "releases/README.md links releases/v2026.999.0.md, which does not exist",
  ]);
  assert.deepEqual(checkReleaseLog({ notes: {}, readme: null, tags: [] }), ["releases/README.md is missing"]);
});

// The structured format (www.agentdash.cloud/releases, part 6).
const structured = (version, sections) =>
  `# ${version}\n\n> Released: 2026-11-08\n\n${sections.map(([title, body]) => `## ${title}\n\n${body}\n`).join("\n")}`;
const FOUR = [
  ["What’s new", "- Admins can change many records at once."],
  ["For admins", "- Three company switches control it."],
  ["Upgrade", "- No changes."],
  ["Security", "- Each record still passes its own route's guard."],
];

test("the format floor starts with the first cut after v2026.1105.0", () => {
  assert.equal(LAST_FREEFORM_VERSION, "v2026.1105.0");
  const freeform = note("v2026.1105.1");
  assert.equal(needsStructure("v2026.1105.0.md", freeform), false);
  assert.equal(needsStructure("v2026.1031.0.md", freeform), false);
  assert.equal(needsStructure("v0.3.1.md", freeform), false);
  assert.equal(needsStructure("v2026.1105.1.md", freeform), true);
  assert.equal(needsStructure("v2026.1108.0.md", freeform), true);
  assert.equal(needsStructure("v2027.101.0.md", freeform), true);
  // Withdrawn and upstream notes are never published, so they are exempt.
  assert.equal(needsStructure("v2026.1108.0.md", "# v2026.1108.0\n\n> Withdrawn, never released.\n"), false);
  assert.equal(needsStructure("v2026.1108.0.md", "# v2026.1108.0\n> Released: 2026-11-08\n> Upstream: Paperclip\n"), false);
  assert.equal(isUpstream("> Upstream: inherited\n"), true);
});

test("a structured note opens with the four sections in order, then anything else", () => {
  const ok = structured("v2026.1108.0", [...FOUR, ["Fixes", "- Technical detail."], ["Contributors", "@someone"]]);
  assert.deepEqual(structureProblems("v2026.1108.0.md", ok), []);
  // Straight apostrophe too.
  assert.deepEqual(structureProblems("v2026.1108.0.md", ok.replace("What’s new", "What's new")), []);
  const notes = { "v2026.1108.0.md": ok };
  assert.deepEqual(checkReleaseLog({ notes, readme: readmeFor("v2026.1108.0.md"), tags: [] }), []);
});

test("a structured note with missing, renamed or reordered sections fails", () => {
  const missing = structureProblems("v2026.1108.0.md", structured("v2026.1108.0", FOUR.slice(0, 3)));
  assert.equal(missing.length, 1);
  assert.match(missing[0], /must open with the sections "## What's new", "## For admins", "## Upgrade", "## Security", in that order \(found "## What's new", "## For admins", "## Upgrade"\)/);
  const reordered = structureProblems("v2026.1108.0.md", structured("v2026.1108.0", [FOUR[1], FOUR[0], FOUR[2], FOUR[3]]));
  assert.match(reordered.join("\n"), /in that order \(found "## For admins", "## What's new"/);
  const legacy = structureProblems("v2026.1108.0.md", note("v2026.1108.0"));
  assert.match(legacy.join("\n"), /\(found "## Fixed"\)/);
  const leading = structureProblems("v2026.1108.0.md", structured("v2026.1108.0", [["Highlights", "- First."], ...FOUR]));
  assert.match(leading.join("\n"), /found "## Highlights"/);
  // The check is wired into the whole-log check for notes past the floor only.
  const problems = checkReleaseLog({
    notes: { "v2026.1105.0.md": note("v2026.1105.0"), "v2026.1108.0.md": note("v2026.1108.0") },
    readme: readmeFor("v2026.1105.0.md", "v2026.1108.0.md"),
    tags: [],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^releases\/v2026\.1108\.0\.md must open with/);
});

test("each of the four sections keeps a bullet after the public-notes sanitizer", () => {
  const prose = structured("v2026.1108.0", [FOUR[0], ["For admins", "Admins get three switches, explained in prose only."], FOUR[2], FOUR[3]]);
  const proseProblems = structureProblems("v2026.1108.0.md", prose);
  assert.equal(proseProblems.length, 1);
  assert.match(proseProblems[0], /"## For admins" has no bullet left after the public-notes sanitizer/);
  // A withheld bullet (here: a private hostname) is dropped, which empties the section.
  const withheld = structured("v2026.1108.0", [FOUR[0], FOUR[1], FOUR[2], ["Security", "- Rotated the key on build-box.internal."]]);
  assert.match(structureProblems("v2026.1108.0.md", withheld).join("\n"), /"## Security" has no bullet left/);
  // A child of a withheld bullet goes with it.
  const ancestry = structured("v2026.1108.0", [["What’s new", "- Shipped to build-box.internal first\n  - Then everywhere."], ...FOUR.slice(1)]);
  assert.match(structureProblems("v2026.1108.0.md", ancestry).join("\n"), /"## What's new" has no bullet left/);
  // "No changes." is a bullet, and counts.
  assert.deepEqual(structureProblems("v2026.1108.0.md", structured("v2026.1108.0", FOUR.map(([title]) => [title, "- No changes."]))), []);
  assert.match(structureProblems("v2026.1108.0.md", "# not-a-version\n\n## What's new\n\n- x\n").join("\n"), /cannot be published: Invalid release version/);
});

test("checks releases/published.json against the notes and the remote tags", () => {
  const notes = {
    "v2026.1105.0.md": note("v2026.1105.0"),
    "v2026.1104.0.md": note("v2026.1104.0"),
    "v2026.902.1.md": "# v2026.902.1\n\n> Withdrawn, never released.\n",
    "v2026.428.0.md": "# v2026.428.0\n\n> Released: 2026-04-28\n> Upstream: Paperclip\n",
  };
  const tags = ["v2026.1105.0", "v2026.1104.0", "v2026.902.1"];
  const file = (published) => JSON.stringify({ schema: 1, published });
  assert.deepEqual(publishedProblems({ text: file(["v2026.1105.0", "v2026.1104.0"]), notes, tags }), []);
  assert.deepEqual(publishedProblems({ text: file(["v2026.1106.0", "v2026.902.1", "v2026.1104.0", "v2026.1104.0"]), notes, tags }), [
    "releases/published.json lists v2026.1106.0, which has no notes file releases/v2026.1106.0.md",
    "releases/published.json lists v2026.1106.0, which is not a stable tag on the remote",
    "releases/published.json lists v2026.902.1, which is withdrawn",
    "releases/published.json lists v2026.1104.0 more than once",
  ]);
  assert.deepEqual(publishedProblems({ text: file(["v2026.428.0"]), notes, tags: ["v2026.428.0"] }), [
    "releases/published.json lists v2026.428.0, an inherited upstream note",
  ]);
  assert.match(publishedProblems({ text: null, notes, tags })[0], /published\.json is missing/);
  assert.match(publishedProblems({ text: "{oops", notes, tags })[0], /is invalid: it is not valid JSON/);
  assert.match(publishedProblems({ text: file(["latest"]), notes, tags })[0], /is invalid: "published" has 1 entry that is not/);
  // Wired into the whole-log check when the snapshot is passed.
  const log = checkReleaseLog({ notes: { "v2026.1105.0.md": note("v2026.1105.0") }, readme: readmeFor("v2026.1105.0.md"), tags: [], published: file(["v2026.1105.0"]) });
  assert.deepEqual(log, ["releases/published.json lists v2026.1105.0, which is not a stable tag on the remote"]);
});

// Part 6: the public pages build from main, installs show the tag's copy, so
// a tagged structured note is frozen. Fixture repository, local git only.
test("a tagged structured note must stay byte-identical to the copy in its tagged commit", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "release-log-tags-"));
  try {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args) => execFileSync("git", args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "--initial-branch=main", ".");
    git("config", "user.name", "release-fixture");
    git("config", "user.email", "fixture@example.invalid");
    const releases = path.join(repo, "releases");
    mkdirSync(releases);
    const tagged = structured("v2026.1108.0", FOUR);
    writeFileSync(path.join(releases, "v2026.1108.0.md"), tagged);
    writeFileSync(path.join(releases, "v2026.1105.0.md"), note("v2026.1105.0"));
    writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git("add", ".");
    git("commit", "-m", "notes");
    git("tag", "v2026.1108.0");
    git("tag", "v2026.1105.0");
    // A tag cut from a commit without its notes.
    git("tag", "v2026.1110.0", "HEAD");
    // Notes for a later cut, not tagged yet.
    writeFileSync(path.join(releases, "v2026.1112.0.md"), structured("v2026.1112.0", FOUR));
    writeFileSync(path.join(releases, "v2026.1110.0.md"), structured("v2026.1110.0", FOUR));
    writeFileSync(path.join(releases, "v2026.1111.0.md"), structured("v2026.1111.0", FOUR));

    const readTagged = gitTaggedNoteReader(repo);
    const run = (tags) => {
      const notes = readNotes(releases);
      return checkReleaseLog({ notes, readme: null, tags, readTagged, readCurrent: (file) => readFileSync(path.join(releases, file)) })
        .filter((problem) => !problem.startsWith("releases/README.md"));
    };

    // Unchanged: passes. Untagged notes (v2026.1112.0) are free to change.
    assert.deepEqual(run(["v2026.1108.0", "v2026.1105.0"]), []);
    assert.equal(readTagged("v2026.1108.0", "releases/v2026.1108.0.md").toString("utf8"), tagged);

    // An edit after tagging fails, even a whitespace-only one.
    writeFileSync(path.join(releases, "v2026.1108.0.md"), `${tagged}\n`);
    assert.deepEqual(run(["v2026.1108.0"]), [
      "releases/v2026.1108.0.md differs from the copy in tag v2026.1108.0. Published notes are frozen (the public pages build from main, installs show the tag's copy): restore it and put the correction in the next release's notes",
    ]);
    writeFileSync(path.join(releases, "v2026.1108.0.md"), tagged);

    // Historical notes (at or before the cutoff) are not compared.
    writeFileSync(path.join(releases, "v2026.1105.0.md"), `${note("v2026.1105.0")}- Edited later\n`);
    assert.deepEqual(run(["v2026.1105.0"]), []);

    // A tag whose commit lacks the notes, and a remote tag missing locally.
    assert.deepEqual(run(["v2026.1110.0", "v2026.1111.0"]), [
      'tag v2026.1110.0 was cut from a commit without releases/v2026.1110.0.md: cut stable releases from a main commit that contains their notes (see releases/README.md, "How releases are logged")',
      "releases/v2026.1111.0.md cannot be compared with tag v2026.1111.0: tag v2026.1111.0 is not in the local repository (git fetch --tags origin)",
    ]);
    assert.equal(readTagged("v2026.1110.0", "releases/v2026.1110.0.md"), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a note's # heading must be the version in its file name", () => {
  assert.equal(headingVersion("# v2026.1108.0\n\n> Released: 2026-11-08\n"), "v2026.1108.0");
  assert.equal(headingVersion("> Released: 2026-11-08\n"), null);
  const notes = {
    "v2026.1108.0.md": note("v2026.1107.0"),
    "v2026.1109.0.md": "> Released: 2026-11-09\n\n## Fixed\n\n- x\n",
    "v2026.902.1.md": "# v2026.902.1\n\n> Withdrawn, never released.\n",
  };
  const problems = checkReleaseLog({ notes, readme: readmeFor(...Object.keys(notes)), tags: [] })
    .filter((problem) => /heading/.test(problem));
  assert.deepEqual(problems, [
    'releases/v2026.1108.0.md must start with the heading "# v2026.1108.0" (found "# v2026.1107.0")',
    'releases/v2026.1109.0.md must start with the heading "# v2026.1109.0" (found no # heading)',
  ]);
});

/**
 * A fixture repository with its own copy of the check (and the modules it
 * imports), its own releases/ and its own tags, plus a bare "origin". The CLI
 * resolves releases/ from its own location, so running the copy checks only
 * the fixture.
 */
function cliFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "release-log-cli-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const work = path.join(root, "work");
  const remote = path.join(root, "origin.git");
  for (const rel of ["ci/check-release-log.mjs", "docs/generate-api-changelog.mjs", "docs/forbidden-tokens.mjs", "docs/public-release-notes.mjs", "published-releases.mjs"]) {
    mkdirSync(path.join(work, "scripts", path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(work, "scripts", rel), readFileSync(path.join(SCRIPTS_ROOT, rel)));
  }
  const releases = path.join(work, "releases");
  mkdirSync(releases);
  const notes = {
    "v2026.1108.0.md": structured("v2026.1108.0", FOUR),
    "v2026.1105.0.md": note("v2026.1105.0", "2026-11-05"),
    "v2026.902.1.md": "# v2026.902.1\n\n> Withdrawn, never released.\n",
    "v2026.428.0.md": "# v2026.428.0\n\n> Released: 2026-04-28\n> Upstream: Paperclip\n",
  };
  for (const [file, markdown] of Object.entries(notes)) writeFileSync(path.join(releases, file), markdown);
  writeFileSync(path.join(releases, "README.md"), readmeFor(...Object.keys(notes)));
  writeFileSync(path.join(releases, "published.json"), JSON.stringify({ schema: 1, published: ["v2026.1108.0", "v2026.1105.0"] }));
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(work, "init", "--initial-branch=main", ".");
  git(work, "config", "user.name", "release-fixture");
  git(work, "config", "user.email", "fixture@example.invalid");
  git(work, "add", ".");
  git(work, "commit", "-m", "fixture");
  for (const tag of ["v2026.1108.0", "v2026.1105.0", "canary/v2026.1109.0-canary.0", "agentdash-connect-v0.5.0"]) git(work, "tag", tag);
  git(work, "push", "--quiet", remote, "main", "--tags");
  const run = (...args) => {
    try {
      const stdout = execFileSync(process.execPath, [path.join(work, "scripts/ci/check-release-log.mjs"), ...args], { cwd: work, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  return { root, work, remote, releases, git, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Regression: the CLI's live path (tags from `git ls-remote`, no --tags-file)
// once threw a TDZ error because a local shadowed remoteTags(), which failed
// every PR's policy job. This runs the real argv path; no network.
test("the CLI reads tags from a remote, compares tagged notes with local git, and passes a complete fixture log", () => {
  const fx = cliFixture();
  try {
    const ok = fx.run("--remote", fx.remote);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(
      ok.stdout,
      `Release log OK: 4 notes files, all indexed; 2 stable tags from v2026.512.0 on ${fx.remote}, all with notes; ` +
        "1 structured note after v2026.1105.0 (1 tagged, identical to the tag); releases/published.json lists 2 published releases.\n",
    );

    // The tag-file path agrees.
    writeFileSync(path.join(fx.root, "tags.txt"), "v2026.1108.0\nv2026.1105.0\n");
    assert.equal(fx.run("--tags-file", path.join(fx.root, "tags.txt")).status, 0);

    // Editing a tagged structured note fails the live path.
    writeFileSync(path.join(fx.releases, "v2026.1108.0.md"), `${structured("v2026.1108.0", FOUR)}- late edit\n`);
    const edited = fx.run("--remote", fx.remote);
    assert.equal(edited.status, 1);
    assert.match(edited.stderr, /releases\/v2026\.1108\.0\.md differs from the copy in tag v2026\.1108\.0/);
  } finally {
    fx.cleanup();
  }
});

test("the CLI fails a remote tag without notes, and fails closed on an unreadable remote", () => {
  const fx = cliFixture();
  try {
    fx.git(fx.work, "tag", "v2026.1199.0");
    fx.git(fx.work, "push", "--quiet", fx.remote, "v2026.1199.0");
    const missing = fx.run("--remote", fx.remote);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /tag v2026\.1199\.0 has no notes file releases\/v2026\.1199\.0\.md/);

    const gone = fx.run("--remote", path.join(fx.root, "no-such-remote.git"));
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /could not read tags from remote .*Refusing to pass on an empty tag list/s);
    assert.doesNotMatch(gone.stderr, /before initialization/);
  } finally {
    fx.cleanup();
  }
});
