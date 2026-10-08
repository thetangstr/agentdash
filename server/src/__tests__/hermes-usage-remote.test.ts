import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as ssh from "@paperclipai/adapter-utils/ssh";
import { readRemoteHermesSessionUsage } from "../adapters/hermes-usage-remote.js";

const target = {
  kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/tmp",
  spec: { host: "synthetic.invalid", port: 2222, username: "fixture", remoteCwd: "/tmp", remoteWorkspacePath: "/tmp", privateKey: null, knownHosts: null, strictHostKeyChecking: true, identityFile: "/synthetic/key", knownHostsFile: "/synthetic/hosts" },
};
const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hermes-remote-usage-")));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Canonical console entry point; never invoked, only identified as a non-wrapper.
  writeFileSync(join(bin, "hermes"), "#!/usr/bin/env python3\nfrom hermes_cli.main import main\nmain()\n", { mode: 0o755 });
  return { root, bin };
}
function ledger(home: string, session: string) {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("CREATE TABLE session_model_usage(session_id TEXT, model TEXT, billing_provider TEXT, api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL); CREATE TABLE sessions(id TEXT, tool_call_count INTEGER)");
  db.prepare("INSERT INTO session_model_usage VALUES(?, 'fixture-model', 'fixture-provider', 4, 120, 30, 20, 0.5, 0.75)").run(session);
  db.prepare("INSERT INTO sessions VALUES(?, 7)").run(session);
  db.close();
}
function fakeRemote(root: string, bin: string) {
  return vi.spyOn(ssh, "runSshCommand").mockImplementation(async (_spec, command) => ({
    // The generated query is executed against disposable local SQLite only.
    // Strip login mode so macOS cannot replace this synthetic PATH/HOME.
    stdout: execFileSync("sh", ["-c", command.replace(/^sh -lc /, "sh -c ")], {
      env: { HOME: root, PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin` }, encoding: "utf8", timeout: 5000,
    }), stderr: "",
  }));
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("remote Hermes session ledger", () => {
  it.each(["root", "custom", "profile", "custom-profile", "home-profile"])("reads cumulative usage from the remote %s home", async (kind) => {
    const { root, bin } = fixture();
    const custom = join(root, "custom");
    const profileHome = join(root, ".hermes", "profiles", "work");
    const home = kind === "root" ? join(root, ".hermes") : kind === "custom" ? custom : kind === "custom-profile" ? join(custom, "profiles", "work") : profileHome;
    const config = { hermesCommand: "hermes", ...(kind.includes("profile") && kind !== "home-profile" ? { extraArgs: ["-p", "work"] } : {}), env: { ...(kind.startsWith("custom") ? { HERMES_HOME: custom } : kind === "home-profile" ? { HERMES_HOME: profileHome } : {}), API_KEY: "never-send-secret" } };
    ledger(home, "session-1");
    const remote = fakeRemote(root, bin);
    const result = await readRemoteHermesSessionUsage("session-1", target, config);
    expect(result.status).toBe("metered");
    expect(result.dbPath).toBe(join(home, "state.db"));
    expect(result.usage).toMatchObject({ usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 }, costUsd: 0.75, apiCalls: 4, toolCalls: 7 });
    expect(remote.mock.calls[0][0]).toEqual(target.spec);
    expect(remote.mock.calls[0][1]).not.toContain("never-send-secret");
    expect(remote.mock.calls[0][2]).toMatchObject({ timeoutMs: 10_000, maxBuffer: 131072 });
  });
  it("does not interpolate hostile session ids into shell or SQL", async () => {
    const { root, bin } = fixture();
    const session = "x' OR 1=1; -- $(touch injected) `uname`\n雪";
    ledger(join(root, ".hermes"), session);
    fakeRemote(root, bin);
    expect((await readRemoteHermesSessionUsage(session, target, { hermesCommand: "hermes" })).status).toBe("metered");
    expect((await readRemoteHermesSessionUsage("different", target, { hermesCommand: "hermes" })).status).toBe("unmetered_no_session");
  });
  it("leaves unavailable ledgers unmetered and never creates one", async () => {
    const { root, bin } = fixture();
    fakeRemote(root, bin);
    expect((await readRemoteHermesSessionUsage("session-1", target, {})).status).toBe("unmetered_no_ledger");
  });
  it("does not attribute a named sticky profile without an explicit invocation profile", async () => {
    const { root, bin } = fixture();
    ledger(join(root, ".hermes"), "s");
    ledger(join(root, ".hermes", "profiles", "work"), "s");
    writeFileSync(join(root, ".hermes", "active_profile"), "work");
    fakeRemote(root, bin);
    expect((await readRemoteHermesSessionUsage("s", target, {})).status).toBe("unmetered_no_ledger");
    expect((await readRemoteHermesSessionUsage("s", target, { extraArgs: ["--profile=work"] })).status).toBe("metered");
  });
  it("does not guess a wrapper's private home", async () => {
    const { root, bin } = fixture();
    writeFileSync(join(bin, "hermes"), "#!/bin/sh\nHERMES_HOME=/elsewhere exec /real/hermes \"$@\"\n", { mode: 0o755 });
    ledger(join(root, ".hermes"), "session-1");
    fakeRemote(root, bin);
    expect((await readRemoteHermesSessionUsage("session-1", target, {})).status).toBe("unmetered_no_ledger");
  });
  it.each(["not-json", JSON.stringify({ sessionId: "foreign", status: "metered", rows: [] }), JSON.stringify({ sessionId: "s", status: "metered", dbPath: "/tmp/state.db", rows: [{ input_tokens: -1 }] })])("rejects malformed or mismatched payload %s", async (stdout) => {
    vi.spyOn(ssh, "runSshCommand").mockResolvedValue({ stdout, stderr: "" });
    expect((await readRemoteHermesSessionUsage("s", target, {})).status).toBe("unmetered_no_ledger");
  });
  it("leaves timeout unmetered and skips querying without a session", async () => {
    const remote = vi.spyOn(ssh, "runSshCommand").mockRejectedValue(new Error("timeout"));
    expect((await readRemoteHermesSessionUsage(null, target, {})).status).toBe("unmetered_no_session");
    expect(remote).not.toHaveBeenCalled();
    expect((await readRemoteHermesSessionUsage("s", target, {})).status).toBe("unmetered_no_ledger");
  });
});
