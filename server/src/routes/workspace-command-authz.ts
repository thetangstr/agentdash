import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { actorMaySetHostWorkspaceCommand } from "../services/adapter-host-execution-policy.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function prefixPath(prefix: string, key: string) {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function isEmptyCommand(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
}

/**
 * AgentDash (#735): a command key counts when it SETS a command — a non-empty
 * value different from the stored one. Clearing a command, or resending the
 * stored value (an edit form echoing the row), changes nothing that runs.
 */
function collectCommandKeys(raw: unknown, stored: unknown, prefix: string, keys: string[]): string[] {
  if (!isRecord(raw)) return [];
  const storedRecord = isRecord(stored) ? stored : {};
  const paths: string[] = [];
  for (const key of keys) {
    if (!hasOwn(raw, key)) continue;
    const value = raw[key];
    if (isEmptyCommand(value)) continue;
    if (value === storedRecord[key]) continue;
    paths.push(prefixPath(prefix, key));
  }
  return paths;
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string, stored?: unknown): string[] {
  return collectCommandKeys(raw, stored, prefix, ["provisionCommand", "teardownCommand"]);
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string, stored?: unknown): string[] {
  return collectCommandKeys(raw, stored, prefix, ["provisionCommand", "teardownCommand", "cleanupCommand"]);
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

/**
 * Writing a host-executed workspace command is arbitrary code execution on the
 * Paperclip host the next time the workspace is provisioned or torn down.
 *
 * AgentDash (security, #735): this used to accept any board member holding
 * `agents:create`, which company owners (and CEO agents, by permission) hold.
 * It now applies the host-execution policy's rule: instance admin, or the
 * local_trusted implicit board, only. On a hosted box that is the founder; on
 * a self-hosted install it is whoever runs the instance. Agent keys never.
 *
 * Callers pass only paths that set a command (see `collectCommandKeys`), so
 * clearing one or resending the stored value is not refused.
 */
export async function assertHostWorkspaceCommandAuthority(
  _db: Db,
  req: Request,
  _companyId: string,
  paths: string[],
) {
  if (paths.length === 0) return;
  assertNoAgentHostWorkspaceCommandMutation(req, paths);
  if (req.actor.type !== "board") {
    throw forbidden(`Host-executed workspace commands require board access (${paths.join(", ")}).`);
  }
  if (actorMaySetHostWorkspaceCommand(req.actor)) return;
  throw forbidden(
    `Instance admin access required to set a host-executed workspace command (${paths.join(", ")}). ` +
      "Leave it empty, or ask the instance admin to set it.",
  );
}

function sub(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function collectAgentAdapterWorkspaceCommandPaths(
  adapterConfig: unknown,
  prefix = "adapterConfig",
  storedAdapterConfig?: unknown,
): string[] {
  if (!isRecord(adapterConfig)) return [];
  return collectWorkspaceStrategyCommandPaths(
    adapterConfig.workspaceStrategy,
    `${prefix}.workspaceStrategy`,
    sub(storedAdapterConfig, "workspaceStrategy"),
  );
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown, storedPolicy?: unknown): string[] {
  if (!isRecord(policy)) return [];
  return collectWorkspaceStrategyCommandPaths(
    policy.workspaceStrategy,
    "executionWorkspacePolicy.workspaceStrategy",
    sub(storedPolicy, "workspaceStrategy"),
  );
}

export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
  storedWorkspace?: unknown,
): string[] {
  return collectCommandKeys(workspacePatch, storedWorkspace, prefix, ["cleanupCommand"]);
}

export function collectIssueWorkspaceCommandPaths(
  input: {
    executionWorkspaceSettings?: unknown;
    assigneeAdapterOverrides?: unknown;
  },
  stored: {
    executionWorkspaceSettings?: unknown;
    assigneeAdapterOverrides?: unknown;
  } = {},
): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
        sub(stored.executionWorkspaceSettings, "workspaceStrategy"),
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    if (isRecord(adapterConfig)) {
      paths.push(
        ...collectWorkspaceStrategyCommandPaths(
          adapterConfig.workspaceStrategy,
          "assigneeAdapterOverrides.adapterConfig.workspaceStrategy",
          sub(sub(stored.assigneeAdapterOverrides, "adapterConfig"), "workspaceStrategy"),
        ),
      );
    }
  }
  return paths;
}

export function collectExecutionWorkspaceCommandPaths(
  input: {
    config?: unknown;
    metadata?: unknown;
  },
  stored: { config?: unknown; metadata?: unknown } = {},
): string[] {
  const paths: string[] = [];
  if (input.config !== undefined) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.config, "config", stored.config));
  }
  if (isRecord(input.metadata) && hasOwn(input.metadata, "config")) {
    paths.push(
      ...collectExecutionWorkspaceConfigCommandPaths(
        input.metadata.config,
        "metadata.config",
        sub(stored.metadata, "config"),
      ),
    );
  }
  return paths;
}
