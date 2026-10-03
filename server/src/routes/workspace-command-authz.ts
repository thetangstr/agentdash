import path from "node:path";
import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentStewardships, projects } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { resolveHomeAwarePath } from "../home-paths.js";
import { checkCompanyWorkspaceCwd } from "../services/workspace-cwd-confinement.js";
import { REPO_ONLY_CWD_SENTINEL } from "../services/projects.js";
import {
  actorMaySetHostWorkspaceCommand,
  findRestrictedHostExecutionFields,
} from "../services/adapter-host-execution-policy.js";
import { isProjectVisible, seesEverything } from "./visibility.js";

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

/**
 * AgentDash (security, #735 review): a `workspaceRuntime` block defines
 * runtime services whose `command` runs through `sh -c`, with their own `cwd`
 * and `env`. It is checked with the host-execution policy's walker, so every
 * `command`, `args`, `env`, `cwd` or `*Command`/`*Env`/... key at any depth
 * counts when it is set to something other than the stored value.
 */
function collectWorkspaceRuntimeCommandPaths(raw: unknown, stored: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  return findRestrictedHostExecutionFields({
    adapterType: null,
    adapterConfig: raw,
    stored: isRecord(stored) ? stored : undefined,
    prefix,
  });
}

function hasDotDotPathSegment(value: string) {
  return value.split(/[\\/]+/).includes("..");
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string, stored?: unknown): string[] {
  const paths = collectCommandKeys(raw, stored, prefix, ["provisionCommand", "teardownCommand"]);
  // AgentDash (security, GH #980): a worktreeParentDir names a host directory
  // the server mkdirs and writes worktrees into — the same class as cwd. An
  // ABSOLUTE value lands anywhere; a relative one is resolved against the
  // repo root with plain path.resolve, so one carrying a `..` segment climbs
  // out of the repo just the same (GH #980 review). Both are gated; a plain
  // relative dir stays open to non-admins.
  if (isRecord(raw)) {
    const value = raw.worktreeParentDir;
    const storedValue = isRecord(stored) ? stored.worktreeParentDir : undefined;
    if (
      typeof value === "string" &&
      value.trim().length > 0 &&
      (path.isAbsolute(value.trim()) ||
        value.trim().startsWith("~") ||
        hasDotDotPathSegment(value.trim())) &&
      value !== storedValue
    ) {
      paths.push(prefixPath(prefix, "worktreeParentDir"));
    }
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string, stored?: unknown): string[] {
  return [
    ...collectCommandKeys(raw, stored, prefix, ["provisionCommand", "teardownCommand", "cleanupCommand"]),
    ...collectWorkspaceRuntimeCommandPaths(sub(raw, "workspaceRuntime"), sub(stored, "workspaceRuntime"), prefixPath(prefix, "workspaceRuntime")),
  ];
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

/**
 * Is `projectId` a project of this company the actor may see? A directory
 * under `<instance>/projects/<companyId>/<projectId>` names that project —
 * letting an off-list member point a workspace cwd at it would leak a
 * restricted project's checkout (GH #980 review).
 */
async function actorMayUseManagedProjectDir(
  db: Db,
  req: Request,
  companyId: string,
  projectId: string,
): Promise<boolean> {
  const project = await db
    .select({
      id: projects.id,
      companyId: projects.companyId,
      visibility: projects.visibility,
      createdByUserId: projects.createdByUserId,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!project) return false;
  return isProjectVisible(db, req, project);
}

/**
 * May the actor point a workspace cwd at `<instance>/workspaces/<agentId>`?
 * The dir belongs to one agent, so "manage" — not mere visibility — is the
 * bar: an agent manages its own dir; a human manages the agents they
 * created, steward or answer for, and anything reporting to those (the same
 * `answers_for` set resolveAgentVisibility builds, minus company-visibility
 * and minus the created-by-others flat add).
 */
async function actorManagesAgent(
  db: Db,
  req: Request,
  companyId: string,
  agentId: string,
): Promise<boolean> {
  if (req.actor.type === "agent") return req.actor.agentId === agentId;
  if (seesEverything(req, companyId)) return true;
  const userId = req.actor.type === "board" ? req.actor.userId : null;
  if (!userId) return false;
  const rows = await db.execute<{ id: string }>(sql`
    with recursive manageable as (
      select a.id from ${agents} a
      where a.company_id = ${companyId}
        and (
          a.accountable_user_id = ${userId}
          or a.created_by_user_id = ${userId}
          or exists (
            select 1 from ${agentStewardships} s
            where s.company_id = ${companyId}
              and s.agent_id = a.id
              and s.user_id = ${userId}
              and s.ended_at is null
          )
        )
      union
      select a.id from ${agents} a
        join manageable m on a.reports_to = m.id
        where a.company_id = ${companyId}
    )
    select id from manageable where id = ${agentId}::uuid
    limit 1
  `);
  return (rows as unknown as unknown[]).length > 0;
}

/**
 * AgentDash (security, GH #980): a project workspace `cwd` is the host
 * directory runs execute in — the same authority class as a host-executed
 * command. Everyone but the instance admin (and the local_trusted board) may
 * only choose a cwd inside this company's server-managed roots: the managed
 * project checkout dirs (of projects the actor can see) and the instance
 * workspaces of agents the actor manages.
 *
 * Grandfathering: the check only trips when the EFFECTIVE host cwd changes.
 * Resending the stored value — including the legacy repo paths self-hosted
 * installs hold — stays open, but ONLY while the row's `sourceType` also
 * stays the same. Flipping a row to a host source type (`remote_managed` →
 * `local_path`, or between host types) re-validates the cwd that will
 * actually execute, even when cwd is absent from the body — otherwise a
 * laundered value rides the grandfather clause in (GH #980 review).
 *
 * `remote_managed` rows carry a remote path, not a host one, so a non-empty
 * NEW cwd is refused outright for non-admins: nothing local should ever
 * execute in it, and heartbeats ignore it.
 */
export async function assertProjectWorkspaceCwdAuthority(
  db: Db,
  req: Request,
  companyId: string,
  cwd: unknown,
  options: { storedCwd?: unknown; sourceType?: unknown; storedSourceType?: unknown } = {},
): Promise<void> {
  const sourceType = typeof options.sourceType === "string" ? options.sourceType : undefined;
  const sourceTypeChanged =
    sourceType !== undefined &&
    typeof options.storedSourceType === "string" &&
    sourceType !== options.storedSourceType;
  // "/__paperclip_repo_only__" is a sentinel meaning "no cwd, use the repo
  // clone" — it never lands on the host filesystem.
  const settingCwd =
    typeof cwd === "string" &&
    cwd.trim().length > 0 &&
    cwd.trim() !== REPO_ONLY_CWD_SENTINEL;
  const cwdUnchanged =
    settingCwd &&
    typeof options.storedCwd === "string" &&
    options.storedCwd.trim().length > 0 &&
    resolveHomeAwarePath(cwd) === resolveHomeAwarePath(options.storedCwd);

  if (sourceType === "remote_managed") {
    if (settingCwd && !cwdUnchanged && !actorMaySetHostWorkspaceCommand(req.actor)) {
      throw forbidden(
        "A remote-managed workspace does not execute on this host, so its cwd is not a host path. " +
          "Leave it empty, or ask the instance admin to set it.",
      );
    }
    return;
  }

  // An explicit `cwd: null` clears the value, so the effective post-write cwd
  // is null — not the stored one. Only an ABSENT cwd leaves the stored value
  // in force, which is the case a source-type flip must re-validate.
  const effectiveCwd = cwd !== undefined ? cwd : options.storedCwd;
  if (!sourceTypeChanged && (!settingCwd || cwdUnchanged)) return;
  if (typeof effectiveCwd !== "string" || effectiveCwd.trim().length === 0) return;
  if (effectiveCwd.trim() === REPO_ONLY_CWD_SENTINEL) return;
  if (actorMaySetHostWorkspaceCommand(req.actor)) return;
  const check = await checkCompanyWorkspaceCwd(db, companyId, effectiveCwd, {
    isManagedProjectDirAllowed: (projectId) =>
      actorMayUseManagedProjectDir(db, req, companyId, projectId),
    isAgentWorkspaceDirAllowed: (agentId) =>
      actorManagesAgent(db, req, companyId, agentId),
  });
  if (!check.ok) {
    throw forbidden(
      `Workspace cwd refused: ${check.reason}. ` +
        "Set a path inside the company's managed workspace roots, or ask the instance admin to set it.",
    );
  }
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
  return [
    ...collectWorkspaceStrategyCommandPaths(
      policy.workspaceStrategy,
      "executionWorkspacePolicy.workspaceStrategy",
      sub(storedPolicy, "workspaceStrategy"),
    ),
    ...collectWorkspaceRuntimeCommandPaths(
      policy.workspaceRuntime,
      sub(storedPolicy, "workspaceRuntime"),
      "executionWorkspacePolicy.workspaceRuntime",
    ),
  ];
}

export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
  storedWorkspace?: unknown,
): string[] {
  return [
    ...collectCommandKeys(workspacePatch, storedWorkspace, prefix, ["cleanupCommand"]),
    ...collectWorkspaceRuntimeCommandPaths(
      sub(sub(workspacePatch, "runtimeConfig"), "workspaceRuntime"),
      sub(sub(storedWorkspace, "runtimeConfig"), "workspaceRuntime"),
      prefixPath(prefix, "runtimeConfig.workspaceRuntime"),
    ),
    // The runtime config is stored at metadata.runtimeConfig, and a metadata
    // patch without runtimeConfig is written as-is, so it is a second way in.
    ...collectWorkspaceRuntimeCommandPaths(
      sub(sub(sub(workspacePatch, "metadata"), "runtimeConfig"), "workspaceRuntime"),
      sub(sub(sub(storedWorkspace, "metadata"), "runtimeConfig"), "workspaceRuntime"),
      prefixPath(prefix, "metadata.runtimeConfig.workspaceRuntime"),
    ),
  ];
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
    paths.push(
      ...collectWorkspaceRuntimeCommandPaths(
        input.executionWorkspaceSettings.workspaceRuntime,
        sub(stored.executionWorkspaceSettings, "workspaceRuntime"),
        "executionWorkspaceSettings.workspaceRuntime",
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
