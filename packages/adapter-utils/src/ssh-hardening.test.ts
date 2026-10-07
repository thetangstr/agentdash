import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as serverUtils from "./server-utils.js";
import {
  runAdapterExecutionTargetProcessWithStagedEnv,
  type AdapterSshExecutionTarget,
} from "./execution-target.js";

const legacySpec = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/paperclip/workspace",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

const hardenedSpec = {
  ...legacySpec,
  host: "127.0.0.1",
  username: "ac-provider",
  remoteCwd: "/Users/ac-provider/agentdash",
  remoteWorkspacePath: "/Users/ac-provider/agentdash",
  identityFile: "/etc/agentdash/ssh/ac-provider_ed25519",
  knownHostsFile: "/etc/agentdash/ssh/known_hosts",
};

describe("ssh argv hardening", () => {
  it("leaves argv for environments without key/known_hosts paths exactly as before", async () => {
    const target = await ssh.buildSshSpawnTarget({ spec: legacySpec, command: "claude", args: ["--print"], env: {} });
    await target.cleanup();
    expect(target.command).toBe("ssh");
    expect(target.args.slice(0, -1)).toEqual([
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=yes",
      "-p", "22",
      "ssh-user@ssh.example.test",
    ]);
  });

  it("uses the pinned known_hosts file, the dedicated identity, and no forwarding when paths are set", async () => {
    const target = await ssh.buildSshSpawnTarget({
      spec: hardenedSpec,
      command: "hermes",
      args: ["chat", "-Q"],
      env: {},
    });
    await target.cleanup();
    expect(target.command).toBe("ssh");
    expect(target.args.slice(0, -1)).toEqual([
      "-F", "/dev/null",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UserKnownHostsFile=/etc/agentdash/ssh/known_hosts",
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-i", "/etc/agentdash/ssh/ac-provider_ed25519",
      "-o", "IdentitiesOnly=yes",
      "-o", "ForwardAgent=no",
      "-o", "ForwardX11=no",
      "-o", "ClearAllForwardings=yes",
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "PermitLocalCommand=no",
      "-p", "22",
      "ac-provider@127.0.0.1",
    ]);
    const remoteScript = target.args.at(-1) ?? "";
    expect(remoteScript).not.toContain("exec env");
    expect(remoteScript).toContain(ssh.shellQuote("exec 'hermes' 'chat' '-Q'").slice(1, -1));
  });

  it("carries identity/known_hosts paths through spec parsing only when present", () => {
    expect(ssh.parseSshRemoteExecutionSpec(legacySpec)).not.toHaveProperty("identityFile");
    expect(ssh.parseSshRemoteExecutionSpec(legacySpec)).not.toHaveProperty("knownHostsFile");
    expect(ssh.parseSshRemoteExecutionSpec(hardenedSpec)).toMatchObject({
      identityFile: "/etc/agentdash/ssh/ac-provider_ed25519",
      knownHostsFile: "/etc/agentdash/ssh/known_hosts",
    });
  });
});

describe("runAdapterExecutionTargetProcessWithStagedEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const target: AdapterSshExecutionTarget = {
    kind: "remote",
    transport: "ssh",
    remoteCwd: hardenedSpec.remoteCwd,
    spec: hardenedSpec,
  };

  it("stages env in a 0600 file over ssh stdin and keeps every value off the remote argv", async () => {
    let stagedBody = "";
    let stagedMode = 0;
    let stagedRemoteDir = "";
    vi.spyOn(ssh, "syncDirectoryToSsh").mockImplementation(async (input) => {
      const file = path.join(input.localDir, "runenv");
      stagedBody = await readFile(file, "utf8");
      stagedMode = (await stat(file)).mode & 0o777;
      stagedRemoteDir = input.remoteDir;
    });
    const cleanupSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({ stdout: "", stderr: "" });
    const runSpy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok\n",
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const result = await runAdapterExecutionTargetProcessWithStagedEnv(
      "run-1234",
      target,
      "hermes",
      ["chat", "-q", "do the task", "-Q"],
      {
        cwd: target.remoteCwd,
        env: { PAPERCLIP_API_KEY: "secret-run-token", ZAI_API_KEY: "zai-secret-value" },
        timeoutSec: 60,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(stagedMode).toBe(0o600);
    expect(stagedBody).toBe("PAPERCLIP_API_KEY='secret-run-token'\nZAI_API_KEY='zai-secret-value'\n");
    expect(stagedRemoteDir).toBe("/Users/ac-provider/agentdash/.paperclip-runenv/run-1234");

    expect(runSpy).toHaveBeenCalledTimes(1);
    const [runId, command, args, opts] = runSpy.mock.calls[0]!;
    expect(runId).toBe("run-1234");
    expect(command).toBe("sh");
    expect(args[0]).toBe("-c");
    expect(args.slice(2)).toEqual([
      "runenv",
      "/Users/ac-provider/agentdash/.paperclip-runenv/run-1234/runenv",
      "hermes",
      "chat",
      "-q",
      "do the task",
      "-Q",
    ]);
    expect(opts.env).toEqual({});
    expect(opts.remoteExecution).toBe(hardenedSpec);
    expect(JSON.stringify(args)).not.toContain("secret-run-token");
    expect(JSON.stringify(args)).not.toContain("zai-secret-value");

    // The run-scoped remote dir is always swept afterwards.
    expect(cleanupSpy).toHaveBeenCalledWith(
      hardenedSpec,
      `rm -rf '/Users/ac-provider/agentdash/.paperclip-runenv/run-1234'`,
      expect.any(Object),
    );
  });

  it("fails the run without spawning when staging fails (no argv fallback)", async () => {
    vi.spyOn(ssh, "syncDirectoryToSsh").mockRejectedValue(new Error("Host key verification failed."));
    vi.spyOn(ssh, "runSshCommand").mockResolvedValue({ stdout: "", stderr: "" });
    const runSpy = vi.spyOn(serverUtils, "runChildProcess");

    await expect(
      runAdapterExecutionTargetProcessWithStagedEnv("run-1", target, "hermes", ["chat"], {
        cwd: target.remoteCwd,
        env: { A: "1" },
        timeoutSec: 60,
        graceSec: 5,
        onLog: async () => {},
      }),
    ).rejects.toThrow(/stage the run environment/);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid env keys and unsafe run ids before touching the host", async () => {
    const syncSpy = vi.spyOn(ssh, "syncDirectoryToSsh").mockResolvedValue();
    vi.spyOn(ssh, "runSshCommand").mockResolvedValue({ stdout: "", stderr: "" });
    await expect(
      runAdapterExecutionTargetProcessWithStagedEnv("run-1", target, "hermes", [], {
        cwd: target.remoteCwd,
        env: { "BAD KEY": "x" },
        timeoutSec: 60,
        graceSec: 5,
        onLog: async () => {},
      }),
    ).rejects.toThrow(/Invalid SSH environment variable key/);
    await expect(
      runAdapterExecutionTargetProcessWithStagedEnv("../../etc", target, "hermes", [], {
        cwd: target.remoteCwd,
        env: {},
        timeoutSec: 60,
        graceSec: 5,
        onLog: async () => {},
      }),
    ).rejects.toThrow(/run id/);
    expect(syncSpy).not.toHaveBeenCalled();
  });
});
