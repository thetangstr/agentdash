import { publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { isBillingDisabled } from "../services/tier-policy.js";
import { agentConfigurationAuthority, resolveAccountabilityPatch, recordAccountabilityChange } from "../services/human-control/ownership.js";
import { workforceService } from "../services/workforce.js";
import { type ActivityAcceptance } from "../services/activity-log.js";
import { Router, type Request, type Response } from "express";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agentConnectCodes, agentWakeupRequests, agents as agentsTable, assistantConversations, assistantMessages, companies, heartbeatRuns, issues as issuesTable } from "@paperclipai/db";
import { and, count, desc, eq, gte, inArray, isNull, ne, not, or, sql } from "drizzle-orm";
import {
  agentSkillSyncSchema,
  agentMineInboxQuerySchema,
  createAgentKeySchema,
  createAgentHireSchema,
  createAgentSchema,
  deriveAgentUrlKey,
  isUuidLike,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  type AgentRunHealth,
  type AgentSkillSnapshot,
  type InstanceSchedulerHeartbeatAgent,
  upsertAgentInstructionsFileSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentPermissionsSchema,
  updateAgentTokenCeilingSchema,
  updateAgentInstructionsPathSchema,
  wakeAgentSchema,
  updateAgentSchema,
  supportedEnvironmentDriversForAdapter,
  isBlockingPreflightResult,
  RUN_CANCELLED_BY_OPERATOR_MESSAGE,
  RUN_CANCELLED_BY_OPERATOR_CODE,
  AGENT_MODEL_TIER_METADATA_KEY,
  HERMES_LOCAL_ADAPTER_TYPE,
  hermesModelTierForModel,
  type HermesModelTierId,
} from "@paperclipai/shared";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { trackAgentCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  CONNECT_CODE_MAX_RETRIES,
  CONNECT_CODE_TTL_MS,
  createConnectCode,
  formatConnectCode,
  hashConnectCode,
  isConnectCodeHashCollisionError,
} from "../lib/connect-codes.js";
import { buildRequireTierDeps } from "../middleware/build-tier-deps.js";
import { normalizeNewAgentRuntimeConfig } from "../services/agent-create-config.js";
import {
  freeTierCapExceededPayload,
  withCompanyTierCapacityGuard,
} from "../services/tier-policy.js";
import {
  agentInstructionRefreshService,
  agentService,
  agentInstructionsService,
  accessService,
  approvalService,
  companySkillService,
  budgetService,
  heartbeatService,
  ISSUE_LIST_DEFAULT_LIMIT,
  issueApprovalService,
  issueService,
  logActivity,
  syncInstructionsBundleConfigFromFilePath,
  workspaceOperationService,
} from "../services/index.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertNoAssistantProvenanceClaim } from "../services/assistant-provenance-claims.js";
import {
  actorMaySetHostExecutionConfig,
  assertHostExecutionConfigAllowed,
  runtimeConfigHostExecutionInputs,
} from "../services/adapter-host-execution-policy.js";
import { hostExecutionContextForCompany } from "../services/host-execution-context.js";
import { applyHermesModelTierIfActive, hermesModelTiersActive } from "../services/hermes-model-tiers.js";
import {
  checkCompanyInstructionsPath,
  findProtectedHostDirectoryOverlap,
} from "../services/instructions-root-confinement.js";
import { actorHumanRole, assertCanSetCompanyDirection, assertBoard, assertCompanyAccess, assertInstanceAdmin, assistantGrantAttribution, getActorInfo,
  assertCompanyAdministrator,
} from "./authz.js";
// AgentDash (GH #505): member emails reach only callers allowed to read them.
import { canViewMemberEmails, visibleMemberEmail } from "./member-email-visibility.js";
import {
  canReadCompanySpend,
  assertWorkspaceOperationVisible,
  filterVisibleWorkspaceOperations,
  agentVisibilityCondition,
  assertAgentIdVisible,
  assertIssueIdVisible,
  issueVisibilityParam,
  pruneOrgTreeToVisible,
  resolveAgentVisibility,
  runVisibilityCondition,
  runVisibilityParam,
  projectScopedVisibilityCondition,
  wakeVisibilityCondition,
  visibleAgentIdsFor,
} from "./visibility.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { founderStewardshipDeps, pairFounderWithAgent } from "../services/founder-stewardship.js";
import { approvalDecisionEffectsService } from "../services/approval-decision-effects.js";
import {
  approvalAuthorityService,
  type ApprovalDecisionRole,
} from "../services/approval-authority.js";
import {
  type AgentAccountability,
  agentAccountabilityService,
  assertAgentMayHoldKey,
  normalizeAgentAutonomy,
} from "../services/agent-accountability.js";
import { logger } from "../middleware/logger.js";
import {
  assertHostWorkspaceCommandAuthority,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { assertCanPinHermesSsh, assertHermesSshEnvironmentPermitted, hermesSshEnabled, withHermesSshCompanyLock } from "../services/hermes-ssh-policy.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { secretService } from "../services/secrets.js";
import {
  detectAdapterModel,
  findActiveServerAdapter,
  findServerAdapter,
  listAdapterModels,
  listAdapterModelProfiles,
  refreshAdapterModels,
  requireServerAdapter,
} from "../adapters/index.js";
import { redactApprovalForReader, redactEventPayload, redactMonthlySpendForReader } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { redactRunLogValue } from "../services/run-log-redaction.js";
import { parseRunWindowBounds, readAgentRunWindow } from "../services/agent-run-window.js";
import { resolveAgentWakePolicy } from "../services/agent-wake-policy.js";
import { renderOrgChartSvg, renderOrgChartPng, type OrgNode, type OrgChartStyle, ORG_CHART_STYLES } from "./org-chart-svg.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { resolveMaxDailyTokens, tokenCeilingService } from "../services/token-ceiling.js";
import { runClaudeLogin } from "@paperclipai/adapter-claude-local/server";
import {
  DEFAULT_ACPX_LOCAL_AGENT,
  DEFAULT_ACPX_LOCAL_MODE,
  DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
} from "@paperclipai/adapter-acpx-local";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { ensureOpenCodeModelConfiguredAndAvailable } from "@paperclipai/adapter-opencode-local/server";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import { LEGACY_PROMPT_TEMPLATE_PATH } from "../services/agent-instructions.js";
import { getTelemetryClient } from "../telemetry.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  evaluateAgentHarnessPreflightReadiness,
  shouldRequireAgentHarnessPreflight,
  withAgentHarnessPreflightMetadata,
} from "../services/agent-harness-preflight-readiness.js";
import { adapterSupportsInstructionsBundle, resolveInstructionsPathKey } from "../adapters/instructions-bundle-support.js";
import {
  resolveAgentRuntimeModel,
  type AgentResolvedRuntime,
} from "../services/agent-runtime-model.js";

const RUN_LOG_DEFAULT_LIMIT_BYTES = 256_000;
const RUN_LOG_MAX_LIMIT_BYTES = 1024 * 1024;

function readRunLogLimitBytes(value: unknown) {
  const parsed = Number(value ?? RUN_LOG_DEFAULT_LIMIT_BYTES);
  if (!Number.isFinite(parsed)) return RUN_LOG_DEFAULT_LIMIT_BYTES;
  return Math.max(1, Math.min(RUN_LOG_MAX_LIMIT_BYTES, Math.trunc(parsed)));
}

function readLiveRunsQueryInt(value: unknown, max: number, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.min(max, Math.trunc(parsed));
}

// AgentDash: pass the caller's acceptance only when there is one, so the
// non-transactional path keeps the original two-argument create call.
function createAgentRow(
  svc: ReturnType<typeof agentService>,
  companyId: string,
  input: Parameters<ReturnType<typeof agentService>["create"]>[1],
  acceptance: Parameters<ReturnType<typeof agentService>["create"]>[2],
) {
  return acceptance ? svc.create(companyId, input, acceptance) : svc.create(companyId, input);
}

export function agentRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  // AgentDash: adapter bundle support lives in adapters/instructions-bundle-support.ts
  // so the instruction-refresh service can ask the same question (AGE-8).
  const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);
  const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
    "instructionsBundleMode",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
    "agentsMdPath",
    // Which generated blocks an agent does not carry. Guarded with the rest of
    // the bundle configuration on purpose: left ungated, an agent could suppress
    // the blocks that constrain it and delete its own rules.
    "instructionsSuppressedBlocks",
  ] as const;

  const router = Router();
  const svc = agentService(db);
  const access = accessService(db);
  // AgentDash-MK: steward authority + owner-ceiling enforcement for agent
  // configuration. No-ops for `default`-profile companies.
  const governance = agentGovernanceService(db);
  const stewardships = agentStewardshipService(db);
  const accountability = agentAccountabilityService(db);
  const approvalsSvc = approvalService(db);
  // Decision role for a hire approval recorded from the agent page. The
  // caller has already passed the agent-administrator gate, which is what an
  // emergency override requires; this only decides how it is recorded.
  let approvalAuthority: ReturnType<typeof approvalAuthorityService> | null = null;
  async function resolveAgentPageDecisionRole(
    approval: Awaited<ReturnType<typeof approvalsSvc.listPendingHireApprovalsForAgent>>[number],
    actor: Request["actor"],
  ): Promise<ApprovalDecisionRole> {
    approvalAuthority ??= approvalAuthorityService(db);
    try {
      return (await approvalAuthority.requireDecisionActor(approval, actor)) ?? "board";
    } catch (err) {
      if ((err as { status?: number })?.status === 403) return "owner_override";
      throw err;
    }
  }

  // Post-decision effects for a hire approval resolved from the agent page,
  // shared with every other decision surface. Built on first use: only the
  // approve route needs it, and it wires up a dozen services.
  let decisionEffects: ReturnType<typeof approvalDecisionEffectsService> | null = null;
  const getDecisionEffects = () =>
    (decisionEffects ??= approvalDecisionEffectsService(db, {
      pluginWorkerManager: options.pluginWorkerManager,
    }));
  const budgets = budgetService(db);
  const environmentsSvc = environmentService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const instructions = agentInstructionsService();
  const instructionRefresh = agentInstructionRefreshService({ db });
  const companySkills = companySkillService(db);
  const workspaceOperations = workspaceOperationService(db);
  const instanceSettings = instanceSettingsService(db);
  const tokenCeiling = tokenCeilingService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function assertAgentEnvironmentSelection(
    companyId: string,
    adapterType: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentService(db), companyId, environmentId, {
      allowedDrivers: allowedEnvironmentDriversForAgent(adapterType),
    });
    // AgentDash: hermes_local over SSH (flag on) — allowlist + hardening.
    if (adapterType === "hermes_local" && hermesSshEnabled()) {
      const environment = await environmentsSvc.getById(environmentId);
      if (environment?.driver === "ssh") {
        assertHermesSshEnvironmentPermitted({ companyId, config: environment.config });
      }
    }
  }

  /**
   * AgentDash: audit a hermes agent being pinned to an SSH environment. Only
   * the target and ids are recorded — never key material or env values.
   */
  async function logHermesSshEnvironmentPin(
    req: Request,
    agent: { id: string; companyId: string },
    pinned: { environmentId: string; sshTarget: string; port: number } | null,
  ) {
    // `pinned` is only ever non-null for a hermes_local agent on an SSH environment.
    if (!pinned) return;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.ssh_environment_pinned",
      entityType: "agent",
      entityId: agent.id,
      details: {
        environmentId: pinned.environmentId,
        adapterType: "hermes_local",
        sshTarget: pinned.sshTarget,
        port: pinned.port,
      },
    });
  }

  async function createAgentWithinTierCapacity<T>(
    companyId: string,
    res: Response,
    create: (dbOrTx: Db, acceptance?: ActivityAcceptance) => Promise<T>,
    validatePin?: (tx: Db) => Promise<void>,
  ): Promise<T | null> {
    const publications: ActivityPublication[] = [];
    const disabled = isBillingDisabled();
    const result = await withCompanyTierCapacityGuard(
      db,
      companyId,
      { agents: 1 },
      buildRequireTierDeps,
      (action) => res.status(402).json(freeTierCapExceededPayload(action)),
      executor => validatePin
        ? withHermesSshCompanyLock(executor, companyId, async tx => {
            await validatePin(tx);
            return create(tx, { executor: tx, publications });
          })
        : create(executor, disabled ? undefined : { executor, publications }),
    );
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  /**
   * Resolve the execution target the adapter should run its test probes against.
   *
   * - No environmentId / local environment → returns a local target so the
   *   adapter probes the Paperclip host (legacy behavior).
   * - SSH environment → builds an SSH execution target from the environment
   *   config so the adapter probes the remote box. No lease is required:
   *   the SSH spec is fully derived from the saved environment config.
   * - Sandbox / plugin environments → currently fall back to local probing
   *   with a warning check, since lifting a temporary sandbox lease for an
   *   ad-hoc test invocation is out of scope for this iteration.
   */
  async function resolveAdapterTestExecutionContext(input: {
    companyId: string;
    adapterType: string;
    environmentId: string | null;
  }): Promise<{
    executionTarget: AdapterExecutionTarget | null;
    environmentName: string | null;
    fallbackChecks: AdapterEnvironmentCheck[];
  }> {
    if (!input.environmentId) {
      return { executionTarget: null, environmentName: null, fallbackChecks: [] };
    }

    const environment = await environmentsSvc.getById(input.environmentId);
    if (!environment || environment.companyId !== input.companyId) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [
          {
            code: "environment_not_found",
            level: "warn",
            message: "Selected environment was not found. Falling back to a local probe.",
          },
        ],
      };
    }

    if (environment.driver === "local") {
      return { executionTarget: null, environmentName: environment.name, fallbackChecks: [] };
    }

    if (environment.driver === "ssh") {
      try {
        const target = await resolveEnvironmentExecutionTarget({
          db,
          companyId: input.companyId,
          adapterType: input.adapterType,
          environment: {
            id: environment.id,
            driver: environment.driver,
            config: environment.config ?? null,
          },
          leaseMetadata: null,
        });
        if (target) {
          return { executionTarget: target, environmentName: environment.name, fallbackChecks: [] };
        }
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_unavailable",
              level: "warn",
              message:
                `Could not resolve an execution target for environment "${environment.name}". Falling back to a local probe.`,
            },
          ],
        };
      } catch (err) {
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_failed",
              level: "warn",
              message:
                `Could not connect to environment "${environment.name}" to run the test. Falling back to a local probe.`,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    }

    // sandbox / plugin / other drivers: not yet supported for ad-hoc adapter tests.
    return {
      executionTarget: null,
      environmentName: environment.name,
      fallbackChecks: [
        {
          code: "environment_driver_not_supported_for_test",
          level: "warn",
          message:
            `Adapter testing inside ${environment.driver} environments is not yet supported. Falling back to a local probe; results may not reflect runs in "${environment.name}".`,
          hint: "Run a real heartbeat in the environment to verify end-to-end behavior.",
        },
      ],
    };
  }

  function mergeAdapterTestResultWithFallbackChecks(
    result: AdapterEnvironmentTestResult,
    fallbackChecks: AdapterEnvironmentCheck[],
  ): AdapterEnvironmentTestResult {
    if (fallbackChecks.length === 0) return result;
    const checks = [...fallbackChecks, ...result.checks];
    const status: AdapterEnvironmentTestResult["status"] = checks.some((check) => check.level === "error")
      ? "fail"
      : checks.some((check) => check.level === "warn")
        ? "warn"
        : result.status;
    return { ...result, checks, status };
  }

  // AgentDash (AGE-1): harness preflight must state the AGENT's resolved model,
  // never the instance-level adapter preset (`/api/health.adapterPreset` is
  // instance state, not agent state). The adapter's own checkModel only knows
  // the explicit config; this appends an authoritative info check resolved the
  // same way heartbeat resolves it, so an explicit unknown beats a wrong answer.
  async function withAgentResolvedModelCheck(
    agent: {
      id: string;
      adapterType: string;
      adapterConfig: Record<string, unknown> | null | undefined;
      runtimeConfig?: Record<string, unknown> | null;
    },
    result: AdapterEnvironmentTestResult,
  ): Promise<AdapterEnvironmentTestResult> {
    if (agent.adapterType !== "hermes_local") return result;
    const resolved = await resolveAgentRuntimeModel({
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig ?? {},
      agentId: agent.id,
      runtimeConfig: agent.runtimeConfig ?? {},
    });
    const message = resolved.model
      ? `Resolved model for next run: ${resolved.model} (provider: ${resolved.provider ?? "unknown"}, source: ${resolved.source})`
      : `Resolved model for next run: unknown (no explicit model and no readable hermes default; source: ${resolved.source})`;
    const check: AdapterEnvironmentCheck = {
      code: "agent_resolved_model",
      level: "info",
      message,
    };
    return { ...result, checks: [...result.checks, check] };
  }

  function withHarnessPreflightMetadata(
    metadata: Record<string, unknown> | null | undefined,
    input: {
      adapterType: string;
      adapterConfig: Record<string, unknown>;
      defaultEnvironmentId: string | null | undefined;
      result: AdapterEnvironmentTestResult | null;
    },
  ) {
    if (!input.result) return metadata;
    return withAgentHarnessPreflightMetadata(metadata, {
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      defaultEnvironmentId: input.defaultEnvironmentId,
      result: input.result,
    });
  }

  async function runRequiredHarnessPreflight(input: {
    companyId: string;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
    defaultEnvironmentId: string | null | undefined;
    failureMessage?: string;
    // AgentDash: the saved agent, when preflighting one. Adapters with per-agent
    // state (Hermes managed profiles) need it; without it a hosted box's
    // fail-closed Hermes check reports "the run has no agent id".
    agent?: { id: string; companyId: string; adapterConfig: Record<string, unknown> } | null;
    // AgentDash (c3 addendum): false for the standalone re-check endpoint — a
    // failed result is the data the caller asked for, so it persists as
    // evidence and returns 200 instead of a 422 the UI can only log.
    enforce?: boolean;
  }): Promise<AdapterEnvironmentTestResult> {
    const adapter = requireServerAdapter(input.adapterType);
    const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      input.companyId,
      input.adapterConfig,
    );
    const { executionTarget, environmentName, fallbackChecks } =
      await resolveAdapterTestExecutionContext({
        companyId: input.companyId,
        adapterType: input.adapterType,
        environmentId:
          typeof input.defaultEnvironmentId === "string" && input.defaultEnvironmentId.trim().length > 0
            ? input.defaultEnvironmentId
            : null,
      });
    const result = mergeAdapterTestResultWithFallbackChecks(
      await adapter.testEnvironment({
        companyId: input.companyId,
        adapterType: input.adapterType,
        config: runtimeAdapterConfig,
        executionTarget,
        environmentName,
        agent: input.agent
          ? { id: input.agent.id, companyId: input.agent.companyId, adapterConfig: runtimeAdapterConfig }
          : null,
      }),
      fallbackChecks,
    );

    // Warnings are advisory, not failures — a self-hosted Hermes box warns
    // that AgentDash's own env holds no LLM keys (they live in ~/.hermes),
    // which is the correct setup for that adapter. But a warn that means the
    // adapter cannot run at all (probe auth required, probe failed, Hermes
    // with no provider anywhere) blocks exactly like a fail.
    if (isBlockingPreflightResult(result) && input.enforce !== false) {
      throw unprocessable(
        input.failureMessage
          ?? "Agent harness preflight failed. Resolve the adapter environment checks before creating this agent.",
        {
          code: "agent_harness_preflight_failed",
          result,
        },
      );
    }

    return result;
  }

  function assertAgentHarnessPreflightReadyForLaunch(agent: {
    adapterType: string;
    adapterConfig: unknown;
    defaultEnvironmentId?: string | null;
    metadata?: unknown;
  }) {
    if (!shouldRequireAgentHarnessPreflight()) return;
    const readiness = evaluateAgentHarnessPreflightReadiness({
      adapterType: agent.adapterType,
      adapterConfig:
        agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
          ? agent.adapterConfig as Record<string, unknown>
          : {},
      defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
      metadata: agent.metadata ?? null,
    });
    if (readiness.ready) return;
    throw unprocessable(readiness.message, {
      code: "agent_harness_preflight_required",
      reason: readiness.reason,
      testedAt: readiness.testedAt,
    });
  }

  async function getCurrentUserRedactionOptions() {
    return {
      enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
    };
  }

  function canCreateAgents(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    const grants = membership
      ? await access.listPrincipalGrants(agent.companyId, "agent", agent.id)
      : [];
    const hasExplicitTaskAssignGrant = grants.some((grant) => grant.permissionKey === "tasks:assign");

    if (agent.role === "ceo") {
      return {
        canAssignTasks: true,
        taskAssignSource: "ceo_role" as const,
        membership,
        grants,
      };
    }

    if (canCreateAgents(agent)) {
      return {
        canAssignTasks: true,
        taskAssignSource: "agent_creator" as const,
        membership,
        grants,
      };
    }

    if (hasExplicitTaskAssignGrant) {
      return {
        canAssignTasks: true,
        taskAssignSource: "explicit_grant" as const,
        membership,
        grants,
      };
    }

    return {
      canAssignTasks: false,
      taskAssignSource: "none" as const,
      membership,
      grants,
    };
  }

  /**
   * Attach the human steward, and the human answerable, to agent rows.
   *
   * Stewardship was readable only through the dedicated
   * `/agents/:id/stewardship` route, which returns the raw row: a durable
   * principal id and nothing else. An agent reading the agent list or another
   * agent's record therefore got names, roles and adapters but no way to say
   * which person stands behind any of them, even though every mandate this
   * product writes talks about "your steward". Carrying the steward on the
   * read paths agents actually call is what makes that name available.
   *
   * AgentDash (GH #505): `name` travels to every reader; `email` only to
   * callers who may read member emails (see member-email-visibility.ts), the
   * same rule `/companies/:companyId/user-directory` applies. Agent keys get
   * the steward's id and name, never the address.
   */
  /**
   * The readiness verdict, sent alongside the evidence it judges.
   *
   * `metadata.harnessPreflight` is a record of one past test, and on this
   * instance every agent's is out of date: three name `codex_local` while the
   * agent runs `hermes_local`, and two report the wrong provider and claim no
   * model is set. The server has always known — `evaluateAgentHarnessPreflightReadiness`
   * compares the stored `configDigest` against the current configuration and
   * refuses to start a run — but that verdict was computed at start time and
   * thrown away, so every reader of the API got the stale evidence with no
   * indication it was stale, and reasonably believed it.
   *
   * The UI cannot work this out for itself: the digest is a server-side hash
   * over the adapter configuration, and the restricted view does not even
   * receive that configuration. So the verdict travels with the record.
   *
   * It carries no configuration and no secret — only whether the evidence
   * still describes the agent, and why not.
   */
  function withHarnessReadiness<T extends {
    adapterType: string;
    adapterConfig: unknown;
    defaultEnvironmentId?: string | null;
    metadata?: unknown;
  }>(agent: T) {
    const readiness = evaluateAgentHarnessPreflightReadiness({
      adapterType: agent.adapterType,
      adapterConfig:
        agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
          ? agent.adapterConfig as Record<string, unknown>
          : {},
      defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
      metadata: agent.metadata ?? null,
    });
    return { ...agent, harnessReadiness: readiness };
  }

  /**
   * AgentDash (GH #505): the person-shaped fields on agent read paths carry an
   * email only for callers allowed to read member emails. Returns a function
   * that blanks `email` on a steward / accountable party for everyone else.
   */
  async function memberEmailFilter(req: Request, companyId: string) {
    const canView = await canViewMemberEmails(access, req, companyId);
    return <P extends { userId: string; email: string | null }>(party: P | null): P | null =>
      party ? { ...party, email: visibleMemberEmail(req, canView, party.userId, party.email) } : null;
  }

  async function attachHumanContext<T extends { id: string }>(req: Request, companyId: string, rows: T[]) {
    const agentIds = rows.map((row) => row.id);
    const [stewardsByAgentId, accountabilityByAgentId, filterEmail] = await Promise.all([
      stewardships.activeStewardsByAgentIds(companyId, agentIds),
      accountability.resolveForAgents(companyId, agentIds),
      memberEmailFilter(req, companyId),
    ]);
    return rows.map((row) => ({
      ...row,
      steward: filterEmail(stewardsByAgentId.get(row.id) ?? null),
      // Who answers for this agent, and why them. Carried next to `steward`
      // rather than derived by each reader: for an autonomous agent the answer
      // is somebody who does not steward it, and a board or another agent that
      // has to infer that from two nullable fields will infer it differently.
      accountable: filterEmail(toAccountableParty(accountabilityByAgentId.get(row.id) ?? null)),
    }));
  }

  /**
   * The wire shape for "who answers for this agent", or null when nobody does.
   *
   * Null is a real answer — a stewarded agent whose pairing was never finished —
   * and it is deliberately distinguishable from an autonomous agent, which
   * always has somebody. `via` travels with the name so a screen can explain
   * itself instead of showing a person with no reason attached.
   */
  function toAccountableParty(value: AgentAccountability | null) {
    if (!value?.userId || value.via === "unpaired") return null;
    return {
      userId: value.userId,
      name: value.name,
      email: value.email,
      via: value.via,
    };
  }

  /**
   * What this agent's runs actually show, which is the only honest answer to
   * "is it working".
   *
   * Every other signal on this page is a claim made before the fact. The stored
   * harness preflight says "pass" for evidence gathered once, possibly against
   * a different adapter -- three agents on one instance carried a `codex_local`
   * pass while running on `hermes_local`, and nothing evaluated it because the
   * readiness check is gated behind an env flag that is off by default. The
   * agent's `status` column says `idle`, which is true of a healthy agent and
   * of a broken one.
   *
   * The runs know. On one instance the primary agent had failed 163 of 304
   * runs, and 83% of the successful runs across the fleet left no comment and
   * no activity behind -- "succeeded" means the process exited zero, which is
   * not the same claim as "something happened". None of that was visible
   * anywhere.
   *
   * `neverRan` is its own state on purpose: an agent that has never started is
   * not healthy and not failing, and the two need different answers. A
   * placeholder `process` agent whose command does not exist sits here for
   * ever, looking exactly like a working agent nobody has assigned work to.
   */
  async function buildAgentRunHealth(
    agentId: string,
    companyId: string,
    tokenCeilingPause: AgentRunHealth["tokenCeilingPause"] = null,
  ) {
    const [tally] = await db
      .select({
        total: count(),
        succeeded: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
        withoutEvidence: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded' and ${heartbeatRuns.lastUsefulActionAt} is null)::int`,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

    const [last] = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        finishedAt: heartbeatRuns.finishedAt,
        lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1);

    // Chat work never touches heartbeatRuns — a Chief of Staff that answered
    // every message all day still reports total: 0. Count its agent-authored
    // replies so "never run" does not claim the agent did nothing, and the
    // month count lets the spend read "Billed by your model provider" (BYOK).
    //
    // Attribution is per message: the company inbox is one shared conversation
    // whose assistantAgentId is null, so replies by the CoS and by summoned
    // teammates can only be told apart by the message's author_agent_id. Rows
    // from before that column still count through a conversation owned by the
    // agent (the old 1:1 conversations did set assistantAgentId).
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [chatTally] = await db
      .select({
        total: count(),
        thisMonth: sql<number>`count(*) filter (where ${gte(assistantMessages.createdAt, monthStart)})::int`,
      })
      .from(assistantMessages)
      .innerJoin(
        assistantConversations,
        and(
          eq(assistantMessages.conversationId, assistantConversations.id),
          // The join is company-scoped: author_agent_id cannot be trusted to
          // imply the conversation's company on its own.
          eq(assistantConversations.companyId, companyId),
        ),
      )
      .where(and(
        eq(assistantMessages.role, "agent"),
        or(
          eq(assistantMessages.authorAgentId, agentId),
          and(
            isNull(assistantMessages.authorAgentId),
            eq(assistantConversations.assistantAgentId, agentId),
          ),
        ),
        // Not answers: a dispatch-failure card is the absence of a reply, and
        // a billing/system notice is not the agent answering a person. System
        // notices carry cardPayload.systemNotice; they render as ordinary
        // bubbles, so the marker lives in the payload, not a card kind.
        or(
          isNull(assistantMessages.cardKind),
          ne(assistantMessages.cardKind, "cos_dispatch_error_v1"),
        ),
        isNull(sql`${assistantMessages.cardPayload}->>'systemNotice'`),
        // Notices posted before the marker existed carry only their canned
        // bodies (routes/billing.ts notifyDowngrade, notifyTrialWillEnd — the
        // strings have not changed since #290/#291, so a prefix match is
        // exact, not a guess).
        sql`not (
          ${assistantMessages.content} like ${"Heads up: Stripe couldn't charge your card%"}
          or ${assistantMessages.content} like ${"Your Pro subscription ended%"}
          or ${assistantMessages.content} like ${"Heads up: your Pro trial ends in%"}
        )`,
      ));
    const chatTurns = Number(chatTally?.total ?? 0);
    const chatTurnsThisMonth = Number(chatTally?.thisMonth ?? 0);

    const total = Number(tally?.total ?? 0);
    return {
      total,
      succeeded: Number(tally?.succeeded ?? 0),
      failed: Number(tally?.failed ?? 0),
      succeededWithoutEvidence: Number(tally?.withoutEvidence ?? 0),
      neverRan: total === 0,
      chatTurns,
      chatTurnsThisMonth,
      tokenCeilingPause,
      last: last
        ? {
            status: last.status,
            error: last.error ?? null,
            errorCode: last.errorCode ?? null,
            finishedAt: last.finishedAt ?? null,
            leftEvidence: last.lastUsefulActionAt !== null,
          }
        : null,
    };
  }

  // AgentDash (#1057): configuration/mutation authority does not grant spend reads.
  async function agentForReader<T extends { companyId: string }>(req: Request, agent: T) {
    return redactMonthlySpendForReader(agent, await canReadCompanySpend(db, req, agent.companyId));
  }

  async function buildAgentDetail(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    // AgentDash (GH #505): the caller, so steward/accountable emails follow
    // the member-email rule. Required, so no call site can forget it.
    req: Request,
    options?: { restricted?: boolean },
  ) {
    // OBS-2: the ceiling's figures are configuration — the restricted view
    // gets an explicit null rather than the spend. But the pause itself is
    // run health, not configuration: it reaches restricted viewers through
    // `runHealth.tokenCeilingPause` — reason and liftsAt only, no numbers.
    const tokenCeilingStatus = await tokenCeiling.evaluate(agent);
    const tokenCeilingPause = tokenCeilingStatus.paused
      ? {
          reason: tokenCeilingStatus.pauseReason ?? "token_ceiling",
          liftsAt: tokenCeilingStatus.liftsAt,
        }
      : null;
    const [chainOfCommand, accessState, steward, accountableFor, runHealth, resolvedRuntime, filterEmail] = await Promise.all([
      svc.getChainOfCommand(agent.id),
      buildAgentAccessState(agent),
      stewardships.activeStewardForAgent(agent.companyId, agent.id),
      accountability.resolveForAgent(agent.companyId, agent.id),
      buildAgentRunHealth(agent.id, agent.companyId, tokenCeilingPause),
      // AgentDash (AGE-1): state the model/provider that will serve the next
      // run, resolved the same way heartbeat resolves it, or an explicit
      // unknown — never the instance-level adapter preset. Present and null
      // rather than absent so a reader can tell "unknown" from "this build
      // does not report runtime".
      resolveAgentRuntimeModel({
        adapterType: agent.adapterType,
        adapterConfig:
          agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
            ? agent.adapterConfig as Record<string, unknown>
            : {},
        agentId: agent.id,
        runtimeConfig:
          agent.runtimeConfig && typeof agent.runtimeConfig === "object" && !Array.isArray(agent.runtimeConfig)
            ? agent.runtimeConfig as Record<string, unknown>
            : {},
      }),
      memberEmailFilter(req, agent.companyId),
    ]);

    return {
      ...await agentForReader(req, options?.restricted ? redactForRestrictedAgentView(agent)! : agent),
      // Computed from the UNREDACTED agent, deliberately: the digest needs the
      // adapter configuration, and the restricted view strips it. The verdict
      // itself carries no configuration, so it is safe on both views — and a
      // restricted reader is exactly the one who cannot tell staleness alone.
      harnessReadiness: withHarnessReadiness(agent).harnessReadiness,
      chainOfCommand,
      // Present and null when nobody stewards this agent, never absent: an
      // agent reading a missing key cannot tell "unstewarded" from "this
      // build does not report stewards".
      // AgentDash (GH #505): email blanked unless the caller may read it.
      steward: filterEmail(steward),
      // Same contract, and the field that makes an autonomous agent legible:
      // `steward` is null for one of those by definition, so `steward: null`
      // alone cannot tell a reader whether anybody is answerable.
      accountable: filterEmail(toAccountableParty(accountableFor)),
      access: accessState,
      // Derived from runs, not from stored claims. See buildAgentRunHealth.
      runHealth,
      // AGE-1: what will serve the next run (model/provider/source-of-truth),
      // or explicit nulls when unknown. Never the instance adapter preset.
      resolvedRuntime,
      // OBS-2: today's token sum vs the ceiling — the "paused: token ceiling"
      // line on the agent page reads this, and null means the reader was not
      // shown configuration at all. Restricted readers still see the pause
      // through runHealth.tokenCeilingPause.
      tokenCeiling: options?.restricted ? null : tokenCeilingStatus,
    };
  }

  async function applyDefaultAgentTaskAssignGrant(
    companyId: string,
    agentId: string,
    grantedByUserId: string | null,
  ) {
    await access.ensureMembership(companyId, "agent", agentId, "member", "active");
    await access.setPrincipalPermission(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      grantedByUserId,
    );
  }

  async function assertCanCreateAgentsForCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return null;
      // Every active human member may create agents — decided 2026-08-16
      // ("they can create their own agents if they want"). Deliberately a
      // role check and NOT an implicit `agents:create` grant: that permission
      // key doubles as the agent-ADMINISTRATOR predicate across governance,
      // connectors and stewardship, and granting it to members was measured
      // to open all of them. Creation is role-given; administration stays a
      // grant.
      if (actorHumanRole(req, companyId) !== null) return null;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden(
          "Missing permission: agents:create. Ask a company owner or instance admin to grant this " +
            `permission via PATCH /api/companies/${companyId}/members/:memberId/permissions.`,
        );
      }
      return null;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required (missing or invalid X-Agent-Key header)");
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (!allowedByGrant && !canCreateAgents(actorAgent)) {
      throw forbidden(
        `Agent ${actorAgent.name} lacks the agents:create capability. ` +
          "Ask an owner or administrator to enable it via PATCH /api/agents/:id/permissions { canCreateAgents: true }.",
      );
    }
    return actorAgent;
  }

  // AgentDash (#1053): hiring is not authority to delegate privileged roles
  // or grant hiring authority, including the CEO role's inherited default.
  function assertAgentCreationAuthority(req: Request) {
    if (req.actor.type !== "agent") return;
    if (req.body.role === "ceo" || req.body.role === "chief_of_staff" || req.body.permissions?.canCreateAgents === true) {
      throw forbidden("Agents cannot create privileged roles or grant canCreateAgents. Ask a board administrator to create this agent.");
    }
  }

  /**
   * AgentDash (scan 2, E3): when the company's owner creates its first agent,
   * the owner becomes its steward, whatever the company's profile. Not an
   * admin or other member with agents:create (PR #955 review). See
   * services/founder-stewardship.ts. Best-effort; never fails the creation.
   */
  async function pairCreatorWithCompanysFirstAgent(req: Request, companyId: string, agentId: string) {
    if (req.actor.type !== "board" || !req.actor.userId) return;
    try {
      const others = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(and(eq(agentsTable.companyId, companyId), not(eq(agentsTable.id, agentId))))
        .limit(1);
      if (others.length > 0) return;
      // pairFounderWithAgent checks the owner membership itself.
      await pairFounderWithAgent(founderStewardshipDeps(db), { companyId, agentId, userId: req.actor.userId });
    } catch (err) {
      logger.warn({ err, companyId, agentId }, "[agents] could not pair the creator with the company's first agent");
    }
  }

  async function assertBoardCanManageAgentsForCompany(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
    if (!allowed) {
      throw forbidden("Missing permission: agents:create");
    }
  }

  /**
   * Fields a steward may change on their own agent. Everything outside this set
   * requires `agents:create`.
   *
   * This allowlist is a security boundary, not ergonomics. `role` is excluded
   * because promoting an agent to `ceo` grants that agent's key company-wide
   * authority over every other agent (see the `actorAgent.role === "ceo"`
   * branches below) — that would turn per-agent stewardship into exactly the
   * company-wide agent administration the design forbids. `adapterConfig` and
   * `runtimeConfig` are excluded because they carry host-executed
   * `workspaceStrategy` commands; `spentMonthlyCents` because resetting
   * recorded spend defeats the budget hard stop; `status`/`reportsTo`/
   * `defaultEnvironmentId`/`adapterType` because none are ceiling-bound.
   */
  const STEWARD_PATCHABLE_AGENT_FIELDS = new Set([
    "title",
    "icon",
    "capabilities",
    "budgetMonthlyCents",
  ]);

  /**
   * Board authority to configure one agent: an administrator with
   * `agents:create`, or (in `agentdash_mk` companies) the agent's current
   * steward. Returns which authority applied so callers can narrow what a
   * steward is allowed to change.
   */
  async function requireAgentConfigurationAuthority(
    req: Request,
    targetAgent: { id: string; companyId: string },
  ): Promise<"admin" | "steward"> {
    return agentConfigurationAuthority(db, req, targetAgent);
  }

  /** 403 when a steward-authority caller touches a field only an admin may set. */
  function assertStewardPatchScope(
    authority: "admin" | "steward" | "agent",
    body: Record<string, unknown>,
  ) {
    if (authority !== "steward") return;
    const forbiddenFields = Object.keys(body).filter(
      (key) => !STEWARD_PATCHABLE_AGENT_FIELDS.has(key),
    );
    if (forbiddenFields.length > 0) {
      throw forbidden(
        `Stewardship does not permit changing ${forbiddenFields.sort().join(", ")}; ` +
          "an administrator with agents:create must make this change",
      );
    }
  }

  /**
   * GH #886: configuration reads are the `agents:create` grant — the same
   * question the list/detail routes ask (`actorCanReadConfigurationsForCompany`)
   * before deciding to redact adapterConfig/runtimeConfig. These routes once
   * delegated to `assertCanCreateAgentsForCompany`, whose every-member
   * exception is for CREATION only (2026-08-16: "they can create their own
   * agents"); credentials' home was readable one route over from the redacted
   * list. Creation stays role-given; configuration reads stay a grant.
   */
  async function assertCanReadConfigurations(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (await actorCanReadConfigurationsForCompany(req, companyId)) return;
    if (req.actor.type === "board") {
      throw forbidden(
        "Missing permission: agents:create. Ask a company owner or instance admin to grant this " +
          `permission via PATCH /api/companies/${companyId}/members/:memberId/permissions.`,
      );
    }
    throw forbidden("Missing permission: agents:create");
  }

  /**
   * GH #886 review: reading ONE agent's configuration (adapter/runtime config,
   * config revisions, skills, instructions bundle) admits whoever may change
   * it — `resolveConfigurationAuthority`, the same question the write routes
   * ask through `requireAgentConfigurationAuthority`: an `agents:create`
   * holder or instance admin, or, in an `agentdash_mk` company, the agent's
   * steward or creator. A steward who may edit a mandate file must be able to
   * read it. Agent keys keep the company-wide grant rule.
   */
  async function assertCanReadAgentConfiguration(
    req: Request,
    targetAgent: { id: string; companyId: string },
  ) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type !== "board") {
      await assertCanReadConfigurations(req, targetAgent.companyId);
      return;
    }
    const authority = await governance.resolveConfigurationAuthority(
      targetAgent.companyId,
      targetAgent.id,
      req.actor,
    );
    if (authority) return;
    throw forbidden(
      "Only this agent's steward or a company administrator can read its configuration",
    );
  }

  async function getAccessibleAgent(req: Request, res: Response, id: string) {
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return null;
    }
    assertCompanyAccess(req, agent.companyId);
    if (req.actor.type === "board") {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }
    return agent;
  }

  async function actorCanReadConfigurationsForCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
      return access.canUser(companyId, req.actor.userId, "agents:create");
    }
    if (!req.actor.agentId) return false;
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  async function buildSkippedWakeupResponse(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    payload: Record<string, unknown> | null | undefined,
  ) {
    const issueId = typeof payload?.issueId === "string" && payload.issueId.trim() ? payload.issueId : null;
    if (!issueId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId: null,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const issue = await db
      .select({
        id: issuesTable.id,
        executionRunId: issuesTable.executionRunId,
      })
      .from(issuesTable)
      .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, agent.companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issue?.executionRunId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionRun = await heartbeat.getRun(issue.executionRunId);
    if (!executionRun || (executionRun.status !== "queued" && executionRun.status !== "running")) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: issue.executionRunId,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionAgent = await svc.getById(executionRun.agentId);
    const executionAgentName = executionAgent?.name ?? null;

    return {
      status: "skipped" as const,
      reason: "issue_execution_deferred",
      message: executionAgentName
        ? `Wakeup was deferred because this issue is already being executed by ${executionAgentName}.`
        : "Wakeup was deferred because this issue already has an active execution run.",
      issueId,
      executionRunId: executionRun.id,
      executionAgentId: executionRun.agentId,
      executionAgentName,
    };
  }

  // AgentDash (security): the fields an agent may change on ITSELF through
  // `PATCH /agents/:id`. An allowlist, not a denylist: the previous denylist
  // (budgetMonthlyCents, reportsTo, adapterType, adapterConfig) omitted `role`,
  // so an ordinary agent could PATCH itself to `role: "ceo"` and then use CEO
  // status to modify every other agent. Every other authority-bearing field
  // had the same hole — `status` (un-pause yourself), `spentMonthlyCents`
  // (reset your own spend), `runtimeConfig` (heartbeat schedule and cheap-model
  // adapter config), `defaultEnvironmentId`, `metadata` (harness-preflight
  // results), `autonomy`/`accountableUserId`, `instructionsBundle`,
  // `desiredSkills`. New fields added to `updateAgentSchema` are refused for
  // self-edits until someone decides they belong here. What remains is
  // presentation: how the agent is named and described. Role and authority
  // changes are reserved for humans with agent-configuration authority.
  const AGENT_SELF_PATCHABLE_FIELDS: ReadonlySet<string> = new Set([
    "name",
    "title",
    "icon",
    "capabilities",
  ]);

  // AgentDash (security, #727): the fields a CEO agent or an `agents:create`
  // holder may change on ANOTHER agent through `PATCH /agents/:id`. Same
  // allowlist shape as the self-edit list above. Before this, the peer path
  // returned "agent" with no field check, so a CEO agent could PATCH another
  // agent's `role` (to ceo), `status` (un-pausing an agent the board paused,
  // around the board-only `POST /agents/:id/pause` and `/resume`),
  // `spentMonthlyCents` (reset its spend), `reportsTo` and `runtimeConfig`.
  // Authority-bearing fields — role, status, spend, budget, reporting line,
  // runtime and adapter configuration, autonomy, environment, metadata — need
  // a board actor. What an agent may change on a peer is presentation only.
  // `desiredSkills` was removed (#734): the handler never applied it (skill
  // assignment lives in adapterConfig and is written by
  // `POST /agents/:id/skills/sync`, which has its own allowlist), so the field
  // answered 200 having changed nothing.
  const AGENT_PEER_PATCHABLE_FIELDS: ReadonlySet<string> = new Set([
    "name",
    "title",
    "icon",
    "capabilities",
  ]);

  async function assertCanUpdateAgent(
    req: Request,
    targetAgent: { id: string; companyId: string },
    selfEditableFields: ReadonlySet<string>,
    peerEditableFields: ReadonlySet<string>,
  ): Promise<"admin" | "steward" | "agent"> {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") {
      return requireAgentConfigurationAuthority(req, targetAgent);
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    if (actorAgent.id === targetAgent.id) {
      // Self-update is allowed, but only of the fields the calling route names
      // as self-editable. Verified live: an agent PATCHed its own
      // budgetMonthlyCents from 0 to 99,999,999 and got 200 — the spend cap is
      // the brake, and an agent that can release its own brake has no cap.
      // AGE-113 extended that to adapterType/adapterConfig; the AgentDash
      // (security) fix turns the list around so `role` and every future
      // authority-bearing field is refused by default.
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const refused = Object.keys(body)
        .filter((field) => !selfEditableFields.has(field))
        .sort();
      if (refused.length > 0) {
        throw forbidden(
          `An agent cannot change its own ${refused.join(", ")}. Ask an owner, admin or operator.`,
        );
      }
      return "agent";
    }
    const allowedToModifyPeers =
      actorAgent.role === "ceo"
      || canCreateAgents(actorAgent)
      || (await access.hasPermission(
        targetAgent.companyId,
        "agent",
        actorAgent.id,
        "agents:create",
      ));
    if (!allowedToModifyPeers) {
      throw forbidden("Only CEO or agent creators can modify other agents");
    }
    // AgentDash (security, #727): a CEO or agent creator may change another
    // agent only through the calling route's peer allowlist.
    const peerBody = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const refusedForPeer = Object.keys(peerBody)
      .filter((field) => !peerEditableFields.has(field))
      .sort();
    if (refusedForPeer.length > 0) {
      throw forbidden(
        `An agent cannot change another agent's ${refusedForPeer.join(", ")}. Ask an owner, admin or operator.`,
      );
    }
    return "agent";
  }

  async function assertCanReadAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") {
      await assertCanReadAgentConfiguration(req, targetAgent);
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
  }

  function assertKnownAdapterType(type: string | null | undefined): string {
    const adapterType = typeof type === "string" ? type.trim() : "";
    if (!adapterType) {
      throw unprocessable("Adapter type is required");
    }
    if (!findServerAdapter(adapterType)) {
      throw unprocessable(`Unknown adapter type: ${adapterType}`);
    }
    return adapterType;
  }

  async function assertAgentDefaultEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
    options?: { allowedDrivers?: string[]; allowedSandboxProviders?: string[]; adapterType?: string; req?: Request; executor?: Db },
  ): Promise<{ environmentId: string; sshTarget: string; port: number } | null> {
    if (environmentId === undefined || environmentId === null) return null;
    const environment = await (options?.executor ? environmentService(options.executor) : environmentsSvc).getById(environmentId);
    if (!environment || environment.companyId !== companyId) {
      throw unprocessable("Selected environment must belong to the same company");
    }
    if (options?.allowedDrivers && !options.allowedDrivers.includes(environment.driver)) {
      throw unprocessable(`Environment driver "${environment.driver}" is not allowed here`);
    }
    if (environment.driver === "sandbox" && options?.allowedSandboxProviders) {
      const config = environment.config && typeof environment.config === "object"
        ? environment.config as Record<string, unknown>
        : {};
      const provider = typeof config.provider === "string" ? config.provider : "";
      if (provider === "fake") {
        throw unprocessable(
          `Selected sandbox provider "${provider}" is not supported for agent defaults yet`,
        );
      }
      if (options.allowedSandboxProviders.length > 0 && !options.allowedSandboxProviders.includes(provider)) {
        throw unprocessable(
          `Selected sandbox provider "${provider || "unknown"}" is not supported for agent defaults yet`,
        );
      }
    }
    // AgentDash: hermes_local over SSH. Only reachable with the flag on — with
    // it off the driver check above already refused "ssh" for hermes.
    if (options?.adapterType === "hermes_local" && environment.driver === "ssh") {
      if (options.req) await assertCanPinHermesSsh(options.req, companyId, options.executor ? accessService(options.executor) : access);
      const { target, port } = assertHermesSshEnvironmentPermitted({
        companyId,
        config: environment.config as Record<string, unknown> | null,
      });
      return { environmentId: environment.id, sshTarget: target, port };
    }
    return null;
  }

  function hasOwn(value: object, key: string): boolean {
    return Object.hasOwn(value, key);
  }

  function allowedEnvironmentDriversForAgent(adapterType: string): string[] {
    return supportedEnvironmentDriversForAdapter(adapterType, { hermesSshEnabled: hermesSshEnabled() });
  }

  function allowedSandboxProvidersForAgent(adapterType: string): string[] | undefined {
    return supportedEnvironmentDriversForAdapter(adapterType).includes("sandbox") ? [] : [];
  }

  async function resolveCompanyIdForAgentReference(req: Request): Promise<string | null> {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeAgentReference(req: Request, rawId: string): Promise<string> {
    const raw = rawId.trim();
    if (isUuidLike(raw)) return raw;

    const companyId = await resolveCompanyIdForAgentReference(req);
    if (!companyId) {
      throw unprocessable("Agent shortname lookup requires companyId query parameter");
    }

    const resolved = await svc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }

  function parseSourceIssueIds(input: {
    sourceIssueId?: string | null;
    sourceIssueIds?: string[];
  }): string[] {
    const values: string[] = [];
    if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
    if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
      values.push(input.sourceIssueId);
    }
    return Array.from(new Set(values));
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function preserveInstructionsBundleConfig(
    existingAdapterConfig: Record<string, unknown>,
    nextAdapterConfig: Record<string, unknown>,
  ) {
    const nextKeys = new Set(Object.keys(nextAdapterConfig));
    if (KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => nextKeys.has(key))) {
      return nextAdapterConfig;
    }

    const merged = { ...nextAdapterConfig };
    for (const key of KNOWN_INSTRUCTIONS_BUNDLE_KEYS) {
      if (merged[key] === undefined && existingAdapterConfig[key] !== undefined) {
        merged[key] = existingAdapterConfig[key];
      }
    }
    return merged;
  }

  function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return null;
    }
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
    return null;
  }

  function parseNumberLike(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
    const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
    return {
      enabled: parseBooleanLike(heartbeat.enabled) ?? false,
      intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
    };
  }

  function listRuntimeModelProfileAdapterConfigs(runtimeConfig: unknown): Array<{
    profileKey: string;
    profile: Record<string, unknown>;
    adapterConfig: Record<string, unknown>;
    path: string;
  }> {
    const runtimeRecord = asRecord(runtimeConfig);
    const modelProfiles = asRecord(runtimeRecord?.modelProfiles);
    if (!modelProfiles) return [];

    const entries: Array<{
      profileKey: string;
      profile: Record<string, unknown>;
      adapterConfig: Record<string, unknown>;
      path: string;
    }> = [];
    for (const [profileKey, rawProfile] of Object.entries(modelProfiles)) {
      const profile = asRecord(rawProfile);
      const adapterConfig = asRecord(profile?.adapterConfig);
      if (!profile || !adapterConfig) continue;
      entries.push({
        profileKey,
        profile,
        adapterConfig,
        path: `runtimeConfig.modelProfiles.${profileKey}.adapterConfig`,
      });
    }
    return entries;
  }

  /**
   * AgentDash (recovery budget remediation): `runtimeConfig.recoveryBudget`
   * loosens or tightens the spend guard on automatic retries, so only a board
   * actor may set or change it. An agent-authored hire, create or peer PATCH
   * that carries a different value is refused; resending the stored value
   * unchanged passes.
   */
  function assertNoAgentRecoveryBudgetMutation(req: Request, before: unknown, after: unknown) {
    if (req.actor.type === "board") return;
    const read = (runtimeConfig: unknown) =>
      typeof runtimeConfig === "object" && runtimeConfig !== null && !Array.isArray(runtimeConfig)
        ? (runtimeConfig as Record<string, unknown>).recoveryBudget ?? null
        : null;
    if (JSON.stringify(read(before)) === JSON.stringify(read(after))) return;
    throw forbidden(
      "Only a board user may set runtimeConfig.recoveryBudget; agent-authored hires and updates cannot change the automatic-recovery budget",
    );
  }

  /**
   * AgentDash (wake policy): `runtimeConfig.wakePolicy` (and its legacy alias
   * `metadata.travelPairing`) decides which wakes may start a run, so only a
   * board actor may set, change or clear it. Compared on the RESOLVED policy,
   * so an agent-authored request that resends the stored value (or touches
   * neither field) passes, and dropping the field by omission is refused.
   */
  function assertNoAgentWakePolicyMutation(
    req: Request,
    before: { runtimeConfig?: unknown; metadata?: unknown } | null,
    after: { runtimeConfig?: unknown; metadata?: unknown },
  ) {
    if (req.actor.type === "board") return;
    if (resolveAgentWakePolicy(before) === resolveAgentWakePolicy(after)) return;
    throw forbidden(
      "Only a board user may set runtimeConfig.wakePolicy; agent-authored hires and updates cannot change an agent's wake policy",
    );
  }

  /**
   * AgentDash (wake policy): switching an agent ON to board_assignment_only
   * also refuses the runs it already had queued or scheduled (timers, comment
   * wakes, retries from before the switch), so none of them starts under the
   * policy. The run-start check refuses any that slip past this.
   */
  async function refusePendingRunsIfWakePolicyTurnedOn(
    before: { runtimeConfig?: unknown; metadata?: unknown },
    after: { id: string; runtimeConfig?: unknown; metadata?: unknown },
  ) {
    if (resolveAgentWakePolicy(before) === "board_assignment_only") return;
    if (resolveAgentWakePolicy(after) !== "board_assignment_only") return;
    await heartbeat.refusePendingRunsForWakePolicy(after.id);
  }

  async function assertNoAgentRuntimeConfigAdapterConfigMutation(
    req: Request,
    companyId: string,
    runtimeConfig: unknown,
  ) {
    for (const entry of listRuntimeModelProfileAdapterConfigs(runtimeConfig)) {
      await assertNoAgentAdapterConfigMutation(req, companyId, entry.adapterConfig, entry.path);
    }
  }

  async function normalizeMediatedAdapterConfigForPersistence(input: {
    companyId: string;
    adapterType: string | null | undefined;
    adapterConfig: Record<string, unknown>;
    constraintAdapterConfig?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      input.companyId,
      input.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await assertAdapterConfigConstraints(
      input.companyId,
      input.adapterType,
      input.constraintAdapterConfig
        ? { ...input.constraintAdapterConfig, ...normalizedAdapterConfig }
        : normalizedAdapterConfig,
    );
    return normalizedAdapterConfig;
  }

  async function normalizeRuntimeConfigAdapterConfigsForPersistence(
    companyId: string,
    adapterType: string,
    runtimeConfig: Record<string, unknown>,
    baseAdapterConfig: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const entries = listRuntimeModelProfileAdapterConfigs(runtimeConfig);
    if (entries.length === 0) return runtimeConfig;
    const adapterModelProfiles = await listAdapterModelProfiles(adapterType);

    const normalizedRuntimeConfig = { ...runtimeConfig };
    const modelProfiles = asRecord(runtimeConfig.modelProfiles) ?? {};
    const normalizedModelProfiles = { ...modelProfiles };
    normalizedRuntimeConfig.modelProfiles = normalizedModelProfiles;

    for (const entry of entries) {
      const adapterProfile = adapterModelProfiles.find((profile) => profile.key === entry.profileKey);
      const adapterDefaultConfig = asRecord(adapterProfile?.adapterConfig) ?? {};
      const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
        companyId,
        adapterType,
        adapterConfig: entry.adapterConfig,
        constraintAdapterConfig: {
          ...baseAdapterConfig,
          ...adapterDefaultConfig,
        },
      });
      normalizedModelProfiles[entry.profileKey] = {
        ...entry.profile,
        adapterConfig: normalizedAdapterConfig,
      };
    }

    return normalizedRuntimeConfig;
  }

  function generateEd25519PrivateKeyPem(): string {
    const { privateKey } = generateKeyPairSync("ed25519");
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  function ensureGatewayDeviceKey(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "openclaw_gateway") return adapterConfig;
    const disableDeviceAuth = parseBooleanLike(adapterConfig.disableDeviceAuth) === true;
    if (disableDeviceAuth) return adapterConfig;
    if (asNonEmptyString(adapterConfig.devicePrivateKeyPem)) return adapterConfig;
    return { ...adapterConfig, devicePrivateKeyPem: generateEd25519PrivateKeyPem() };
  }

  function applyCreateDefaultsByAdapterType(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
    context?: { role?: string | null; title?: string | null; applyModelTier?: boolean },
  ): { adapterConfig: Record<string, unknown>; appliedModelTier: HermesModelTierId | null } {
    const next = { ...adapterConfig };
    // AgentDash (batch 4, c4-model-tiers): hermes_local agents with no
    // explicit model get the role's high/low tier (Qwen 3.8 Max for
    // leadership, DeepSeek V4.1 Flash for everyone else). An explicit
    // `model` a person set always wins — the tier never overwrites it.
    // AgentDash (review-1028): only when the instance opted in
    // (AGENTDASH_HERMES_MODEL_TIERS=on, no BYOK key) AND the caller allows
    // it — a PATCH that leaves the model alone must not move an existing
    // agent onto a tier.
    const finish = () => {
      const config = ensureGatewayDeviceKey(adapterType, next);
      const tiered = context?.applyModelTier === false
        ? { adapterConfig: config, appliedTier: null }
        : applyHermesModelTierIfActive({
            adapterType,
            adapterConfig: config,
            role: context?.role,
            title: context?.title,
          });
      return { adapterConfig: tiered.adapterConfig, appliedModelTier: tiered.appliedTier };
    };
    if (adapterType === "acpx_local") {
      if (!asNonEmptyString(next.agent)) {
        next.agent = DEFAULT_ACPX_LOCAL_AGENT;
      }
      if (!asNonEmptyString(next.mode)) {
        next.mode = DEFAULT_ACPX_LOCAL_MODE;
      }
      if (!asNonEmptyString(next.permissionMode)) {
        next.permissionMode = DEFAULT_ACPX_LOCAL_PERMISSION_MODE;
      }
      if (!asNonEmptyString(next.nonInteractivePermissions)) {
        next.nonInteractivePermissions = DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS;
      }
      return finish();
    }
    if (adapterType === "codex_local") {
      if (!asNonEmptyString(next.model)) {
        next.model = DEFAULT_CODEX_LOCAL_MODEL;
      }
      const hasBypassFlag =
        typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean" ||
        typeof next.dangerouslyBypassSandbox === "boolean";
      if (!hasBypassFlag) {
        next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
      }
      return finish();
    }
    if (adapterType === "gemini_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_GEMINI_LOCAL_MODEL;
      return finish();
    }
    // OpenCode requires explicit model selection — no default
    if (adapterType === "cursor" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_CURSOR_LOCAL_MODEL;
    }
    return finish();
  }

  async function assertAdapterConfigConstraints(
    companyId: string,
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    if (adapterType !== "opencode_local") return;
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(companyId, adapterConfig);
    const runtimeEnv = asRecord(runtimeConfig.env) ?? {};
    try {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model: runtimeConfig.model,
        command: runtimeConfig.command,
        cwd: runtimeConfig.cwd,
        env: runtimeEnv,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw unprocessable(`Invalid opencode_local adapterConfig: ${reason}`);
    }
  }

  function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
    const trimmed = candidatePath.trim();
    if (path.isAbsolute(trimmed)) return trimmed;

    const cwd = asNonEmptyString(adapterConfig.cwd);
    if (!cwd) {
      throw unprocessable(
        "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
    }
    return path.resolve(cwd, trimmed);
  }

  async function materializeDefaultInstructionsBundleForNewAgent<T extends {
    id: string;
    companyId: string;
    name: string;
    role: string;
    adapterType: string;
    adapterConfig: unknown;
  }>(
    agent: T,
    input?: { files: Record<string, string>; entryFile?: string },
  ): Promise<T> {
    if (!adapterSupportsInstructionsBundle(agent.adapterType)) {
      return agent;
    }

    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const hasExplicitInstructionsBundle =
      Boolean(asNonEmptyString(adapterConfig.instructionsBundleMode))
      || Boolean(asNonEmptyString(adapterConfig.instructionsRootPath))
      || Boolean(asNonEmptyString(adapterConfig.instructionsEntryFile))
      || Boolean(asNonEmptyString(adapterConfig.instructionsFilePath))
      || Boolean(asNonEmptyString(adapterConfig.agentsMdPath));
    if (hasExplicitInstructionsBundle) {
      const nextAdapterConfig = { ...adapterConfig };
      const hadLegacyPrompt =
        Object.prototype.hasOwnProperty.call(nextAdapterConfig, "promptTemplate")
        || Object.prototype.hasOwnProperty.call(nextAdapterConfig, "bootstrapPromptTemplate");
      delete nextAdapterConfig.promptTemplate;
      delete nextAdapterConfig.bootstrapPromptTemplate;
      if (!hadLegacyPrompt) return agent;

      const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
      return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
    }

    const defaultFiles = await loadDefaultAgentInstructionsBundle(
      resolveDefaultAgentInstructionsBundleRole(agent.role),
    );
    // A caller-supplied AGENTS.md customizes the mandate; it does not replace
    // the rest of the managed bundle. The default AGENTS.md references the
    // heartbeat, soul, and tools files, and onboarding must preserve those
    // supporting instructions while allowing explicit files to override them.
    const files = { ...defaultFiles, ...(input?.files ?? {}) };
    const materialized = await instructions.materializeManagedBundle(
      agent,
      files,
      { entryFile: input?.entryFile ?? "AGENTS.md", replaceExisting: false },
    );
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;
    delete nextAdapterConfig.bootstrapPromptTemplate;

    const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
    return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
  }

  function assertNoNewAgentLegacyPromptTemplate(adapterType: string, adapterConfig: Record<string, unknown>) {
    if (!adapterSupportsInstructionsBundle(adapterType)) return;
    if (
      Object.prototype.hasOwnProperty.call(adapterConfig, "promptTemplate")
      || Object.prototype.hasOwnProperty.call(adapterConfig, "bootstrapPromptTemplate")
    ) {
      throw unprocessable(
        "New agents must use instructionsBundle/AGENTS.md instead of adapterConfig.promptTemplate or bootstrapPromptTemplate",
      );
    }
  }

  /**
   * Instructions LOCATION — the adapterConfig path key, the bundle mode, and
   * the external `rootPath`. Administrator only, even in a profile company.
   *
   * A steward must not reach this: `rootPath` is an arbitrary absolute
   * directory that the server `mkdir -p`s and then writes files into, so
   * granting it would hand an ordinary operator arbitrary host filesystem
   * write. Stewards edit instruction CONTENT inside the configured root
   * instead — see `assertCanEditInstructionsContent`.
   */
  async function assertCanManageInstructionsLocation(
    req: Request,
    targetAgent: { id: string; companyId: string },
  ) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type !== "board") {
      throw forbidden(
        "Only board-authenticated callers can manage instructions path or bundle configuration",
      );
    }
    const authority = await requireAgentConfigurationAuthority(req, targetAgent);
    if (authority === "steward") {
      throw forbidden(
        "Stewardship does not permit changing where agent instructions are stored; " +
          "an administrator with agents:create must make this change",
      );
    }
  }

  /**
   * Instructions CONTENT — mandate files within the already-configured bundle
   * root. This is the steward's mandate-editing surface (design §6.3); writes
   * stay confined to the root an administrator chose.
   */
  async function assertCanEditInstructionsContent(
    req: Request,
    targetAgent: { id: string; companyId: string },
    body: { path?: unknown; clearLegacyPromptTemplate?: unknown } = {},
  ) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type !== "board") {
      throw forbidden(
        "Only board-authenticated callers can manage instructions path or bundle configuration",
      );
    }
    const authority = await requireAgentConfigurationAuthority(req, targetAgent);
    // AgentDash (security, #737): a bundle root outside this company's
    // instructions directory is a host directory an instance admin chose
    // (often a checkout, where a written file can run on the next agent run).
    // Only an instance admin writes into it; everyone else edits bundles that
    // live in the managed or company-shared directory.
    if (authority !== "steward" && !actorMaySetHostExecutionConfig(req.actor)) {
      const bundle = await instructions.getBundle(targetAgent as never);
      if (bundle.rootPath && !checkCompanyInstructionsPath(targetAgent.companyId, bundle.rootPath).ok) {
        throw forbidden(
          "Instance admin access required to edit an instructions bundle whose root is outside this " +
            "company's instructions directory",
        );
      }
    }
    if (authority !== "steward") return;

    // A steward may only write inside the SERVER-MANAGED bundle root. An
    // external or legacy-derived root is an arbitrary host directory (commonly
    // the adapter's `cwd`, i.e. a real checkout), where writing files like
    // `.claude/settings.json`, `.mcp.json`, or `Makefile` is host code
    // execution on the next agent run. There is no filename allowlist here, so
    // confining the ROOT is the control.
    const bundle = await instructions.getBundle(targetAgent as never);
    if (bundle.mode !== "managed" || !bundle.rootPath || bundle.rootPath !== bundle.managedRootPath) {
      throw forbidden(
        "Stewardship only permits editing instructions in the managed bundle; " +
          "this agent uses an external instructions root, so an administrator must edit it",
      );
    }
    // Both are back doors into instructions LOCATION: the legacy path writes
    // adapterConfig.promptTemplate directly, and the clear flag rewrites the
    // bundle-mode/root keys that assertCanManageInstructionsLocation reserves.
    if (body.clearLegacyPromptTemplate === true) {
      throw forbidden("Stewardship does not permit clearing the legacy prompt template");
    }
    if (typeof body.path === "string" && body.path.trim() === LEGACY_PROMPT_TEMPLATE_PATH) {
      throw forbidden("Stewardship does not permit editing the legacy prompt template");
    }
  }

  function assertNoAgentInstructionsConfigMutation(
    req: Request,
    adapterConfig: Record<string, unknown> | null | undefined,
    path = "adapterConfig",
  ) {
    if (req.actor.type !== "agent" || !adapterConfig) return;
    const changedSensitiveKeys = KNOWN_INSTRUCTIONS_BUNDLE_KEYS
      .filter((key) => adapterConfig[key] !== undefined)
      .map((key) => `${path}.${key}`);
    if (changedSensitiveKeys.length === 0) return;
    throw forbidden(
      `Agent-authenticated callers cannot modify instructions path or bundle configuration (${changedSensitiveKeys.join(", ")})`,
    );
  }

  function adapterConfigTouchesInstructionsConfig(adapterConfig: Record<string, unknown>) {
    return KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => adapterConfig[key] !== undefined);
  }

  async function assertNoAgentAdapterConfigMutation(
    req: Request,
    companyId: string,
    adapterConfig: Record<string, unknown>,
    path = "adapterConfig",
    storedAdapterConfig?: unknown,
  ) {
    assertNoAgentInstructionsConfigMutation(req, adapterConfig, path);
    await assertHostWorkspaceCommandAuthority(
      db,
      req,
      companyId,
      collectAgentAdapterWorkspaceCommandPaths(adapterConfig, path, storedAdapterConfig),
    );
  }

  function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
    const changedTopLevelKeys = Object.keys(patch).sort();
    const details: Record<string, unknown> = { changedTopLevelKeys };

    const adapterConfigPatch = asRecord(patch.adapterConfig);
    if (adapterConfigPatch) {
      details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
    }

    const runtimeConfigPatch = asRecord(patch.runtimeConfig);
    if (runtimeConfigPatch) {
      details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
    }

    return details;
  }

  function buildUnsupportedSkillSnapshot(
    adapterType: string,
    desiredSkills: string[] = [],
  ): AgentSkillSnapshot {
    return {
      adapterType,
      supported: false,
      mode: "unsupported",
      desiredSkills,
      entries: [],
      warnings: ["This adapter does not implement skill sync yet."],
    };
  }

  // Legacy hardcoded set — used as fallback when adapter module does not
  // declare requiresMaterializedRuntimeSkills explicitly.
  const LEGACY_MATERIALIZED_SKILLS_SET = new Set([
    "cursor",
    "gemini_local",
    "opencode_local",
    "pi_local",
  ]);

  function shouldMaterializeRuntimeSkillsForAdapter(adapterType: string) {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.requiresMaterializedRuntimeSkills !== undefined) {
      return adapter.requiresMaterializedRuntimeSkills;
    }
    return LEGACY_MATERIALIZED_SKILLS_SET.has(adapterType);
  }

  async function buildRuntimeSkillConfig(
    companyId: string,
    adapterType: string,
    config: Record<string, unknown>,
  ) {
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    return {
      ...config,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
  }

  async function resolveDesiredSkillAssignment(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
  ) {
    if (!requestedDesiredSkills) {
      return {
        adapterConfig,
        desiredSkills: null as string[] | null,
        runtimeSkillEntries: null as Awaited<ReturnType<typeof companySkills.listRuntimeSkillEntries>> | null,
      };
    }

    const resolvedRequestedSkills = await companySkills.resolveRequestedSkillKeys(
      companyId,
      requestedDesiredSkills,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    const requiredSkills = runtimeSkillEntries
      .filter((entry) => entry.required)
      .map((entry) => entry.key);
    const desiredSkills = Array.from(new Set([...requiredSkills, ...resolvedRequestedSkills]));

    return {
      adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, desiredSkills),
      desiredSkills,
      runtimeSkillEntries,
    };
  }

  function redactForRestrictedAgentView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      ...agent,
      adapterConfig: {},
      runtimeConfig: {},
    };
  }

  function redactAgentConfiguration(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      adapterType: agent.adapterType,
      adapterConfig: redactEventPayload(agent.adapterConfig),
      runtimeConfig: redactEventPayload(agent.runtimeConfig),
      permissions: agent.permissions,
      updatedAt: agent.updatedAt,
    };
  }

  function redactRevisionSnapshot(snapshot: unknown, canReadSpend: boolean): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
    const record = snapshot as Record<string, unknown>;
    return {
      ...redactMonthlySpendForReader(record, canReadSpend),
      adapterConfig: redactEventPayload(
        typeof record.adapterConfig === "object" && record.adapterConfig !== null
          ? (record.adapterConfig as Record<string, unknown>)
          : {},
      ),
      runtimeConfig: redactEventPayload(
        typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
          ? (record.runtimeConfig as Record<string, unknown>)
          : {},
      ),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? redactEventPayload(record.metadata as Record<string, unknown>)
          : record.metadata ?? null,
    };
  }

  function redactConfigRevision(
    revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
    canReadSpend: boolean,
  ) {
    return {
      ...revision,
      beforeConfig: redactRevisionSnapshot(revision.beforeConfig, canReadSpend),
      afterConfig: redactRevisionSnapshot(revision.afterConfig, canReadSpend),
    };
  }

  function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
    const reports = Array.isArray(node.reports)
      ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
      : [];
    return {
      id: String(node.id),
      name: String(node.name),
      role: String(node.role),
      status: String(node.status),
      reports,
    };
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeAgentReference(req, String(rawId));
      // Agent visibility (2026-09-30): an agent the actor cannot see is 404 on
      // every /agents/:id/* route, before the handler runs.
      await assertAgentIdVisible(db, req, req.params.id);
      next();
    } catch (err) {
      next(err);
    }
  });

  // A5 (GH #830): an issue in a restricted project is 404 on the
  // /issues/:issueId run routes for an actor off the project's access list.
  router.param("issueId", issueVisibilityParam(db));
  // A run's detail, events, log and workspace operations carry its issue's
  // content: a run on an invisible issue is 404 as well.
  router.param("runId", runVisibilityParam(db));

  router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const refresh = typeof req.query.refresh === "string"
      ? ["1", "true", "yes"].includes(req.query.refresh.toLowerCase())
      : false;
    const models = refresh
      ? await refreshAdapterModels(type)
      : await listAdapterModels(type);
    res.json(models);
  });

  router.get("/companies/:companyId/adapters/:type/model-profiles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const profiles = await listAdapterModelProfiles(type);
    res.json(profiles);
  });

  router.get("/companies/:companyId/adapters/:type/detect-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);

    const detected = await detectAdapterModel(type);
    res.json(detected);
  });

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const type = assertKnownAdapterType(req.params.type as string);
      // GH #886 review: the create form calls this probe, so it admits
      // everyone who may create agents (every active member, 2026-08-16).
      // What it may run is narrowed by the host-execution guard below.
      await assertCanCreateAgentsForCompany(req, companyId);

      // AgentDash (security): the environment probe spawns the adapter CLI on
      // the host — some adapters (opencode/pi model discovery) with the full
      // server env and NEVER_SANDBOX — and resolves company secret refs into
      // its env first. Choosing the binary, its args, its env or its working
      // directory is therefore instance-admin only (local_implicit counts, so
      // local_trusted dev is unaffected). Everyone else can probe the default
      // binary, the curated Hermes flags, and — when the edit form names the
      // agent it is testing — the values already stored on that agent.
      const testedAgentId = typeof req.body?.agentId === "string" ? req.body.agentId : null;
      let storedTestConfig: Record<string, unknown> | undefined;
      if (testedAgentId && !actorMaySetHostExecutionConfig(req.actor)) {
        const testedAgent = await svc.getById(testedAgentId);
        if (!testedAgent || testedAgent.companyId !== companyId) {
          throw notFound("Agent not found");
        }
        if (testedAgent.adapterType === type) {
          storedTestConfig = asRecord(testedAgent.adapterConfig) ?? undefined;
        }
      }
      assertHostExecutionConfigAllowed(req.actor, {
        adapterType: type,
        adapterConfig: req.body?.adapterConfig,
        stored: storedTestConfig,
      }, hostExecutionContextForCompany(companyId, { agentId: storedTestConfig ? testedAgentId : null }));

      // Closes #315: e2e bypass — when AGENTDASH_ADAPTER_ENV_BYPASS=true
      // is set, short-circuit the adapter probe and return a synthetic
      // "pass" result. Lets the OnboardingWizard flow advance past step 2
      // on a CI runner that has no Claude/Codex/etc. binary installed.
      // The bypass is OFF by default so production adapter-environment
      // checks (the real customer-facing functionality) are unaffected.
      // Same env-var pattern as AGENTDASH_DEEP_INTERVIEW_ASSESS,
      // AGENTDASH_ALLOW_MULTI_COMPANY, AGENTDASH_RATE_LIMIT_DISABLED.
      if (process.env.AGENTDASH_ADAPTER_ENV_BYPASS === "true") {
        res.json({
          adapterType: type,
          status: "pass",
          checks: [
            {
              code: "adapter_env_bypass",
              level: "info",
              message: "Adapter environment probe bypassed",
              detail:
                "AGENTDASH_ADAPTER_ENV_BYPASS=true is set; the real adapter binary check was skipped. Unset this env var to run the actual probe.",
              hint: null,
            },
          ],
          testedAt: new Date().toISOString(),
        });
        return;
      }

      const adapter = requireServerAdapter(type);

      const inputAdapterConfig =
        (req.body?.adapterConfig ?? {}) as Record<string, unknown>;
      const requestedEnvironmentId =
        typeof req.body?.environmentId === "string" && req.body.environmentId.trim().length > 0
          ? (req.body.environmentId as string)
          : null;
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        companyId,
        inputAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        companyId,
        normalizedAdapterConfig,
      );

      const { executionTarget, environmentName, fallbackChecks } =
        await resolveAdapterTestExecutionContext({
          companyId,
          adapterType: type,
          environmentId: requestedEnvironmentId,
        });

      const result = await adapter.testEnvironment({
        companyId,
        adapterType: type,
        config: runtimeAdapterConfig,
        executionTarget,
        environmentName,
      });

      res.json(mergeAdapterTestResultWithFallbackChecks(result, fallbackChecks));
    },
  );

  router.get("/agents/:id/skills", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgentConfiguration(req, agent);

    const adapter = findActiveServerAdapter(agent.adapterType);
    if (!adapter?.listSkills) {
      const preference = readPaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
      );
      const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId, {
        materializeMissing: false,
      });
      const requiredSkills = runtimeSkillEntries.filter((entry) => entry.required).map((entry) => entry.key);
      res.json(buildUnsupportedSkillSnapshot(agent.adapterType, Array.from(new Set([...requiredSkills, ...preference.desiredSkills]))));
      return;
    }

    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      agent.adapterConfig,
    );
    const runtimeSkillConfig = await buildRuntimeSkillConfig(
      agent.companyId,
      agent.adapterType,
      runtimeConfig,
    );
    const snapshot = await adapter.listSkills({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      config: runtimeSkillConfig,
    });
    res.json(snapshot);
  });

  router.post(
    "/agents/:id/skills/sync",
    validate(agentSkillSyncSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      // Self skill sync stays allowed: it is documented agent behaviour.
      await assertCanUpdateAgent(req, agent, new Set(["desiredSkills"]), new Set(["desiredSkills"]));

      const requestedSkills = Array.from(
        new Set(
          (req.body.desiredSkills as string[])
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      );
      const {
        adapterConfig: nextAdapterConfig,
        desiredSkills,
        runtimeSkillEntries,
      } = await resolveDesiredSkillAssignment(
        agent.companyId,
        agent.adapterType,
        agent.adapterConfig as Record<string, unknown>,
        requestedSkills,
      );
      if (!desiredSkills || !runtimeSkillEntries) {
        throw unprocessable("Skill sync requires desiredSkills.");
      }
      const actor = getActorInfo(req);
      const updated = await svc.update(agent.id, {
        adapterConfig: nextAdapterConfig,
      }, {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "skill-sync",
        },
      });
      if (!updated) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const adapter = findActiveServerAdapter(updated.adapterType);
      const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        updated.companyId,
        updated.adapterConfig,
      );
      const runtimeSkillConfig = {
        ...runtimeConfig,
        paperclipRuntimeSkills: runtimeSkillEntries,
      };
      const snapshot = adapter?.syncSkills
        ? await adapter.syncSkills({
            agentId: updated.id,
            companyId: updated.companyId,
            adapterType: updated.adapterType,
            config: runtimeSkillConfig,
          }, desiredSkills)
        : adapter?.listSkills
          ? await adapter.listSkills({
              agentId: updated.id,
              companyId: updated.companyId,
              adapterType: updated.adapterType,
              config: runtimeSkillConfig,
            })
          : buildUnsupportedSkillSnapshot(updated.adapterType, desiredSkills);

      await logActivity(db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "agent.skills_synced",
        entityType: "agent",
        entityId: updated.id,
        agentId: actor.agentId,
        runId: actor.runId,
        details: {
          adapterType: updated.adapterType,
          desiredSkills,
          mode: snapshot.mode,
          supported: snapshot.supported,
          entryCount: snapshot.entries.length,
          warningCount: snapshot.warnings.length,
        },
      });

      res.json(snapshot);
    },
  );

  router.get("/companies/:companyId/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const unsupportedQueryParams = Object.keys(req.query).sort();
    if (unsupportedQueryParams.length > 0) {
      res.status(400).json({
        error: `Unsupported query parameter${unsupportedQueryParams.length === 1 ? "" : "s"}: ${unsupportedQueryParams.join(", ")}`,
      });
      return;
    }
    const visibleIds = await visibleAgentIdsFor(db, req, companyId);
    const result = (await svc.list(companyId))
      .filter((agent) => visibleIds === null || visibleIds.has(agent.id))
      .map((agent) => withHarnessReadiness(agent));
    const canReadConfigs = await actorCanReadConfigurationsForCompany(req, companyId);
    const canReadSpend = await canReadCompanySpend(db, req, companyId);
    const redactSpend = <T extends object>(row: T) => redactMonthlySpendForReader(row, canReadSpend);
    if (canReadConfigs) {
      res.json((await attachHumanContext(req, companyId, result)).map(redactSpend));
      return;
    }
    // The restricted view redacts adapter and runtime configuration, which is
    // where credentials live. Stewardship is not a credential — it is the org
    // chart — so it survives the redaction rather than being stripped with it.
    res.json(
      (await attachHumanContext(
        req,
        companyId,
        // Non-null: every row came from `svc.list`, and the redactor only
        // returns null for a null input.
        result.map((agent) => redactForRestrictedAgentView(agent)!),
      )).map(redactSpend),
    );
  });

  router.get("/instance/scheduler-heartbeats", async (req, res) => {
    assertInstanceAdmin(req);

    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        agentName: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        status: agentsTable.status,
        adapterType: agentsTable.adapterType,
        runtimeConfig: agentsTable.runtimeConfig,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        companyName: companies.name,
        companyIssuePrefix: companies.issuePrefix,
      })
      .from(agentsTable)
      .innerJoin(companies, eq(agentsTable.companyId, companies.id))
      .orderBy(companies.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows
      .map((row) => {
        const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
        const statusEligible =
          row.status !== "paused" &&
          row.status !== "terminated" &&
          row.status !== "pending_approval";

        return {
          id: row.id,
          companyId: row.companyId,
          companyName: row.companyName,
          companyIssuePrefix: row.companyIssuePrefix,
          agentName: row.agentName,
          agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
          role: row.role as InstanceSchedulerHeartbeatAgent["role"],
          title: row.title,
          status: row.status as InstanceSchedulerHeartbeatAgent["status"],
          adapterType: row.adapterType,
          intervalSec: policy.intervalSec,
          heartbeatEnabled: policy.enabled,
          schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
          lastHeartbeatAt: row.lastHeartbeatAt,
        };
      })
      .filter((item) =>
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
      )
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) {
          return left.schedulerActive ? -1 : 1;
        }
        const companyOrder = left.companyName.localeCompare(right.companyName);
        if (companyOrder !== 0) return companyOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    res.json(items);
  });

  router.get("/companies/:companyId/org", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tree = await svc.orgForCompany(companyId);
    const visibleIds = await visibleAgentIdsFor(db, req, companyId);
    const fullLeanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const leanTree = visibleIds === null ? fullLeanTree : pruneOrgTreeToVisible(fullLeanTree, visibleIds);
    res.json(leanTree);
  });

  router.get("/companies/:companyId/org.svg", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(companyId);
    const visibleIds = await visibleAgentIdsFor(db, req, companyId);
    const fullLeanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const leanTree = visibleIds === null ? fullLeanTree : pruneOrgTreeToVisible(fullLeanTree, visibleIds);
    const svg = renderOrgChartSvg(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  router.get("/companies/:companyId/org.png", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(companyId);
    const visibleIds = await visibleAgentIdsFor(db, req, companyId);
    const fullLeanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const leanTree = visibleIds === null ? fullLeanTree : pruneOrgTreeToVisible(fullLeanTree, visibleIds);
    const png = await renderOrgChartPng(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  });

  router.get("/companies/:companyId/agent-configurations", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanReadConfigurations(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows.map((row) => redactAgentConfiguration(row)));
  });

  router.get("/agents/me", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const agent = await svc.getById(req.actor.agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await buildAgentDetail(agent, req));
  });

  router.get("/agents/me/inbox-lite", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(req.actor.companyId, {
      assigneeAgentId: req.actor.agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
      limit: ISSUE_LIST_DEFAULT_LIMIT,
    });
    const dependencyReadiness = await issuesSvc.listDependencyReadiness(
      req.actor.companyId,
      rows.map((issue) => issue.id),
    );

    res.json(
      rows.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        updatedAt: issue.updatedAt,
        activeRun: issue.activeRun,
        dependencyReady: dependencyReadiness.get(issue.id)?.isDependencyReady ?? true,
        unresolvedBlockerCount: dependencyReadiness.get(issue.id)?.unresolvedBlockerCount ?? 0,
        unresolvedBlockerIssueIds: dependencyReadiness.get(issue.id)?.unresolvedBlockerIssueIds ?? [],
      })),
    );
  });

  router.get("/agents/me/inbox/mine", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const query = agentMineInboxQuerySchema.parse(req.query);
    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(req.actor.companyId, {
      touchedByUserId: query.userId,
      inboxArchivedByUserId: query.userId,
      status: query.status,
      limit: ISSUE_LIST_DEFAULT_LIMIT,
    });

    res.json(rows);
  });

  router.get("/agents/:id", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const isSelf = req.actor.type === "agent" && req.actor.agentId === id;
    const canReadSensitiveDetail = isSelf
      ? true
      : await actorCanReadConfigurationsForCompany(req, agent.companyId);
    if (!canReadSensitiveDetail) {
      res.json(await buildAgentDetail(agent, req, { restricted: true }));
      return;
    }
    res.json(await buildAgentDetail(agent, req));
  });

  router.get("/agents/:id/configuration", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgentConfiguration(req, agent);
    res.json(redactAgentConfiguration(agent));
  });

  router.get("/agents/:id/config-revisions", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgentConfiguration(req, agent);
    const revisions = await svc.listConfigRevisions(id);
    const canReadSpend = await canReadCompanySpend(db, req, agent.companyId);
    res.json(revisions.map((revision) => redactConfigRevision(revision, canReadSpend)));
  });

  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgentConfiguration(req, agent);
    const revision = await svc.getConfigRevision(id, revisionId);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(redactConfigRevision(revision, await canReadCompanySpend(db, req, agent.companyId)));
  });

  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const rollbackAuthority = await assertCanUpdateAgent(req, existing, new Set(), new Set());
    // A rollback restores a whole prior configuration — including fields no
    // ceiling dimension covers (role, adapterConfig) and values captured before
    // the current ceiling existed. Stewardship alone is not sufficient.
    if (rollbackAuthority === "steward") {
      throw forbidden(
        "Stewardship does not permit configuration rollback; an administrator with agents:create must perform it",
      );
    }
    // AgentDash (security): a rollback restores role, reportsTo, budget and
    // adapter configuration wholesale, so an agent rolling back (itself, after
    // a demotion, or another agent) would sidestep the self-edit allowlist and
    // AGE-113. Configuration rollback is a human operation.
    if (rollbackAuthority === "agent") {
      throw forbidden(
        "An agent cannot roll back agent configuration. Ask an owner, admin or operator.",
      );
    }

    // AgentDash (security, #719): a rollback can restore a command, env or cwd
    // an instance admin has since removed. Values equal to what is stored now
    // pass; restoring different host-execution values needs instance admin.
    if (!actorMaySetHostExecutionConfig(req.actor)) {
      const revision = await svc.getConfigRevision(id, revisionId);
      const snapshot = asRecord(revision?.afterConfig);
      if (snapshot) {
        const snapshotAdapterType =
          typeof snapshot.adapterType === "string" ? snapshot.adapterType : existing.adapterType;
        assertHostExecutionConfigAllowed(req.actor, [
          { adapterType: snapshotAdapterType, adapterConfig: snapshot.adapterConfig, stored: existing.adapterConfig },
          ...runtimeConfigHostExecutionInputs(snapshotAdapterType, snapshot.runtimeConfig, existing.runtimeConfig),
        ], hostExecutionContextForCompany(existing.companyId, { agentId: existing.id }));
      }
    }

    const actor = getActorInfo(req);
    let rollbackPin: { environmentId: string; sshTarget: string; port: number } | null = null;
    const updated = await withHermesSshCompanyLock(db, existing.companyId, async tx => {
      const writer = agentService(tx, { environmentLockHeld: true });
      const revision = await writer.getConfigRevision(id, revisionId);
      const snapshot = asRecord(revision?.afterConfig);
      if (!snapshot) return null;
      const adapterType = typeof snapshot.adapterType === "string" ? snapshot.adapterType : existing.adapterType;
      rollbackPin = await assertAgentDefaultEnvironmentSelection(existing.companyId,
        typeof snapshot.defaultEnvironmentId === "string" ? snapshot.defaultEnvironmentId : null, {
          allowedDrivers: allowedEnvironmentDriversForAgent(adapterType),
          allowedSandboxProviders: allowedSandboxProvidersForAgent(adapterType), adapterType, req, executor: tx,
        });
      return writer.rollbackConfigRevision(id, revisionId, {
        agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null,
      });
    });
    if (!updated) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    await logHermesSshEnvironmentPin(req, updated, rollbackPin);
    await refusePendingRunsIfWakePolicyTurnedOn(existing, updated);

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId },
    });

    res.json(await agentForReader(req, updated));
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const state = await heartbeat.getRuntimeState(id);
    // `lastError`/`sessionParamsJson` can carry adapter output — redact at
    // the response boundary (GH #992).
    res.json(redactRunLogValue(state));
  });

  /**
   * AgentDash (run window): board-only audit of one agent over [from, to] —
   * runs, wake requests (including skipped refusals) and agent-related
   * comments, each list capped at RUN_WINDOW_ROW_CAP with `truncated` always
   * present. An agent key is refused: this is the ledger a harness checks the
   * agent against. Agent visibility is enforced by the `:id` param handler;
   * reading it also needs the agent-management permission, like the other
   * run-internals reads (runtime-state, task-sessions).
   */
  router.get("/agents/:id/run-window", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    const bounds = parseRunWindowBounds(req.query.from, req.query.to);
    if ("error" in bounds) {
      res.status(400).json({ error: bounds.error });
      return;
    }
    // A5 (GH #830): rows tied to an issue in a restricted project the caller
    // is not listed on are absent, exactly as on every other run list.
    res.json(await readAgentRunWindow(db, agent, bounds, {
      runs: runVisibilityCondition(req, agent.companyId),
      wakes: wakeVisibilityCondition(req, agent.companyId),
      comments: projectScopedVisibilityCondition(req, agent.companyId, issuesTable.projectId),
    }));
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });

    res.json(state);
  });

  router.post("/agents/:id/harness-preflight", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const adapterConfig =
      agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
        ? agent.adapterConfig as Record<string, unknown>
        : {};
    const result = await withAgentResolvedModelCheck(
      agent,
      // AgentDash (c3 addendum): the re-check endpoint reports the outcome —
      // even a failed check result is saved evidence, not a 422. The launch
      // gate in claimQueuedRun is what enforces readiness.
      await runRequiredHarnessPreflight({
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        adapterConfig,
        defaultEnvironmentId: agent.defaultEnvironmentId,
        agent: { id: agent.id, companyId: agent.companyId, adapterConfig },
        enforce: false,
      }),
    );
    const metadata = withHarnessPreflightMetadata(
      agent.metadata as Record<string, unknown> | null | undefined,
      {
        adapterType: agent.adapterType,
        adapterConfig,
        defaultEnvironmentId: agent.defaultEnvironmentId,
        result,
      },
    );
    const updated = await svc.update(id, { metadata });
    const readiness = evaluateAgentHarnessPreflightReadiness({
      adapterType: agent.adapterType,
      adapterConfig,
      defaultEnvironmentId: agent.defaultEnvironmentId,
      metadata,
    });
    // AgentDash (c4 trust): the agent page re-checks in the background when
    // evidence is absent or out of date. Those checks never write an activity
    // row — a page visit is not something the viewer did, and on agents whose
    // check keeps failing it spammed the feed as "<viewer> agent harness
    // preflight failed" once per visit. Only a check a person explicitly
    // asked for is logged.
    const isBackgroundCheck =
      !!req.body && typeof req.body === "object" && (req.body as Record<string, unknown>).background === true;
    if (!isBackgroundCheck) await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      // AgentDash (c3 review): a non-blocking warn is a pass — the advisory
      // checks are advisory. Only a result that would block a launch counts
      // as a failure in the activity log.
      action: isBlockingPreflightResult(result) ? "agent.harness_preflight_failed" : "agent.harness_preflight_passed",
      entityType: "agent",
      entityId: id,
      details: {
        adapterType: agent.adapterType,
        status: result.status,
        testedAt: result.testedAt,
      },
    });

    res.json({
      agent: await agentForReader(req, updated ?? { ...agent, metadata }),
      result,
      readiness,
    });
  });

  router.post("/companies/:companyId/agent-hires", validate(createAgentHireSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);
    assertAgentCreationAuthority(req);
    if (req.body.workforceTemplateId !== undefined) assertCanSetCompanyDirection(req, companyId);
    // AgentDash (GH #828): body metadata becomes the hire approval's payload
    // metadata, which the digest reads for assistant provenance.
    assertNoAssistantProvenanceClaim(req.actor, req.body.metadata);
    const sourceIssueIds = parseSourceIssueIds(req.body);
    // A5 (GH #830): the hire approval links these issues; they must be visible.
    for (const issueId of sourceIssueIds) {
      await assertIssueIdVisible(db, req, issueId);
    }
    const {
      desiredSkills: requestedDesiredSkills,
      instructionsBundle,
      sourceIssueId: _sourceIssueId,
      sourceIssueIds: _sourceIssueIds,
      // Defaults FALSE — see requireHarnessPreflight in
      // packages/shared/src/validators/agent.ts for why environment preflight
      // stays opt-in, and why configuration completeness is enforced instead.
      requireHarnessPreflight,
      ...hireInput
    } = req.body;
    hireInput.adapterType = assertKnownAdapterType(hireInput.adapterType);
    const rawHireAdapterConfig = (hireInput.adapterConfig ?? {}) as Record<string, unknown>;
    assertNoNewAgentLegacyPromptTemplate(
      hireInput.adapterType,
      rawHireAdapterConfig,
    );
    await assertNoAgentAdapterConfigMutation(req, companyId, rawHireAdapterConfig);
    await assertNoAgentRuntimeConfigAdapterConfigMutation(req, companyId, hireInput.runtimeConfig);
    assertNoAgentRecoveryBudgetMutation(req, null, hireInput.runtimeConfig);
    assertNoAgentWakePolicyMutation(req, null, { runtimeConfig: hireInput.runtimeConfig, metadata: hireInput.metadata });
    // AgentDash (security, #719): the binary, argv, env and cwd an agent runs
    // with are instance-admin only; see services/adapter-host-execution-policy.ts.
    assertHostExecutionConfigAllowed(req.actor, [
      { adapterType: hireInput.adapterType, adapterConfig: rawHireAdapterConfig },
      ...runtimeConfigHostExecutionInputs(hireInput.adapterType, hireInput.runtimeConfig),
    ], hostExecutionContextForCompany(companyId));
    const {
      adapterConfig: requestedAdapterConfig,
      appliedModelTier,
    } = applyCreateDefaultsByAdapterType(
      hireInput.adapterType,
      rawHireAdapterConfig,
      { role: hireInput.role, title: hireInput.title },
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      hireInput.adapterType,
      requestedAdapterConfig,
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
    );
    const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
      companyId,
      adapterType: hireInput.adapterType,
      adapterConfig: desiredSkillAssignment.adapterConfig,
    });
    const normalizedRuntimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
      companyId,
      hireInput.adapterType,
      normalizeNewAgentRuntimeConfig(hireInput.runtimeConfig),
      normalizedAdapterConfig,
    );
    const normalizedHireInput = {
      ...hireInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
      // AgentDash (c4-model-tiers): the tier applied to an unmodelled
      // hermes_local agent is recorded so the UI can label the model in
      // plain words and the doctor command can see provenance.
      metadata: appliedModelTier
        ? { ...(hireInput.metadata ?? {}), [AGENT_MODEL_TIER_METADATA_KEY]: appliedModelTier }
        : hireInput.metadata,
      // A hire is a proposal for a personal agent: the whole flow exists so a
      // person ends up with an agent of their own, and the approval payload has
      // nowhere to carry an accountable human.
      //
      // Pinned rather than passed through. `createAgentHireSchema` extends the
      // same base schema as creation, so a body asking for `autonomy:
      // "autonomous"` would otherwise reach the insert with no accountable
      // person resolved and fail on `agents_accountable_ck` as a 500. Creating
      // autonomous agents goes through POST /companies/:id/agents.
      autonomy: "stewarded" as const,
      accountableUserId: null,
    };

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    // AgentDash: the hire path pins an environment too, so it gets the same
    // company, driver, allowlist and permission checks as create. A no-op for
    // a valid request (or none); it refuses another company's environment id.
    let hermesSshHirePin = await assertAgentDefaultEnvironmentSelection(
      companyId,
      normalizedHireInput.defaultEnvironmentId,
      {
        allowedDrivers: allowedEnvironmentDriversForAgent(normalizedHireInput.adapterType),
        allowedSandboxProviders: allowedSandboxProvidersForAgent(normalizedHireInput.adapterType),
        adapterType: normalizedHireInput.adapterType,
        req,
      },
    );

    const harnessPreflightResult = requireHarnessPreflight
      ? await runRequiredHarnessPreflight({
          companyId,
          adapterType: normalizedHireInput.adapterType,
          adapterConfig: normalizedAdapterConfig,
          defaultEnvironmentId: normalizedHireInput.defaultEnvironmentId,
        })
      : null;

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const createdAgent = await createAgentWithinTierCapacity(companyId, res, (dbOrTx, acceptance) =>
      createAgentRow(agentService(dbOrTx), companyId, {
        ...normalizedHireInput,
        metadata: withHarnessPreflightMetadata(normalizedHireInput.metadata, {
          adapterType: normalizedHireInput.adapterType,
          adapterConfig: normalizedAdapterConfig,
          defaultEnvironmentId: normalizedHireInput.defaultEnvironmentId,
          result: harnessPreflightResult,
        }),
        status,
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        // A3: ownership from the ACTOR, never the body. An agent creating an
        // agent (chief-of-staff hires) records no human creator; the hire
        // approval trail is its provenance.
        createdByUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
      }, acceptance),
      normalizedHireInput.adapterType === "hermes_local" && normalizedHireInput.defaultEnvironmentId ? async tx => {
        hermesSshHirePin = await assertAgentDefaultEnvironmentSelection(companyId, normalizedHireInput.defaultEnvironmentId, {
          allowedDrivers: allowedEnvironmentDriversForAgent(normalizedHireInput.adapterType),
          allowedSandboxProviders: allowedSandboxProvidersForAgent(normalizedHireInput.adapterType),
          adapterType: normalizedHireInput.adapterType, req, executor: tx,
        });
      } : undefined,
    );
    if (!createdAgent) return;
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, instructionsBundle);
    // AgentDash: enrollment is atomic with creation; filesystem work follows commit.
    if (req.body.workforceTemplateId !== undefined) {
      await workforceService(db).ensureSkillsInstalled(companyId, agent.id, { userId: req.actor.userId ?? "board" });
    }
    // AgentDash (scan 2, E3): the onboarding wizard hires here; a company's
    // first agent is its owner's when the owner hires it, on every workspace.
    // Hires are always stewarded (see normalizedHireInput).
    await pairCreatorWithCompanysFirstAgent(req, companyId, agent.id);

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig =
        redactEventPayload(
          (agent.adapterConfig ?? normalizedHireInput.adapterConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          desiredSkills: desiredSkillAssignment.desiredSkills,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: {
            adapterType: requestedAdapterType,
            adapterConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
            desiredSkills: desiredSkillAssignment.desiredSkills,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        issueIds: sourceIssueIds,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    await logHermesSshEnvironmentPin(req, agent, hermesSshHirePin);
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      actor.actorType === "user" ? actor.actorId : null,
    );

    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }

    const canReadSpend = await canReadCompanySpend(db, req, companyId);
    res.status(201).json({
      agent: redactMonthlySpendForReader(agent, canReadSpend),
      approval: approval ? redactApprovalForReader(approval, canReadSpend) : null,
    });
  });

  router.post("/companies/:companyId/agents", validate(createAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);
    assertAgentCreationAuthority(req);
    if (req.body.workforceTemplateId !== undefined) assertCanSetCompanyDirection(req, companyId);

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (company.requireBoardApprovalForNewAgents) {
      throw conflict(
        "Direct agent creation requires board approval. Use POST /api/companies/:companyId/agent-hires to create a pending hire approval.",
      );
    }

    const {
      desiredSkills: requestedDesiredSkills,
      instructionsBundle,
      // Defaults FALSE — see requireHarnessPreflight in
      // packages/shared/src/validators/agent.ts for why environment preflight
      // stays opt-in, and why configuration completeness is enforced instead.
      requireHarnessPreflight,
      ...createInput
    } = req.body;
    createInput.adapterType = assertKnownAdapterType(createInput.adapterType);
    const rawCreateAdapterConfig = (createInput.adapterConfig ?? {}) as Record<string, unknown>;
    assertNoNewAgentLegacyPromptTemplate(
      createInput.adapterType,
      rawCreateAdapterConfig,
    );
    await assertNoAgentAdapterConfigMutation(req, companyId, rawCreateAdapterConfig);
    await assertNoAgentRuntimeConfigAdapterConfigMutation(req, companyId, createInput.runtimeConfig);
    assertNoAgentRecoveryBudgetMutation(req, null, createInput.runtimeConfig);
    assertNoAgentWakePolicyMutation(req, null, { runtimeConfig: createInput.runtimeConfig, metadata: createInput.metadata });
    // AgentDash (security, #719): the binary, argv, env and cwd an agent runs
    // with are instance-admin only; see services/adapter-host-execution-policy.ts.
    assertHostExecutionConfigAllowed(req.actor, [
      { adapterType: createInput.adapterType, adapterConfig: rawCreateAdapterConfig },
      ...runtimeConfigHostExecutionInputs(createInput.adapterType, createInput.runtimeConfig),
    ], hostExecutionContextForCompany(companyId));
    const {
      adapterConfig: requestedAdapterConfig,
      appliedModelTier,
    } = applyCreateDefaultsByAdapterType(
      createInput.adapterType,
      rawCreateAdapterConfig,
      { role: createInput.role, title: createInput.title },
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      createInput.adapterType,
      requestedAdapterConfig,
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
    );
    const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
      companyId,
      adapterType: createInput.adapterType,
      adapterConfig: desiredSkillAssignment.adapterConfig,
    });
    const normalizedRuntimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
      companyId,
      createInput.adapterType,
      normalizeNewAgentRuntimeConfig(createInput.runtimeConfig),
      normalizedAdapterConfig,
    );
    await assertAgentEnvironmentSelection(companyId, createInput.adapterType, createInput.defaultEnvironmentId);
    let hermesSshPin = await assertAgentDefaultEnvironmentSelection(companyId, createInput.defaultEnvironmentId, {
      allowedDrivers: allowedEnvironmentDriversForAgent(createInput.adapterType),
      allowedSandboxProviders: allowedSandboxProvidersForAgent(createInput.adapterType),
      adapterType: createInput.adapterType,
      req,
    });

    // Which kind of agent this is, and who answers for it.
    //
    // `stewarded` is the default, so every existing caller keeps creating
    // personal agents. An autonomous agent has no steward to inherit
    // accountability from, so it has to be recorded here or it never is: the
    // person asking, or — when one agent hires another, where there is no human
    // actor at all — whoever is already accountable for the hiring agent.
    //
    // An autonomous agent with nobody behind it is refused rather than created.
    // That is the same rule `agents_accountable_ck` enforces in the database;
    // refusing here means the caller gets a sentence they can act on instead of
    // a constraint violation.
    const requestedAutonomy = normalizeAgentAutonomy(createInput.autonomy);
    if (requestedAutonomy === "stewarded" && createInput.accountableUserId) {
      throw conflict(
        "A stewarded agent takes its accountable human from its steward, so accountableUserId "
          + "cannot be set on one. Assign the stewardship instead, or create the agent as autonomous.",
      );
    }
    let resolvedAccountableUserId: string | null = null;
    if (requestedAutonomy === "autonomous") {
      const creationActor = getActorInfo(req);
      resolvedAccountableUserId =
        (createInput.accountableUserId as string | null | undefined)
        ?? (req.actor.type === "board" ? req.actor.userId ?? null : null)
        ?? (creationActor.agentId
          ? await accountability.escalationUserId(companyId, creationActor.agentId)
          : null);
      if (!resolvedAccountableUserId) {
        throw conflict(
          "An autonomous agent needs a human who is accountable for it. Pass accountableUserId, "
            + "or create the agent as stewarded so its steward is the answer.",
        );
      }
      await accountability.assertAccountableMember(companyId, resolvedAccountableUserId);
    }

    const harnessPreflightResult = requireHarnessPreflight
      ? await runRequiredHarnessPreflight({
          companyId,
          adapterType: createInput.adapterType,
          adapterConfig: normalizedAdapterConfig,
          defaultEnvironmentId: createInput.defaultEnvironmentId,
        })
      : null;

    const createdAgent = await createAgentWithinTierCapacity(companyId, res, (dbOrTx, acceptance) =>
      createAgentRow(agentService(dbOrTx), companyId, {
        ...createInput,
        adapterConfig: normalizedAdapterConfig,
        runtimeConfig: normalizedRuntimeConfig,
        metadata: withHarnessPreflightMetadata(
          appliedModelTier
            ? { ...(createInput.metadata ?? {}), [AGENT_MODEL_TIER_METADATA_KEY]: appliedModelTier }
            : createInput.metadata,
          {
            adapterType: createInput.adapterType,
            adapterConfig: normalizedAdapterConfig,
            defaultEnvironmentId: createInput.defaultEnvironmentId,
            result: harnessPreflightResult,
          },
        ),
        status: "idle",
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        // Resolved above, and set after the spread so the resolution wins over
        // whatever the body asked for.
        autonomy: requestedAutonomy,
        accountableUserId: resolvedAccountableUserId,
        // A3: ownership from the ACTOR, never the body. An agent creating an
        // agent (chief-of-staff hires) records no human creator; the hire
        // approval trail is its provenance.
        createdByUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
      }, acceptance),
      createInput.adapterType === "hermes_local" && createInput.defaultEnvironmentId ? async tx => {
        hermesSshPin = await assertAgentDefaultEnvironmentSelection(companyId, createInput.defaultEnvironmentId, {
          allowedDrivers: allowedEnvironmentDriversForAgent(createInput.adapterType),
          allowedSandboxProviders: allowedSandboxProvidersForAgent(createInput.adapterType),
          adapterType: createInput.adapterType, req, executor: tx,
        });
      } : undefined,
    );
    if (!createdAgent) return;
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, instructionsBundle);
    // AgentDash: enrollment is atomic with creation; filesystem work follows commit.
    if (req.body.workforceTemplateId !== undefined) {
      await workforceService(db).ensureSkillsInstalled(companyId, agent.id, { userId: req.actor.userId ?? "board" });
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    await logHermesSshEnvironmentPin(req, agent, hermesSshPin);
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    // Make the creator this agent's steward, if they are not already stewarding
    // one.
    //
    // Creating an agent used to leave you with no way to RUN it. The API key
    // and the "work with it from your own terminal" prompts live on the My
    // Agent page, `getMyAgent` returns only the agent you steward, and creation
    // never wrote a stewardship row -- so a new admin created their first agent
    // and then found nothing anywhere in the UI that would connect them to it.
    // Observed on a client's own instance the day they set it up.
    //
    // Only when the creator has none. Stewardship is deliberately 1:1 in both
    // directions (`assign` rejects a second one with a 409), so this cannot
    // mean "you steward everything you create" -- it means the FIRST agent you
    // make is yours to run, which is the case where being stranded actually
    // happens. Later agents are paired deliberately, which is the point of the
    // model.
    //
    // Best-effort: a failure here must not fail the creation. The agent exists
    // and is valid without a steward; someone can pair it afterwards.
    //
    // Skipped entirely for an autonomous agent: it has no steward by
    // definition, and `assign` now refuses one anyway.
    //
    // AgentDash (one UX): and only where stewardship is on. It is a
    // per-workspace capability gated on the server; a company without it does
    // not collect pairings as a side effect of creating agents, with one
    // exception (scan 2, E3): the company's owner is paired with the company's
    // FIRST agent on every workspace, below (pairCreatorWithCompanysFirstAgent).
    if (requestedAutonomy === "stewarded" && req.actor.type === "board" && req.actor.userId) {
      try {
        const stewardshipOn = await db
          .select({ productProfile: companies.productProfile })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0]?.productProfile === "agentdash_mk");
        const existing = stewardshipOn ? await stewardships.activeByUser(companyId, req.actor.userId) : null;
        if (stewardshipOn && !existing) {
          await stewardships.assign(companyId, {
            agentId: agent.id,
            userId: req.actor.userId,
            assignedByUserId: req.actor.userId,
          });
        }
      } catch (err) {
        logger.warn(
          { err, agentId: agent.id, userId: req.actor.userId },
          "[agents] could not auto-assign stewardship to the creator",
        );
      }
    }

    // AgentDash (scan 2, E3): a company's first agent is its owner's when the
    // owner creates it, on every workspace (the block above pairs only where
    // stewardship is on). Admins and other members are not paired here.
    if (requestedAutonomy === "stewarded") {
      await pairCreatorWithCompanysFirstAgent(req, companyId, agent.id);
    }

    if (agent.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: agent.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        actor.actorType === "user" ? actor.actorId : null,
      );
    }

    // GH #71: every agent needs an API key to authenticate callbacks against
    // /api/* (especially adapters like claude_api). Create a default key
    // synchronously so the create response carries the only viewable copy of
    // the token (subsequent GET /agents/:id/keys never re-exposes it).
    let apiKey: Awaited<ReturnType<typeof svc.createApiKey>> | null = null;
    if (agent.status !== "pending_approval") {
      apiKey = await svc.createApiKey(agent.id, "default", {
        source: "agent_creation",
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByAgentId: actor.agentId ?? null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.key_created",
        entityType: "agent",
        entityId: agent.id,
        details: { keyId: apiKey.id, name: apiKey.name, autoCreated: true },
      });
    }

    // AgentDash (AGE-24): say plainly that this key was minted with the agent,
    // so nobody finds a "default" key later and wonders who holds it.
    res.status(201).json({ ...await agentForReader(req, agent), apiKey: apiKey ? { ...apiKey, autoCreated: true } : null });
  });

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent") {
      // AgentDash (security, #734): granting `canCreateAgents` mints a
      // company-wide agent administrator and `canAssignTasks` extends task
      // authority — both are authority-bearing in the sense of #727, where the
      // rule is that everything outside the presentation allowlist needs a
      // board actor. The old exception let a CEO agent pass, which made one
      // compromised agent key enough to spread agent administration to every
      // other agent in the company. There is no narrower safe grant on this
      // route — the schema offers only these two fields — so agent actors are
      // refused outright, matching `POST /agents/:id/pause` and friends.
      res.status(403).json({
        error:
          "Only a human with agent-configuration authority may change agent permissions; " +
          "ask an owner, admin or operator",
      });
      return;
    }
    const permissionAuthority = await requireAgentConfigurationAuthority(req, existing);
    // `agents:create` is company-wide agent administration by another name:
    // an agent holding it can modify every agent in the company via its own
    // key. A steward must not be able to grant it to their own agent, and the
    // ceiling cannot be relied on to stop them because the default ceiling is
    // deliberately unrestricted.
    if (permissionAuthority === "steward" && req.body.canCreateAgents) {
      throw forbidden(
        "Stewardship does not permit granting agent-creation authority; " +
          "an administrator with agents:create must make this change",
      );
    }

    // AgentDash-MK: the owner ceiling binds at the service boundary, so a
    // steward (or an admin) cannot grant an agent authority the owner withheld.
    // This must validate the permissions that will ACTUALLY be written, not the
    // request body: `tasks:assign` is additionally derived below from the CEO
    // role and from canCreateAgents, so checking the raw body would let
    // `{canCreateAgents: true, canAssignTasks: false}` slip a withheld
    // `tasks:assign` grant past a ceiling that forbids it.
    const willAssignTasks =
      existing.role === "ceo" || Boolean(req.body.canCreateAgents) || Boolean(req.body.canAssignTasks);
    await governance.assertAgentMutationWithinCeiling(
      existing.companyId,
      existing.id,
      {
        permissions: [
          ...(req.body.canCreateAgents ? ["agents:create"] : []),
          ...(willAssignTasks ? ["tasks:assign"] : []),
        ],
      },
      { actorUserId: req.actor.userId ?? null },
    );

    const agent = await svc.updatePermissions(id, req.body);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const effectiveCanAssignTasks =
      agent.role === "ceo" || Boolean(agent.permissions?.canCreateAgents) || req.body.canAssignTasks;
    await access.ensureMembership(agent.companyId, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(
      agent.companyId,
      "agent",
      agent.id,
      "tasks:assign",
      effectiveCanAssignTasks,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        canCreateAgents: agent.permissions?.canCreateAgents ?? false,
        canAssignTasks: effectiveCanAssignTasks,
      },
    });

    res.json(await buildAgentDetail(agent, req));
  });

  /**
   * AgentDash (OBS-2 / GH #695): raise or clear this agent's daily token
   * ceiling — the "unpause" control the steward reaches for from the agent
   * page. Dedicated route rather than the generic PATCH because PATCH
   * replaces `runtimeConfig` wholesale and `runtimeConfig` is not a field a
   * steward may write; this merges the single key into the stored config.
   *
   * `maxDailyTokens` is required: `0` or `null` disables the ceiling, a
   * positive integer sets it. Removing the key (unset) is not possible here —
   * unset means the shared default, which is what an absent config already
   * yields.
   */
  router.patch(
    "/agents/:id/token-ceiling",
    validate(updateAgentTokenCeilingSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      // Admin or steward — the pause is the steward's problem to solve.
      await requireAgentConfigurationAuthority(req, existing);

      const runtimeConfig = { ...(asRecord(existing.runtimeConfig) ?? {}) };
      const heartbeat = { ...(asRecord(runtimeConfig.heartbeat) ?? {}) };
      heartbeat.maxDailyTokens = req.body.maxDailyTokens;
      runtimeConfig.heartbeat = heartbeat;

      const actor = getActorInfo(req);
      const agent = await svc.update(id, { runtimeConfig }, {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "patch",
        },
      });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.token_ceiling_updated",
        entityType: "agent",
        entityId: agent.id,
        details: { maxDailyTokens: req.body.maxDailyTokens },
      });

      res.json(await buildAgentDetail(agent, req));
    },
  );

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), async (req, res) => {
    if (req.actor.type !== "board") {
      throw forbidden("Only board-authenticated callers can manage instructions path or bundle configuration");
    }

    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await assertCanManageInstructionsLocation(req, existing);

    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const explicitKey = asNonEmptyString(req.body.adapterConfigKey);
    const defaultKey = resolveInstructionsPathKey(existing.adapterType);
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) {
      res.status(422).json({
        error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.`,
      });
      return;
    }
    // `adapterConfigKey` is caller-supplied and this route writes it straight
    // into adapterConfig, so it must be constrained to actual instructions-path
    // keys. Unbounded, it is an arbitrary-adapterConfig writer — a caller could
    // set `command` (the host binary every local adapter spawns) or delete
    // `workspaceStrategy`. That is now reachable by stewards, not just admins.
    const allowedInstructionsPathKeys = new Set(KNOWN_INSTRUCTIONS_PATH_KEYS);
    if (defaultKey) allowedInstructionsPathKeys.add(defaultKey);
    if (!allowedInstructionsPathKeys.has(adapterConfigKey)) {
      res.status(422).json({
        error:
          `adapterConfigKey '${adapterConfigKey}' is not an instructions path key. ` +
          `Expected one of: ${[...allowedInstructionsPathKeys].sort().join(", ")}.`,
      });
      return;
    }

    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (req.body.path === null) {
      delete nextAdapterConfig[adapterConfigKey];
    } else {
      const resolvedInstructionsPath = resolveInstructionsFilePath(req.body.path, existingAdapterConfig);
      const protectedDir = findProtectedHostDirectoryOverlap(path.dirname(resolvedInstructionsPath));
      if (protectedDir) {
        throw unprocessable(
          `Instructions path overlaps a protected host directory (${protectedDir}); choose another location.`,
        );
      }
      // AgentDash (security, #737): the server reads this file into the
      // agent's prompt and treats its directory as the bundle root, so a path
      // outside this company's instructions directory is instance-admin only.
      if (!actorMaySetHostExecutionConfig(req.actor)) {
        const check = checkCompanyInstructionsPath(existing.companyId, resolvedInstructionsPath);
        if (!check.ok) {
          throw forbidden(
            `Instance admin access required for an instructions path outside this company's ` +
              `instructions directory: ${check.reason}.`,
          );
        }
      }
      nextAdapterConfig[adapterConfigKey] = resolvedInstructionsPath;
    }

    const syncedAdapterConfig = syncInstructionsBundleConfigFromFilePath(existing, nextAdapterConfig);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      syncedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const actor = getActorInfo(req);
    const agent = await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_path_patch",
        },
      },
    );
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        adapterConfigKey,
        path: pathValue,
        cleared: req.body.path === null,
      },
    });

    res.json({
      agentId: agent.id,
      adapterType: agent.adapterType,
      adapterConfigKey,
      path: pathValue,
    });
  });

  router.get("/agents/:id/instructions-bundle", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);
    res.json(await instructions.getBundle(existing));
  });

  router.patch("/agents/:id/instructions-bundle", validate(updateAgentInstructionsBundleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsLocation(req, existing);

    const actor = getActorInfo(req);
    // AgentDash (security, #737): an external root outside this company's
    // instructions directory is instance-admin only.
    const { bundle, adapterConfig } = await instructions.updateBundle(existing, req.body, {
      allowUnconfinedExternalRoot: actorMaySetHostExecutionConfig(req.actor),
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_patch",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_bundle_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        mode: bundle.mode,
        rootPath: bundle.rootPath,
        entryFile: bundle.entryFile,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(bundle);
  });

  router.get("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    res.json(await instructions.readFile(existing, relativePath));
  });

  router.put("/agents/:id/instructions-bundle/file", validate(upsertAgentInstructionsFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanEditInstructionsContent(req, existing, req.body ?? {});

    const actor = getActorInfo(req);
    const result = await instructions.writeFile(existing, req.body.path, req.body.content, {
      clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_put",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(result.file);
  });

  router.delete("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanEditInstructionsContent(req, existing, req.body ?? {});

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await instructions.deleteFile(existing, relativePath);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_deleted",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: relativePath,
      },
    });

    res.json(result.bundle);
  });

  // AgentDash: agent-instruction-refresh — manual refresh routes for cases
  // where the next tick is too far away. The heartbeat hook already refreshes
  // on every dispatch; these endpoints exist for board-driven force-refresh.
  router.post(
    "/companies/:companyId/agents/:agentId/refresh-instructions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      const existing = await svc.getById(agentId);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      const result = await instructionRefresh.refreshIfStale(agentId);
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/agents/refresh-instructions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const results = await instructionRefresh.refreshAllForCompany(companyId);
      res.json({ companyId, results });
    },
  );

  router.patch("/agents/:id", validate(updateAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const updateAuthority = await assertCanUpdateAgent(
      req,
      existing,
      AGENT_SELF_PATCHABLE_FIELDS,
      AGENT_PEER_PATCHABLE_FIELDS,
    );
    assertStewardPatchScope(updateAuthority, req.body as Record<string, unknown>);

    if (hasOwn(req.body as object, "permissions")) {
      res.status(422).json({ error: "Use /api/agents/:id/permissions for permission changes" });
      return;
    }
    // GH #734: `desiredSkills` is not a column — the update silently dropped it.
    // Refuse it and name the route that actually applies a skill assignment.
    if (hasOwn(req.body as object, "desiredSkills")) {
      res.status(422).json({
        error: "Skill assignment is not set here. Use POST /api/agents/:id/skills/sync to change an agent's desired skills.",
      });
      return;
    }
    // Agent visibility (2026-09-30): who may see an agent is a company
    // administrator's decision, whoever else may edit the agent.
    if (hasOwn(req.body as object, "visibility")) {
      await assertCompanyAdministrator(access, req, existing.companyId);
    }

    /*
     * Refuse `steward` rather than silently dropping it.
     *
     * `updateAgentSchema` has no such field, so zod stripped it and this route
     * answered 200 having changed nothing. That is the worst possible reply: a
     * caller asked to pair a steward, was told it worked, re-read the agent,
     * found `steward: null`, and concluded the backend was broken. One run did
     * exactly that and closed its task on a root cause that did not exist.
     *
     * Stewardship is a separate resource with its own history and its own
     * authority check -- it is deliberately not a column you can PATCH -- so
     * the honest answer names where it does live.
     */
    if (
      hasOwn(req.body as object, "steward") ||
      hasOwn(req.body as object, "stewardUserId")
    ) {
      // Name the stewardship routes only where they answer: in a company
      // without the capability, assigning is a 404.
      const stewardshipOn = await db
        .select({ productProfile: companies.productProfile })
        .from(companies)
        .where(eq(companies.id, existing.companyId))
        .then((rows) => rows[0]?.productProfile === "agentdash_mk");
      res.status(422).json({
        error: stewardshipOn
          ? "Stewardship is not set here. Use POST /api/companies/:companyId/agent-stewardships " +
            "to assign one, or POST /api/companies/:companyId/agents/:agentId/stewardship/transfer to move it."
          : "Stewardship is not set here, and it is not enabled for this workspace.",
      });
      return;
    }

    // AgentDash-MK: budget is a ceiling dimension, so it is checked before
    // persistence rather than trusted from the client.
    if (hasOwn(req.body as object, "budgetMonthlyCents")) {
      await governance.assertAgentMutationWithinCeiling(
        existing.companyId,
        existing.id,
        { monthlyBudgetCents: (req.body as { budgetMonthlyCents: number }).budgetMonthlyCents },
        { actorUserId: req.actor.userId ?? null },
      );
    }

    const patchData = { ...(req.body as Record<string, unknown>) };
    const replaceAdapterConfig = patchData.replaceAdapterConfig === true;
    delete patchData.replaceAdapterConfig;

    // Changing what kind of agent this is, or who answers for it.
    //
    // Reassignment is the whole point of a separate accountable column: the
    // person who set an autonomous agent running is often not the person who
    // should be woken by it later, and `created_by_user_id` is provenance that
    // must not be rewritten to express that.
    //
    // Turning a paired agent autonomous is refused while the pairing is live.
    // Doing it silently would end someone's stewardship as a side effect of a
    // field edit — taking away their My Agent page, their connect code and their
    // channel binding — so the steward is named and the pairing has to be ended
    // deliberately first.
    //
    // Only administrators reach this at all: `STEWARD_PATCHABLE_AGENT_FIELDS`
    // does not list either field, so a steward patching their own agent is
    // refused by `assertStewardPatchScope` above.
    if (hasOwn(patchData, "autonomy") || hasOwn(patchData, "accountableUserId")) {
      Object.assign(patchData, await resolveAccountabilityPatch(db, req, existing, patchData));
    }
    if (hasOwn(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) {
        res.status(422).json({ error: "adapterConfig must be an object" });
        return;
      }
      await assertNoAgentAdapterConfigMutation(
        req,
        existing.companyId,
        adapterConfig,
        "adapterConfig",
        existing.adapterConfig,
      );
      const changingInstructionsConfig = adapterConfigTouchesInstructionsConfig(adapterConfig);
      if (changingInstructionsConfig) {
        await assertCanManageInstructionsLocation(req, existing);
      }
      patchData.adapterConfig = adapterConfig;
    }

    const requestedAdapterType = hasOwn(patchData, "adapterType")
      ? assertKnownAdapterType(patchData.adapterType as string | null | undefined)
      : existing.adapterType;
    let requestedRuntimeConfig: Record<string, unknown> | null = null;
    if (hasOwn(patchData, "runtimeConfig")) {
      const runtimeConfig = asRecord(patchData.runtimeConfig);
      if (!runtimeConfig) {
        res.status(422).json({ error: "runtimeConfig must be an object" });
        return;
      }
      // OBS-2: the daily token ceiling is a safety bound with the same
      // authority as the dedicated /token-ceiling route — a human with
      // agent-configuration authority (or the mk steward). An agent key must
      // not move it, including by omission: this PATCH replaces runtimeConfig
      // wholesale, so dropping `heartbeat.maxDailyTokens` here would reset a
      // steward-set ceiling to the default. Compared on the resolved value so
      // an unchanged ceiling (or an equivalent spelling of it) still passes.
      // Self-edits of runtimeConfig are already refused by the
      // AGENT_SELF_PATCHABLE_FIELDS allowlist above; this guard is what stops
      // an agent authority (CEO, agents:create holder) moving another agent's
      // ceiling.
      if (updateAuthority === "agent") {
        const before = resolveMaxDailyTokens(existing.runtimeConfig).ceiling;
        const after = resolveMaxDailyTokens(runtimeConfig).ceiling;
        if (before !== after) {
          res.status(403).json({
            error:
              "Only a human with agent-configuration authority may change runtimeConfig.heartbeat.maxDailyTokens; " +
              "ask an owner, admin or operator — or use PATCH /api/agents/:id/token-ceiling",
          });
          return;
        }
      }
      await assertNoAgentRuntimeConfigAdapterConfigMutation(req, existing.companyId, runtimeConfig);
      assertNoAgentRecoveryBudgetMutation(req, existing.runtimeConfig, runtimeConfig);
      requestedRuntimeConfig = runtimeConfig;
    }
    // AgentDash (security, #719): changing the binary, argv, env or cwd is
    // instance-admin only. Compared against the STORED row, so an edit form
    // that resends unchanged values (or the curated Hermes preset) passes.
    assertHostExecutionConfigAllowed(req.actor, [
      ...(hasOwn(patchData, "adapterConfig")
        ? [{
            adapterType: requestedAdapterType,
            adapterConfig: patchData.adapterConfig,
            stored: existing.adapterConfig,
          }]
        : []),
      ...runtimeConfigHostExecutionInputs(requestedAdapterType, requestedRuntimeConfig, existing.runtimeConfig),
    ], hostExecutionContextForCompany(existing.companyId, { agentId: existing.id }));
    const touchesAdapterConfiguration =
      hasOwn(patchData, "adapterType") ||
      hasOwn(patchData, "adapterConfig");
    if (touchesAdapterConfiguration) {
      // AGE-113: only a human with agent-configuration authority may change an
      // agent's adapter or model — not the agent itself, and not another agent
      // (including a CEO agent). Board actors pass; `authority === "agent"`
      // means an agent key got this far, and it stops here.
      if (updateAuthority === "agent") {
        res.status(403).json({
          error: "Only a human with agent-configuration authority may change an agent's adapterType or adapterConfig; ask an owner, admin or operator",
        });
        return;
      }
      const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
      const changingAdapterType =
        typeof patchData.adapterType === "string" && patchData.adapterType !== existing.adapterType;
      const requestedAdapterConfig = hasOwn(patchData, "adapterConfig")
        ? (asRecord(patchData.adapterConfig) ?? {})
        : null;
      if (
        requestedAdapterConfig
        && replaceAdapterConfig
        && KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) =>
          existingAdapterConfig[key] !== undefined && requestedAdapterConfig[key] === undefined,
        )
      ) {
        await assertCanManageInstructionsLocation(req, existing);
      }
      let rawEffectiveAdapterConfig = requestedAdapterConfig ?? existingAdapterConfig;
      if (requestedAdapterConfig && !changingAdapterType && !replaceAdapterConfig) {
        rawEffectiveAdapterConfig = { ...existingAdapterConfig, ...requestedAdapterConfig };
      }
      if (changingAdapterType) {
        // Preserve adapter-agnostic keys (env, cwd, etc.) from the existing config
        // when the adapter type changes. Without this, a PATCH that includes
        // adapterConfig but omits these keys would silently drop them.
        const ADAPTER_AGNOSTIC_KEYS = [
          "env", "cwd", "timeoutSec", "graceSec",
          "promptTemplate", "bootstrapPromptTemplate",
        ] as const;
        for (const key of ADAPTER_AGNOSTIC_KEYS) {
          if (rawEffectiveAdapterConfig[key] === undefined && existingAdapterConfig[key] !== undefined) {
            rawEffectiveAdapterConfig = { ...rawEffectiveAdapterConfig, [key]: existingAdapterConfig[key] };
          }
        }
        rawEffectiveAdapterConfig = preserveInstructionsBundleConfig(
          existingAdapterConfig,
          rawEffectiveAdapterConfig,
        );
      }
      // AgentDash (review-1028, item 5): a PATCH that leaves the model alone
      // must not move an existing model-less agent onto a tier — an empty
      // model there means "Hermes' own configured default", not a gap to
      // fill. The tier default only applies when the adapter type changes
      // TO hermes_local or the request explicitly clears the model.
      const modelExplicitlyCleared =
        requestedAdapterConfig !== null
        && Object.prototype.hasOwnProperty.call(requestedAdapterConfig, "model")
        && !asNonEmptyString(requestedAdapterConfig.model);
      const applyModelTier =
        (changingAdapterType && requestedAdapterType === HERMES_LOCAL_ADAPTER_TYPE)
        || modelExplicitlyCleared;
      const {
        adapterConfig: effectiveAdapterConfig,
        appliedModelTier,
      } = applyCreateDefaultsByAdapterType(
        requestedAdapterType,
        rawEffectiveAdapterConfig,
        {
          role: typeof patchData.role === "string" ? patchData.role : existing.role,
          title: typeof patchData.title === "string" ? patchData.title : existing.title,
          applyModelTier,
        },
      );
      const normalizedEffectiveAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
        companyId: existing.companyId,
        adapterType: requestedAdapterType,
        adapterConfig: effectiveAdapterConfig,
      });
      patchData.adapterConfig = syncInstructionsBundleConfigFromFilePath(existing, normalizedEffectiveAdapterConfig);
      // AgentDash (c4-model-tiers): keep the recorded tier truthful on every
      // adapter-config touch — set on a materialized tier default, refreshed
      // when the model still is a tier model, and cleared when the operator
      // picks a custom model or switches away from hermes_local. With the
      // tiers switched off the inference is skipped too: a model id matching
      // a shipped tier is then a person's explicit choice, not a managed
      // default.
      const tiersActive = hermesModelTiersActive();
      const persistedModelTier =
        requestedAdapterType === HERMES_LOCAL_ADAPTER_TYPE && tiersActive
          ? appliedModelTier
            ?? hermesModelTierForModel(asNonEmptyString(normalizedEffectiveAdapterConfig.model))
          : null;
      // AgentDash (review-1028 follow-up): on a tiers-off box the stamp is
      // provenance, not a live flag — a PATCH that leaves the adapter type
      // and model alone (a timeoutSec edit, say) must not erase it. The
      // clears that already fire under tiers stay: a custom or cleared
      // model, and any adapterType switch.
      const keepRecordedModelTier =
        !tiersActive
        && requestedAdapterType === HERMES_LOCAL_ADAPTER_TYPE
        && !changingAdapterType
        && asNonEmptyString(normalizedEffectiveAdapterConfig.model)
          === asNonEmptyString(existingAdapterConfig.model);
      const metadataPatch: Record<string, unknown> = {
        ...(asRecord(existing.metadata) ?? {}),
        ...(asRecord(patchData.metadata) ?? {}),
      };
      if (persistedModelTier) {
        metadataPatch[AGENT_MODEL_TIER_METADATA_KEY] = persistedModelTier;
      } else if (!keepRecordedModelTier) {
        delete metadataPatch[AGENT_MODEL_TIER_METADATA_KEY];
      }
      patchData.metadata = metadataPatch;
    }
    if (requestedRuntimeConfig) {
      const baseAdapterConfig = asRecord(patchData.adapterConfig) ?? asRecord(existing.adapterConfig) ?? {};
      patchData.runtimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
        existing.companyId,
        requestedAdapterType,
        requestedRuntimeConfig,
        baseAdapterConfig,
      );
    }
    let hermesSshPin: { environmentId: string; sshTarget: string; port: number } | null = null;
    if (touchesAdapterConfiguration || Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")) {
      hermesSshPin = await assertAgentDefaultEnvironmentSelection(
        existing.companyId,
        Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")
          ? (typeof patchData.defaultEnvironmentId === "string" ? patchData.defaultEnvironmentId : null)
          : existing.defaultEnvironmentId,
        {
          allowedDrivers: allowedEnvironmentDriversForAgent(requestedAdapterType),
          allowedSandboxProviders: allowedSandboxProvidersForAgent(requestedAdapterType),
          adapterType: requestedAdapterType,
          req,
        },
      );
    }

    assertNoAgentWakePolicyMutation(req, existing, {
      runtimeConfig: hasOwn(patchData, "runtimeConfig") ? patchData.runtimeConfig : existing.runtimeConfig,
      metadata: hasOwn(patchData, "metadata") ? patchData.metadata : existing.metadata,
    });
    const actor = getActorInfo(req);
    const writePatch = async (executor: Db, locked = false) => {
      const writer = locked ? agentService(executor, { environmentLockHeld: true }) : svc;
      if (locked) {
        const latest = await writer.getById(id);
        if (!latest) return null;
        const adapterType = typeof patchData.adapterType === "string" ? patchData.adapterType : latest.adapterType;
        hermesSshPin = await assertAgentDefaultEnvironmentSelection(latest.companyId,
          hasOwn(patchData, "defaultEnvironmentId") ? (typeof patchData.defaultEnvironmentId === "string" ? patchData.defaultEnvironmentId : null) : latest.defaultEnvironmentId, {
            allowedDrivers: allowedEnvironmentDriversForAgent(adapterType),
            allowedSandboxProviders: allowedSandboxProvidersForAgent(adapterType),
            adapterType, req, executor,
          });
      }
      return writer.update(id, patchData, {
        recordRevision: { createdByAgentId: actor.agentId, createdByUserId: actor.actorType === "user" ? actor.actorId : null, source: "patch" },
      });
    };
    const agent = hasOwn(patchData, "adapterType") || hasOwn(patchData, "defaultEnvironmentId") || (touchesAdapterConfiguration && requestedAdapterType === "hermes_local" && existing.defaultEnvironmentId)
      ? await withHermesSshCompanyLock(db, existing.companyId, tx => writePatch(tx, true))
      : await writePatch(db);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await refusePendingRunsIfWakePolicyTurnedOn(existing, agent);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: summarizeAgentUpdateDetails(patchData),
    });
    // Audit only a new pin: a fresh environment, or an agent newly switched to hermes.
    if (
      (hasOwn(patchData, "defaultEnvironmentId") && patchData.defaultEnvironmentId !== existing.defaultEnvironmentId) ||
      requestedAdapterType !== existing.adapterType
    ) {
      await logHermesSshEnvironmentPin(req, agent, hermesSshPin);
    }

    // A second, specific entry when accountability moved.
    //
    // `agent.updated` records that a field changed; it does not answer "who was
    // answerable for this agent in March", which is the question an audit
    // actually asks. Recorded separately so it can be found without reading
    // every update to the agent.
    if (hasOwn(patchData, "autonomy") || hasOwn(patchData, "accountableUserId")) {
      await recordAccountabilityChange(db, req, existing, agent);
    }

    res.json(await agentForReader(req, agent));
  });

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.pause(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(await agentForReader(req, agent));
  });

  router.post("/agents/:id/resume", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(await agentForReader(req, agent));
  });

  router.post("/agents/:id/approve", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.status !== "pending_approval") {
      res.status(409).json({ error: "Only pending approval agents can be approved" });
      return;
    }
    const approval = await svc.activatePendingApproval(id);
    if (!approval) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (!approval.activated) {
      res.status(409).json({ error: "Only pending approval agents can be approved" });
      return;
    }
    const { agent } = approval;

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.approved",
      entityType: "agent",
      entityId: agent.id,
      details: { source: "agent_detail" },
    });

    // AgentDash: approving the agent IS the answer to its hire request, so the
    // linked `hire_agent` approval is decided too. Left pending it stayed an
    // open decision in every inbox — and rejecting it later terminated the
    // agent this call just activated. The agent is already activated when this
    // runs, so a failure here is logged rather than turned into an error.
    const decidedByUserId = req.actor.userId ?? "board";
    const decisionNote = "Approved from the agent page";
    try {
      const linked = await approvalsSvc.listPendingHireApprovalsForAgent(agent.companyId, agent.id);
      for (const pending of linked) {
        // Recorded under the same authority rules as any other decision. In
        // `agentdash_mk` an agent-requested hire belongs to that agent's
        // steward; an administrator who is not the decider has bypassed them,
        // which is exactly an emergency override and is recorded as one, with
        // a reason. Default-profile companies keep the `board` role.
        const role = await resolveAgentPageDecisionRole(pending, req.actor);
        const overrideReason =
          role === "owner_override" ? "Activated from the agent page" : undefined;
        const resolved = await approvalsSvc.approve(pending.id, decidedByUserId, decisionNote, {
          revision: pending.revision,
          channel: "web",
          actorRole: role,
          ...(overrideReason ? { overrideReason } : {}),
        });
        if (resolved.applied && role === "owner_override") {
          await logActivity(db, {
            companyId: agent.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.emergency_override",
            entityType: "approval",
            entityId: pending.id,
            details: {
              type: pending.type,
              decision: "approved",
              overrideReason,
              channel: "web",
              revision: pending.revision,
              requestedByAgentId: pending.requestedByAgentId,
              source: "agent_detail",
            },
          });
        }
        // No requester wake: activating from the agent page never woke the
        // requesting agent, and recording the decision must not start a full
        // agent run that the person who activated it did not ask for.
        await getDecisionEffects().afterApprove(resolved.approval, resolved.applied, {
          actorUserId: decidedByUserId,
          decisionNote,
          wakeRequester: false,
        });
      }
    } catch (err) {
      logger.error(
        { err, agentId: agent.id, companyId: agent.companyId },
        "agent approved but its hire approval could not be resolved; it may still show as pending",
      );
    }

    res.json(await agentForReader(req, agent));
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.terminate(id, { endedByUserId: req.actor.userId ?? null });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(await agentForReader(req, agent));
  });

  router.delete("/agents/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.remove(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.deleted",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json({ ok: true });
  });

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }
    const keys = await svc.listKeys(id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }
    // A key is for a person to run this agent from their own terminal, which is
    // exactly what an autonomous agent does not have.
    assertAgentMayHoldKey(agent);
    const key = await svc.createApiKey(id, req.body.name, {
      source: "manual",
      createdByUserId: req.actor.userId ?? null,
    });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.key_created",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    res.status(201).json(key);
  });

  /**
   * Mint a short, single-use code that pairs one machine with this agent.
   *
   * This is the thing a steward hands to a colleague instead of a raw agent
   * key. Authorized as configuration authority over THIS agent: an
   * administrator with `agents:create`, or — in `agentdash_mk` companies — the
   * agent's active steward, or its creator while it has no other steward. It
   * used to require `agents:create`
   * outright, which is the company-wide agent-administrator predicate, so a
   * member could not connect their own terminal to the agent they steward
   * (the My Agent page offers exactly that) without being made an
   * administrator of every agent. A code only lets someone run the agent they
   * already answer for: redemption mints a key scoped to this agent and
   * enrolls an endpoint under the redeeming user.
   *
   * Deliberately NOT widened to the key list/revoke, pause or resume routes;
   * those still require `agents:create`.
   *
   * Any unredeemed codes for this agent are revoked first. Two live codes for
   * one agent means a screen showing a stale one still works, which is exactly
   * the confusion this flow exists to remove.
   */
  router.post("/agents/:id/connect-codes", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const authority = await requireAgentConfigurationAuthority(req, agent);
    if (authority === "steward") {
      // The steward tier covers the active steward AND the agent's creator.
      // For configuration that is fine; here it is not. A code mints a live key
      // for this agent, so a creator whose agent was handed to someone else
      // must not keep a way to run it — a transfer is how an administrator
      // takes an agent away. The creator qualifies only while nobody stewards
      // the agent.
      const active = await stewardships.activeByAgent(agent.companyId, agent.id);
      if (active && active.userId !== req.actor.userId) {
        throw forbidden(
          "This agent has another steward. Only its steward or an administrator can connect a terminal to it.",
        );
      }
      // AgentDash: a release takes an agent away just as a transfer does, it
      // only leaves nobody in the seat. So the creator's fallback applies to
      // an agent that has never been stewarded; once any pairing has existed
      // and ended, only a current steward or an administrator can mint.
      if (!active) {
        const history = await stewardships.historyForAgent(agent.companyId, agent.id);
        if (history.length > 0) {
          throw forbidden(
            "This agent's stewardship was released. Only a current steward or an administrator can connect a terminal to it.",
          );
        }
      }
    }

    if (agent.status === "terminated" || agent.status === "pending_approval") {
      res.status(409).json({ error: "This agent cannot be connected to yet." });
      return;
    }

    // Same rule as minting a key, because redeeming this code mints one.
    assertAgentMayHoldKey(agent);

    const now = new Date();
    await db
      .update(agentConnectCodes)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(agentConnectCodes.agentId, agent.id),
          isNull(agentConnectCodes.redeemedAt),
          isNull(agentConnectCodes.revokedAt),
        ),
      );

    // Retry on hash collision the way invite tokens do. It will not happen;
    // silently handing back a code that belongs to another agent, if it ever
    // did, would be a cross-tenant credential leak.
    let code: string | null = null;
    let expiresAt: Date | null = null;
    for (let attempt = 0; attempt < CONNECT_CODE_MAX_RETRIES; attempt += 1) {
      const candidate = createConnectCode();
      const candidateExpiry = new Date(Date.now() + CONNECT_CODE_TTL_MS);
      try {
        await db.insert(agentConnectCodes).values({
          companyId: agent.companyId,
          agentId: agent.id,
          codeHash: hashConnectCode(candidate),
          expiresAt: candidateExpiry,
          createdByUserId: req.actor.userId ?? null,
        });
        code = candidate;
        expiresAt = candidateExpiry;
        break;
      } catch (err) {
        if (!isConnectCodeHashCollisionError(err)) throw err;
      }
    }

    if (!code || !expiresAt) {
      res.status(500).json({ error: "Could not create a connect code. Try again." });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.connect_code_created",
      entityType: "agent",
      entityId: agent.id,
      details: { expiresAt: expiresAt.toISOString() },
    });

    res.status(201).json({
      code: formatConnectCode(code),
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: Math.round(CONNECT_CODE_TTL_MS / 1000),
    });
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const keyId = req.params.keyId as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }

    const key = await svc.getKeyById(keyId);
    if (!key || key.agentId !== agent.id) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    const revoked = await svc.revokeKey(agent.id, keyId);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.key_revoked",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    res.json({ ok: true });
  });

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== id) {
        res.status(403).json({ error: "Agent can only invoke itself" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }

    assertAgentHarnessPreflightReadyForLaunch(agent);

    // AgentDash (GH #745 review): an assistant nudge is a PAID run — the
    // tool sends a deterministic idempotencyKey, and a retry inside the
    // same bucket must replay the wake that already landed rather than
    // spend a second one. Scoped to assistant-grant writes so the field's
    // record-only semantics are unchanged for every other caller; mirrors
    // the run-liveness continuation dedup (queued/deferred/completed).
    const wakeupIdempotencyKey =
      typeof req.body.idempotencyKey === "string" && req.body.idempotencyKey.trim().length > 0
        ? req.body.idempotencyKey.trim()
        : null;
    if (req.actor.source === "assistant_grant" && wakeupIdempotencyKey) {
      const existingWake = await db
        .select({
          id: agentWakeupRequests.id,
          status: agentWakeupRequests.status,
          runId: agentWakeupRequests.runId,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, agent.companyId),
            eq(agentWakeupRequests.agentId, agent.id),
            eq(agentWakeupRequests.idempotencyKey, wakeupIdempotencyKey),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "completed", "skipped"]),
          ),
        )
        .orderBy(desc(agentWakeupRequests.requestedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingWake) {
        res.status(200).json({
          replayed: true,
          status: existingWake.status,
          runId: existingWake.runId,
          wakeupRequestId: existingWake.id,
        });
        return;
      }
    }

    const run = await heartbeat.wakeup(id, {
      source: req.body.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot: {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
        forceFreshSession: req.body.forceFreshSession === true,
      },
    });

    if (!run) {
      res.status(202).json(await buildSkippedWakeupResponse(agent, req.body.payload ?? null));
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      // AgentDash (GH #678): provenance when the write came via an assistant grant.
      details: { agentId: id, ...assistantGrantAttribution(req) },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/heartbeat/invoke", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== id) {
        res.status(403).json({ error: "Agent can only invoke itself" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }

    assertAgentHarnessPreflightReadyForLaunch(agent);

    const run = await heartbeat.invoke(
      id,
      "on_demand",
      {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
      },
      "manual",
      {
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      },
    );

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      // AgentDash (GH #678): provenance when the write came via an assistant grant.
      details: { agentId: id, ...assistantGrantAttribution(req) },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);
    if (agent.adapterType !== "claude_local") {
      res.status(400).json({ error: "Login is only supported for claude_local agents" });
      return;
    }

    const config = asRecord(agent.adapterConfig) ?? {};
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(agent.companyId, config);
    const result = await runClaudeLogin({
      runId: `claude-login-${randomUUID()}`,
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      },
      config: runtimeConfig,
    });

    res.json(result);
  });

  router.get("/companies/:companyId/heartbeat-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
    // Honor offset pagination: previously this parameter was accepted but
    // ignored, so pages beyond the first silently repeated page one.
    const offsetParam = req.query.offset as string | undefined;
    const parsedOffset = offsetParam !== undefined && /^\d+$/.test(offsetParam) ? Number.parseInt(offsetParam, 10) : null;
    if (offsetParam !== undefined && (parsedOffset === null || !Number.isInteger(parsedOffset) || parsedOffset < 0)) {
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }
    await resolveAgentVisibility(db, req, companyId);
    const runs = await heartbeat.list(companyId, agentId, limit, parsedOffset ?? 0, {
      visibleWhere: and(
        runVisibilityCondition(req, companyId),
        agentVisibilityCondition(req, companyId, heartbeatRuns.agentId),
      ),
    });
    res.json(runs);
  });

  router.get("/companies/:companyId/live-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // `minCount` is a padding floor for callers that want a minimum number of
    // recent runs to render (e.g. dashboard cards). It must default to 0 so
    // callers asking for "live runs" get only actually-live runs — otherwise
    // every caller with no minCount param gets up to 50 historical runs
    // padded in and renders bogus "live" counts.
    const minCount = readLiveRunsQueryInt(req.query.minCount, 50, 0);
    // A5 (GH #830): runs on an issue in a restricted project are absent.
    await resolveAgentVisibility(db, req, companyId);
    const runsVisibleWhere = and(
      runVisibilityCondition(req, companyId),
      agentVisibilityCondition(req, companyId, heartbeatRuns.agentId),
    );
    const limit = readLiveRunsQueryInt(req.query.limit, 50, 50);

    const columns = {
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
      contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      agentId: heartbeatRuns.agentId,
      agentName: agentsTable.name,
      adapterType: agentsTable.adapterType,
      logBytes: heartbeatRuns.logBytes,
      livenessState: heartbeatRuns.livenessState,
      livenessReason: heartbeatRuns.livenessReason,
      continuationAttempt: heartbeatRuns.continuationAttempt,
      lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      nextAction: heartbeatRuns.nextAction,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastOutputSeq: heartbeatRuns.lastOutputSeq,
      lastOutputStream: heartbeatRuns.lastOutputStream,
      lastOutputBytes: heartbeatRuns.lastOutputBytes,
      processStartedAt: heartbeatRuns.processStartedAt,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRunsQuery = db
      .select(columns)
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          ...(runsVisibleWhere ? [runsVisibleWhere] : []),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const liveRuns = await liveRunsQuery.limit(limit);
    const targetRunCount = Math.min(minCount, limit);

    if (targetRunCount > 0 && liveRuns.length < targetRunCount) {
      const activeIds = liveRuns.map((r) => r.id);
      const recentRuns = await db
        .select(columns)
        .from(heartbeatRuns)
        .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            not(inArray(heartbeatRuns.status, ["queued", "running"])),
            ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
            ...(runsVisibleWhere ? [runsVisibleWhere] : []),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(targetRunCount - liveRuns.length);

      const rows = [...liveRuns, ...recentRuns];
      res.json(await Promise.all(rows.map(async (run) => redactRunLogValue({
        ...run,
        outputSilence: await heartbeat.buildRunOutputSilence(run),
      }))));
      return;
    }

    res.json(await Promise.all(liveRuns.map(async (run) => redactRunLogValue({
      ...run,
      outputSilence: await heartbeat.buildRunOutputSilence(run),
    }))));
  });

  router.get("/heartbeat-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const retryExhaustedReason = await heartbeat.getRetryExhaustedReason(runId);
    // AgentDash (GH #992): the run row carries `error`, `resultJson` and the
    // excerpts — provider 401s can echo credentials into all of them.
    res.json(
      redactRunLogValue(redactCurrentUserValue(
        { ...run, retryExhaustedReason, outputSilence: await heartbeat.buildRunOutputSilence(run) },
        await getCurrentUserRedactionOptions(),
      )),
    );
  });

  router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const existing = await heartbeat.getRun(runId);
    if (existing) {
      assertCompanyAccess(req, existing.companyId);
    }
    const run = await heartbeat.cancelRun(runId, RUN_CANCELLED_BY_OPERATOR_MESSAGE, RUN_CANCELLED_BY_OPERATOR_CODE);

    if (run) {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    // AgentDash (GH #992): the cancelled row is served straight back; its
    // `error`/`resultJson`/`contextSnapshot` go through the same serve-time
    // pass as the detail route.
    res.json(redactRunLogValue(run));
  });

  router.post("/heartbeat-runs/:runId/watchdog-decisions", async (req, res) => {
    const runId = req.params.runId as string;
    const existing = await heartbeat.getRun(runId);
    if (!existing) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const decision = typeof req.body?.decision === "string" ? req.body.decision : "";
    if (!["snooze", "continue", "dismissed_false_positive"].includes(decision)) {
      res.status(400).json({ error: "Unsupported watchdog decision" });
      return;
    }
    const evaluationIssueId = typeof req.body?.evaluationIssueId === "string" ? req.body.evaluationIssueId : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 4000) : null;
    const snoozedUntil = decision === "snooze"
      ? new Date(String(req.body?.snoozedUntil ?? ""))
      : null;
    if (decision === "snooze" && (!snoozedUntil || Number.isNaN(snoozedUntil.getTime()) || snoozedUntil <= new Date())) {
      res.status(400).json({ error: "snoozedUntil must be a future ISO datetime" });
      return;
    }

    const row = await recovery.recordWatchdogDecision({
      runId: existing.id,
      actor: req.actor,
      decision: decision as "snooze" | "continue" | "dismissed_false_positive",
      evaluationIssueId,
      reason,
      snoozedUntil,
      createdByRunId: req.actor.runId ?? null,
    });

    res.json(row);
  });

  router.get("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const afterSeq = Number(req.query.afterSeq ?? 0);
    const limit = Number(req.query.limit ?? 200);
    const events = await heartbeat.listEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const redactedEvents = events.map((event) =>
      redactCurrentUserValue({
        ...event,
        payload: redactEventPayload(event.payload),
      }, currentUserRedactionOptions),
    );
    res.json(redactedEvents);
  });

  router.get("/heartbeat-runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRunLogAccess(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = readRunLogLimitBytes(req.query.limitBytes);
    // AgentDash: stop the serve-time redaction pass if the client disconnects
    // before the response is written.
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.on("close", onClose);
    let result: Awaited<ReturnType<typeof heartbeat.readLog>>;
    try {
      result = await heartbeat.readLog(run, {
        offset: Number.isFinite(offset) ? offset : 0,
        limitBytes,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      throw err;
    } finally {
      res.off("close", onClose);
    }

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/workspace-operations", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const context = asRecord(run.contextSnapshot);
    const executionWorkspaceId = asNonEmptyString(context?.executionWorkspaceId);
    const operations = await filterVisibleWorkspaceOperations(db, req, run.companyId, await workspaceOperations.listForRun(runId, executionWorkspaceId));
    res.json(redactCurrentUserValue(operations, await getCurrentUserRedactionOptions()));
  });

  router.get("/workspace-operations/:operationId/log", async (req, res) => {
    const operationId = req.params.operationId as string;
    const operation = await workspaceOperations.getById(operationId);
    if (!operation) {
      res.status(404).json({ error: "Workspace operation not found" });
      return;
    }
    assertCompanyAccess(req, operation.companyId);
    await assertWorkspaceOperationVisible(db, req, operation);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = readRunLogLimitBytes(req.query.limitBytes);
    const result = await workspaceOperations.readLog(operationId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/issues/:issueId/live-runs", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const liveRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
        contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        adapterType: agentsTable.adapterType,
        logBytes: heartbeatRuns.logBytes,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
        continuationAttempt: heartbeatRuns.continuationAttempt,
        lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
        nextAction: heartbeatRuns.nextAction,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        lastOutputSeq: heartbeatRuns.lastOutputSeq,
        lastOutputStream: heartbeatRuns.lastOutputStream,
        lastOutputBytes: heartbeatRuns.lastOutputBytes,
        processStartedAt: heartbeatRuns.processStartedAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    res.json(await Promise.all(liveRuns.map(async (run) => redactRunLogValue({
      ...run,
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    }))));
  });

  router.get("/issues/:issueId/active-run", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    let run = issue.executionRunId ? await heartbeat.getRunIssueSummary(issue.executionRunId) : null;
    if (
      run &&
      (
        (run.status !== "queued" && run.status !== "running") ||
        run.issueId !== issue.id
      )
    ) {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunIssueSummaryForAgent(issue.assigneeAgentId);
      const candidateIssueId = asNonEmptyString(candidateRun?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) {
      res.json(null);
      return;
    }

    const agent = await svc.getById(run.agentId);
    if (!agent) {
      res.json(null);
      return;
    }

    res.json(redactRunLogValue({
      ...run,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    }));
  });

  return router;
}
