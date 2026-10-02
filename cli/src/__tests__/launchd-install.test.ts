import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const installScriptPath = path.join(repoRoot, "docker/launchd/install.sh");
const plistTemplatePath = path.join(repoRoot, "docker/launchd/ai.agentdash.agent.plist");

describe("macOS launchd installer", () => {
  it("runs the service from a built source checkout with claude_api + heartbeat-off defaults", () => {
    const installScript = readFileSync(installScriptPath, "utf8");
    const plistTemplate = readFileSync(plistTemplatePath, "utf8");

    expect(installScript).toContain("APP_DIR=");
    expect(installScript).toContain('"$PNPM_BIN" install --frozen-lockfile');
    expect(installScript).toContain('"$PNPM_BIN" build');
    expect(installScript).toContain("docker exec agentdash-pg pg_isready");
    expect(installScript).toContain("service_loaded()");
    expect(installScript).toContain("'$3 == label");
    expect(installScript).toContain("NODE_ENV=production");
    // claude_api is the customer default (degrades to stub replies with no key,
    // no crash-loop); the customer wires a real key during onboarding. Heartbeat
    // is OFF until the team is confirmed so nothing spawns before a model exists.
    expect(installScript).toContain("AGENTDASH_DEFAULT_ADAPTER=claude_api");
    expect(installScript).toContain("HEARTBEAT_SCHEDULER_ENABLED=false");
    expect(plistTemplate).toContain("%%APP_DIR%%");
    expect(plistTemplate).toContain("--filter @paperclipai/server exec tsx src/index.ts");
  });

  it("detects and disables a broken legacy com.paperclip.server plist before installing", () => {
    const installScript = readFileSync(installScriptPath, "utf8");

    expect(installScript).toContain("LEGACY_PLIST_DST=");
    expect(installScript).toContain("com.paperclip.server.plist");
    expect(installScript).toContain("LEGACY_WRAPPER=");
    expect(installScript).toContain("paperclip-launchd.sh");
    expect(installScript).toContain("LEGACY_LABEL=");
    expect(installScript).toContain("com.paperclip.server");
    // The remediation function must be defined and invoked (the bare
    // "name\n" only matches the call site, not the definition).
    expect(installScript).toContain("disable_broken_legacy_service()");
    expect(installScript).toContain("disable_broken_legacy_service\n");
    // bootout is what disarms a loaded service; a plist that merely lost its
    // wrapper would otherwise be re-bootstrapped by launchd at next login.
    expect(installScript).toContain("launchctl bootout");
    // Moved aside, not deleted, so the machine's history stays inspectable.
    expect(installScript).toContain(".migrated.bak");
  });
});

/**
 * GH #347 regression: on a machine migrated from a pre-AgentDash Paperclip
 * install, ~/Library/LaunchAgents/com.paperclip.server.plist can point at a
 * missing ~/.paperclip/paperclip-launchd.sh. install.sh must boot the legacy
 * service out and set the plist aside instead of proceeding with the broken
 * legacy service still enabled.
 *
 * The behavioral tests below run the real docker/launchd/install.sh inside a
 * sandboxed HOME: a staged fake checkout (so AGENTDASH_INSTALL_SKIP_BUILD can
 * skip pnpm install/build), a fake psql that satisfies the Postgres check, and
 * a fake launchctl that records every call. Nothing here touches the real
 * launchd domain, the real HOME, or the real workspace build.
 */
describe("legacy plist remediation (GH #347 regression)", () => {
  // Directories created for one installer run, removed in afterAll.
  const sandboxDirs: string[] = [];

  function writeExecutable(file: string, body: string): void {
    writeFileSync(file, body, { mode: 0o755 });
  }

  function makeFakeLaunchctl(callLog: string): string {
    const ctlDir = mkdtempSync(path.join(os.tmpdir(), "launchd-install-test-launchctl-"));
    sandboxDirs.push(ctlDir);
    const fake = path.join(ctlDir, "launchctl");
    writeExecutable(
      fake,
      [
        "#!/bin/bash",
        `echo "$@" >> ${JSON.stringify(callLog)}`,
        "case \"$1\" in",
        "  list)",
        // Mimic real `launchctl list` rows: PID, last exit status, label.
        "    for l in $FAKE_LOADED_LABELS; do printf '%s\\t0\\t%s\\n' \"-\" \"$l\"; done",
        "    exit 0 ;;",
        "  bootout) exit 0 ;;",
        "  unload) exit 0 ;;",
        "  load) exit 0 ;;",
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    return ctlDir;
  }

  interface SandboxRun {
    status: number | null;
    stdout: string;
    stderr: string;
    home: string;
    legacyPlist: string;
    legacyWrapper: string;
    launchctlCalls: string;
  }

  function runInstallerInSandbox(opts: {
    legacyWrapperExists: boolean;
    /** Plant a plist whose target is a healthy unrelated executable instead of the legacy wrapper. */
    healthyTarget?: boolean;
  }): SandboxRun {
    const home = mkdtempSync(path.join(os.tmpdir(), "launchd-install-test-home-"));
    sandboxDirs.push(home);
    const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgentsDir, { recursive: true });

    // Fake psql: the Postgres pre-flight passes without a database.
    const binDir = path.join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "psql"), "#!/bin/sh\nexit 0\n");
    const callLog = path.join(home, "launchctl-calls.log");
    const ctlDir = makeFakeLaunchctl(callLog);

    // Stage a fake checkout so install.sh's SCRIPT_DIR/APP_DIR live inside the
    // sandbox and the skip-build hook finds an already-"built" tree.
    const stagedRepo = mkdtempSync(path.join(os.tmpdir(), "launchd-install-test-repo-"));
    sandboxDirs.push(stagedRepo);
    const stagedLaunchdDir = path.join(stagedRepo, "docker", "launchd");
    mkdirSync(stagedLaunchdDir, { recursive: true });
    copyFileSync(installScriptPath, path.join(stagedLaunchdDir, "install.sh"));
    copyFileSync(plistTemplatePath, path.join(stagedLaunchdDir, "ai.agentdash.agent.plist"));
    mkdirSync(path.join(stagedRepo, "server", "dist"), { recursive: true });
    mkdirSync(path.join(stagedRepo, "ui", "dist"), { recursive: true });
    writeFileSync(path.join(stagedRepo, "ui", "dist", "index.html"), "<html></html>\n");

    // Plant the legacy plist exactly as a migrated machine would have it.
    const legacyPlist = path.join(launchAgentsDir, "com.paperclip.server.plist");
    const legacyWrapper = path.join(home, ".paperclip", "paperclip-launchd.sh");
    // A healthy, unrelated target proves the content check: a same-named
    // plist that does not reference the legacy wrapper must be left alone.
    const plistTarget = opts.healthyTarget
      ? path.join(home, "bin", "unrelated-healthy-service.sh")
      : legacyWrapper;
    writeFileSync(
      legacyPlist,
      [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\">",
        "<dict>",
        "  <key>Label</key><string>com.paperclip.server</string>",
        "  <key>ProgramArguments</key>",
        `  <array><string>/bin/bash</string><string>${plistTarget}</string></array>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
    if (opts.legacyWrapperExists) {
      mkdirSync(path.dirname(legacyWrapper), { recursive: true });
      writeExecutable(legacyWrapper, "#!/bin/sh\nexit 0\n");
    }
    if (opts.healthyTarget) {
      writeExecutable(plistTarget, "#!/bin/sh\nexit 0\n");
    }

    const result = spawnSync("/bin/bash", [path.join(stagedLaunchdDir, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${ctlDir}:${process.env.PATH ?? ""}`,
        FAKE_LOADED_LABELS: "com.paperclip.server ai.agentdash.agent",
        AGENTDASH_INSTALL_SKIP_BUILD: "1",
      },
    });

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      home,
      legacyPlist,
      legacyWrapper,
      launchctlCalls: existsSync(callLog) ? readFileSync(callLog, "utf8") : "",
    };
  }

  it("boots out and sets aside a legacy plist that points at a missing wrapper", () => {
    const run = runInstallerInSandbox({ legacyWrapperExists: false });

    expect(
      [run.stderr, run.stdout].filter((s) => s.length > 0).join("\n--- stdout ---\n"),
      "install.sh failed inside the sandbox",
    ).toMatch("");
    expect(run.status).toBe(0);

    // The legacy service was booted out of the gui domain — not left loaded
    // to fight the new ai.agentdash.agent service over the port.
    expect(run.launchctlCalls).toContain("bootout");
    expect(run.launchctlCalls).toContain("com.paperclip.server");

    // The plist was moved aside (nothing for launchd to re-bootstrap at next
    // login) under the .migrated.bak name, not deleted.
    expect(existsSync(run.legacyPlist)).toBe(false);
    const siblings = readdirSync(path.dirname(run.legacyPlist));
    expect(
      siblings.some((name) => name.startsWith("com.paperclip.server.plist.migrated.bak")),
      `expected a .migrated.bak sibling, got: ${siblings.join(", ")}`,
    ).toBe(true);

    // The new service still went on to load.
    expect(run.launchctlCalls).toContain("ai.agentdash.agent.plist");
  }, 60000);

  it("leaves a legacy plist alone when its wrapper still exists", () => {
    const run = runInstallerInSandbox({ legacyWrapperExists: true });

    expect(run.status).toBe(0);
    expect(existsSync(run.legacyPlist)).toBe(true);
    // No bootout, no move: the legacy service is somebody's working setup.
    expect(run.launchctlCalls).not.toContain("com.paperclip.server");
    expect(readdirSync(path.dirname(run.legacyPlist)).some((name) => name.includes(".migrated.bak"))).toBe(false);
  }, 60000);

  it("leaves a legacy plist with a healthy unrelated target alone (no false positive)", () => {
    const run = runInstallerInSandbox({ legacyWrapperExists: false, healthyTarget: true });

    expect(run.status).toBe(0);
    // The same-named plist targets a healthy executable, not the legacy
    // wrapper — it is not ours to remove.
    expect(existsSync(run.legacyPlist)).toBe(true);
    expect(run.launchctlCalls).not.toContain("bootout gui/");
    expect(run.launchctlCalls).not.toContain("com.paperclip.server");
    expect(readdirSync(path.dirname(run.legacyPlist)).some((name) => name.includes(".migrated.bak"))).toBe(false);
  }, 60000);

  afterAll(() => {
    for (const dir of sandboxDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
