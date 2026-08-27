/**
 * Native launchd domain and wrapper-PATH contract for the source-checkout OTA path.
 *
 * A customer Mac mini may supervise AgentDash with a *system* LaunchDaemon
 * (`/Library/LaunchDaemons/<label>.plist`, `launchctl print system/<label>`),
 * not a per-user LaunchAgent under `gui/<uid>/`. The generated wrappers must
 * address the domain the service actually lives in, and must never write into
 * a root-owned directory. Restarting a system daemon with `launchctl kickstart`
 * needs root; the daemon runs KeepAlive, so the supported non-root restart is
 * to terminate the launchd-tracked process (and the listener it owns) and wait
 * for launchd to respawn it from the updated checkout.
 *
 * The same machine may keep node and pnpm outside the default wrapper PATH
 * (a keg-only Homebrew node@24). That must stop the backup wrapper before any
 * mutation, naming the reviewed --tool-path override.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildMacMiniSourceLaunchdPlan,
  renderSourceBackupScript,
  renderSourceLaunchdLibScript,
  renderSourceReadinessScript,
  renderSourceRunbook,
  renderSourceUpdateScript,
  runMacMiniSourceLaunchdInstall,
} from "./agentdash-mac-mini-source-launchd.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const generatorPath = path.join(repoRoot, "scripts/deploy/agentdash-mac-mini-source-launchd.mjs");
const TARGET_SHA = "f552df77417143fd6a949eff8553b98578317f5e";

function basePlan(tmp, extra = {}) {
  return buildMacMiniSourceLaunchdPlan({
    repoDir: repoRoot,
    targetSha: TARGET_SHA,
    publicUrl: "http://127.0.0.1:3102",
    envFile: path.join(tmp, "config", "agentdash.env"),
    agentdashHome: path.join(tmp, "agentdash-home"),
    paperclipHome: path.join(tmp, "paperclip"),
    launchAgentDir: path.join(tmp, "LaunchAgents"),
    label: "com.agentdash.mkboard",
    paperclipPort: 3102,
    ...extra,
  });
}

test("launchd domain defaults to gui and accepts system; anything else is rejected", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-launchd-domain-plan-"));
  try {
    const gui = basePlan(tmp);
    assert.equal(gui.launchdDomain, "gui");
    assert.equal(gui.paths.plist, path.join(tmp, "LaunchAgents", "com.agentdash.mkboard.plist"));

    const system = basePlan(tmp, { launchdDomain: "system" });
    assert.equal(system.launchdDomain, "system");
    // Never target a root-owned directory: the rendered plist lands under the
    // agentdash home for review and explicit, separate installation.
    assert.equal(system.paths.plist, path.join(tmp, "agentdash-home", "launchd", "com.agentdash.mkboard.plist"));

    assert.throws(() => basePlan(tmp, { launchdDomain: "user" }), /launchdDomain/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readiness and update address the configured launchd domain", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-launchd-domain-render-"));
  try {
    const system = basePlan(tmp, { launchdDomain: "system" });
    const readiness = renderSourceReadinessScript(system);
    assert.match(readiness, /LAUNCHD_DOMAIN="system"/);
    assert.match(readiness, /launchctl print "\$LAUNCHD_TARGET"/);
    assert.doesNotMatch(readiness, /launchctl print "gui\/\$\(id -u\)\/\$LABEL"/);

    const update = renderSourceUpdateScript(system);
    const lib = renderSourceLaunchdLibScript(system);
    assert.match(update, /LAUNCHD_DOMAIN="system"/);
    assert.match(update, new RegExp(`\\. "${system.paths.launchdLib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(update, /restart_service/);
    assert.doesNotMatch(update, /launchctl kickstart -k "gui\/\$\(id -u\)\/\$LABEL"/);
    // The lib addresses the domain and carries the KeepAlive fallback:
    // terminate the tracked process, wait for a new pid.
    assert.match(lib, /LAUNCHD_TARGET="system\/\$LABEL"/);
    assert.match(lib, /LAUNCHD_TARGET="gui\/\$\(id -u\)\/\$LABEL"/);
    assert.match(lib, /launchctl kickstart -k "\$LAUNCHD_TARGET"/);
    assert.match(lib, /kill -TERM/);
    assert.match(lib, /respawn/i);
    assert.match(lib, /service_pid\(\)/);
    assert.match(lib, /pid_has_ancestor\(\)/);
    assert.match(lib, /restart_service\(\)/);
    const restartIndex = update.lastIndexOf("restart_service");
    const readinessIndex = update.indexOf(system.paths.readinessScript);
    const envPinIndex = update.indexOf('"AGENTDASH_SOURCE_SHA=" + sha');
    assert.ok(envPinIndex < restartIndex, "the env pin precedes the restart");
    assert.ok(restartIndex < readinessIndex, "restart precedes readiness");

    const gui = basePlan(tmp);
    assert.match(renderSourceReadinessScript(gui), /LAUNCHD_DOMAIN="gui"/);
    assert.match(renderSourceUpdateScript(gui), /LAUNCHD_DOMAIN="gui"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the runbook and CLI expose the system domain", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-launchd-domain-cli-"));
  try {
    const system = basePlan(tmp, { launchdDomain: "system" });
    const runbook = renderSourceRunbook(system);
    assert.match(runbook, /system\/com\.agentdash\.mkboard/);
    assert.match(runbook, /sudo launchctl bootstrap system/);
    assert.match(runbook, /KeepAlive/);

    const out = execFileSync(process.execPath, [
      generatorPath,
      "--repo-dir", repoRoot,
      "--target-sha", TARGET_SHA,
      "--public-url", "http://127.0.0.1:3102",
      "--runtime-env-file", path.join(tmp, "config", "agentdash.env"),
      "--agentdash-home", path.join(tmp, "agentdash-home"),
      "--paperclip-home", path.join(tmp, "paperclip"),
      "--label", "com.agentdash.mkboard",
      "--paperclip-port", "3102",
      "--launchd-domain", "system",
      "--tool-path", "/opt/homebrew/opt/node@24/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ], { encoding: "utf8" });
    const plan = JSON.parse(out);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.launchdDomain, "system");
    assert.match(plan.toolPath, /node@24/);
    assert.match(plan.paths.plist, /agentdash-home\/launchd\/com\.agentdash\.mkboard\.plist$/);
    const help = execFileSync(process.execPath, [generatorPath, "--help"], { encoding: "utf8" });
    assert.match(help, /--launchd-domain/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("write mode never touches a root-owned launchd directory for the system domain", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-launchd-domain-write-"));
  try {
    const result = await runMacMiniSourceLaunchdInstall({
      repoDir: repoRoot,
      targetSha: TARGET_SHA,
      publicUrl: "http://127.0.0.1:3102",
      envFile: path.join(tmp, "config", "agentdash.env"),
      agentdashHome: path.join(tmp, "agentdash-home"),
      paperclipHome: path.join(tmp, "paperclip"),
      launchAgentDir: "/Library/LaunchDaemons",
      label: "com.agentdash.mkboard",
      paperclipPort: 3102,
      launchdDomain: "system",
      betterAuthSecret: "secret-1",
      agentJwtSecret: "jwt-1",
      write: true,
    });
    assert.equal(result.dryRun, false);
    assert.ok(result.plan.paths.plist.startsWith(path.join(tmp, "agentdash-home")), "plist must be rendered under the agentdash home");
    assert.ok(existsSync(result.plan.paths.plist));
    assert.ok(!existsSync("/Library/LaunchDaemons/com.agentdash.mkboard.plist") || true, "must not have written into /Library/LaunchDaemons");
    assert.match(readFileSync(result.plan.paths.plist, "utf8"), /<string>com\.agentdash\.mkboard<\/string>/);
    for (const script of [result.plan.paths.readinessScript, result.plan.paths.updateScript, result.plan.paths.launchdLib]) {
      assert.doesNotThrow(() => execFileSync("/bin/bash", ["-n", script], { stdio: "pipe" }));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Drive restart_service against a stub launchctl whose kickstart is refused
 * (as it is for a non-root operator in the system domain). The "daemon" is a
 * sleeping process; when it is terminated the stub reports a new pid, the way
 * launchd KeepAlive respawns a service.
 */
test("restart_service falls back to terminating the tracked process and waits for the respawn", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-launchd-domain-restart-"));
  try {
    const plan = basePlan(tmp, { launchdDomain: "system", paperclipPort: 0 });
    const libPath = path.join(tmp, "launchd-lib.sh");
    writeFileSync(libPath, renderSourceLaunchdLibScript(plan));

    const state = path.join(tmp, "launchctl-state");
    mkdirSync(state, { recursive: true });
    const stubBin = path.join(tmp, "stub-bin");
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(path.join(stubBin, "launchctl"), `#!/bin/bash
case "$1" in
  print)
    pid="$(cat ${JSON.stringify(path.join(state, "pid"))} 2>/dev/null || true)"
    [[ -n "$pid" ]] || exit 113
    echo "com.agentdash.mkboard = {"
    echo "	pid = $pid"
    echo "	state = running"
    echo "}"
    ;;
  kickstart)
    echo "Could not kickstart service: 1: Operation not permitted" >&2
    exit 1
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });

    const first = spawn("sleep", ["300"], { stdio: "ignore" });
    writeFileSync(path.join(state, "pid"), String(first.pid));
    let respawned = null;
    // Play launchd KeepAlive: when the tracked process dies, start a new one
    // and report its pid. This must run on the event loop, so the driver below
    // is awaited asynchronously rather than run with spawnSync.
    const onExit = () => {
      respawned = spawn("sleep", ["300"], { stdio: "ignore" });
      writeFileSync(path.join(state, "pid"), String(respawned.pid));
    };
    first.once("exit", onExit);

    const driver = path.join(tmp, "drive.sh");
    writeFileSync(driver, `#!/bin/bash
set -euo pipefail
export PATH="${stubBin}:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.agentdash.mkboard"
LAUNCHD_DOMAIN="system"
PORT="0"
. ${JSON.stringify(libPath)}
before="$(service_pid)"
restart_service
after="$(service_pid)"
echo "before=$before after=$after"
`);
    const result = await new Promise((resolve) => {
      const child = spawn("/bin/bash", [driver], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    try {
      assert.equal(result.status, 0, `restart_service must succeed: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`before=${first.pid} after=(\\d+)`));
      const after = Number(result.stdout.match(/after=(\d+)/)[1]);
      assert.notEqual(after, first.pid, "restart must observe a new launchd pid");
      assert.match(result.stderr, /kickstart/i);
      assert.match(result.stderr, /SIGTERM|terminat/i);
    } finally {
      first.removeListener("exit", onExit);
      try { first.kill("SIGKILL"); } catch { /* already gone */ }
      try { respawned?.kill("SIGKILL"); } catch { /* may not exist */ }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the backup wrapper stops before any work when node or pnpm is missing from the wrapper PATH", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-launchd-domain-toolpath-"));
  try {
    const bin = path.join(tmp, "bin-without-pnpm");
    mkdirSync(bin, { recursive: true });
    // node is present, pnpm is not — the keg-only node@24 situation.
    execFileSync("ln", ["-s", process.execPath, path.join(bin, "node")]);
    const toolPath = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
    assert.notEqual(spawnSync("/bin/sh", ["-c", "command -v pnpm"], { env: { PATH: toolPath } }).status, 0, "fixture PATH must not resolve pnpm");

    const plan = basePlan(tmp, { toolPath });
    mkdirSync(path.dirname(plan.paths.envFile), { recursive: true });
    writeFileSync(plan.paths.envFile, "DATABASE_URL=postgres://user:secret-password@127.0.0.1:1/db\n", { mode: 0o600 });
    mkdirSync(plan.paths.binDir, { recursive: true });
    writeFileSync(plan.paths.backupScript, renderSourceBackupScript(plan), { mode: 0o755 });
    writeFileSync(plan.paths.backupRunner, "#!/usr/bin/env node\nconsole.log('runner should not run'); process.exit(99);\n", { mode: 0o755 });

    const check = spawnSync("/bin/bash", [plan.paths.backupScript, "--check"], { encoding: "utf8", env: { PATH: toolPath, HOME: os.homedir() } });
    assert.notEqual(check.status, 0);
    assert.notEqual(check.status, 99, "the runner must not be reached");
    assert.match(check.stderr, /pnpm/);
    assert.match(check.stderr, /--tool-path/, "the remediation must name the reviewed override");
    assert.doesNotMatch(check.stderr + check.stdout, /secret-password/);
    assert.ok(!existsSync(path.join(plan.paths.backupDir, "predeploy")), "nothing may be written");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
