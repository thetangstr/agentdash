import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestResult,
  AdapterExecutionResult,
  AdapterModelProfileDefinition,
  ServerAdapterModule,
} from "./types.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import {
  execute as acpxExecute,
  testEnvironment as acpxTestEnvironment,
  sessionCodec as acpxSessionCodec,
  getConfigSchema as getAcpxConfigSchema,
  listAcpxSkills,
  syncAcpxSkills,
} from "@paperclipai/adapter-acpx-local/server";
import { agentConfigurationDoc as acpxAgentConfigurationDoc } from "@paperclipai/adapter-acpx-local";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import {
  agentConfigurationDoc as claudeAgentConfigurationDoc,
  models as claudeModels,
  modelProfiles as claudeModelProfiles,
} from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import {
  agentConfigurationDoc as codexAgentConfigurationDoc,
  models as codexModels,
  modelProfiles as codexModelProfiles,
} from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import {
  agentConfigurationDoc as cursorAgentConfigurationDoc,
  models as cursorModels,
  modelProfiles as cursorModelProfiles,
} from "@paperclipai/adapter-cursor-local";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import {
  agentConfigurationDoc as geminiAgentConfigurationDoc,
  models as geminiModels,
  modelProfiles as geminiModelProfiles,
} from "@paperclipai/adapter-gemini-local";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
  modelProfiles as openCodeModelProfiles,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels, refreshCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  modelProfiles as piModelProfiles,
} from "@paperclipai/adapter-pi-local";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";
import { ensureAgentProfileCommand, provisionAgentProfile } from "../services/hermes-profile.js";
import { hermesRoundTripProbeCheck } from "./hermes-roundtrip-probe.js";

// AgentDash: opt-in managed per-agent Hermes profiles. When enabled, each agent
// is hired into its own Hermes profile (isolated model/MCP/skills/state) and runs
// are scoped via the profile's alias wrapper. Off by default — no behavior change.
function hermesManagedProfilesEnabled(): boolean {
  return process.env.AGENTDASH_HERMES_MANAGED_PROFILES === "true";
}

const DEFAULT_HERMES_COMMAND = "hermes";
const DEFAULT_CODEX_COMMAND = "codex-acp";

function defaultHermesCommand(): string {
  const configured = process.env.AGENTDASH_HERMES_COMMAND;
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_HERMES_COMMAND;
}

function defaultCodexCommand(): string {
  const configured = process.env.AGENTDASH_CODEX_COMMAND;
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_CODEX_COMMAND;
}

const execFileAsync = promisify(execFile);

export function normalizeHermesConfig<T extends { config?: unknown; agent?: unknown }>(ctx: T): T {
  const config =
    ctx && typeof ctx === "object" && "config" in ctx && ctx.config && typeof ctx.config === "object"
      ? (ctx.config as Record<string, unknown>)
      : null;
  const agent =
    ctx && typeof ctx === "object" && "agent" in ctx && ctx.agent && typeof ctx.agent === "object"
      ? (ctx.agent as Record<string, unknown>)
      : null;
  const agentAdapterConfig =
    agent?.adapterConfig && typeof agent.adapterConfig === "object"
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;

  const configCommand =
    typeof config?.command === "string" && config.command.length > 0 ? config.command : undefined;
  const agentCommand =
    typeof agentAdapterConfig?.command === "string" && agentAdapterConfig.command.length > 0
      ? agentAdapterConfig.command
      : undefined;
  const fallbackHermesCommand = defaultHermesCommand();
  const fallbackCodexCommand = defaultCodexCommand();

  if (config && !config.hermesCommand && configCommand) {
    config.hermesCommand = configCommand;
  }
  if (config && !config.hermesCommand) {
    config.hermesCommand = fallbackHermesCommand;
  }
  if (agentAdapterConfig && !agentAdapterConfig.hermesCommand && agentCommand) {
    agentAdapterConfig.hermesCommand = agentCommand;
  }
  if (agentAdapterConfig && !agentAdapterConfig.hermesCommand) {
    agentAdapterConfig.hermesCommand = fallbackHermesCommand;
  }
  // Codex command defaults (parallel to hermesCommand pattern)
  if (config && !config.command && configCommand) {
    config.command = configCommand;
  }
  if (config && !config.command) {
    config.command = fallbackCodexCommand;
  }
  if (agentAdapterConfig && !agentAdapterConfig.command && agentCommand) {
    agentAdapterConfig.command = agentCommand;
  }
  if (agentAdapterConfig && !agentAdapterConfig.command) {
    agentAdapterConfig.command = fallbackCodexCommand;
  }

  return ctx;
}

export function getHermesCommandFromContext(ctx: { config?: unknown; agent?: unknown }): string {
  const config =
    ctx.config && typeof ctx.config === "object" && !Array.isArray(ctx.config)
      ? (ctx.config as Record<string, unknown>)
      : null;
  const agent =
    ctx.agent && typeof ctx.agent === "object" && !Array.isArray(ctx.agent)
      ? (ctx.agent as Record<string, unknown>)
      : null;
  const agentConfig =
    agent?.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;
  return readNonEmptyString(config?.hermesCommand)
    ?? readNonEmptyString(agentConfig?.hermesCommand)
    // Portable fallback: honor AGENTDASH_HERMES_COMMAND, else "hermes" on PATH.
    // (Was a hardcoded developer-specific absolute path, which broke on any other
    // machine when an agent had no config — the round-trip probe would ENOENT.)
    ?? defaultHermesCommand();
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deriveHermesPaperclipTaskConfig(ctx: { config?: unknown; context?: unknown }) {
  const existingConfig = readRecord(ctx.config);
  const context = readRecord(ctx.context);
  if (!context) return null;

  const issue = readRecord(context.paperclipIssue);
  const wakeComment = readRecord(context.paperclipWakeComment);
  const workspace = readRecord(context.paperclipWorkspace);

  const patch: Record<string, unknown> = {};
  const setIfMissing = (key: string, value: string | null) => {
    if (!value) return;
    if (readNonEmptyString(existingConfig?.[key])) return;
    patch[key] = value;
  };

  const taskId =
    readNonEmptyString(context.taskId) ??
    readNonEmptyString(context.issueId) ??
    readNonEmptyString(issue?.id);
  const taskIdentifier = readNonEmptyString(issue?.identifier);
  const taskTitle = [
    taskIdentifier,
    readNonEmptyString(issue?.title),
  ].filter(Boolean).join(" - ");
  const taskBody =
    readNonEmptyString(context.paperclipTaskMarkdown) ??
    readNonEmptyString(issue?.description);
  const commentId =
    readNonEmptyString(context.commentId) ??
    readNonEmptyString(context.wakeCommentId) ??
    readNonEmptyString(wakeComment?.id);

  setIfMissing("taskId", taskId);
  setIfMissing("taskTitle", taskTitle || null);
  setIfMissing("taskBody", taskBody);
  setIfMissing("commentId", commentId);
  setIfMissing("wakeReason", readNonEmptyString(context.wakeReason));
  setIfMissing("projectName", readNonEmptyString(workspace?.cwd));
  setIfMissing("workspaceDir", readNonEmptyString(workspace?.cwd));

  return Object.keys(patch).length > 0 ? patch : null;
}

const HERMES_AUTH_GUARD_PROMPT = [
  "Paperclip API safety rule:",
  "Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
  "Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data, including comments and issue updates.",
  "Never use a board, browser, or local-board session for Paperclip API writes.",
].join("\n");

const HERMES_AUTHENTICATED_DEFAULT_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

${HERMES_AUTH_GUARD_PROMPT}

IMPORTANT: Use \`terminal\` tool with \`curl\` for ALL Paperclip API calls (web_extract and browser cannot access localhost).

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools.
2. When done, mark the issue as completed:
   \`curl -s -X PATCH "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here>"}'\`
4. If this issue has a parent, post a brief notification on the parent issue:
   \`curl -s -X POST "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented. Read it:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake - Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\\"identifier\\"]} {i[\\"status\\"]:>12} {i[\\"priority\\"]:>6} {i[\\"title\\"]}') for i in issues if i['status'] not in ('done','cancelled')]"\`

2. If issues found, pick the highest priority one that is not done/cancelled and work on it:
   - Read the issue details: \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID"\`
   - Do the work in the project directory: {{projectName}}
   - When done, mark complete and post a comment using the workflow commands above.

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\\"identifier\\"]} {i[\\"title\\"]}') for i in issues if not i.get('assigneeAgentId')]"\`
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -H "Content-Type: application/json" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

function sectionAfter(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) return "";
  const rest = content.slice(startIndex + start.length);
  const endIndex = rest.indexOf(end);
  return endIndex < 0 ? rest : rest.slice(0, endIndex);
}

export function hermesStatusHasConfiguredCredentials(statusOutput: string): boolean {
  const apiKeyProviders = sectionAfter(statusOutput, "API-Key Providers", "Terminal Backend");
  if (apiKeyProviders
    .split(/\r?\n/)
    .some((line) => /\bconfigured\b/i.test(line) && !/\bnot configured\b/i.test(line))) {
    return true;
  }

  const authProviders = sectionAfter(statusOutput, "Auth Providers", "API-Key Providers");
  return authProviders
    .split(/\r?\n/)
    .some((line) => /\blogged in\b/i.test(line) && !/\bnot logged in\b/i.test(line));
}

async function hermesCommandHasConfiguredCredentials(command: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(command, ["status"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return hermesStatusHasConfiguredCredentials(stdout);
  } catch {
    return false;
  }
}

function summarizeAdapterEnvironmentChecks(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

// AgentDash: opt-in real round-trip probe appended to the static Hermes checks,
// so harness-preflight catches an installed-but-broken Hermes. Off by default
// (it spawns a real process); enable with AGENTDASH_HERMES_ROUNDTRIP_PROBE=true.
async function testHermesEnvironment(ctx: Parameters<ServerAdapterModule["testEnvironment"]>[0]) {
  const base = await testHermesEnvironmentStatic(ctx);
  if (process.env.AGENTDASH_HERMES_ROUNDTRIP_PROBE !== "true") return base;
  const normalizedCtx = normalizeHermesConfig(ctx);
  const cfg =
    normalizedCtx.config && typeof normalizedCtx.config === "object" && !Array.isArray(normalizedCtx.config)
      ? (normalizedCtx.config as Record<string, unknown>)
      : {};
  const probe = await hermesRoundTripProbeCheck({
    command: getHermesCommandFromContext(normalizedCtx),
    model: readNonEmptyString(cfg.model) ?? undefined,
    provider: readNonEmptyString(cfg.provider) ?? undefined,
  });
  const checks = [...(Array.isArray(base.checks) ? base.checks : []), probe];
  return { ...base, checks, status: summarizeAdapterEnvironmentChecks(checks) };
}

async function testHermesEnvironmentStatic(ctx: Parameters<ServerAdapterModule["testEnvironment"]>[0]) {
  const normalizedCtx = normalizeHermesConfig(ctx);
  const result = await hermesTestEnvironment(normalizedCtx as never);
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const hasAgentDashEnvWarning = checks.some((check) => check.code === "hermes_no_api_keys" && check.level === "warn");
  if (!hasAgentDashEnvWarning) return result;

  const command = getHermesCommandFromContext(normalizedCtx);
  if (!await hermesCommandHasConfiguredCredentials(command)) return result;

  const normalizedChecks = checks.map((check) => {
    if (check.code !== "hermes_no_api_keys") return check;
    return {
      ...check,
      level: "info" as const,
      message: "Hermes status reports a configured local provider",
      hint: "AgentDash env keys are not required when Hermes owns the provider credentials in its local config.",
    };
  });
  return {
    ...result,
    status: summarizeAdapterEnvironmentChecks(normalizedChecks),
    checks: normalizedChecks,
  };
}
function isHermesResumeHelpTextSessionId(value: unknown): boolean {
  return readNonEmptyString(value)?.toLowerCase() === "from";
}

function sanitizeHermesRuntimeSession<T extends { runtime?: unknown }>(ctx: T): T {
  const runtime =
    ctx.runtime && typeof ctx.runtime === "object" && !Array.isArray(ctx.runtime)
      ? (ctx.runtime as Record<string, unknown>)
      : null;
  const sessionParams =
    runtime?.sessionParams && typeof runtime.sessionParams === "object" && !Array.isArray(runtime.sessionParams)
      ? (runtime.sessionParams as Record<string, unknown>)
      : null;
  const hasInvalidSession =
    isHermesResumeHelpTextSessionId(runtime?.sessionId) ||
    isHermesResumeHelpTextSessionId(runtime?.sessionDisplayId) ||
    isHermesResumeHelpTextSessionId(sessionParams?.sessionId);

  if (!runtime || !hasInvalidSession) return ctx;

  return {
    ...ctx,
    runtime: {
      ...runtime,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
    },
  };
}

function sanitizeHermesExecutionResult(result: AdapterExecutionResult): AdapterExecutionResult {
  const resultJson =
    result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
      ? result.resultJson
      : null;
  const sessionParams =
    result.sessionParams && typeof result.sessionParams === "object" && !Array.isArray(result.sessionParams)
      ? result.sessionParams
      : null;
  const hasInvalidSession =
    result.exitCode !== 0 &&
    (isHermesResumeHelpTextSessionId(result.sessionId) ||
      isHermesResumeHelpTextSessionId(result.sessionDisplayId) ||
      isHermesResumeHelpTextSessionId(sessionParams?.sessionId) ||
      isHermesResumeHelpTextSessionId(resultJson?.session_id));

  if (!hasInvalidSession) return result;

  return {
    ...result,
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    clearSession: true,
    resultJson: resultJson
      ? {
          ...resultJson,
          session_id: null,
        }
      : result.resultJson,
  };
}

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  modelProfiles: claudeModelProfiles,
  listModels: listClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  execute: acpxExecute,
  testEnvironment: acpxTestEnvironment,
  listSkills: listAcpxSkills,
  syncSkills: syncAcpxSkills,
  sessionCodec: acpxSessionCodec,
  sessionManagement: getAdapterSessionManagement("acpx_local") ?? undefined,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: acpxAgentConfigurationDoc,
  getConfigSchema: getAcpxConfigSchema,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  modelProfiles: codexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  modelProfiles: cursorModelProfiles,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  modelProfiles: geminiModelProfiles,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  modelProfiles: openCodeModelProfiles,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  modelProfiles: piModelProfiles,
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};

// hermes-paperclip-adapter v0.2.0 predates the authToken field; cast is
// intentional until hermes ships a matching AdapterExecutionContext type.
const executeHermesLocal = hermesExecute as unknown as ServerAdapterModule["execute"];

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: async (ctx) => {
    const normalizedCtx = sanitizeHermesRuntimeSession(normalizeHermesConfig(ctx));
    const paperclipTaskConfig = deriveHermesPaperclipTaskConfig(normalizedCtx);
    const taskPatchedCtx = paperclipTaskConfig
      ? {
          ...normalizedCtx,
          config: {
            ...(readRecord(normalizedCtx.config) ?? {}),
            ...paperclipTaskConfig,
          },
        }
      : normalizedCtx;
    if (normalizedCtx !== ctx) {
      await taskPatchedCtx.onLog(
        "stdout",
        "[hermes] Ignoring invalid persisted session id parsed from resume help text.\n",
      );
    }
    if (!taskPatchedCtx.authToken) return sanitizeHermesExecutionResult(await executeHermesLocal(taskPatchedCtx));

    const existingConfig = (taskPatchedCtx.agent.adapterConfig ?? {}) as Record<string, unknown>;
    const existingEnv =
      typeof existingConfig.env === "object" && existingConfig.env !== null && !Array.isArray(existingConfig.env)
        ? (existingConfig.env as Record<string, string>)
        : {};
    const explicitApiKey =
      typeof existingEnv.PAPERCLIP_API_KEY === "string" && existingEnv.PAPERCLIP_API_KEY.trim().length > 0;
    const promptTemplate =
      typeof existingConfig.promptTemplate === "string" && existingConfig.promptTemplate.trim().length > 0
        ? existingConfig.promptTemplate
        : "";
    const patchedConfig: Record<string, unknown> = {
      ...existingConfig,
      env: {
        ...existingEnv,
        ...(!explicitApiKey ? { PAPERCLIP_API_KEY: normalizedCtx.authToken } : {}),
        PAPERCLIP_RUN_ID: normalizedCtx.runId,
      },
    };

    // AgentDash: when managed profiles are enabled, scope this run to the agent's
    // own Hermes profile by invoking its alias wrapper (`hermes -p <profile>`).
    // Provisions the profile if it is missing (covers agents created by any path,
    // not just the hire-approval flow); falls back to the default command if it
    // could not be provisioned.
    if (hermesManagedProfilesEnabled()) {
      const profileCmd = await ensureAgentProfileCommand(taskPatchedCtx.agent?.id);
      if (profileCmd) patchedConfig.hermesCommand = profileCmd;
    }

    // Hermes' package default prompt predates authenticated mode and shows bare curl examples.
    // In authenticated mode, replace it with an equivalent auth-aware template.
    if (promptTemplate) {
      patchedConfig.promptTemplate = `${HERMES_AUTH_GUARD_PROMPT}\n\n${promptTemplate}`;
    } else {
      patchedConfig.promptTemplate = HERMES_AUTHENTICATED_DEFAULT_PROMPT_TEMPLATE;
    }

    const patchedCtx = {
      ...taskPatchedCtx,
      agent: {
        ...taskPatchedCtx.agent,
        adapterConfig: patchedConfig,
      },
    };

    return sanitizeHermesExecutionResult(await executeHermesLocal(patchedCtx));
  },
  // AgentDash: ensure the agent's managed profile exists before the env check so
  // harness-preflight passes for an agent created by any path, and run the check
  // against that profile's wrapper command.
  testEnvironment: async (ctx) => {
    if (hermesManagedProfilesEnabled()) {
      const agentId = (ctx as { agent?: { id?: string | null } }).agent?.id;
      const profileCmd = await ensureAgentProfileCommand(agentId);
      if (profileCmd) {
        const cfg =
          ctx.config && typeof ctx.config === "object" && !Array.isArray(ctx.config)
            ? (ctx.config as Record<string, unknown>)
            : {};
        return testHermesEnvironment({ ...ctx, config: { ...cfg, hermesCommand: profileCmd } } as typeof ctx);
      }
    }
    return testHermesEnvironment(ctx);
  },
  sessionCodec: hermesSessionCodec,
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: () => detectModelFromHermes(),
  // AgentDash: provision a distinct Hermes profile for each agent on hire
  // (isolated model/MCP/skills/state, gateway-pointed). Opt-in; non-fatal.
  onHireApproved: async (payload) => {
    if (!hermesManagedProfilesEnabled()) return { ok: true };
    try {
      const { profileName, providerSource } = await provisionAgentProfile(payload.agentId);
      return { ok: true, detail: { profileName, providerSource } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

function registerBuiltInAdapters() {
  for (const adapter of [
    acpxLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    openclawGatewayAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}

registerBuiltInAdapters();

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
//
// External adapter packages export createServerAdapter() which returns a
// ServerAdapterModule. When the module provides its own sessionManagement
// it is preserved; otherwise the host falls back to the built-in registry
// lookup (so externals that override a built-in type inherit the builtin's
// policy). This brings init-time registration to at-least-as-good behavior
// as the hot-install path (routes/adapters.ts:179 -> registerServerAdapter):
// both preserve module-provided sessionManagement, and init-time additionally
// applies the registry fallback for externals overriding a built-in type.
// ---------------------------------------------------------------------------

/** Cached sync wrapper — the store is a simple JSON file read, safe to call frequently. */
function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

/**
 * Merge an external adapter module with host-provided session management.
 *
 * Module-provided `sessionManagement` takes precedence. When absent, fall
 * back to the hardcoded registry keyed by adapter type (so externals that
 * override a built-in — same `type` — inherit the builtin's policy). If
 * neither is available, `sessionManagement` remains `undefined`.
 *
 * Used by both the init-time IIFE below (external-adapter load pass on
 * server start) and the hot-install path in `routes/adapters.ts`
 * (`registerWithSessionManagement`), so the two load paths resolve
 * `sessionManagement` identically.
 */
export function resolveExternalAdapterRegistration(
  externalAdapter: ServerAdapterModule,
): ServerAdapterModule {
  return {
    ...externalAdapter,
    sessionManagement:
      externalAdapter.sessionManagement
        ?? getAdapterSessionManagement(externalAdapter.type)
        ?? undefined,
  };
}

/**
 * Load external adapters from the plugin store and hardcoded sources.
 * Called once at module initialization. The promise is exported so that
 * callers (e.g. assertKnownAdapterType, app startup) can await completion
 * and avoid racing against the loading window.
 */
const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
        resolveExternalAdapterRegistration(externalAdapter),
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

/**
 * Await this before validating adapter types to avoid race conditions
 * during server startup. External adapters are loaded asynchronously;
 * calling assertKnownAdapterType before this resolves will reject
 * valid external adapter types.
 */
export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return findActiveServerAdapter(type) ?? processAdapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function refreshAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.refreshModels) {
    const refreshed = await adapter.refreshModels();
    if (refreshed.length > 0) return refreshed;
  }
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function listAdapterModelProfiles(type: string): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModelProfiles) {
    const discovered = await adapter.listModelProfiles();
    if (discovered.length > 0) return discovered;
  }
  return adapter.modelProfiles ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * List adapters excluding those that are disabled in settings.
 * Used for menus and agent creation flows — disabled adapters remain
 * functional for existing agents but hidden from selection.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Override pause / resume
// ---------------------------------------------------------------------------

/**
 * Pause or resume an external override for a builtin adapter type.
 *
 * - `paused = true`  → subsequent calls to `getServerAdapter(type)` return
 *   the builtin fallback instead of the external adapter.  Already-running
 *   agent sessions are unaffected (they hold a reference to the module they
 *   started with).
 *
 * - `paused = false` → the external adapter is active again.
 *
 * Returns `true` if the state actually changed, `false` if the type is not
 * an override or was already in the requested state.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

/** Check whether the external override for a builtin type is currently paused. */
export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/** Get the set of types whose overrides are currently paused. */
export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }
  return adaptersByType.get(type) ?? null;
}
