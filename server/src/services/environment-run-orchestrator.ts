/**
 * Centralized environment run orchestrator.
 *
 * Owns the full environment lifecycle for a heartbeat run:
 *   1. Resolve selected environment
 *   2. Validate environment is active and allowed
 *   3. Acquire or resume lease
 *   4. Realize workspace in the environment
 *   5. Resolve execution target for the adapter
 *   6. Release / retain / fail lease according to policy
 *   7. Record activity and operator-visible status
 *
 * Heartbeat callers delegate to this service instead of inlining
 * environment resolution, lease management, workspace realization,
 * and transport logic.
 */

import type { Db } from "@paperclipai/db";
import type {
  Environment,
  EnvironmentLease,
  EnvironmentLeasePolicy,
  EnvironmentLeaseStatus,
  ExecutionWorkspace,
  ExecutionWorkspaceConfig,
} from "@paperclipai/shared";
import { environmentService } from "./environments.js";
import {
  environmentRuntimeService,
  buildEnvironmentLeaseContext,
  type EnvironmentRuntimeLeaseRecord,
  type EnvironmentRuntimeService,
  type OperatorSshConnection,
} from "./environment-runtime.js";
import {
  resolveEnvironmentExecutionTarget,
  resolveEnvironmentExecutionTransport,
} from "./environment-execution-target.js";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
  type AdapterRemoteExecutionSpec,
} from "@paperclipai/adapter-utils/execution-target";
import { buildWorkspaceRealizationRequest } from "./workspace-realization.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { logActivity } from "./activity-log.js";
import {
  HERMES_SSH_DISABLED_MESSAGE,
  assertHermesSshLaunchReady,
  evaluateHermesSshEnvironment,
  hermesSshConnectionFor,
  hermesSshEnabled,
} from "./hermes-ssh-policy.js";
import { parseObject } from "../adapters/utils.js";
import type { RealizedExecutionWorkspace } from "./workspace-runtime.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type EnvironmentErrorCode =
  | "environment_not_found"
  | "environment_inactive"
  | "unsupported_environment"
  | "unsupported_adapter_environment"
  | "probe_failed"
  | "lease_acquire_failed"
  | "workspace_realization_failed"
  | "transport_resolution_failed"
  | "lease_release_failed"
  | "lease_cleanup_failed";

export class EnvironmentRunError extends Error {
  code: EnvironmentErrorCode;
  environmentId?: string;
  driver?: string;
  provider?: string;
  cause?: unknown;

  constructor(
    code: EnvironmentErrorCode,
    message: string,
    details?: {
      environmentId?: string;
      driver?: string;
      provider?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "EnvironmentRunError";
    this.code = code;
    this.environmentId = details?.environmentId;
    this.driver = details?.driver;
    this.provider = details?.provider;
    this.cause = details?.cause;
  }
}

// ---------------------------------------------------------------------------
// Orchestration result types
// ---------------------------------------------------------------------------

export interface EnvironmentAcquisitionResult {
  environment: Environment;
  lease: EnvironmentLease;
  leaseContext: ReturnType<typeof buildEnvironmentLeaseContext>;
  executionTransport: Record<string, unknown> | null;
}

export interface EnvironmentRealizationResult {
  lease: EnvironmentLease;
  workspaceRealization: Record<string, unknown>;
  executionTarget: AdapterExecutionTarget | null;
  remoteExecution: AdapterRemoteExecutionSpec | null;
  persistedExecutionWorkspace: ExecutionWorkspace | null;
}

export interface EnvironmentReleaseResult {
  released: EnvironmentRuntimeLeaseRecord[];
  errors: Array<{ leaseId: string; error: unknown }>;
}

function firstNonEmptyLine(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line) return line;
  }
  return null;
}

function formatProvisionFailureDetail(result: {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): string {
  if (result.timedOut) {
    return "provision command timed out";
  }
  const signal = typeof result.signal === "string" && result.signal.trim().length > 0
    ? ` (signal ${result.signal.trim()})`
    : "";
  const detail = firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout);
  const status = `exit code ${result.exitCode ?? "null"}${signal}`;
  return detail ? `${status}: ${detail}` : status;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function environmentRunOrchestrator(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    environmentRuntime?: EnvironmentRuntimeService;
  } = {},
) {
  const environmentsSvc = environmentService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const environmentRuntime = options.environmentRuntime ?? environmentRuntimeService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });

  /**
   * Resolve the selected environment for a run. Ensures a local default
   * exists and resolves the priority chain:
   *   execution workspace config > issue settings > project policy > agent default > company default
   */
  async function resolveEnvironment(input: {
    companyId: string;
    selectedEnvironmentId: string;
    defaultEnvironmentId: string;
  }): Promise<Environment> {
    const environmentId =
      input.selectedEnvironmentId || input.defaultEnvironmentId;

    const environment =
      environmentId === input.defaultEnvironmentId
        ? await environmentsSvc.ensureLocalEnvironment(input.companyId)
        : await environmentsSvc.getById(environmentId);

    if (!environment) {
      throw new EnvironmentRunError("environment_not_found", `Environment "${environmentId}" not found.`, {
        environmentId,
      });
    }

    if (environment.companyId !== input.companyId) {
      throw new EnvironmentRunError("environment_not_found", `Environment "${environmentId}" does not belong to this company.`, {
        environmentId,
      });
    }

    if (environment.status !== "active") {
      throw new EnvironmentRunError("environment_inactive", `Environment "${environment.name}" is not active (status: ${environment.status}).`, {
        environmentId: environment.id,
        driver: environment.driver,
      });
    }

    return environment;
  }

  /**
   * Acquire an environment lease for a heartbeat run.
   * Wraps the runtime driver's acquire call with standardized error handling.
   */
  async function acquireLease(input: {
    companyId: string;
    environment: Environment;
    issueId: string | null;
    heartbeatRunId: string;
    persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
    operatorSshConnection?: OperatorSshConnection | null;
  }): Promise<EnvironmentRuntimeLeaseRecord> {
    try {
      return await environmentRuntime.acquireRunLease(input);
    } catch (err) {
      throw new EnvironmentRunError(
        "lease_acquire_failed",
        `Failed to acquire lease for environment "${input.environment.name}" (${input.environment.driver}): ${err instanceof Error ? err.message : String(err)}`,
        {
          environmentId: input.environment.id,
          driver: input.environment.driver,
          cause: err,
        },
      );
    }
  }

  /**
   * Resolve the execution transport for an adapter based on the acquired lease.
   */
  async function resolveTransport(input: {
    companyId: string;
    adapterType: string;
    environment: Environment;
    leaseMetadata: Record<string, unknown> | null;
  }): Promise<Record<string, unknown> | null> {
    try {
      return await resolveEnvironmentExecutionTransport({
        db,
        companyId: input.companyId,
        adapterType: input.adapterType,
        environment: input.environment,
        leaseMetadata: input.leaseMetadata,
      });
    } catch (err) {
      throw new EnvironmentRunError(
        "transport_resolution_failed",
        `Failed to resolve execution transport for "${input.environment.name}": ${err instanceof Error ? err.message : String(err)}`,
        {
          environmentId: input.environment.id,
          driver: input.environment.driver,
          cause: err,
        },
      );
    }
  }

  /**
   * Full acquisition flow: resolve environment, acquire lease, resolve transport.
   * This is the primary entry point for heartbeat run setup.
   */
  async function acquireForRun(input: {
    companyId: string;
    selectedEnvironmentId: string;
    defaultEnvironmentId: string;
    adapterType: string;
    issueId: string | null;
    heartbeatRunId: string;
    agentId: string;
    /** AgentDash: the agent's own (admin-set) default environment, if any. */
    agentDefaultEnvironmentId?: string | null;
    persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
  }): Promise<EnvironmentAcquisitionResult> {
    // Step 1: Resolve environment
    const environment = await resolveEnvironment({
      companyId: input.companyId,
      selectedEnvironmentId: input.selectedEnvironmentId,
      defaultEnvironmentId: input.defaultEnvironmentId,
    });

    // AgentDash: hermes_local outside the local environment. Every check runs
    // before the lease, so a refused host is never connected to, and a refusal
    // fails the run: Hermes is never quietly run locally as the server user.
    let hermesSshTarget: string | null = null;
    let operatorSshConnection: ReturnType<typeof hermesSshConnectionFor> | null = null;
    if (input.adapterType === "hermes_local") {
      const refuse = async (message: string): Promise<never> => {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.heartbeatRunId,
          action: "agent.ssh_run_refused",
          entityType: "heartbeat_run",
          entityId: input.heartbeatRunId,
          details: {
            environmentId: environment.id,
            driver: environment.driver,
            adapterType: input.adapterType,
            issueId: input.issueId,
            reason: message,
          },
        });
        throw new EnvironmentRunError("unsupported_adapter_environment", message, {
          environmentId: environment.id,
          driver: environment.driver,
        });
      };
      const pinnedEnvironmentId = input.agentDefaultEnvironmentId ?? null;
      // An admin's SSH pin can't be overridden by an issue or project picking
      // another environment (local included).
      if (pinnedEnvironmentId && pinnedEnvironmentId !== environment.id) {
        const pinned = await environmentsSvc.getById(pinnedEnvironmentId);
        if (pinned?.driver === "ssh") {
          await refuse(
            "This Hermes agent is pinned to an SSH environment by an admin; an issue or project can't move its runs to a different environment. Nothing was run.",
          );
        }
      }
      if (environment.driver !== "local") {
        if (environment.driver !== "ssh") {
          await refuse(
            "Hermes agents run only on this server or on an allowlisted SSH environment pinned by an admin. Nothing was run.",
          );
        }
        if (!hermesSshEnabled()) await refuse(HERMES_SSH_DISABLED_MESSAGE);
        // Issue- and project-level selection can't put a Hermes run on SSH;
        // only the agent's own admin-set pin can.
        if (environment.id !== pinnedEnvironmentId) {
          await refuse(
            "Hermes agents run over SSH only on the environment an admin pinned to the agent; an issue or project can't choose one. Nothing was run.",
          );
        }
        const decision = evaluateHermesSshEnvironment({
          companyId: input.companyId,
          config: parseObject(environment.config),
        });
        if (!decision.ok) return await refuse(decision.message);
        const connection = hermesSshConnectionFor(decision.entry);
        try {
          await assertHermesSshLaunchReady(connection);
        } catch (err) {
          await refuse(err instanceof Error ? err.message : String(err));
        }
        hermesSshTarget = decision.target;
        operatorSshConnection = connection;
      }
    }

    // Step 2: Acquire lease
    const leaseRecord = await acquireLease({
      companyId: input.companyId,
      environment,
      issueId: input.issueId,
      heartbeatRunId: input.heartbeatRunId,
      persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      ...(operatorSshConnection ? { operatorSshConnection } : {}),
    });

    // Step 3: Log lease acquisition activity
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.heartbeatRunId,
      action: "environment.lease_acquired",
      entityType: "environment_lease",
      entityId: leaseRecord.lease.id,
      details: {
        environmentId: environment.id,
        driver: environment.driver,
        leasePolicy: leaseRecord.lease.leasePolicy,
        provider: leaseRecord.lease.provider,
        executionWorkspaceId: leaseRecord.leaseContext.executionWorkspaceId,
        issueId: input.issueId,
      },
    });

    if (hermesSshTarget) {
      // AgentDash: audit every hermes run launched over SSH (target and ids only).
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
        runId: input.heartbeatRunId,
        action: "agent.ssh_run_launched",
        entityType: "heartbeat_run",
        entityId: input.heartbeatRunId,
        details: {
          environmentId: environment.id,
          adapterType: input.adapterType,
          sshTarget: hermesSshTarget,
          leaseId: leaseRecord.lease.id,
          issueId: input.issueId,
        },
      });
    }

    // Step 4: Resolve execution transport
    const executionTransport = await resolveTransport({
      companyId: input.companyId,
      adapterType: input.adapterType,
      environment,
      leaseMetadata: leaseRecord.lease.metadata,
    });

    return {
      environment,
      lease: leaseRecord.lease,
      leaseContext: leaseRecord.leaseContext,
      executionTransport,
    };
  }

  /**
   * Realize workspace in the environment and resolve the execution target.
   *
   * After lease acquisition, this method:
   *   1. Builds a workspace realization request
   *   2. Calls the environment runtime driver to realize the workspace
   *   3. Persists realization metadata on the lease and execution workspace
   *   4. Resolves the adapter execution target (local/ssh/sandbox)
   *
   * Returns the updated lease, realization metadata, and the execution
   * target spec that the adapter needs to run.
   */
  async function realizeForRun(input: {
    environment: Environment;
    lease: EnvironmentLease;
    adapterType: string;
    companyId: string;
    issueId: string | null;
    heartbeatRunId: string;
    executionWorkspace: RealizedExecutionWorkspace;
    effectiveExecutionWorkspaceMode: string | null;
    persistedExecutionWorkspace: ExecutionWorkspace | null;
  }): Promise<EnvironmentRealizationResult> {
    const {
      environment,
      adapterType,
      companyId,
      issueId,
      heartbeatRunId,
      executionWorkspace,
      effectiveExecutionWorkspaceMode,
    } = input;
    let { lease, persistedExecutionWorkspace } = input;

    // Step 1: Build workspace realization request
    const workspaceRealizationRequest = buildWorkspaceRealizationRequest({
      adapterType,
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: persistedExecutionWorkspace?.id ?? null,
      issueId,
      heartbeatRunId,
      requestedMode: persistedExecutionWorkspace?.mode ?? effectiveExecutionWorkspaceMode,
      workspace: executionWorkspace,
      workspaceConfig: persistedExecutionWorkspace?.config ?? null,
    });

    // Step 2: Realize workspace in the environment via the runtime driver
    let workspaceRealization: Record<string, unknown> = {};
    let realizedWorkspaceCwd: string | null = null;
    if (
      environment.driver === "local" ||
      environment.driver === "ssh" ||
      environment.driver === "sandbox"
    ) {
      try {
        const remoteCwd =
          typeof lease.metadata?.remoteCwd === "string" && lease.metadata.remoteCwd.trim().length > 0
            ? lease.metadata.remoteCwd
            : undefined;
        const workspaceRealizationResult = await environmentRuntime.realizeWorkspace({
          environment,
          lease,
          workspace: {
            localPath: executionWorkspace.cwd,
            remotePath: remoteCwd,
            mode: persistedExecutionWorkspace?.mode ?? effectiveExecutionWorkspaceMode ?? undefined,
            metadata: {
              workspaceRealizationRequest,
            },
          },
        });
        realizedWorkspaceCwd =
          typeof workspaceRealizationResult.cwd === "string" && workspaceRealizationResult.cwd.trim().length > 0
            ? workspaceRealizationResult.cwd.trim()
            : null;
        workspaceRealization = parseObject(workspaceRealizationResult.metadata?.workspaceRealization);
      } catch (err) {
        throw new EnvironmentRunError(
          "workspace_realization_failed",
          `Failed to realize workspace for environment "${environment.name}" (${environment.driver}): ${err instanceof Error ? err.message : String(err)}`,
          {
            environmentId: environment.id,
            driver: environment.driver,
            cause: err,
          },
        );
      }
    }

    const provisionCommand = workspaceRealizationRequest.runtimeOverlay.provisionCommand?.trim() ?? "";
    const realizedCwd =
      realizedWorkspaceCwd ??
      (typeof lease.metadata?.remoteCwd === "string" && lease.metadata.remoteCwd.trim().length > 0
        ? lease.metadata.remoteCwd.trim()
        : executionWorkspace.cwd);
    if (provisionCommand && environment.driver !== "local") {
      try {
        const provisionResult = await environmentRuntime.execute({
          environment,
          lease,
          command: "bash",
          args: ["-lc", provisionCommand],
          cwd: realizedCwd,
          env: {
            SHELL: "/bin/bash",
          },
          timeoutMs: 300_000,
        });
        if (provisionResult.exitCode !== 0 || provisionResult.timedOut) {
          throw new Error(formatProvisionFailureDetail(provisionResult));
        }
      } catch (err) {
        throw new EnvironmentRunError(
          "workspace_realization_failed",
          `Failed to provision workspace for environment "${environment.name}" (${environment.driver}): ${err instanceof Error ? err.message : String(err)}`,
          {
            environmentId: environment.id,
            driver: environment.driver,
            cause: err,
          },
        );
      }
    }

    // Step 3: Persist realization metadata on lease and execution workspace
    if (Object.keys(workspaceRealization).length > 0) {
      const nextLeaseMetadata = {
        ...(lease.metadata ?? {}),
        workspaceRealization,
      };
      const updatedLease = await environmentsSvc.updateLeaseMetadata(lease.id, nextLeaseMetadata);
      if (updatedLease) {
        lease = updatedLease;
      }
      if (persistedExecutionWorkspace) {
        const updatedEw = await executionWorkspacesSvc.update(persistedExecutionWorkspace.id, {
          metadata: {
            ...(persistedExecutionWorkspace.metadata ?? {}),
            workspaceRealizationRequest,
            workspaceRealization,
          },
        });
        if (updatedEw) {
          persistedExecutionWorkspace = updatedEw;
        }
      }
    }

    // Step 4: Resolve execution target for the adapter
    let executionTarget: AdapterExecutionTarget | null;
    try {
      executionTarget = await resolveEnvironmentExecutionTarget({
        db,
        companyId,
        adapterType,
        environment,
        leaseId: lease.id,
        leaseMetadata: (lease.metadata as Record<string, unknown> | null) ?? null,
        lease,
        environmentRuntime,
      });
    } catch (err) {
      throw new EnvironmentRunError(
        "transport_resolution_failed",
        `Failed to resolve execution target for "${environment.name}": ${err instanceof Error ? err.message : String(err)}`,
        {
          environmentId: environment.id,
          driver: environment.driver,
          cause: err,
        },
      );
    }

    return {
      lease,
      workspaceRealization,
      executionTarget,
      remoteExecution: adapterExecutionTargetToRemoteSpec(executionTarget),
      persistedExecutionWorkspace,
    };
  }

  /**
   * Release all active leases for a heartbeat run.
   * Tracks cleanup status per lease. Errors during individual lease release
   * are captured but do not prevent other leases from being released.
   * The original run failure (if any) is never hidden by cleanup errors.
   */
  async function releaseForRun(input: {
    heartbeatRunId: string;
    companyId: string;
    agentId: string;
    status?: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
    failureReason?: string;
  }): Promise<EnvironmentReleaseResult> {
    const status = input.status ?? "released";
    const result: EnvironmentReleaseResult = { released: [], errors: [] };

    let releasedLeases: EnvironmentRuntimeLeaseRecord[];
    try {
      releasedLeases = await environmentRuntime.releaseRunLeases(input.heartbeatRunId, status);
    } catch (err) {
      result.errors.push({ leaseId: "*", error: err });
      return result;
    }

    for (const released of releasedLeases) {
      try {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.heartbeatRunId,
          action: "environment.lease_released",
          entityType: "environment_lease",
          entityId: released.lease.id,
          details: {
            environmentId: released.lease.environmentId,
            driver: released.environment.driver,
            leasePolicy: released.lease.leasePolicy,
            provider: released.lease.provider,
            executionWorkspaceId: released.lease.executionWorkspaceId,
            issueId: released.lease.issueId,
            status: released.lease.status,
            cleanupStatus: released.lease.cleanupStatus,
            failureReason: input.failureReason ?? released.lease.failureReason,
          },
        });
      } catch {
        // Activity logging failure should not block lease release
      }
      result.released.push(released);
    }

    return result;
  }

  return {
    resolveEnvironment,
    acquireLease,
    resolveTransport,
    acquireForRun,
    realizeForRun,
    releaseForRun,

    // Expose the underlying runtime for cases that need direct driver access
    runtime: environmentRuntime,
  };
}

export type EnvironmentRunOrchestrator = ReturnType<typeof environmentRunOrchestrator>;
