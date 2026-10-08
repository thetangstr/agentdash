// AgentDash: execute the parsed release gate and the selected source's actual
// test runner. Fixtures have no credentials, network, providers or database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const controlRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceRoot = process.env.RELEASE_SOURCE_ROOT ?? controlRoot;
const workflow = parse(readFileSync(path.join(controlRoot, ".github/workflows/release.yml"), "utf8"));
const jobs = workflow.jobs;

function step(job, name) {
  const found = job.steps.find((entry) => entry.name === name);
  assert.ok(found, `missing step ${name}`);
  return found;
}

test("stable shards and build verify the same immutable source, preserving publication dependencies", () => {
  const shards = jobs.verify_stable_shard;
  assert.deepEqual(shards.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(shards.strategy["fail-fast"], false);
  assert.deepEqual(shards.env, { SHARD_INDEX: "${{ matrix.shard }}", SHARD_COUNT: 4 });
  for (const job of [shards, jobs.verify_stable_build]) {
    assert.equal(job.if, "github.event_name == 'workflow_dispatch'");
    assert.deepEqual(job.permissions, { contents: "read" });
    assert.equal(job["continue-on-error"], undefined);
    for (const entry of job.steps) {
      assert.equal(entry["continue-on-error"], undefined);
      assert.equal(entry.if, undefined, `${entry.name} cannot silently skip a gate`);
    }
    assert.equal(step(job, "Checkout immutable source").with.ref, "${{ inputs.source_ref }}");
    assert.equal(step(job, "Checkout immutable source").with.path, "source");
    assert.equal(step(job, "Checkout release control").with.path, "release-control");
    assert.equal(step(job, "Checkout release control").with.ref, "${{ github.sha }}");
    assert.match(step(job, "Require immutable source SHA").run, /\^\[0-9a-fA-F\]\{40\}\$/);
    assert.equal(step(job, "Verify immutable source provenance").env.SOURCE_REF, "${{ inputs.source_ref }}");
    for (const entry of job.steps.filter((entry) => entry.run && /pnpm (?:test:run|typecheck|build|run test:regression)/.test(entry.run))) {
      assert.equal(entry["working-directory"], "source");
    }
  }
  assert.equal(step(shards, "Run tests (shard ${{ matrix.shard }} of 4)").run, "pnpm test:run");
  assert.equal(step(jobs.verify_stable_build, "Typecheck").run, "pnpm typecheck");
  assert.equal(step(jobs.verify_stable_build, "Run Hermes onboarding regression lane").run, "pnpm run test:regression:hermes-onboarding");
  assert.equal(step(jobs.verify_stable_build, "Build").run, "pnpm build");
  const controlTests = step(jobs.verify_stable_build, "Test release-control gates and shard coverage");
  assert.equal(controlTests["working-directory"], "release-control");
  assert.equal(controlTests.env.RELEASE_SOURCE_ROOT, "${{ github.workspace }}/source");
  const controlInstall = step(jobs.verify_stable_build, "Install release-control test dependencies");
  assert.equal(controlInstall["working-directory"], "release-control");
  assert.equal(controlInstall.run, "pnpm install --filter . --no-frozen-lockfile --ignore-scripts");
  assert.ok(jobs.verify_stable_build.steps.indexOf(controlInstall) < jobs.verify_stable_build.steps.indexOf(controlTests));
  assert.deepEqual(jobs.verify_stable.needs, ["verify_stable_shard", "verify_stable_build"]);
  assert.equal(jobs.verify_stable.if, "always() && github.event_name == 'workflow_dispatch'");
  assert.deepEqual(jobs.verify_stable.permissions, {});
  for (const name of ["publish_stable", "preview_stable"]) assert.equal(jobs[name].needs, "verify_stable");
  assert.equal(jobs.publish_stable.environment, "npm-stable");
  assert.equal(jobs.preview_stable.if, "github.event_name == 'workflow_dispatch' && inputs.dry_run");
  assert.equal(jobs.publish_stable.if, "github.event_name == 'workflow_dispatch' && !inputs.dry_run");
  assert.equal(jobs.publish_canary.needs, "verify_canary");
  assert.equal(jobs.verify_canary.if, "github.event_name == 'push'");
  assert.ok(jobs.verify_canary.steps.some((entry) => entry.run === "pnpm test:run"));
  assert.equal(jobs.verify_canary.env?.SHARD_COUNT, undefined);
});

test("actual aggregate shell accepts only success/success, including cancelled and skipped results", () => {
  const gate = step(jobs.verify_stable, "Require every shard and the build to have passed");
  assert.deepEqual(gate.env, { SHARDS: "${{ needs.verify_stable_shard.result }}", BUILD: "${{ needs.verify_stable_build.result }}" });
  for (const shards of ["success", "failure", "cancelled", "skipped", ""]) {
    for (const build of ["success", "failure", "cancelled", "skipped", ""]) {
      const result = spawnSync("bash", ["-e", "-c", gate.run], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", SHARDS: shards, BUILD: build } });
      assert.equal(result.status === 0, shards === "success" && build === "success", `${shards}/${build}: ${result.stderr}`);
    }
  }
});

test("immutable-source validation rejects branches and malformed or substituted SHA input", () => {
  for (const name of ["verify_stable_shard", "verify_stable_build"]) {
    const script = step(jobs[name], "Require immutable source SHA").run;
    for (const [input, accepted] of [["a".repeat(40), true], ["ABCDEF".repeat(6) + "ABCD", true], ["main", false], ["a".repeat(39), false], ["a".repeat(41), false], ["$(touch sentinel)", false], ["", false]]) {
      const result = spawnSync("bash", ["-e", "-c", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", SOURCE_REF: input } });
      assert.equal(result.status === 0, accepted, `${name}: ${input}`);
    }
  }
});

test("four workflow shards cover the source runner's complete unsharded inventory exactly once", (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "agentdash-release-shards-"));
  try {
    const bin = path.join(fixture, "bin");
    mkdirSync(bin);
    const fakePnpm = path.join(bin, "pnpm");
    writeFileSync(fakePnpm, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
    chmodSync(fakePnpm, 0o755);
    const run = (index, count) => {
      const calls = path.join(fixture, `calls-${index}-${count}.jsonl`);
      const result = spawnSync(process.execPath, [path.join(sourceRoot, "scripts/run-vitest-stable.mjs")], {
        cwd: sourceRoot, encoding: "utf8", timeout: 60_000,
        env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: fixture, TMPDIR: fixture, CALLS: calls, SHARD_INDEX: String(index), SHARD_COUNT: String(count) },
      });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    };
    const baseline = run(1, 1);
    assert.ok(baseline.length > 1);
    const parts = jobs.verify_stable_shard.strategy.matrix.shard.map((index) => run(index, jobs.verify_stable_shard.env.SHARD_COUNT));
    const actual = parts.flat();
    t.diagnostic(`source inventory: ${baseline.length} invocations; shard sizes: ${parts.map((part) => part.length).join(", ")}`);
    const sorted = (calls) => calls.map((args) => JSON.stringify(args)).sort();
    // Older source runners that ignore SHARD_* repeat the full suite per job.
    const supportsShards = existsSync(path.join(sourceRoot, "scripts/lib/shard.mjs"));
    assert.deepEqual(sorted(actual), sorted(supportsShards ? baseline : Array.from({ length: 4 }, () => baseline).flat()));
    assert.equal(new Set(baseline.map((args) => JSON.stringify(args))).size, baseline.length);
    const bulk = baseline.find((args) => args.includes("@paperclipai/server") && args.includes("--exclude"));
    assert.ok(bulk, "server bulk must run");
    const exclusions = bulk.flatMap((arg, index) => arg === "--exclude" ? [bulk[index + 1]] : []).sort();
    const serialized = baseline.flatMap((args) => args.filter((arg) => arg.startsWith("server/") && arg.endsWith(".test.ts"))).map((name) => name.slice("server/".length)).sort();
    assert.deepEqual(exclusions, serialized, "every excluded suite must run separately");
    const config = readFileSync(path.join(sourceRoot, "vitest.config.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
    const projects = [...config.match(/projects:\s*\[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const expectedNames = projects.filter((name) => name !== "server").map((name) => JSON.parse(readFileSync(path.join(sourceRoot, name, "package.json"), "utf8")).name).sort();
    const executedNames = baseline.filter((args) => !args.includes("@paperclipai/server")).map((args) => args[args.indexOf("--project") + 1]).sort();
    assert.deepEqual(executedNames, expectedNames, "every configured non-server project must run");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});


test("actual stable preview uses separate control notes and leaves local source/remote without a release tag", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "agentdash-release-preview-"));
  try {
    const source = path.join(fixture, "source");
    const control = path.join(fixture, "release-control");
    const remote = path.join(fixture, "remote.git");
    const bin = path.join(fixture, "bin");
    for (const directory of [source, path.join(control, "scripts"), path.join(control, "releases"), bin]) mkdirSync(directory, { recursive: true });
    for (const name of ["release.sh", "release-lib.sh", "release-package-map.mjs"]) {
      const target = path.join(control, "scripts", name);
      copyFileSync(path.join(controlRoot, "scripts", name), target);
      chmodSync(target, 0o755);
    }
    writeFileSync(path.join(control, "releases/v2026.1008.0.md"), "# Reviewed fixture release\n");
    writeFileSync(path.join(source, "README.md"), "synthetic application source\n");
    const calls = path.join(fixture, "calls.jsonl");
    for (const command of ["pnpm", "npm", "gh"]) {
      const target = path.join(bin, command);
      writeFileSync(target, `#!${process.execPath}\nconst args=process.argv.slice(2); require('node:fs').appendFileSync(process.env.CALLS, JSON.stringify([${JSON.stringify(command)},...args]) + '\\n'); if (${JSON.stringify(command)} !== 'pnpm' || JSON.stringify(args) !== '["build"]') process.exit(99);\n`);
      chmodSync(target, 0o755);
    }
    const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: fixture, TMPDIR: fixture, CALLS: calls, REPO_ROOT: source, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file" };
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: fixture, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "--bare", "--initial-branch=main", remote]);
    git(["init", "--initial-branch=main", source]);
    git(["-C", source, "config", "user.name", "release-fixture"]);
    git(["-C", source, "config", "user.email", "fixture@example.invalid"]);
    git(["-C", source, "add", "."]);
    git(["-C", source, "commit", "-m", "fixture"]);
    git(["-C", source, "remote", "add", "origin", remote]);
    git(["-C", source, "push", "origin", "main"]);
    const sourceSha = git(["-C", source, "rev-parse", "HEAD"]);
    const script = step(jobs.preview_stable, "Dry-run stable release").run.replaceAll("${{ github.workspace }}", fixture).replaceAll("${{ inputs.stable_date }}", "2026-10-08");
    const result = spawnSync("bash", ["-e", "-c", script], { cwd: fixture, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run complete for stable 2026\.1008\.0/);
    assert.ok(result.stdout.includes(`Would create git tag v2026.1008.0 on ${sourceSha}`));
    assert.ok(result.stdout.includes(path.join(control, "releases/v2026.1008.0.md")));
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse), [["pnpm", "build"]]);
    assert.equal(git(["-C", source, "tag", "--list"]), "");
    assert.equal(git(["-C", source, "ls-remote", "--tags", "origin"]), "");
    assert.equal(git(["-C", source, "status", "--porcelain"]), "");
    assert.equal(git(["-C", source, "rev-parse", "HEAD"]), sourceSha);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
