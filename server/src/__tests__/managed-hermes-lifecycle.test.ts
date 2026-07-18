// Integration coverage for the managed-Hermes agent lifecycle.
//
// Regression guard for the live-box failure where a newly-created hermes_local
// agent failed harness-preflight ("Resolve the adapter environment checks")
// because its managed profile was never provisioned (onHireApproved only fires
// on the hire-approval flow, not direct create) and the alias wrapper used a
// bare `hermes` that died with exit 127 under the adapter PATH.
//
// Exercises the REAL provisioning code path (ensureAgentProfileCommand ->
// provisionAgentProfile) against a fake `hermes` binary + temp dirs, so it is
// deterministic in CI with no network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { agentProfileName, ensureAgentProfileCommand } from "../services/hermes-profile.js";

const ENV_KEYS = [
  "AGENTDASH_HERMES_MANAGED_PROFILES",
  "AGENTDASH_HERMES_COMMAND",
  "HERMES_PROFILES_DIR",
  "AGENTDASH_HERMES_BIN_DIR",
  "HERMES_FAKE_CALL_LOG",
  "AGENTDASH_GATEWAY_BASE_URL",
  "AGENTDASH_GATEWAY_API_KEY",
];

describe("managed-Hermes agent lifecycle (integration, fake hermes)", () => {
  let tmp: string;
  let profilesDir: string;
  let binDir: string;
  let callLog: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mh-lifecycle-"));
    profilesDir = path.join(tmp, "profiles");
    binDir = path.join(tmp, "bin");
    callLog = path.join(tmp, "calls.log");
    await fs.mkdir(profilesDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    // A fake `hermes` that records its args and materializes the profile dir on
    // `profile create`, so provisioning succeeds without a real Hermes/network.
    const fakeHermes = path.join(tmp, "fake-hermes");
    await fs.writeFile(
      fakeHermes,
      [
        "#!/bin/sh",
        'echo "$@" >> "$HERMES_FAKE_CALL_LOG"',
        'if [ "$1" = "profile" ] && [ "$2" = "create" ]; then mkdir -p "$HERMES_PROFILES_DIR/$3"; fi',
        'if [ "$1" = "profile" ] && [ "$2" = "delete" ]; then rm -rf "$HERMES_PROFILES_DIR/$3"; fi',
        "exit 0",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.AGENTDASH_HERMES_MANAGED_PROFILES = "true";
    process.env.AGENTDASH_HERMES_COMMAND = fakeHermes;
    process.env.HERMES_PROFILES_DIR = profilesDir;
    process.env.AGENTDASH_HERMES_BIN_DIR = binDir;
    process.env.HERMES_FAKE_CALL_LOG = callLog;
    delete process.env.AGENTDASH_GATEWAY_BASE_URL;
    delete process.env.AGENTDASH_GATEWAY_API_KEY;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("provisions a managed profile + executable PATH-resolving wrapper for a new agent", async () => {
    const agentId = "a2838717-d069-47a7-a1c7-4324d63222f0";
    const profile = agentProfileName(agentId);
    const expectedWrapper = path.join(binDir, profile);

    expect(existsSync(expectedWrapper)).toBe(false);

    const cmd = await ensureAgentProfileCommand(agentId);
    expect(cmd).toBe(expectedWrapper);

    // the profile was cloned from the template (real provisioning ran the fake)
    const calls = await fs.readFile(callLog, "utf8");
    expect(calls).toContain(`profile create ${profile} --clone-from`);
    expect(existsSync(path.join(profilesDir, profile))).toBe(true);

    // an executable, PATH-resolving wrapper was written (NOT the bare-hermes one)
    const wrapper = await fs.readFile(expectedWrapper, "utf8");
    expect(wrapper).toContain(`-p ${profile}`);
    expect(wrapper).toContain("PATH=");
    expect((await fs.stat(expectedWrapper)).mode & 0o111).not.toBe(0);
  });

  it("is idempotent: a second ensure does not re-run hermes", async () => {
    const agentId = "tilly-1";
    await ensureAgentProfileCommand(agentId);
    const firstCalls = (await fs.readFile(callLog, "utf8")).trim().split("\n").length;

    const cmd = await ensureAgentProfileCommand(agentId);
    expect(cmd).toBe(path.join(binDir, agentProfileName(agentId)));

    const secondCalls = (await fs.readFile(callLog, "utf8")).trim().split("\n").length;
    expect(secondCalls).toBe(firstCalls);
  });
});
