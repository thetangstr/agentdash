import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import {
  checkReleaseLog,
  checkedTags,
  isWithdrawn,
  linkedNotes,
  parseLsRemote,
  readNotes,
  releasedDate,
} from "./check-release-log.mjs";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

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

test("the repository's own release log is complete against the tags on origin at the time of writing", () => {
  const releasesDir = path.join(REPO_ROOT, "releases");
  const notes = readNotes(releasesDir);
  const readme = readFileSync(path.join(releasesDir, "README.md"), "utf8");
  // A snapshot, so this test needs no network; the CI step checks live tags.
  const tags = [
    "v2026.827.0", "v2026.827.1", "v2026.827.2", "v2026.902.0", "v2026.904.0", "v2026.908.0",
    "v2026.909.0", "v2026.909.1", "v2026.909.2", "v2026.914.0", "v2026.915.0", "v2026.922.0",
    "v2026.922.1", "v2026.923.0",
  ];
  assert.deepEqual(checkReleaseLog({ notes, readme, tags }), []);
  assert.equal(linkedNotes(readme).size, Object.keys(notes).length);
  assert.equal(isWithdrawn(notes["v2026.902.1.md"]), true);
  assert.equal(isWithdrawn(notes["v2026.827.3.md"]), true);
});
