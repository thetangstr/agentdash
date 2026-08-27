import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release workflows run the workspace-link preflight before recursive typecheck", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const releaseScript = readFileSync(path.join(repoRoot, "scripts/release.sh"), "utf8");
  const vercel = JSON.parse(readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));

  assert.doesNotMatch(workflow, /run:\s*pnpm -r typecheck/);
  assert.doesNotMatch(releaseScript, /pnpm -r typecheck/);
  assert.match(releaseScript, /pnpm typecheck/);
  assert.ok(
    [...workflow.matchAll(/name:\s*Typecheck[\s\S]*?run:\s*pnpm typecheck/g)].length >= 2,
    "canary and stable verification must call the root typecheck script",
  );
  assert.match(vercel.buildCommand, /pnpm run preflight:workspace-links/);
  assert.match(vercel.buildCommand, /pnpm --filter @paperclipai\/adapter-utils build/);
  assert.match(vercel.buildCommand, /pnpm --filter @paperclipai\/ui build/);
});

test("stable workflow separates immutable source from release-control metadata", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

  assert.match(workflow, /full 40-character commit SHA/i);
  assert.match(workflow, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(workflow, /name:\s*Checkout release control/);
  assert.match(workflow, /name:\s*Checkout immutable source/);
  assert.match(workflow, /path:\s*release-control/);
  assert.match(workflow, /path:\s*source/);
  assert.match(workflow, /REPO_ROOT:/);
  assert.match(workflow, /export RELEASE_NOTES_FILE=/);
  assert.match(workflow, /name:\s*Verify immutable source provenance/);
  assert.match(workflow, /git rev-parse "\$tag\^\{commit\}"/);
  assert.match(workflow, /build-release-control-assets\.mjs/);
  assert.match(workflow, /--asset/);
});

test("release scripts honor explicit source and release-notes paths", () => {
  const releaseScript = readFileSync(path.join(repoRoot, "scripts/release.sh"), "utf8");
  const githubReleaseScript = readFileSync(path.join(repoRoot, "scripts/create-github-release.sh"), "utf8");

  assert.match(releaseScript, /if \[ -z "\$\{REPO_ROOT:-\}" \]/);
  assert.match(githubReleaseScript, /if \[ -z "\$\{REPO_ROOT:-\}" \]/);

  const explicitNotes = "/tmp/release-control/releases/v2026.827.0.md";
  const output = execFileSync(
    "bash",
    [
      "-c",
      '. "$1/scripts/release-lib.sh"; release_notes_file 2026.827.0',
      "bash",
      repoRoot,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        REPO_ROOT: repoRoot,
        RELEASE_NOTES_FILE: explicitNotes,
      },
    },
  ).trim();

  assert.equal(output, explicitNotes);
});

test("release branch guard permits previews but keeps live canaries on main", () => {
  const releaseScript = readFileSync(path.join(repoRoot, "scripts/release.sh"), "utf8");
  const tempRepo = mkdtempSync(path.join(tmpdir(), "agentdash-release-main-"));

  try {
    execFileSync("git", ["init", "-b", "main", tempRepo], { stdio: "ignore" });

    assert.match(releaseScript, /require_on_master_branch "\$dry_run"/);

    execFileSync(
      "bash",
      [
        "-c",
        '. "$1/scripts/release-lib.sh"; require_on_master_branch false',
        "bash",
        repoRoot,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, REPO_ROOT: tempRepo },
      },
    );

    execFileSync("git", ["-C", tempRepo, "switch", "-c", "feature"], { stdio: "ignore" });

    execFileSync(
      "bash",
      [
        "-c",
        '. "$1/scripts/release-lib.sh"; require_on_master_branch true',
        "bash",
        repoRoot,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, REPO_ROOT: tempRepo },
      },
    );

    assert.throws(
      () =>
        execFileSync(
          "bash",
          [
            "-c",
            '. "$1/scripts/release-lib.sh"; require_on_master_branch false',
            "bash",
            repoRoot,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, REPO_ROOT: tempRepo },
            stdio: "pipe",
          },
        ),
      /current branch is feature/,
    );
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("application release workflow cannot publish workspace npm packages", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.ok(
    [...workflow.matchAll(/args=\(stable --skip-verify --skip-npm/g)].length >= 2,
    "stable preview and publication must explicitly suppress npm publication",
  );
  assert.ok(
    [...workflow.matchAll(/version_args=\(stable --skip-npm --print-version\)/g)].length >= 3,
    "every stable version resolution must use the application-only release scope",
  );
  assert.match(workflow, /\.\/scripts\/release\.sh canary --skip-verify --skip-npm/);
  assert.match(rootManifest.scripts["release:canary"], /--skip-npm/);
  assert.match(rootManifest.scripts["release:stable"], /--skip-npm/);
});

test("connector workflow is scoped to the owned package and creates its GitHub release", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/publish-connect.yml"),
    "utf8",
  );

  assert.match(workflow, /working-directory:\s*packages\/connect/);
  assert.match(workflow, /agentdash-connect-v\*/);
  assert.match(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /^\s*(NODE_AUTH_TOKEN|NPM_TOKEN)\s*:/m);
  assert.doesNotMatch(workflow, /@paperclipai\/|@agentdash\//);
  assert.match(workflow, /name:\s*Create GitHub Release/);
  assert.match(workflow, /name:\s*Verify package release notes/);
  assert.match(workflow, /packages\/connect\/releases\/v\$\{PKG_VERSION\}\.md/);
  assert.match(workflow, /build-release-control-assets\.mjs/);
  assert.match(workflow, /--connect-package-dir packages\/connect/);
  assert.match(workflow, /agentdash-connect-v\$\{PKG_VERSION\}\.tgz\.sha256/);
  assert.match(workflow, /agentdash-connect-release-v\$\{PKG_VERSION\}\.json/);
  assert.match(workflow, /npm view .*dist\.integrity/);
  assert.match(workflow, /npm view .*gitHead/);
  assert.match(workflow, /REGISTRY_GIT_HEAD.*GITHUB_SHA/);

  const notesGate = workflow.indexOf("name: Verify package release notes");
  const livePublish = workflow.indexOf("name: Publish\n");
  assert.ok(notesGate >= 0 && notesGate < livePublish, "release notes must be verified before npm publish");
});

test("repo release skills preserve the AgentDash application/package boundary", () => {
  const releaseSkill = readFileSync(path.join(repoRoot, ".agents/skills/release/SKILL.md"), "utf8");
  const changelogSkill = readFileSync(
    path.join(repoRoot, ".agents/skills/release-changelog/SKILL.md"),
    "utf8",
  );

  for (const guidance of [releaseSkill, changelogSkill]) {
    assert.match(guidance, /agentdash-connect/);
    assert.match(guidance, /packages\/connect\/releases\/vX\.Y\.Z\.md/);
    assert.match(guidance, /--skip-npm/);
  }
});

test("release operator surfaces use main and pin the trusted-publishing npm client", () => {
  const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
  const connectorWorkflow = readFileSync(
    path.join(repoRoot, ".github/workflows/publish-connect.yml"),
    "utf8",
  );
  const releaseDoc = readFileSync(path.join(repoRoot, "doc/RELEASING.md"), "utf8");
  const releaseSkill = readFileSync(path.join(repoRoot, ".agents/skills/release/SKILL.md"), "utf8");

  assert.doesNotMatch(prWorkflow, /git checkout -B master/);
  assert.doesNotMatch(releaseDoc, /\bmaster\b/);
  assert.doesNotMatch(releaseSkill, /\bmaster\b/);
  assert.doesNotMatch(connectorWorkflow, /npm@latest/);
  assert.match(connectorWorkflow, /npm@11\.5\.1/);
});

test("application version resolution works with an empty npm package set", () => {
  const tempRepo = mkdtempSync(path.join(tmpdir(), "agentdash-app-release-version-"));
  const tempRemote = mkdtempSync(path.join(tmpdir(), "agentdash-app-release-remote-"));

  try {
    mkdirSync(path.join(tempRepo, "scripts"), { recursive: true });
    for (const file of ["release.sh", "release-lib.sh", "release-package-map.mjs"]) {
      copyFileSync(path.join(repoRoot, "scripts", file), path.join(tempRepo, "scripts", file));
    }

    execFileSync("git", ["init", "-b", "main", tempRepo], { stdio: "ignore" });
    execFileSync("git", ["init", "--bare", "-b", "main", tempRemote], { stdio: "ignore" });
    execFileSync("git", ["-C", tempRepo, "config", "user.name", "release-test"]);
    execFileSync("git", ["-C", tempRepo, "config", "user.email", "release-test@example.invalid"]);
    execFileSync("git", ["-C", tempRepo, "add", "."]);
    execFileSync("git", ["-C", tempRepo, "commit", "-m", "fixture"], { stdio: "ignore" });
    execFileSync("git", ["-C", tempRepo, "remote", "add", "origin", tempRemote]);
    execFileSync("git", ["-C", tempRepo, "push", "-u", "origin", "main"], { stdio: "ignore" });

    const version = execFileSync(
      "bash",
      ["scripts/release.sh", "stable", "--skip-npm", "--date", "2026-08-27", "--print-version"],
      { cwd: tempRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    assert.equal(version, "2026.827.0");

    execFileSync("git", ["-C", tempRepo, "tag", "v2026.827.0"]);
    execFileSync("git", ["-C", tempRepo, "push", "origin", "refs/tags/v2026.827.0"], {
      stdio: "ignore",
    });

    const nextStable = execFileSync(
      "bash",
      ["scripts/release.sh", "stable", "--skip-npm", "--date", "2026-08-27", "--print-version"],
      { cwd: tempRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    assert.equal(nextStable, "2026.827.1");

    execFileSync("git", ["-C", tempRepo, "tag", "canary/v2026.827.1-canary.0"]);
    execFileSync(
      "git",
      ["-C", tempRepo, "push", "origin", "refs/tags/canary/v2026.827.1-canary.0"],
      { stdio: "ignore" },
    );

    const nextCanary = execFileSync(
      "bash",
      ["scripts/release.sh", "canary", "--skip-npm", "--date", "2026-08-27", "--print-version"],
      { cwd: tempRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    assert.equal(nextCanary, "2026.827.1-canary.1");
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
    rmSync(tempRemote, { recursive: true, force: true });
  }
});
