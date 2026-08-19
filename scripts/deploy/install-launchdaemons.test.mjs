import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
  "deploy",
  "install-launchdaemons.sh",
);

/**
 * A stand-in for `launchctl` that records what it was asked to do.
 *
 * `loaded` names the labels it should claim are already running, which is the
 * state this script kept getting wrong: `bootstrap` on an already-loaded
 * service answers "Bootstrap failed: 5: Input/output error", and `set -e`
 * turned that into an aborted run where every later label silently never
 * installed. It happened installing the TLS daemon, and again on 2026-08-19,
 * where the update job was the casualty.
 */
function makeHarness({ loaded = [], bootstrapFails = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "launchdaemons-test-"));
  const staged = path.join(root, "staged");
  const daemons = path.join(root, "LaunchDaemons");
  const agents = path.join(root, "LaunchAgents");
  const callLog = path.join(root, "calls.log");
  for (const dir of [staged, daemons, agents]) mkdirSync(dir, { recursive: true });

  const fake = path.join(root, "launchctl");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(callLog)}`,
      "is_loaded() {",
      // A label that has been booted out is gone, the way launchd behaves.
      // Without this the script's wait-for-unload loop spins its full timeout
      // and the test passes slowly for the wrong reason.
      `  [ -f ${JSON.stringify(root)}/booted-$1 ] && return 1`,
      "  for l in $LOADED_LABELS; do [ \"$1\" = \"$l\" ] && return 0; done",
      "  return 1",
      "}",
      "case \"$1\" in",
      "  print) is_loaded \"${2#system/}\" && exit 0; exit 1 ;;",
      `  bootout) case "$2" in system/*) touch ${JSON.stringify(root)}/booted-\${2#system/} ;; esac; exit 0 ;;`,
      "  bootstrap)",
      "    [ \"$BOOTSTRAP_FAILS\" = \"1\" ] && exit 5",
      "    label=$(basename \"$3\" .plist)",
      // launchd answers a bootstrap of an already-loaded label with error 5,
      // which is the exact behaviour this script kept treating as fatal.
      "    is_loaded \"$label\" && exit 5",
      "    exit 0 ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const childEnv = {
    LOADED_LABELS: loaded.join(" "),
    BOOTSTRAP_FAILS: bootstrapFails ? "1" : "0",
  };

  return {
    root,
    staged,
    daemons,
    agents,
    calls: () => (existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean) : []),
    stage(label, body) {
      writeFileSync(path.join(staged, `${label}.plist`), body);
    },
    run() {
      return execFileSync("/bin/bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...childEnv,
          AGENTDASH_ALLOW_NONROOT: "1",
          AGENTDASH_STAGED_DIR: staged,
          AGENTDASH_LAUNCHDAEMON_DIR: daemons,
          AGENTDASH_LAUNCHAGENT_DIR: agents,
          AGENTDASH_LAUNCHCTL: fake,
          AGENTDASH_INSTALL_OWNER_ARGS: "",
        },
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("installs a service that is not loaded yet", () => {
  const h = makeHarness({ loaded: [] });
  try {
    h.stage("com.agentdash.update", "<plist>one</plist>");
    const out = h.run();
    assert.match(out, /installed com\.agentdash\.update/);
    assert.ok(existsSync(path.join(h.daemons, "com.agentdash.update.plist")));
    assert.ok(h.calls().some((c) => c.startsWith("bootstrap system")));
  } finally {
    h.cleanup();
  }
});

test("re-running leaves an already-loaded, unchanged service alone", () => {
  // The bug this file exists for. A loaded service with an identical plist is
  // the desired state, not an error — and reloading it would restart a healthy
  // production server for nothing.
  const h = makeHarness({ loaded: ["com.agentdash.mkboard.server"] });
  try {
    h.stage("com.agentdash.mkboard.server", "<plist>same</plist>");
    writeFileSync(path.join(h.daemons, "com.agentdash.mkboard.server.plist"), "<plist>same</plist>");
    const out = h.run();
    assert.match(out, /already loaded, plist unchanged — left running/);
    assert.ok(!h.calls().some((c) => c.startsWith("bootout system/")), "must not bounce a healthy service");
  } finally {
    h.cleanup();
  }
});

test("one already-loaded service does not stop the ones after it", () => {
  // The actual production failure: the run died on the first loaded label and
  // the new job at the end of the alphabet was never installed, while the
  // output looked like a single failure rather than a skipped install.
  const h = makeHarness({ loaded: ["com.agentdash.caddy"] });
  try {
    h.stage("com.agentdash.caddy", "<plist>caddy</plist>");
    writeFileSync(path.join(h.daemons, "com.agentdash.caddy.plist"), "<plist>caddy</plist>");
    h.stage("com.agentdash.update", "<plist>update</plist>");
    const out = h.run();
    assert.match(out, /com\.agentdash\.caddy: already loaded/);
    assert.match(out, /installed com\.agentdash\.update/);
    assert.ok(existsSync(path.join(h.daemons, "com.agentdash.update.plist")));
  } finally {
    h.cleanup();
  }
});

test("a changed plist is reloaded rather than left stale", () => {
  const h = makeHarness({ loaded: ["com.agentdash.update"] });
  try {
    h.stage("com.agentdash.update", "<plist>new</plist>");
    writeFileSync(path.join(h.daemons, "com.agentdash.update.plist"), "<plist>old</plist>");
    const out = h.run();
    assert.match(out, /plist changed, reloading/);
    assert.equal(readFileSync(path.join(h.daemons, "com.agentdash.update.plist"), "utf8"), "<plist>new</plist>");
    assert.ok(h.calls().some((c) => c.startsWith("bootout system/com.agentdash.update")));
  } finally {
    h.cleanup();
  }
});

test("disables the login-scoped copy so two supervisors cannot race", () => {
  const h = makeHarness({ loaded: [] });
  try {
    h.stage("com.agentdash.update", "<plist>one</plist>");
    writeFileSync(path.join(h.agents, "com.agentdash.update.plist"), "<plist>agent</plist>");
    h.run();
    assert.ok(!existsSync(path.join(h.agents, "com.agentdash.update.plist")));
    assert.ok(existsSync(path.join(h.agents, "com.agentdash.update.plist.disabled")));
  } finally {
    h.cleanup();
  }
});

test("a genuine bootstrap failure still fails the run, and names the label", () => {
  const h = makeHarness({ loaded: [], bootstrapFails: true });
  try {
    h.stage("com.agentdash.update", "<plist>one</plist>");
    assert.throws(
      () => h.run(),
      (error) => {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        assert.match(output, /com\.agentdash\.update/);
        assert.match(output, /did not load/i);
        return true;
      },
    );
  } finally {
    h.cleanup();
  }
});
