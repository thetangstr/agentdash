import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshSpawnTarget } from "@paperclipai/adapter-utils/ssh";
import {
  DEFAULT_SANDBOX_REMOTE_CWD,
  resolveEnvironmentExecutionTarget,
} from "../services/environment-execution-target.js";

describe("resolveEnvironmentExecutionTarget", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
  });

  it("uses a bounded default cwd for sandbox targets when lease metadata omits remoteCwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
      leaseId: "lease-1",
      environmentId: "env-1",
      paperclipTransport: "bridge",
      timeoutMs: 30_000,
    });
  });

  it("prefers an explicit Paperclip API URL from lease metadata for sandbox targets", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://paperclip.example.test:3200";
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        paperclipApiUrl: "https://paperclip.example.test",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      paperclipApiUrl: "https://paperclip.example.test",
      paperclipTransport: "direct",
    });
  });

  describe("hermes_local over SSH", () => {
    const companyId = "0008870a-4a07-4e09-9a3e-1998f4c7d640";
    let identityFile = "";
    let knownHostsFile = "";

    beforeEach(async () => {
      delete process.env.AGENTDASH_HERMES_SSH_ENABLED;
      delete process.env.AGENTDASH_HERMES_SSH_ALLOWLIST;
      const dir = await mkdtemp(join(tmpdir(), "hermes-ssh-target-"));
      identityFile = join(dir, "ac-provider_ed25519");
      knownHostsFile = join(dir, "known_hosts");
      await writeFile(identityFile, "placeholder", { mode: 0o600 });
      await writeFile(`${identityFile}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPub agentdash\n");
      await writeFile(knownHostsFile, "127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost\n");
      mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
        driver: "ssh",
        config: {
          host: "127.0.0.1",
          port: 22,
          username: "ac-provider",
          remoteWorkspacePath: "/Users/ac-provider/agentdash",
          privateKey: null,
          privateKeySecretRef: null,
          knownHosts: null,
          strictHostKeyChecking: true,
          identityFile,
          knownHostsFile,
        },
      });
    });

    afterEach(() => {
      delete process.env.AGENTDASH_HERMES_SSH_ENABLED;
      delete process.env.AGENTDASH_HERMES_SSH_ALLOWLIST;
    });

    const resolveHermes = (overrides: { companyId?: string } = {}) =>
      resolveEnvironmentExecutionTarget({
        db: {} as never,
        companyId: overrides.companyId ?? companyId,
        adapterType: "hermes_local",
        environment: { id: "env-ssh", driver: "ssh", config: {} },
        leaseId: "lease-1",
        leaseMetadata: {},
      });

    it("returns null with the flag off, exactly as before", async () => {
      process.env.AGENTDASH_HERMES_SSH_ALLOWLIST = JSON.stringify({ "ac-provider@127.0.0.1": [companyId] });
      await expect(resolveHermes()).resolves.toBeNull();
      expect(mockResolveEnvironmentDriverConfigForRuntime).not.toHaveBeenCalled();
    });

    it("builds a hardened ssh target and argv for an allowlisted company and target", async () => {
      process.env.AGENTDASH_HERMES_SSH_ENABLED = "true";
      process.env.AGENTDASH_HERMES_SSH_ALLOWLIST = JSON.stringify({ "ac-provider@127.0.0.1": [companyId] });

      const target = await resolveHermes();
      expect(target).toMatchObject({
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/Users/ac-provider/agentdash",
        spec: {
          host: "127.0.0.1",
          port: 22,
          username: "ac-provider",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
          identityFile,
          knownHostsFile,
        },
      });
      if (target?.kind !== "remote" || target.transport !== "ssh") throw new Error("expected ssh target");

      // No process is spawned: the argv the run would hand to `ssh` is built and inspected.
      const spawnTarget = await buildSshSpawnTarget({
        spec: target.spec,
        command: "hermes",
        args: ["chat", "-q", "task", "-Q"],
        env: {},
      });
      await spawnTarget.cleanup();
      expect(spawnTarget.command).toBe("ssh");
      expect(spawnTarget.args.slice(0, -1)).toEqual([
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${knownHostsFile}`,
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-i", identityFile,
        "-o", "IdentitiesOnly=yes",
        "-o", "ForwardAgent=no",
        "-o", "ClearAllForwardings=yes",
        "-p", "22",
        "ac-provider@127.0.0.1",
      ]);
    });

    it("refuses (never falls back to local) for a company the target is not allowed for", async () => {
      process.env.AGENTDASH_HERMES_SSH_ENABLED = "true";
      process.env.AGENTDASH_HERMES_SSH_ALLOWLIST = JSON.stringify({ "ac-provider@127.0.0.1": [companyId] });
      await expect(resolveHermes({ companyId: "22222222-2222-4222-8222-222222222222" })).rejects.toThrow(
        /ac-provider@127\.0\.0\.1/,
      );
    });

    it("refuses a target that is not on the allowlist", async () => {
      process.env.AGENTDASH_HERMES_SSH_ENABLED = "true";
      process.env.AGENTDASH_HERMES_SSH_ALLOWLIST = JSON.stringify({ "ac-prov-b@127.0.0.1": [companyId] });
      await expect(resolveHermes()).rejects.toThrow(/allowed list/);
    });
  });
});
