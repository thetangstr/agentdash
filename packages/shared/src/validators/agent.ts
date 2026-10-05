import { workforceTemplateIdSchema } from "./workforce.js";
import { z } from "zod";
import {
  AGENT_AUTONOMY_KINDS,
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  AGENT_VISIBILITIES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envConfigSchema } from "./secret.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
});

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const adapterConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgentAdapterAliases(value: unknown) {
  if (!isPlainRecord(value)) return value;
  const normalized = { ...value };
  if (normalized.adapterType === undefined && typeof normalized.type === "string") {
    normalized.adapterType = normalized.type;
  }
  if (normalized.adapterConfig === undefined && isPlainRecord(normalized.config)) {
    normalized.adapterConfig = normalized.config;
  }
  return normalized;
}

export const createAgentInstructionsBundleSchema = z.object({
  entryFile: z.string().trim().min(1).optional(),
  files: z.record(z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "instructionsBundle.files must contain at least one file",
  }),
});

const agentModelProfileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  adapterConfig: adapterConfigSchema,
}).strict();

/**
 * AgentDash (recovery budget remediation): per-agent overrides for the
 * automatic-recovery budget (server/src/services/task-recovery-budget.ts).
 * Every field is optional; an absent field keeps the server default. The
 * budget binds automatic retries only, so these numbers bound what the
 * control plane may spend retrying on its own, not what a task may spend.
 */
/**
 * Sanity ceilings on those overrides. They are not recommended values: they
 * stop a typo or a runaway write from turning the guard off. Overrides are
 * board-only (agent-authored hires and creates may not carry them); a value
 * above a ceiling fails validation, and the heartbeat ignores an invalid
 * stored override and uses the defaults.
 */
export const AGENT_RECOVERY_BUDGET_MAXIMUMS = {
  automaticRetries: 10,
  providerTurns: 500,
  providerTokens: 50_000_000,
  providerCostUsd: 100,
  runtimeMs: 24 * 60 * 60 * 1_000,
} as const;

export const agentRecoveryBudgetConfigSchema = z.object({
  automaticRetries: z.number().int().nonnegative().max(AGENT_RECOVERY_BUDGET_MAXIMUMS.automaticRetries).optional(),
  providerTurns: z.number().int().positive().max(AGENT_RECOVERY_BUDGET_MAXIMUMS.providerTurns).optional(),
  providerTokens: z.number().int().positive().max(AGENT_RECOVERY_BUDGET_MAXIMUMS.providerTokens).optional(),
  providerCostUsd: z.number().positive().finite().max(AGENT_RECOVERY_BUDGET_MAXIMUMS.providerCostUsd).optional(),
  runtimeMs: z.number().int().positive().max(AGENT_RECOVERY_BUDGET_MAXIMUMS.runtimeMs).optional(),
}).strict();

export type AgentRecoveryBudgetConfig = z.infer<typeof agentRecoveryBudgetConfigSchema>;

export const agentRuntimeConfigSchema = z.object({
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
  heartbeat: z.object({
    // OBS-2: `0`/`null` disables the daily ceiling; absent applies the default.
    maxDailyTokens: z.number().int().nonnegative().nullable().optional(),
  }).catchall(z.unknown()).optional(),
  recoveryBudget: agentRecoveryBudgetConfigSchema.optional(),
}).catchall(z.unknown());

const createAgentBaseSchema = z.object({
  workforceTemplateId: workforceTemplateIdSchema.optional(),
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(z.string().min(1)).optional(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional().default({}),
  instructionsBundle: createAgentInstructionsBundleSchema.optional(),
  runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
  defaultEnvironmentId: z.string().uuid().optional().nullable(),
  /**
   * Run the adapter's ENVIRONMENT preflight before creating the agent.
   *
   * Stays opt-in, deliberately. Defaulting it on looks right and is not:
   * preflight probes the machine, and "the claude binary is not on this host"
   * is a legitimate state at creation time — you configure an agent before
   * installing its harness, or the harness lives on a different machine
   * entirely. Turning it on by default broke twenty tests that assert exactly
   * those flows, which is the product telling you the default is wrong.
   *
   * Environment readiness and configuration completeness are different
   * questions. A missing `command` on a process agent is not an environment
   * condition that might resolve later — it is an agent that can never run, and
   * that is enforced unconditionally by the refinement below.
   */
  requireHarnessPreflight: z.boolean().optional().default(false),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
  /**
   * Which kind of agent this is. Absent means `stewarded`, so every existing
   * caller keeps creating personal agents without changing a line.
   */
  autonomy: z.enum(AGENT_AUTONOMY_KINDS).optional(),
  /**
   * The human answerable for an autonomous agent.
   *
   * Optional here and defaulted server-side to the person creating the agent,
   * because "you are accountable for what you set running" is the right default
   * and refusing the request over a field the caller did not know about is not.
   * Meaningless for a stewarded agent, where the steward is the answer; the
   * route rejects sending it there rather than storing something that could
   * later disagree with the stewardship.
   */
  accountableUserId: z.string().trim().min(1).optional().nullable(),
});


/**
 * Configuration completeness, checked on every creation path.
 *
 * Distinct from the environment preflight above: this asks "could this agent
 * ever run", not "can it run on this machine right now". A process agent with
 * no command is the former. It used to be accepted, and then failed every
 * heartbeat forever with "Process adapter missing command" — visible only in
 * the server log, never to the person who created it. The adapter's own
 * testEnvironment already flagged it; nothing ran that check by default.
 *
 * Exposed as a plain predicate so a non-zod caller — the assistant hire path,
 * which resolves its own fields rather than parsing a create body — runs the
 * SAME check the schema does instead of a lookalike.
 */
export function agentAdapterConfigCompletenessError(input: {
  adapterType?: unknown;
  adapterConfig?: unknown;
}): string | null {
  if (input.adapterType !== "process") return null;
  const config = isPlainRecord(input.adapterConfig) ? input.adapterConfig : {};
  const command = typeof config.command === "string" ? config.command.trim() : "";
  if (command) return null;
  return (
    "A process agent needs adapterConfig.command — without it every run fails. "
    + "Set the command to execute, or create the agent with a different adapter."
  );
}

function assertAdapterConfigComplete(value: unknown, ctx: z.RefinementCtx): void {
  if (!isPlainRecord(value)) return;
  const message = agentAdapterConfigCompletenessError(value);
  if (!message) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["adapterConfig", "command"] });
}

export const createAgentSchema = z.preprocess(normalizeAgentAdapterAliases, createAgentBaseSchema)
  .superRefine(assertAdapterConfigComplete);

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = z.preprocess(normalizeAgentAdapterAliases, createAgentBaseSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
})).superRefine(assertAdapterConfigComplete);

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = z.preprocess(normalizeAgentAdapterAliases, createAgentBaseSchema
  .omit({ permissions: true, workforceTemplateId: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    workforceTemplateId: z.never().optional(),
    /*
     * Stewardship is not settable here, and these two exist only so the route
     * can say so.
     *
     * `validate()` does `req.body = schema.parse(req.body)`, and a zod object
     * strips keys it does not declare -- so an undeclared `steward` vanished
     * before the handler ran and the request answered 200 having changed
     * nothing. Declaring them as `unknown` lets them survive parsing so
     * `PATCH /agents/:id` can return a 422 naming the real endpoint, the same
     * way it already does for `permissions`.
     */
    steward: z.unknown().optional(),
    stewardUserId: z.unknown().optional(),
    /*
     * Same refusal-on-sight as `steward` above (GH #734). Skill assignment is
     * not a column: it lives inside adapterConfig and is written, validated
     * against the company catalogue and pushed to the agent's runtime by
     * `POST /agents/:id/skills/sync`. The generic update used to accept the
     * field and silently drop it — a 200 that changed nothing. Declared as
     * `unknown` so it survives parsing and the route can name the real
     * endpoint, and so a peer-agent PATCH is still refused by the peer
     * allowlist before reaching that message.
     */
    desiredSkills: z.unknown().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    /** Agent visibility (2026-09-30): null inherits the company default. Administrators only; the route enforces it. */
    visibility: z.enum(AGENT_VISIBILITIES).nullable().optional(),
  }));

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
  /**
   * Optional environment to run the adapter test inside. When omitted, the
   * test runs against the local Paperclip host. When provided and the
   * environment is non-local (SSH/sandbox), the test probes are executed
   * inside that environment so the result reflects real agent execution.
   */
  environmentId: z.string().uuid().optional().nullable(),
  /**
   * AgentDash (security): the agent being edited, when the test runs from an
   * edit form. The server compares host-execution fields (command, args, env,
   * cwd) against that agent's STORED config, so resending unchanged values does
   * not require instance admin.
   */
  agentId: z.string().uuid().optional().nullable(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

/**
 * AgentDash (OBS-2 / GH #695): raise or clear the per-agent daily token
 * ceiling. `0` and `null` both disable; absent is not a valid body — turning
 * the ceiling off has to be said out loud.
 */
export const updateAgentTokenCeilingSchema = z.object({
  maxDailyTokens: z.number().int().nonnegative().nullable(),
});

export type UpdateAgentTokenCeiling = z.infer<typeof updateAgentTokenCeilingSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canAssignTasks: z.boolean(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
