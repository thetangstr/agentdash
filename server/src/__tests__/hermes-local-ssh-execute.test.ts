import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * hermes_local over an SSH execution target, end to end through the registry
 * wrapper and the patched vendored adapter — with a fake `ssh` on PATH, so no
 * connection is made. The fake records every argv and any stdin it is fed.
 */

const PRIVATE_PROMPT = "PRIVATE-QUERY-1062 雪\nquotes \" ' $(touch /tmp/never-run) `uname`";
const RUN_TOKEN = "test-run-token-value";
const ZAI_SECRET = "zai-secret-value";
const SERVER_SECRET = "postgres://server-only-secret@db/agentdash";

async function writeFakeSsh(dir: string, options: { unsupportedQuery?: boolean; noLedger?: boolean; runLocally?: boolean } = {}): Promise<string> {
  const logPath = join(dir, "ssh-calls.jsonl");
  await writeFile(
    join(dir, "ssh"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const argv = process.argv.slice(2);",
      "const remote = argv[argv.length - 1] || \"\";",
      `const log = ${JSON.stringify(logPath)};`,
      `if (${options.runLocally === true}) {`,
      '  const cp = require("node:child_process");',
      `  const env = { HOME: ${JSON.stringify(dir)}, PATH: ${JSON.stringify(process.env.PATH)} };`,
      '  const input = remote.includes("tar -xf -") ? fs.readFileSync(0) : undefined;',
      '  const result = cp.spawnSync("/bin/sh", ["-c", remote], { env, input, encoding: "utf8" });',
      '  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exit(result.status ?? 1);',
      "}",
      "if (remote.includes(\"tar -xf -\")) {",
      "  const chunks = [];",
      "  process.stdin.on(\"data\", (c) => chunks.push(c));",
      "  process.stdin.on(\"end\", () => {",
      "    fs.appendFileSync(log, JSON.stringify({ argv, stdin: Buffer.concat(chunks).toString(\"latin1\") }) + \"\\n\");",
      "    process.exit(0);",
      "  });",
      '} else if (remote.includes("AGENTDASH_HERMES_USAGE_READ")) {',
      '  fs.appendFileSync(log, JSON.stringify({ argv }) + "\\n");',
      `  process.stdout.write(${JSON.stringify(JSON.stringify(options.noLedger ? { sessionId: "hermes-ssh-session", status: "unmetered_no_ledger" } : { sessionId: "hermes-ssh-session", status: "metered", dbPath: "/remote/.hermes/state.db", profile: null, rows: [{ input_tokens: 100, output_tokens: 20, cache_read_tokens: 10, api_call_count: 2, estimated_cost_usd: 0.2, actual_cost_usd: null, model: "synthetic", billing_provider: "test" }], toolCalls: 3 }))});`,
      "} else {",
      "  fs.appendFileSync(log, JSON.stringify({ argv }) + \"\\n\");",
      `  if (${options.unsupportedQuery === true} && remote.includes("--query-file")) { process.stderr.write("error: unrecognized arguments: --query-file\\n"); process.exit(2); }`,
      "  if (!remote.includes(\"rm -rf\")) process.stdout.write(\"done\\n\\nsession_id: hermes-ssh-session\\n\");",
      "  process.exit(0);",
      "}",
    ].join("\n"),
  );
  await chmod(join(dir, "ssh"), 0o755);
  return logPath;
}

const sshTarget = {
  kind: "remote" as const,
  transport: "ssh" as const,
  environmentId: "env-ssh",
  leaseId: "lease-1",
  remoteCwd: "/Users/ac-provider/agentdash",
  paperclipApiUrl: null,
  spec: {
    host: "127.0.0.1",
    port: 22,
    username: "ac-provider",
    remoteWorkspacePath: "/Users/ac-provider/agentdash",
    remoteCwd: "/Users/ac-provider/agentdash",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
    identityFile: "/etc/agentdash/ssh/ac-provider_ed25519",
    knownHostsFile: "/etc/agentdash/ssh/known_hosts",
    paperclipApiUrl: null,
  },
};

describe("hermes_local over an SSH execution target", () => {
  const originalPath = process.env.PATH;
  const originalDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("reports the exact remote Hermes argv and hashes the rendered private query", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-invocation-meta-"));
    try {
      await writeFakeSsh(dir, { runLocally: true });
      const command = join(dir, "fake-hermes");
      const receivedPath = join(dir, "received.json");
      await writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const query = fs.readFileSync(args[args.indexOf("--query-file") + 1], "utf8");
fs.writeFileSync(${JSON.stringify(receivedPath)}, JSON.stringify({ args, query }));
process.stdout.write("done\\nsession_id: synthetic-session\\n");
`);
      await chmod(command, 0o755);
      process.env.PATH = `${dir}:${originalPath ?? ""}`;
      const onMeta = vi.fn(async () => {});
      const { execute } = await import("hermes-paperclip-adapter/server");
      const result = await execute({
        runId: "metadata-run", agent: { id: "agent-meta", companyId: "company-meta", name: "Rendered 雪", role: "engineer", adapterType: "hermes_local", adapterConfig: {
          hermesCommand: command, promptTemplate: "Hello {{agentName}}\n" + PRIVATE_PROMPT,
          provider: "zai", extraArgs: ["--profile", "synthetic-profile"], env: { ZAI_API_KEY: ZAI_SECRET, ROLE_HANDLE: "synthetic-role-handle" },
        } }, runtime: {}, config: {}, context: {},
        executionTarget: { ...sshTarget, remoteCwd: dir, spec: { ...sshTarget.spec, remoteCwd: dir } },
        onMeta, onLog: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      const received = JSON.parse(await readFile(receivedPath, "utf8"));
      expect(received.query).toBe("Hello Rendered 雪\n" + PRIVATE_PROMPT);
      expect(received.args).toEqual(["chat", "-Q", "--provider", "zai", "--source", "tool", "--yolo", "--profile", "synthetic-profile", "--query-file", join(dir, ".paperclip-runenv/metadata-run/query")]);
      expect(onMeta).toHaveBeenCalledExactlyOnceWith({
        adapterType: "hermes_local", command, commandArgs: received.args, cwd: dir,
        promptSha256: createHash("sha256").update(received.query).digest("hex"),
      });
      const metadata = JSON.stringify(onMeta.mock.calls);
      for (const privateValue of [PRIVATE_PROMPT, ZAI_SECRET, "synthetic-role-handle"]) expect(metadata).not.toContain(privateValue);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("runs hermes over hardened ssh with env staged off-argv and never leaks server env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentdash-hermes-ssh-"));
    const logPath = await writeFakeSsh(dir);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    process.env.DATABASE_URL = SERVER_SECRET;

    const logs: string[] = [];
    const { getServerAdapter } = await import("../adapters/registry.js");
    const result = await getServerAdapter("hermes_local").execute({
      runId: "run-ssh-1",
      agent: {
        id: "agent-1",
        companyId: "0008870a-4a07-4e09-9a3e-1998f4c7d640",
        name: "Rome Provider",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          promptTemplate: PRIVATE_PROMPT,
          provider: "zai",
          model: "glm-5.3-flash",
          env: { ZAI_API_KEY: ZAI_SECRET },
        },
      },
      runtime: {},
      config: {},
      context: {},
      authToken: RUN_TOKEN,
      executionTarget: sshTarget,
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect.soft((result.resultJson as Record<string, unknown>).meteringStatus).toBe("metered");
    expect(logs.join("")).toContain("target=SSH environment ac-provider@127.0.0.1:22");

    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; stdin?: string });
    // stage env (tar over stdin) → run → sweep
    expect.soft(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.argv.slice(0, -1)).toEqual([
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
      const argvText = JSON.stringify(call.argv);
      expect(argvText).not.toContain("PRIVATE-QUERY-1062");
      expect(argvText).not.toContain(RUN_TOKEN);
      expect(argvText).not.toContain(ZAI_SECRET);
      expect(argvText).not.toContain(SERVER_SECRET);
    }

    const [stage, run, sweep] = calls;
    expect(stage!.argv.at(-1)).toContain(".paperclip-runenv/run-ssh-1");
    expect(stage!.stdin).toContain(`PAPERCLIP_API_KEY='${RUN_TOKEN}'`);
    expect(stage!.stdin).toContain(`ZAI_API_KEY='${ZAI_SECRET}'`);
    expect(stage!.stdin).not.toContain(SERVER_SECRET);
    expect(Buffer.from(stage!.stdin!, "latin1").toString("utf8")).toContain(PRIVATE_PROMPT);
    expect(run!.argv.at(-1)).toContain("--query-file");
    expect(run!.argv.at(-1)).toContain("cd '\"'\"'/Users/ac-provider/agentdash'\"'\"'");
    expect(run!.argv.at(-1)).toContain("'\"'\"'hermes'\"'\"' '\"'\"'chat'\"'\"'");
    expect(run!.argv.at(-1)).not.toContain("exec env");
    expect(sweep!.argv.at(-1)).toBe("rm -rf '/Users/ac-provider/agentdash/.paperclip-runenv/run-ssh-1'");
  }, 120_000);

  it("fails closed with an upgrade instruction when remote Hermes lacks query-file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-query-unsupported-"));
    const logPath = await writeFakeSsh(dir, { unsupportedQuery: true });
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    const { getServerAdapter } = await import("../adapters/registry.js");
    const result = await getServerAdapter("hermes_local").execute({
      runId: "query-unsupported", agent: { id: "a", companyId: "c", name: "A", role: "engineer", adapterType: "hermes_local", adapterConfig: { provider: "zai", promptTemplate: PRIVATE_PROMPT } },
      runtime: {}, config: {}, context: {}, executionTarget: sshTarget,
      onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {},
    } as never);
    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toMatch(/Upgrade Hermes/);
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toHaveLength(3);
    expect(calls.at(-1).argv.at(-1)).toContain("rm -rf");
    expect(JSON.stringify(calls.map((call) => call.argv))).not.toContain("PRIVATE-QUERY-1062");
  });

  it("never consults the server ledger when the remote ledger is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-no-remote-ledger-"));
    await writeFakeSsh(dir, { noLedger: true });
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    const localUsage = await import("../adapters/hermes-usage.js");
    const localRead = vi.spyOn(localUsage, "readHermesSessionUsageDetailed");
    const { getServerAdapter } = await import("../adapters/registry.js");
    try {
      const result = await getServerAdapter("hermes_local").execute({
        runId: "no-remote-ledger", agent: { id: "a", companyId: "c", name: "A", role: "engineer", adapterType: "hermes_local", adapterConfig: { provider: "zai" } },
        runtime: {}, config: {}, context: {}, executionTarget: sshTarget,
        onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      expect(result.resultJson?.meteringStatus).toBe("unmetered_no_ledger");
      expect(localRead).not.toHaveBeenCalled();
    } finally { localRead.mockRestore(); }
  });

  it.each(["-q", "-qsecret", "--query", "--query=secret", "--query-file", "--query-f=elsewhere", "--que=secret"])("rejects conflicting extra query option %s before SSH", async (flag) => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-query-conflict-"));
    await writeFakeSsh(dir);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    const { getServerAdapter } = await import("../adapters/registry.js");
    await expect(getServerAdapter("hermes_local").execute({
      runId: "query-conflict", agent: { id: "a", companyId: "c", name: "A", role: "engineer", adapterType: "hermes_local", adapterConfig: { provider: "zai", extraArgs: [flag] } },
      runtime: {}, config: {}, context: {}, executionTarget: sshTarget,
      onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {},
    } as never)).rejects.toThrow(/query.*SSH|SSH.*query/i);
  });

  it.each(["ccra_synthetic_role_handle", "Bearer synthetic-bearer", ZAI_SECRET, "--api-key=synthetic-key", "sk-synthetic-provider-key"])("rejects secret-bearing argv %s before staging or metadata", async (arg) => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-secret-arg-"));
    try {
      const log = await writeFakeSsh(dir);
      process.env.PATH = `${dir}:${originalPath ?? ""}`;
      const onMeta = vi.fn(async () => {});
      const { execute } = await import("hermes-paperclip-adapter/server");
      await expect(execute({
        runId: "unsafe-argv", agent: { id: "a", companyId: "c", name: "A", role: "engineer", adapterType: "hermes_local", adapterConfig: { provider: "zai", extraArgs: [arg], env: { ZAI_API_KEY: ZAI_SECRET } } },
        runtime: {}, config: {}, context: {}, executionTarget: sshTarget,
        onLog: async () => {}, onMeta,
      } as never)).rejects.toThrow(/secret.*argv/i);
      expect(onMeta).not.toHaveBeenCalled();
      await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a non-ssh remote target instead of running on the server host", async () => {
    const { getServerAdapter } = await import("../adapters/registry.js");
    await expect(
      getServerAdapter("hermes_local").execute({
        runId: "run-sandbox-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Rome Provider",
          role: "engineer",
          adapterType: "hermes_local",
          adapterConfig: { provider: "zai" },
        },
        runtime: {},
        config: {},
        context: {},
        authToken: RUN_TOKEN,
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/tmp" },
        onLog: async () => {},
        onMeta: async () => {},
        onSpawn: async () => {},
      } as never),
    ).rejects.toThrow(/locally or over SSH only/);
  }, 120_000);
});
