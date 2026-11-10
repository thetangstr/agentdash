// scripts/check-release-body.mjs: the GitHub Release body is the notes file.
// `gh` is always faked; no test reaches GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareReleaseBody, main, normalizeBody, stripImageSection, viewRelease } from "./check-release-body.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(SCRIPTS_DIR, "check-release-body.mjs");
const TAG = "v2026.1108.0";
const NOTES = "# v2026.1108.0\n\n> Released: 2026-11-08\n\n## What's new\n\n- A thing\n\n## For admins\n\n- No changes.\n";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const published = (body, extra = {}) => ({ body, isDraft: false, isPrerelease: false, tagName: TAG, ...extra });

/** The body exactly as create-github-release.sh --image-digest composes it. */
function bodyWithImageSection(notes) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-body-"));
  try {
    const file = path.join(dir, "notes.md");
    writeFileSync(file, notes);
    return execFileSync(
      "bash",
      ["-c", '{ cat "$1"; printf \'\\n%s\\n\' "$(node "$2" section 2026.1108.0 "$3")"; }', "bash", file, path.join(SCRIPTS_DIR, "release-image.mjs"), DIGEST],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a body that is the notes, with or without the generated image section, matches", () => {
  assert.deepEqual(compareReleaseBody({ tag: TAG, notes: NOTES, release: published(NOTES) }), []);
  const withImage = bodyWithImageSection(NOTES);
  assert.match(withImage, /## Container image/);
  assert.deepEqual(compareReleaseBody({ tag: TAG, notes: NOTES, release: published(withImage) }), []);
  // GitHub may hand the body back with CRLF line endings and no final newline.
  assert.deepEqual(compareReleaseBody({ tag: TAG, notes: NOTES, release: published(withImage.replace(/\n/g, "\r\n").trimEnd()) }), []);
  assert.equal(normalizeBody("a\r\nb\r\n\r\n"), "a\nb");
});

test("an edited body, a draft, a prerelease or a different tag fails", () => {
  const edited = compareReleaseBody({ tag: TAG, notes: NOTES, release: published(NOTES.replace("A thing", "Another thing")) });
  assert.equal(edited.length, 1);
  assert.match(edited[0], /differs from the notes file at line 7: notes "- A thing", release "- Another thing"/);
  assert.match(compareReleaseBody({ tag: TAG, notes: NOTES, release: published(`${NOTES}- extra line\n`) })[0], /line 12: notes \(end of text\), release "- extra line"/);
  assert.match(compareReleaseBody({ tag: TAG, notes: NOTES, release: published(NOTES, { isDraft: true }) }).join("\n"), /is a draft/);
  assert.match(compareReleaseBody({ tag: TAG, notes: NOTES, release: published(NOTES, { isPrerelease: true }) }).join("\n"), /prerelease/);
  assert.match(compareReleaseBody({ tag: TAG, notes: NOTES, release: published(NOTES, { tagName: "v2026.1105.0" }) }).join("\n"), /for tag v2026\.1105\.0, expected v2026\.1108\.0/);
  assert.match(compareReleaseBody({ tag: TAG, notes: NOTES, release: { body: NOTES, tagName: TAG } }).join("\n"), /draft[\s\S]*prerelease/);
  assert.match(compareReleaseBody({ tag: TAG, notes: "\n", release: published("") }).join("\n"), /notes file is empty/);
});

test("only a trailing image section is removed", () => {
  const notesWithHeading = `${NOTES}\n## Container image\n\nWritten by hand.\n\n## Security\n\n- No changes.\n`;
  assert.equal(stripImageSection(notesWithHeading), normalizeBody(notesWithHeading));
  // A hand-edited body that drops part of the notes still fails even though the image section is removed.
  const truncated = bodyWithImageSection(NOTES.replace("\n## For admins\n\n- No changes.\n", ""));
  assert.equal(compareReleaseBody({ tag: TAG, notes: NOTES, release: published(truncated) }).length, 1);
});

test("asks gh for exactly the fields it compares", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return JSON.stringify(published(NOTES));
  };
  assert.deepEqual(viewRelease({ tag: TAG, repo: "thetangstr/agentdash", run }), published(NOTES));
  assert.deepEqual(calls, [["gh", "release", "view", TAG, "--json", "body,isDraft,isPrerelease,tagName", "-R", "thetangstr/agentdash"]]);
});

test("the CLI passes and fails on what a fake gh reports", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-body-cli-"));
  try {
    const bin = path.join(dir, "bin");
    execFileSync("mkdir", ["-p", bin]);
    const gh = path.join(bin, "gh");
    writeFileSync(gh, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.GH_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.env.GH_FAIL) { process.stderr.write("release not found\\n"); process.exit(1); }\nprocess.stdout.write(fs.readFileSync(process.env.GH_RELEASE, "utf8"));\n`);
    chmodSync(gh, 0o755);
    const notesFile = path.join(dir, "v2026.1108.0.md");
    const releaseFile = path.join(dir, "release.json");
    writeFileSync(notesFile, NOTES);
    const run = (release, extraEnv = {}) => {
      writeFileSync(releaseFile, JSON.stringify(release));
      return spawnSync(process.execPath, [SCRIPT, "--tag", TAG, "--notes", notesFile, "--repo", "thetangstr/agentdash"], {
        encoding: "utf8",
        env: { PATH: `${bin}:/usr/bin:/bin`, GH_CALLS: path.join(dir, "calls.jsonl"), GH_RELEASE: releaseFile, ...extraEnv },
      });
    };
    const ok = run(published(bodyWithImageSection(NOTES)));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /is published and its body matches/);

    const bad = run(published(NOTES.replace("A thing", "Something else")));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /differs from the notes file at line 7/);

    const missing = run(published(NOTES), { GH_FAIL: "1" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /could not read the GitHub Release v2026\.1108\.0 \(release not found\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a non-stable tag, a bad --attempts or missing notes before calling gh", async () => {
  const lines = [];
  const run = () => {
    throw new Error("gh must not be called");
  };
  const sink = { run, log: (l) => lines.push(l), error: (l) => lines.push(l) };
  assert.equal(await main(["--tag", "canary/v2026.1108.0-canary.0", "--notes", "x.md"], sink), 2);
  assert.equal(await main(["--tag", TAG], sink), 2);
  assert.equal(await main(["--tag", TAG, "--notes", "x.md", "--attempts", "0"], sink), 2);
  assert.equal(await main(["--tag", TAG, "--notes", "/nope/missing.md"], sink), 1);
  assert.match(lines.join("\n"), /cannot read the notes file/);
});

test("--attempts retries a failed read or a stale body with a growing pause", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-body-retry-"));
  try {
    const notesFile = path.join(dir, "notes.md");
    writeFileSync(notesFile, NOTES);
    const run = (answers) => {
      let call = 0;
      return () => {
        const answer = answers[Math.min(call, answers.length - 1)];
        call += 1;
        if (answer instanceof Error) throw answer;
        return JSON.stringify(answer);
      };
    };
    const harness = async (answers, attempts) => {
      const lines = [];
      const sleeps = [];
      const status = await main(["--tag", TAG, "--notes", notesFile, "--attempts", String(attempts)], {
        run: run(answers),
        log: (l) => lines.push(l),
        error: (l) => lines.push(l),
        sleep: async (ms) => sleeps.push(ms),
      });
      return { status, lines: lines.join("\n"), sleeps };
    };
    const flaky = await harness([Object.assign(new Error("x"), { stderr: "HTTP 502\n" }), published(NOTES.replace("A thing", "Old")), published(NOTES)], 3);
    assert.equal(flaky.status, 0, flaky.lines);
    assert.deepEqual(flaky.sleeps, [10_000, 20_000]);
    assert.match(flaky.lines, /attempt 1 of 3 failed \(could not read the GitHub Release v2026\.1108\.0 \(HTTP 502\)\)/);
    assert.match(flaky.lines, /matches .* \(attempt 3\)/);

    const stale = await harness([published(NOTES.replace("A thing", "Old"))], 3);
    assert.equal(stale.status, 1);
    assert.deepEqual(stale.sleeps, [10_000, 20_000]);
    assert.match(stale.lines, /does not match[\s\S]*differs from the notes file at line 7/);

    const once = await harness([published(NOTES.replace("A thing", "Old"))], 1);
    assert.equal(once.status, 1);
    assert.deepEqual(once.sleeps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
