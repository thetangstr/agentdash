import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * hermes_local over an SSH execution target, end to end through the registry
 * wrapper and the patched vendored adapter — with a fake `ssh` on PATH, so no
 * connection is made. The fake records every argv and any stdin it is fed.
 */

const RUN_TOKEN = "test-run-token-value";
const ZAI_SECRET = "zai-secret-value";
const SERVER_SECRET = "postgres://server-only-secret@db/agentdash";

async function writeFakeSsh(dir: string): Promise<string> {
  const logPath = join(dir, "ssh-calls.jsonl");
  await writeFile(
    join(dir, "ssh"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const argv = process.argv.slice(2);",
      "const remote = argv[argv.length - 1] || \"\";",
      `const log = ${JSON.stringify(logPath)};`,
      "if (remote.includes(\"tar -xf -\")) {",
      "  const chunks = [];",
      "  process.stdin.on(\"data\", (c) => chunks.push(c));",
      "  process.stdin.on(\"end\", () => {",
      "    fs.appendFileSync(log, JSON.stringify({ argv, stdin: Buffer.concat(chunks).toString(\"latin1\") }) + \"\\n\");",
      "    process.exit(0);",
      "  });",
      "} else {",
      "  fs.appendFileSync(log, JSON.stringify({ argv }) + \"\\n\");",
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
    expect((result.resultJson as Record<string, unknown>).meteringStatus).toBe("unmetered_no_ledger");
    expect(logs.join("")).toContain("target=SSH environment ac-provider@127.0.0.1:22");

    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; stdin?: string });
    // stage env (tar over stdin) → run → sweep
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.argv.slice(0, -1)).toEqual([
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=/etc/agentdash/ssh/known_hosts",
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-i", "/etc/agentdash/ssh/ac-provider_ed25519",
        "-o", "IdentitiesOnly=yes",
        "-o", "ForwardAgent=no",
        "-o", "ClearAllForwardings=yes",
        "-p", "22",
        "ac-provider@127.0.0.1",
      ]);
      const argvText = JSON.stringify(call.argv);
      expect(argvText).not.toContain(RUN_TOKEN);
      expect(argvText).not.toContain(ZAI_SECRET);
      expect(argvText).not.toContain(SERVER_SECRET);
    }

    const [stage, run, sweep] = calls;
    expect(stage!.argv.at(-1)).toContain(".paperclip-runenv/run-ssh-1");
    expect(stage!.stdin).toContain(`PAPERCLIP_API_KEY='${RUN_TOKEN}'`);
    expect(stage!.stdin).toContain(`ZAI_API_KEY='${ZAI_SECRET}'`);
    expect(stage!.stdin).not.toContain(SERVER_SECRET);
    expect(run!.argv.at(-1)).toContain("cd '\"'\"'/Users/ac-provider/agentdash'\"'\"'");
    expect(run!.argv.at(-1)).toContain("'\"'\"'hermes'\"'\"' '\"'\"'chat'\"'\"'");
    expect(run!.argv.at(-1)).not.toContain("exec env");
    expect(sweep!.argv.at(-1)).toBe("rm -rf '/Users/ac-provider/agentdash/.paperclip-runenv/run-ssh-1'");
  }, 120_000);

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
