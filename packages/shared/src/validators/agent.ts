import { z } from "zod";
import {
  AGENT_AUTONOMY_KINDS,
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
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

export const agentRuntimeConfigSchema = z.object({
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
}).catchall(z.unknown());

const createAgentBaseSchema = z.object({
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
 */
function assertAdapterConfigComplete(value: unknown, ctx: z.RefinementCtx): void {
  if (!isPlainRecord(value)) return;
  if (value.adapterType !== "process") return;
  const config = isPlainRecord(value.adapterConfig) ? value.adapterConfig : {};
  const command = typeof config.command === "string" ? config.command.trim() : "";
  if (command) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      "A process agent needs adapterConfig.command — without it every run fails. "
      + "Set the command to execute, or create the agent with a different adapter.",
    path: ["adapterConfig", "command"],
  });
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
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
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
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canAssignTasks: z.boolean(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
