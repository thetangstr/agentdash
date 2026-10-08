import { readFile, stat, mkdtemp, writeFile, cp, mkdir, rm, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

describe("private SSH tar staging", () => {
  it("sets 0700 before archive extraction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ssh-private-transfer-"));
    const previousPath = process.env.PATH;
    const local = path.join(root, "local"), remote = path.join(root, "remote"), bin = path.join(root, "bin"), modes = path.join(root, "modes");
    await mkdir(local, { mode: 0o700 }); await mkdir(remote, { mode: 0o755 }); await mkdir(bin);
    await chmod(remote, 0o755);
    await writeFile(path.join(local, "query"), "synthetic-private", { mode: 0o600 });
    await writeFile(path.join(bin, "ssh"), `#!${process.execPath}\nconst cp=require("node:child_process"), fs=require("node:fs"); const remote=process.argv.at(-1).replace(/^sh -lc /,"sh -c "); const result=cp.spawnSync("sh",["-c",remote],{input:fs.readFileSync(0),env:{PATH:${JSON.stringify(bin + ":/usr/bin:/bin")},HOME:${JSON.stringify(root)}},stdio:["pipe","inherit","inherit"]});process.exit(result.status ?? 1);`, { mode: 0o755 });
    await writeFile(path.join(bin, "tar"), `#!${process.execPath}\nconst cp=require("node:child_process"), fs=require("node:fs");const args=process.argv.slice(2);if(args.includes("-xf")) fs.appendFileSync(${JSON.stringify(modes)},String(fs.statSync(args.at(-1)).mode & 511)+"\\n"); const result=cp.spawnSync("/usr/bin/tar",args,{stdio:"inherit"});process.exit(result.status ?? 1);`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      await ssh.syncDirectoryToSsh({ spec: hardenedSpec, localDir: local, remoteDir: remote, privateDirectory: true });
      expect((await readFile(modes, "utf8")).trim()).toBe("448");
      expect((await stat(path.join(remote, "query"))).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(remote, "query"), "utf8")).toBe("synthetic-private");
    } finally { process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); }
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

  it("the runtime reads the unchanged query only from a 0600 file in a 0700 directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ssh-private-query-"));
    const query = "雪 query\n' \" $(touch NEVER) `uname`";
    const fake = path.join(root, "fake-hermes.cjs");
    await writeFile(fake, `const fs = require("node:fs"); const args = process.argv.slice(2); const file = args[args.indexOf("--query-file") + 1]; process.stdout.write(JSON.stringify({ args, query: fs.readFileSync(file,"utf8"), mode: fs.statSync(file).mode & 511, dirMode: fs.statSync(require("node:path").dirname(file)).mode & 511, token: process.env.RUN_TOKEN }));`);
    const localTarget = { ...target, remoteCwd: root, spec: { ...target.spec, remoteCwd: root } };
    vi.spyOn(ssh, "syncDirectoryToSsh").mockImplementation(async (input) => {
      expect(input.privateDirectory).toBe(true);
      expect((await stat(input.localDir)).mode & 0o777).toBe(0o700);
      await mkdir(input.remoteDir, { recursive: true, mode: 0o700 });
      await cp(input.localDir, input.remoteDir, { recursive: true });
    });
    vi.spyOn(ssh, "runSshCommand").mockImplementation(async () => {
      await rm(path.join(root, ".paperclip-runenv", "query-read"), { recursive: true, force: true });
      return { stdout: "", stderr: "" };
    });
    vi.spyOn(serverUtils, "runChildProcess").mockImplementation(async (_run, command, args) => {
      expect(JSON.stringify(args)).not.toContain("雪 query");
      const result = await promisify(execFile)(command, args, { env: { PATH: process.env.PATH }, cwd: root });
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString() };
    });
    try {
      const result = await runAdapterExecutionTargetProcessWithStagedEnv("query-read", localTarget, process.execPath, [fake], {
        cwd: root, env: { RUN_TOKEN: "synthetic-private" }, privateQuery: query, timeoutSec: 5, graceSec: 1, onLog: async () => {},
      });
      const received = JSON.parse(result.stdout);
      expect(received).toMatchObject({ query, mode: 0o600, dirMode: 0o700, token: "synthetic-private" });
      expect(received.args).toEqual(["--query-file", path.join(root, ".paperclip-runenv/query-read/query")]);
      await expect(stat(path.join(root, ".paperclip-runenv/query-read"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["launch", "timeout", "nonzero"])("sweeps staged inputs after %s failure", async (failure) => {
    vi.spyOn(ssh, "syncDirectoryToSsh").mockResolvedValue();
    const sweep = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({ stdout: "", stderr: "" });
    const run = vi.spyOn(serverUtils, "runChildProcess");
    if (failure === "launch") run.mockRejectedValue(new Error("synthetic launch failure"));
    else run.mockResolvedValue({ exitCode: failure === "nonzero" ? 2 : null, signal: null, timedOut: failure === "timeout", stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() });
    const pending = runAdapterExecutionTargetProcessWithStagedEnv("cleanup-case", target, "hermes", ["chat"], { cwd: target.remoteCwd, env: {}, privateQuery: "private-query", timeoutSec: 1, graceSec: 1, onLog: async () => {} });
    if (failure === "launch") await expect(pending).rejects.toThrow("synthetic launch failure");
    else await pending;
    expect(sweep).toHaveBeenCalledWith(hardenedSpec, "rm -rf '/Users/ac-provider/agentdash/.paperclip-runenv/cleanup-case'", expect.any(Object));
  });

  it("sweeps staged inputs and does not launch when invocation metadata fails", async () => {
    vi.spyOn(ssh, "syncDirectoryToSsh").mockResolvedValue();
    const sweep = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({ stdout: "", stderr: "" });
    const run = vi.spyOn(serverUtils, "runChildProcess");
    await expect(runAdapterExecutionTargetProcessWithStagedEnv("metadata-failure", target, "hermes", ["chat"], {
      cwd: target.remoteCwd, env: {}, privateQuery: "private-query", timeoutSec: 1, graceSec: 1, onLog: async () => {},
      onInvocation: async () => { throw new Error("synthetic metadata failure"); },
    })).rejects.toThrow("synthetic metadata failure");
    expect(run).not.toHaveBeenCalled();
    expect(sweep).toHaveBeenCalledWith(hardenedSpec, "rm -rf '/Users/ac-provider/agentdash/.paperclip-runenv/metadata-failure'", expect.any(Object));
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
