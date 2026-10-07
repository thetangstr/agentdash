import { beforeEach, describe, expect, it, vi } from "vitest";

// The SSH lease driver connects with operator-resolved values (Hermes over
// SSH) when the orchestrator passes them, and with the company environment's
// config otherwise. No ssh process is spawned: the ssh helpers are stubbed.

const mockEnsureSshWorkspaceReady = vi.hoisted(() => vi.fn());
const mockFindReachable = vi.hoisted(() => vi.fn());
const mockResolveConfig = vi.hoisted(() => vi.fn());
const mockAcquireLease = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>()),
  ensureSshWorkspaceReady: mockEnsureSshWorkspaceReady,
  findReachablePaperclipApiUrlOverSsh: mockFindReachable,
}));

vi.mock("../services/environment-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/environment-config.js")>()),
  resolveEnvironmentDriverConfigForRuntime: mockResolveConfig,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ acquireLease: mockAcquireLease }),
}));

import { environmentRuntimeService } from "../services/environment-runtime.js";

const tenantConfig = {
  host: "127.0.0.1",
  port: 2222,
  username: "ac-provider",
  remoteWorkspacePath: "/Users/ac-provider/agentdash",
  privateKey: "tenant-key-material",
  privateKeySecretRef: null,
  knownHosts: "tenant-known-hosts",
  strictHostKeyChecking: false,
};

const operatorSshConnection = {
  host: "127.0.0.1",
  port: 2222,
  username: "ac-provider",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true as const,
  identityFile: "/etc/agentdash/ssh/ac-provider_ed25519",
  knownHostsFile: "/etc/agentdash/ssh/known_hosts",
};

const environment = {
  id: "env-ssh",
  companyId: "company-1",
  name: "ac-provider",
  description: null,
  driver: "ssh",
  status: "active",
  config: {},
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as never;

describe("SSH lease driver connection source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfig.mockResolvedValue({ driver: "ssh", config: tenantConfig });
    mockEnsureSshWorkspaceReady.mockResolvedValue({ remoteCwd: "/Users/ac-provider/agentdash" });
    mockFindReachable.mockResolvedValue("http://127.0.0.1:3100");
    mockAcquireLease.mockImplementation(async (lease: unknown) => ({ id: "lease-1", ...(lease as object) }));
  });

  const acquire = (extra: Record<string, unknown> = {}) =>
    environmentRuntimeService({} as never).acquireRunLease({
      companyId: "company-1",
      environment,
      issueId: null,
      heartbeatRunId: "run-1",
      persistedExecutionWorkspace: null,
      ...extra,
    });

  it("uses the company environment's config when no operator connection is passed (unchanged)", async () => {
    await acquire();
    expect(mockEnsureSshWorkspaceReady).toHaveBeenCalledWith(tenantConfig);
    expect(mockFindReachable.mock.calls[0]?.[0].config).toBe(tenantConfig);
  });

  it("connects with operator values only for an approved Hermes target", async () => {
    await acquire({ operatorSshConnection });
    const used = mockEnsureSshWorkspaceReady.mock.calls[0]?.[0];
    expect(used).toMatchObject(operatorSshConnection);
    expect(used.privateKey).toBeNull();
    expect(used.knownHosts).toBeNull();
    expect(used.strictHostKeyChecking).toBe(true);
    expect(mockFindReachable.mock.calls[0]?.[0].config).toMatchObject(operatorSshConnection);
  });
});
