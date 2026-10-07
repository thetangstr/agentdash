import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that reference them
// ---------------------------------------------------------------------------

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn());
const mockAdapterExecutionTargetToRemoteSpec = vi.hoisted(() => vi.fn());
const mockBuildWorkspaceRealizationRequest = vi.hoisted(() => vi.fn());
const mockUpdateLeaseMetadata = vi.hoisted(() => vi.fn());
const mockUpdateExecutionWorkspace = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetEnvironmentById = vi.hoisted(() => vi.fn());

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
  resolveEnvironmentExecutionTransport: vi.fn().mockResolvedValue(null),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetToRemoteSpec: mockAdapterExecutionTargetToRemoteSpec,
}));

vi.mock("../services/workspace-realization.js", () => ({
  buildWorkspaceRealizationRequest: mockBuildWorkspaceRealizationRequest,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: vi.fn(() => ({
    ensureLocalEnvironment: vi.fn(),
    getById: mockGetEnvironmentById,
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    updateLeaseMetadata: mockUpdateLeaseMetadata,
  })),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: vi.fn(() => ({
    update: mockUpdateExecutionWorkspace,
  })),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  environmentRunOrchestrator,
  EnvironmentRunError,
} from "../services/environment-run-orchestrator.ts";
import type { Environment, EnvironmentLease, ExecutionWorkspace } from "@paperclipai/shared";
import type { RealizedExecutionWorkspace } from "../services/workspace-runtime.ts";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEnvironment(driver: string = "local"): Environment {
  return {
    id: "env-1",
    companyId: "company-1",
    name: "Test Environment",
    description: null,
    driver: driver as Environment["driver"],
    status: "active",
    config: {},
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "lease-1",
    companyId: "company-1",
    environmentId: "env-1",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: "run-1",
    status: "active",
    leasePolicy: "ephemeral",
    provider: "local",
    providerLeaseId: null,
    acquiredAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeExecutionWorkspace(cwd: string = "/workspace/project"): RealizedExecutionWorkspace {
  return {
    baseCwd: "/workspace",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "ws-1",
    repoUrl: null,
    repoRef: null,
    strategy: "project_primary",
    cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
  };
}

function makePersistedExecutionWorkspace(
  overrides: Partial<ExecutionWorkspace> = {},
): ExecutionWorkspace {
  return {
    id: "ew-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "standard",
    strategyType: "project_primary",
    name: "workspace",
    status: "open",
    cwd: "/workspace/project",
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "local",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRealizeInput(overrides: {
  environment?: Environment;
  lease?: EnvironmentLease;
  persistedExecutionWorkspace?: ExecutionWorkspace | null;
} = {}): Parameters<ReturnType<typeof environmentRunOrchestrator>["realizeForRun"]>[0] {
  return {
    environment: overrides.environment ?? makeEnvironment("local"),
    lease: overrides.lease ?? makeLease(),
    adapterType: "claude_local",
    companyId: "company-1",
    issueId: null,
    heartbeatRunId: "run-1",
    executionWorkspace: makeExecutionWorkspace(),
    effectiveExecutionWorkspaceMode: null,
    persistedExecutionWorkspace: overrides.persistedExecutionWorkspace !== undefined
      ? overrides.persistedExecutionWorkspace
      : null,
  };
}

function makeMockRuntime(overrides: Partial<EnvironmentRuntimeService> = {}): EnvironmentRuntimeService {
  return {
    acquireRunLease: vi.fn(),
    releaseRunLeases: vi.fn(),
    execute: vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }),
    realizeWorkspace: vi.fn().mockResolvedValue({
      cwd: "/workspace/project",
      metadata: {
        workspaceRealization: {
          version: 1,
          driver: "local",
          cwd: "/workspace/project",
        },
      },
    }),
    ...overrides,
  } as unknown as EnvironmentRuntimeService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("environmentRunOrchestrator — realizeForRun", () => {
  const mockDb = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: null,
      },
    });

    mockAdapterExecutionTargetToRemoteSpec.mockReturnValue({
      kind: "local",
      environmentId: "env-1",
      leaseId: "lease-1",
    });

    mockUpdateLeaseMetadata.mockResolvedValue(null);
    mockUpdateExecutionWorkspace.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("happy path: returns lease, executionTarget, and remoteExecution on successful realization", async () => {
    const executionTarget = { kind: "local", environmentId: "env-1", leaseId: "lease-1" };
    const remoteExecution = { kind: "local", environmentId: "env-1", leaseId: "lease-1" };

    mockResolveEnvironmentExecutionTarget.mockResolvedValue(executionTarget);
    mockAdapterExecutionTargetToRemoteSpec.mockReturnValue(remoteExecution);

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput());

    expect(result.lease).toBeDefined();
    expect(result.executionTarget).toEqual(executionTarget);
    expect(result.remoteExecution).toEqual(remoteExecution);
    expect(result.workspaceRealization).toEqual(
      expect.objectContaining({ version: 1, driver: "local" }),
    );

    expect(runtime.realizeWorkspace).toHaveBeenCalledOnce();
    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledOnce();
  });

  it("realization failure: runtime.realizeWorkspace throws → EnvironmentRunError with code workspace_realization_failed", async () => {
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockRejectedValue(new Error("sandbox unreachable")),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput())).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "workspace_realization_failed" &&
        err.environmentId === "env-1" &&
        err.driver === "local",
    );

    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });

  it("target resolution failure: resolveEnvironmentExecutionTarget throws → EnvironmentRunError with code transport_resolution_failed", async () => {
    mockResolveEnvironmentExecutionTarget.mockRejectedValue(new Error("network error"));

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput())).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "transport_resolution_failed" &&
        err.environmentId === "env-1",
    );
  });

  it("non-sandbox driver skips workspace realization and goes straight to target resolution", async () => {
    const environment = makeEnvironment("plugin" as Environment["driver"]);
    const executionTarget = null;

    mockResolveEnvironmentExecutionTarget.mockResolvedValue(executionTarget);

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(
      makeRealizeInput({ environment }),
    );

    expect(runtime.realizeWorkspace).not.toHaveBeenCalled();
    expect(result.workspaceRealization).toEqual({});
    expect(result.executionTarget).toBeNull();
  });

  it("persisted metadata is updated on lease and execution workspace after realization", async () => {
    const persistedExecutionWorkspace = makePersistedExecutionWorkspace();
    const updatedLease = makeLease({
      metadata: { workspaceRealization: { version: 1, driver: "local", cwd: "/workspace/project" } },
    });
    const updatedEw = { ...persistedExecutionWorkspace, metadata: { workspaceRealizationRequest: {}, workspaceRealization: {} } };

    mockUpdateLeaseMetadata.mockResolvedValue(updatedLease);
    mockUpdateExecutionWorkspace.mockResolvedValue(updatedEw);
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({ kind: "local", environmentId: "env-1", leaseId: "lease-1" });

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(
      makeRealizeInput({ persistedExecutionWorkspace }),
    );

    // Lease metadata should have been updated with workspaceRealization
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledOnce();
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledWith(
      "lease-1",
      expect.objectContaining({ workspaceRealization: expect.any(Object) }),
    );

    // Execution workspace metadata should have been updated
    expect(mockUpdateExecutionWorkspace).toHaveBeenCalledOnce();
    expect(mockUpdateExecutionWorkspace).toHaveBeenCalledWith(
      "ew-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspaceRealizationRequest: expect.any(Object),
          workspaceRealization: expect.any(Object),
        }),
      }),
    );

    // The returned lease should reflect the updated value
    expect(result.lease).toEqual(updatedLease);
    expect(result.persistedExecutionWorkspace).toEqual(updatedEw);
  });

  it("runs a remote provision command after workspace realization when configured", async () => {
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: "npm install -g @anthropic-ai/claude-code",
      },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      remoteCwd: "/remote/workspace",
      environmentId: "env-1",
      leaseId: "lease-1",
    });

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/remote/workspace",
        metadata: {
          workspaceRealization: {
            version: 1,
            transport: "sandbox",
            remote: { path: "/remote/workspace" },
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("sandbox"),
    }));

    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({ driver: "sandbox" }),
      lease: expect.objectContaining({ id: "lease-1" }),
      command: "bash",
      args: ["-lc", "npm install -g @anthropic-ai/claude-code"],
      cwd: "/remote/workspace",
      env: {
        SHELL: "/bin/bash",
      },
    }));
  });

  it("surfaces remote provision command failures before resolving the adapter target", async () => {
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: "install-tool",
      },
    });

    const runtime = makeMockRuntime({
      execute: vi.fn().mockResolvedValue({
        exitCode: 127,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "/bin/sh: install-tool: not found\n",
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("sandbox"),
    }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "workspace_realization_failed" &&
        String(err.message).includes("install-tool: not found"),
    );

    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });
});

describe("environmentRunOrchestrator — hermes_local over SSH", () => {
  const FOUNDER_COMPANY = "0008870a-4a07-4e09-9a3e-1998f4c7d640";
  const keyDir = mkdtempSync(join(tmpdir(), "hermes-ssh-orchestrator-"));
  const identityFile = join(keyDir, "ac-provider_ed25519");
  const knownHostsFile = join(keyDir, "known_hosts");
  writeFileSync(identityFile, "placeholder", { mode: 0o600 });
  writeFileSync(`${identityFile}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPub agentdash\n");
  writeFileSync(knownHostsFile, "127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost\n");

  // The company environment only names the target; no key or known_hosts paths.
  const sshEnvironment: Environment = {
    ...makeEnvironment("ssh"),
    id: "env-ssh",
    companyId: FOUNDER_COMPANY,
    config: {
      host: "127.0.0.1",
      port: 2222,
      username: "ac-provider",
      remoteWorkspacePath: "/Users/ac-provider/agentdash",
    },
  };
  const otherSshEnvironment: Environment = { ...sshEnvironment, id: "env-ssh-other" };
  const localEnvironment: Environment = { ...makeEnvironment("local"), id: "env-local-issue", companyId: FOUNDER_COMPANY };
  const sandboxEnvironment: Environment = {
    ...makeEnvironment("sandbox"),
    id: "env-sandbox",
    companyId: FOUNDER_COMPANY,
    config: { provider: "fake-plugin" },
  };
  const byId: Record<string, Environment> = {
    [sshEnvironment.id]: sshEnvironment,
    [otherSshEnvironment.id]: otherSshEnvironment,
    [localEnvironment.id]: localEnvironment,
    [sandboxEnvironment.id]: sandboxEnvironment,
  };

  const allow = (extra: Record<string, unknown> = {}) => {
    process.env.AGENTDASH_HERMES_SSH_ENABLED = "true";
    process.env.AGENTDASH_HERMES_SSH_ALLOWLIST = JSON.stringify({
      "ac-provider@127.0.0.1": { companies: [FOUNDER_COMPANY], identityFile, knownHostsFile, port: 2222, ...extra },
    });
  };

  function makeRuntime() {
    return {
      acquireRunLease: vi.fn().mockResolvedValue({
        lease: makeLease({ id: "lease-ssh", environmentId: "env-ssh", provider: "ssh" }),
        leaseContext: { executionWorkspaceId: null },
      }),
    } as unknown as EnvironmentRuntimeService & { acquireRunLease: ReturnType<typeof vi.fn> };
  }

  const acquire = (
    runtime: EnvironmentRuntimeService,
    options: { selectedEnvironmentId?: string; agentDefaultEnvironmentId?: string | null } = {},
  ) =>
    environmentRunOrchestrator({} as never, { environmentRuntime: runtime }).acquireForRun({
      companyId: FOUNDER_COMPANY,
      selectedEnvironmentId: options.selectedEnvironmentId ?? "env-ssh",
      defaultEnvironmentId: "env-company-default",
      adapterType: "hermes_local",
      issueId: null,
      heartbeatRunId: "run-1",
      agentId: "agent-1",
      agentDefaultEnvironmentId: options.agentDefaultEnvironmentId === undefined ? "env-ssh" : options.agentDefaultEnvironmentId,
      persistedExecutionWorkspace: null,
    });

  const actions = () => mockLogActivity.mock.calls.map(([, entry]) => entry.action);

  async function expectRefused(runtime: ReturnType<typeof makeRuntime>, promise: Promise<unknown>, match: RegExp) {
    const error = await promise.catch((err) => err);
    expect(error).toBeInstanceOf(EnvironmentRunError);
    expect(error.code).toBe("unsupported_adapter_environment");
    expect(error.message).toMatch(match);
    expect(runtime.acquireRunLease).not.toHaveBeenCalled();
    expect(actions()).toContain("agent.ssh_run_refused");
    expect(actions()).not.toContain("environment.lease_acquired");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENTDASH_HERMES_SSH_ENABLED;
    delete process.env.AGENTDASH_HERMES_SSH_ALLOWLIST;
    mockGetEnvironmentById.mockImplementation(async (id: string) => byId[id] ?? null);
  });

  afterEach(() => {
    delete process.env.AGENTDASH_HERMES_SSH_ENABLED;
    delete process.env.AGENTDASH_HERMES_SSH_ALLOWLIST;
  });

  it("rollback: with the flag off a pinned Hermes agent is refused, with no lease and nothing run locally", async () => {
    process.env.AGENTDASH_HERMES_SSH_ALLOWLIST = JSON.stringify({
      "ac-provider@127.0.0.1": { companies: [FOUNDER_COMPANY], identityFile, knownHostsFile, port: 2222 },
    });
    const runtime = makeRuntime();
    await expectRefused(runtime, acquire(runtime), /turned off/);
  });

  it("refuses an unlisted target before any lease (no connection is made)", async () => {
    process.env.AGENTDASH_HERMES_SSH_ENABLED = "true";
    process.env.AGENTDASH_HERMES_SSH_ALLOWLIST = JSON.stringify({
      "ac-prov-b@127.0.0.1": { companies: [FOUNDER_COMPANY], identityFile, knownHostsFile, port: 2222 },
    });
    const runtime = makeRuntime();
    await expectRefused(runtime, acquire(runtime), /ac-provider@127\.0\.0\.1/);
  });

  it("refuses an environment on a port the operator did not pin", async () => {
    allow({ port: 22 });
    const runtime = makeRuntime();
    await expectRefused(runtime, acquire(runtime), /only on SSH port 22/);
  });

  it("refuses before any lease when the operator's key file is missing", async () => {
    allow({ identityFile: join(keyDir, "missing_ed25519") });
    const runtime = makeRuntime();
    await expectRefused(runtime, acquire(runtime), /key file/);
  });

  it("refuses an SSH environment chosen by an issue or project rather than the agent's admin pin", async () => {
    allow();
    const runtime = makeRuntime();
    await expectRefused(
      runtime,
      acquire(runtime, { selectedEnvironmentId: "env-ssh", agentDefaultEnvironmentId: null }),
      /pinned to the agent/,
    );
  });

  it("refuses an issue or project moving an SSH-pinned agent to another environment (local included)", async () => {
    allow();
    for (const selectedEnvironmentId of ["env-local-issue", "env-ssh-other"]) {
      vi.clearAllMocks();
      mockGetEnvironmentById.mockImplementation(async (id: string) => byId[id] ?? null);
      const runtime = makeRuntime();
      await expectRefused(runtime, acquire(runtime, { selectedEnvironmentId }), /pinned to an SSH environment/);
    }
  });

  it("refuses Hermes on a sandbox environment instead of running it on the server host", async () => {
    const runtime = makeRuntime();
    await expectRefused(
      runtime,
      acquire(runtime, { selectedEnvironmentId: "env-sandbox", agentDefaultEnvironmentId: null }),
      /only on this server or on an allowlisted SSH environment/,
    );
  });

  it("leases with the operator's connection only and audits the launch", async () => {
    allow();
    const runtime = makeRuntime();
    await acquire(runtime);
    expect(runtime.acquireRunLease).toHaveBeenCalledTimes(1);
    expect(runtime.acquireRunLease.mock.calls[0]?.[0]).toMatchObject({
      operatorSshConnection: {
        host: "127.0.0.1",
        port: 2222,
        username: "ac-provider",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
        identityFile,
        knownHostsFile,
      },
    });
    const audit = mockLogActivity.mock.calls.find(([, entry]) => entry.action === "agent.ssh_run_launched");
    expect(audit?.[1]).toMatchObject({
      companyId: FOUNDER_COMPANY,
      agentId: "agent-1",
      runId: "run-1",
      entityType: "heartbeat_run",
      details: { environmentId: "env-ssh", sshTarget: "ac-provider@127.0.0.1", adapterType: "hermes_local" },
    });
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain(identityFile);
  });
});
