import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SCRIPT = path.join(REPO_ROOT, "deploy", "install-launchdaemons.sh");
const STAGED_PLISTS = path.join(REPO_ROOT, "deploy", "launchdaemons");
const SOURCE_CLONE = "/Users/yang/agentdash";

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
  // The script checks that each daemon's program exists under this prefix.
  const checkRoot = path.join(root, "checkroot");
  for (const dir of [staged, daemons, agents, checkRoot]) mkdirSync(dir, { recursive: true });

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
    /** Make an absolute path exist (executable) under the check root. */
    provide(absolute) {
      const target = path.join(checkRoot, absolute);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
    },
    run({ stagedDir = staged } = {}) {
      return execFileSync("/bin/bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...childEnv,
          AGENTDASH_ALLOW_NONROOT: "1",
          AGENTDASH_STAGED_DIR: stagedDir,
          AGENTDASH_LAUNCHDAEMON_DIR: daemons,
          AGENTDASH_LAUNCHAGENT_DIR: agents,
          AGENTDASH_LAUNCHCTL: fake,
          AGENTDASH_INSTALL_OWNER_ARGS: "",
          AGENTDASH_CHECK_ROOT: checkRoot,
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

// ---------------------------------------------------------------------------
// Nothing runs from the source clone
// ---------------------------------------------------------------------------
//
// Daemons that run scripts out of ~/agentdash — the developer clone — drift
// behind the serving release, because an apply never updates the clone. The
// daily update check then runs a retired updater and reports a commit nothing
// is serving, and nothing an apply ships ever reaches those jobs.

/**
 * Every <string> in a plist, attributed to the nearest preceding <key> — the
 * same attribution the script's guard uses, so array entries such as
 * ProgramArguments are reported under the array's key.
 */
function plistStrings(xml) {
  const out = [];
  let key = null;
  for (const line of xml.split("\n")) {
    const k = line.match(/<key>(.*?)<\/key>/);
    if (k) key = k[1];
    const v = line.match(/<string>(.*?)<\/string>/);
    if (v) out.push({ key, value: v[1] });
  }
  return out;
}

const stagedPlists = () =>
  readdirSync(STAGED_PLISTS)
    .filter((name) => /^com\.agentdash\..*\.plist$/.test(name))
    .map((name) => ({ name, xml: readFileSync(path.join(STAGED_PLISTS, name), "utf8") }));

test("no staged daemon points into the source clone", () => {
  const plists = stagedPlists();
  assert.ok(plists.length >= 7, "every AgentDash daemon is checked");
  for (const { name, xml } of plists) {
    // Postgres stays on the clone until its own, explicit migration: its binary
    // must not change as a side effect of an apply, prune or reinstall.
    if (name === "com.agentdash.postgres.plist") continue;
    for (const { key, value } of plistStrings(xml)) {
      // The update job's fetch-only source of release tags.
      if (name === "com.agentdash.update.plist" && key === "AGENTDASH_REPO_DIR") continue;
      const inClone = value === SOURCE_CLONE || value.includes(`${SOURCE_CLONE}/`);
      assert.ok(!inClone, `${name}: ${key}=${value} points into the source clone`);
    }
  }
});

test("services run from releases/current and the update job from the standalone bin copy", () => {
  const program = (name) => {
    const xml = readFileSync(path.join(STAGED_PLISTS, name), "utf8");
    return plistStrings(xml).find((entry) => entry.key === "ProgramArguments")?.value;
  };
  const current = "/Users/yang/.agentdash/releases/current/deploy";
  assert.equal(program("com.agentdash.mkboard.server.plist"), `${current}/agentdash-server.sh`);
  assert.equal(program("com.agentdash.mkboard.backup.plist"), `${current}/agentdash-backup.sh`);
  // Deliberately NOT releases/current: see the Postgres note in deploy/README.md.
  assert.equal(program("com.agentdash.postgres.plist"), `${SOURCE_CLONE}/deploy/agentdash-postgres.sh`);
  assert.equal(program("com.agentdash.renew-tls.plist"), `${current}/agentdash-renew-tls.sh`);
  assert.equal(program("com.agentdash.rotate-logs.plist"), `${current}/agentdash-rotate-logs.sh`);
  // Installed there by a healthy apply, from the release it just proved.
  assert.equal(program("com.agentdash.update.plist"), "/Users/yang/.agentdash/bin/agentdash-update.sh");
  const update = plistStrings(readFileSync(path.join(STAGED_PLISTS, "com.agentdash.update.plist"), "utf8"));
  assert.equal(update.find((entry) => entry.key === "AGENTDASH_REPO_DIR")?.value, SOURCE_CLONE);
});

test("refuses a plist that runs from the source clone, and installs nothing at all", () => {
  const h = makeHarness({ loaded: [] });
  try {
    h.provide("/opt/homebrew/bin/caddy");
    h.stage("com.agentdash.caddy", "<plist>\n<key>ProgramArguments</key>\n<array>\n<string>/opt/homebrew/bin/caddy</string>\n</array>\n</plist>");
    h.stage(
      "com.agentdash.update",
      "<plist>\n<key>ProgramArguments</key>\n<array>\n<string>/Users/yang/agentdash/deploy/agentdash-update.sh</string>\n</array>\n</plist>",
    );
    assert.throws(
      () => h.run(),
      (error) => {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        assert.match(output, /com\.agentdash\.update runs from the source clone/);
        assert.match(output, /ProgramArguments=\/Users\/yang\/agentdash\/deploy\/agentdash-update\.sh/);
        assert.match(output, /REFUSED, nothing installed/);
        return true;
      },
    );
    // Checked before the loop, so even the valid plist was not installed.
    assert.equal(existsSync(path.join(h.daemons, "com.agentdash.caddy.plist")), false);
    assert.deepEqual(h.calls(), []);
  } finally {
    h.cleanup();
  }
});

/** An update plist in the new shape, plus the bin files it needs. */
function stageUpdate(h, { repoDirKey = "AGENTDASH_REPO_DIR", label = "com.agentdash.update", provide = true } = {}) {
  h.stage(
    label,
    [
      "<plist>",
      `<key>${repoDirKey}</key>`,
      "<string>/Users/yang/agentdash</string>",
      "<key>ProgramArguments</key>",
      "<array>",
      "<string>/Users/yang/.agentdash/bin/agentdash-update.sh</string>",
      "</array>",
      "</plist>",
    ].join("\n"),
  );
  if (provide) {
    for (const file of ["agentdash-update.sh", "ota-apply.mjs", "ota-release-layout.mjs"]) {
      h.provide(`/Users/yang/.agentdash/bin/${file}`);
    }
  }
}

test("the fetch-only AGENTDASH_REPO_DIR is allowed to name the source clone", () => {
  const h = makeHarness({ loaded: [] });
  try {
    for (const file of ["agentdash-update.sh", "ota-apply.mjs", "ota-release-layout.mjs"]) {
      h.provide(`/Users/yang/.agentdash/bin/${file}`);
    }
    h.stage(
      "com.agentdash.update",
      [
        "<plist>",
        "<key>AGENTDASH_REPO_DIR</key>",
        "<string>/Users/yang/agentdash</string>",
        "<key>ProgramArguments</key>",
        "<array>",
        "<string>/Users/yang/.agentdash/bin/agentdash-update.sh</string>",
        "</array>",
        "</plist>",
      ].join("\n"),
    );
    assert.match(h.run(), /installed com\.agentdash\.update/);
  } finally {
    h.cleanup();
  }
});

test("the repository's own staged plists pass the guard and install", () => {
  const h = makeHarness({ loaded: [] });
  try {
    for (const { xml } of stagedPlists()) {
      const program = plistStrings(xml).find((entry) => entry.key === "ProgramArguments")?.value;
      if (program) h.provide(program);
    }
    h.provide("/Users/yang/.agentdash/bin/ota-apply.mjs");
    h.provide("/Users/yang/.agentdash/bin/ota-release-layout.mjs");
    const out = h.run({ stagedDir: STAGED_PLISTS });
    for (const { name } of stagedPlists()) {
      const label = name.replace(/\.plist$/, "");
      assert.match(out, new RegExp(`installed ${label.replace(/\./g, "\\.")}`));
      assert.ok(existsSync(path.join(h.daemons, name)));
    }
  } finally {
    h.cleanup();
  }
});

test("the AGENTDASH_REPO_DIR exception belongs to the update job only", () => {
  const h = makeHarness({ loaded: [] });
  try {
    stageUpdate(h, { label: "com.agentdash.mkboard.backup" });
    assert.throws(
      () => h.run(),
      (error) => {
        assert.match(`${error.stderr ?? ""}`, /com\.agentdash\.mkboard\.backup runs from the source clone/);
        return true;
      },
    );
  } finally {
    h.cleanup();
  }
});

test("Postgres may stay on the source clone; its move is a separate migration", () => {
  const h = makeHarness({ loaded: [] });
  try {
    h.provide("/Users/yang/agentdash/deploy/agentdash-postgres.sh");
    h.stage(
      "com.agentdash.postgres",
      "<plist>\n<key>AGENTDASH_APP_DIR</key>\n<string>/Users/yang/agentdash</string>\n<key>ProgramArguments</key>\n<array>\n<string>/Users/yang/agentdash/deploy/agentdash-postgres.sh</string>\n</array>\n</plist>",
    );
    assert.match(h.run(), /installed com\.agentdash\.postgres/);
  } finally {
    h.cleanup();
  }
});

test("refuses the update job until ~/.agentdash/bin holds the updater, installing nothing", () => {
  for (const missing of ["agentdash-update.sh", "ota-apply.mjs"]) {
    const h = makeHarness({ loaded: [] });
    try {
      h.provide("/opt/homebrew/bin/caddy");
      h.stage("com.agentdash.caddy", "<plist>\n<key>ProgramArguments</key>\n<array>\n<string>/opt/homebrew/bin/caddy</string>\n</array>\n</plist>");
      stageUpdate(h, { provide: false });
      for (const file of ["agentdash-update.sh", "ota-apply.mjs", "ota-release-layout.mjs"]) {
        if (file !== missing) h.provide(`/Users/yang/.agentdash/bin/${file}`);
      }
      assert.throws(
        () => h.run(),
        (error) => {
          const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
          assert.match(output, new RegExp(missing.replace(".", "\\.")));
          assert.match(output, /REFUSED, nothing installed: com\.agentdash\.update/);
          return true;
        },
      );
      assert.deepEqual(h.calls(), [], `nothing installed when ${missing} is missing`);
      assert.equal(existsSync(path.join(h.daemons, "com.agentdash.caddy.plist")), false);
    } finally {
      h.cleanup();
    }
  }
});
