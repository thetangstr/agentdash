// AgentDash: current authority witnesses for canonical issue and tree composers.
// This is request-bound authority, independent of private intent/state pins.
import type { Request } from "express";
import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  type Db, agents, agentApiKeys, companyMemberships,
  instanceUserRoles, principalPermissionGrants, projects, projectAccess,
  projectWorkspaces, executionWorkspaces, environments, goals, assistantAccessTokens, assistantGrants,
} from "@paperclipai/db";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { normalizeHumanRole } from "./company-member-roles.js";
import type { IssueCommentContext } from "./issue-mutation-actions.js";
import { currentBoardIdentity } from "./current-board-identity.js";

type Issue = Parameters<IssueCommentContext["validate"]>[1];
type Patch = Record<string, unknown>;
type Witness = { key: string; lock: SQL };
const strings = (values: unknown[]) => [...new Set(values.filter((v): v is string => typeof v === "string" && !!v))].sort();
const bindings = (issue: Issue) => JSON.stringify([issue.companyId, issue.projectId, issue.assigneeAgentId,
  issue.assigneeUserId, issue.projectWorkspaceId, issue.executionWorkspaceId, issue.executionWorkspaceSettings]);
function selection(issue: Issue, patch: Patch) {
  const effective = { ...issue, ...patch };
  return { projectId: effective.projectId, projectWorkspaceId: effective.projectWorkspaceId,
    executionWorkspaceId: effective.executionWorkspaceId, goalId: effective.goalId,
    assigneeAgentId: effective.assigneeAgentId, assigneeUserId: effective.assigneeUserId,
    executionWorkspaceSettings: effective.executionWorkspaceSettings };
}

type CollectionState = { witnesses: Map<string, Witness>; collecting: boolean; credentialDeadline: number | null };
function authorityCollection(req: Request, original: Request["actor"], verified: Request["verifiedCredential"],
  executor: Pick<Db, "select">, issue: Issue, requestedProjectId: string | null | undefined, state: CollectionState,
  board: ReturnType<typeof currentBoardIdentity> | null) {
    function witness(key: string, lock: SQL) {
      if (state.collecting) state.witnesses.set(key, { key, lock });
      else if (!state.witnesses.has(key)) throw conflict("Issue authority changed during acceptance");
    }
    const byId = (table: SQLWrapper, id: string) =>
      sql`select id from ${table} where id = ${id} for share`;
    async function identity() {
      const companyId = issue.companyId;
      if (original.source === "local_implicit" && board) { await board.read(executor, companyId); return; }
      if (original.type === "none" || !(original.agentId ?? original.userId)) throw unauthorized();
      const principalType = original.type === "agent" ? "agent" : "user";
      const principalId = original.agentId ?? original.userId!;
      const grants = await executor.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, principalType), eq(principalPermissionGrants.principalId, principalId),
        inArray(principalPermissionGrants.permissionKey, ["tasks:assign", "tasks:manage_active_checkouts"])));
      for (const grant of grants) witness(`10:permission:${grant.id}`, byId(principalPermissionGrants, grant.id));
      if (original.type === "board") {
        const userId = original.userId;
        if (!userId) throw unauthorized();
        if (board) {
          const profile = await board.read(executor, companyId);
          state.credentialDeadline = profile.credentialDeadline;
          for (const { key, lock } of profile.witnesses) witness(key, lock);
          if (!profile.membership) throw forbidden("Company access denied");
          const refresh = profile.actorRefresh!;
          req.actor = { ...original, userId: refresh.userId, memberships: refresh.memberships.map(member => ({ ...member })),
            companyIds: [...refresh.companyIds], isInstanceAdmin: refresh.isInstanceAdmin };
          return;
        } else if (original.source === "assistant_grant") {
          if (!original.assistantLoopback || verified?.kind !== "assistant" || !verified.loopback ||
              verified.loopback.expiresAt <= Date.now() || !verified.loopback.lease.isLive() ||
              original.companyId !== companyId || !original.assistantGrantId || !original.assistantScopes?.includes("agentdash:work")) throw unauthorized();
          const [grant] = await executor.select().from(assistantGrants).where(eq(assistantGrants.id, original.assistantGrantId));
          if (!grant || grant.userId !== userId || grant.companyId !== companyId || grant.revokedAt || !grant.scopes.includes("agentdash:work")) throw unauthorized();
          witness(`07:assistant_grant:${grant.id}`, byId(assistantGrants, grant.id));
          if (verified.origin.kind === "oauth") {
            const origin = verified.origin;
            const [token] = await executor.select({ id: assistantAccessTokens.id, grantId: assistantAccessTokens.grantId,
              expiresAt: assistantAccessTokens.expiresAt, revokedAt: assistantAccessTokens.revokedAt,
              resource: assistantAccessTokens.resource, scopes: assistantAccessTokens.scopes })
              .from(assistantAccessTokens).where(eq(assistantAccessTokens.id, origin.accessTokenId));
            if (!token || token.grantId !== grant.id || token.resource !== origin.resource || token.revokedAt ||
                origin.expiresAt <= Date.now() || token.expiresAt.getTime() <= Date.now() ||
                !origin.scopes.includes("agentdash:work") || !token.scopes.includes("agentdash:work")) throw unauthorized();
            state.credentialDeadline = Math.min(token.expiresAt.getTime(), origin.expiresAt);
            witness(`08:assistant_access:${token.id}`, byId(assistantAccessTokens, token.id));
          } else if (verified.origin.kind !== "internal") throw unauthorized();
        } else throw unauthorized();
        const [member] = await executor.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)));
        if (!member || member.status !== "active") throw forbidden("Company access denied");
        witness(`09:membership:${member.id}`, byId(companyMemberships, member.id));
        const admins = await executor.select().from(instanceUserRoles)
          .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
        for (const admin of admins) witness(`11:admin:${admin.id}`, byId(instanceUserRoles, admin.id));
        req.actor = { ...original, memberships: [{ companyId, membershipRole: member.membershipRole, status: member.status }],
          companyIds: [companyId], isInstanceAdmin: original.source !== "assistant_grant" && admins.length > 0 };
      } else if (original.type === "agent") {
        if (!original.agentId || original.companyId !== companyId) throw unauthorized();
        if (original.source === "agent_key") {
          if (!original.keyId) throw unauthorized();
          const [key] = await executor.select({ id: agentApiKeys.id, agentId: agentApiKeys.agentId, companyId: agentApiKeys.companyId,
            revokedAt: agentApiKeys.revokedAt, principalKind: agentApiKeys.principalKind }).from(agentApiKeys).where(eq(agentApiKeys.id, original.keyId));
          if (!key || key.agentId !== original.agentId || key.companyId !== companyId || key.revokedAt) throw unauthorized();
          if (key.principalKind === "evaluator") throw forbidden("This principal is read-only");
          witness(`08:agent_key:${key.id}`, byId(agentApiKeys, key.id));
        } else if (original.source === "agent_jwt") {
          if (verified?.kind !== "agent_jwt" || verified.agentId !== original.agentId || verified.companyId !== companyId ||
              verified.signedRunId !== original.jwtRunId || verified.expiresAt < Math.floor(Date.now() / 1000)) throw unauthorized();
        } else throw unauthorized();
        const [agent] = await executor.select().from(agents).where(eq(agents.id, original.agentId));
        if (!agent || agent.companyId !== companyId || ["terminated", "pending_approval"].includes(agent.status)) throw unauthorized();
        if (agent.role === "evaluator" || original.readOnly) throw forbidden("This principal is read-only");
        witness(`02:agent:${agent.id}`, byId(agents, agent.id));
        const [member] = await executor.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, agent.id)));
        if (member) witness(`09:membership:${member.id}`, byId(companyMemberships, member.id));
        // Only the actual reporting path may be an ownership override. No
        // company-wide agent lock, no newly invented project ACL for workers.
        if (issue.assigneeAgentId && issue.assigneeAgentId !== agent.id && agent.role !== "ceo" && !agent.permissions?.canCreateAgents &&
            !(member?.status === "active" && grants.some(grant => grant.permissionKey === "tasks:manage_active_checkouts"))) {
          const chain: typeof agents.$inferSelect[] = [];
          let cursor: string | null = issue.assigneeAgentId;
          for (let depth = 0; cursor && depth < 50; depth++) {
            const [row] = await executor.select().from(agents).where(and(eq(agents.id, cursor), eq(agents.companyId, companyId)));
            if (!row) break;
            chain.push(row);
            if (row.reportsTo === agent.id) { for (const link of chain) witness(`02:agent:${link.id}`, byId(agents, link.id)); break; }
            cursor = row.reportsTo;
          }
        }
      }
    }
    async function projectGuards() {
      for (const id of strings([issue.projectId, requestedProjectId])) {
        const [project] = await executor.select().from(projects).where(eq(projects.id, id));
        if (!project || project.companyId !== issue.companyId) throw notFound("Project not found");
        witness(`04:project:${id}`, byId(projects, id));
        if (project.visibility !== "restricted") continue;
        // A5 (GH #830, #854): the same rule for boards AND agents. Admins,
        // instance operators and the creator see a restricted project; any
        // other principal (an agent included) needs an access-list row, and
        // an off-list principal gets 404, never 403.
        if (original.type === "board" && (original.source === "local_implicit" || req.actor.isInstanceAdmin ||
            normalizeHumanRole(req.actor.memberships?.[0]?.membershipRole) === "admin" ||
            project.createdByUserId === original.userId)) continue;
        const principalType = original.type === "agent" ? "agent" : original.type === "board" ? "user" : null;
        const principalId = original.type === "agent" ? original.agentId : original.type === "board" ? original.userId : null;
        if (!principalType || !principalId) throw notFound("Project not found");
        const [access] = await executor.select().from(projectAccess).where(and(eq(projectAccess.projectId, id),
          eq(projectAccess.principalType, principalType), eq(projectAccess.principalId, principalId)));
        if (!access) throw notFound("Project not found");
        witness(`12:project_access:${id}:${principalType}:${principalId}`, sql`select project_id from ${projectAccess}
          where project_id = ${id} and principal_type = ${principalType} and principal_id = ${principalId} for share`);
      }
    }
    async function sourceWorkspace() {
      if (!issue.executionWorkspaceId) return;
      const [row] = await executor.select({ id: executionWorkspaces.id, companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId }).from(executionWorkspaces).where(eq(executionWorkspaces.id, issue.executionWorkspaceId));
      if (!row || row.companyId !== issue.companyId || (issue.projectId && row.projectId !== issue.projectId)) throw notFound("Workspace not found");
      witness(`06:execution_workspace:${row.id}`, byId(executionWorkspaces, row.id));
    }
    async function resources(patch: Patch) {
      const selected = selection(issue, patch);
      if (selected.assigneeUserId) {
        const [member] = await executor.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, issue.companyId),
          eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, selected.assigneeUserId as string)));
        if (member) witness(`09:membership:${member.id}`, byId(companyMemberships, member.id));
      }
      for (const id of strings([selected.assigneeAgentId])) {
        const [agent] = await executor.select({ id: agents.id }).from(agents).where(eq(agents.id, id));
        if (agent) witness(`02:agent:${id}`, byId(agents, id));
      }
      for (const [label, table, ids] of [
        ["project_workspace", projectWorkspaces, strings([selected.projectWorkspaceId])],
        ["execution_workspace", executionWorkspaces, strings([issue.executionWorkspaceId, selected.executionWorkspaceId])],
      ] as const) {
        for (const id of ids) {
          const [row] = await executor.select({ id: table.id, companyId: table.companyId, projectId: table.projectId }).from(table).where(eq(table.id, id));
          if (!row || row.companyId !== issue.companyId || ((label === "execution_workspace" && id === issue.executionWorkspaceId ? issue.projectId : selected.projectId) &&
              row.projectId !== (label === "execution_workspace" && id === issue.executionWorkspaceId ? issue.projectId : selected.projectId))) throw notFound("Workspace not found");
          witness(`${label === "project_workspace" ? "05" : "06"}:${label}:${id}`, byId(table, id));
        }
      }
      const environmentId = (selected.executionWorkspaceSettings as { environmentId?: string } | null)?.environmentId;
      if (environmentId) {
        const [row] = await executor.select({ id: environments.id, companyId: environments.companyId }).from(environments).where(eq(environments.id, environmentId));
        if (!row || row.companyId !== issue.companyId) throw notFound("Environment not found");
        witness(`01:environment:${row.id}`, byId(environments, row.id));
      }
      if (selected.goalId) {
        const [row] = await executor.select({ id: goals.id, companyId: goals.companyId }).from(goals).where(eq(goals.id, selected.goalId as string));
        if (!row || row.companyId !== issue.companyId) throw notFound("Goal not found");
        witness(`03:goal:${row.id}`, byId(goals, row.id));
      }
      return JSON.stringify(selected);
    }
  async function referencedAgents(ids: readonly string[]) {
    for (const id of strings([...ids])) {
      const [row] = await executor.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, id));
      if (!row || row.companyId !== issue.companyId) throw notFound("Agent not found");
      witness(`02:agent:${id}`, byId(agents, id));
    }
  }
  return { identity, projectGuards, sourceWorkspace, resources, referencedAgents };
}
function checkAuthorityTime(verified: Request["verifiedCredential"], state: CollectionState, board: ReturnType<typeof currentBoardIdentity> | null) {
  board?.checkTime();
  if (state.credentialDeadline !== null && state.credentialDeadline <= Date.now()) throw unauthorized();
  if (verified?.kind === "assistant" && (!verified.loopback?.lease.isLive() ||
      verified.loopback.expiresAt <= Date.now() || (verified.origin.kind === "oauth" && verified.origin.expiresAt <= Date.now()))) throw unauthorized();
  if (verified?.kind === "agent_jwt" && verified.expiresAt < Math.floor(Date.now() / 1000)) throw unauthorized();
}

/** Called after the company mutex, before issue/run locks. Only the canonical
 * route supplies this closure, bound to its actual authenticated Request. */
export function issueCurrentAuthority(req: Request, requestedProjectId?: string | null): NonNullable<IssueCommentContext["stageAuthority"]> {
  const original = { ...req.actor };
  const verified = req.verifiedCredential;
  const board = original.type === "board" && original.source !== "assistant_grant" ? currentBoardIdentity(req) : null;
  return async (executor, issue, resolvePatch) => {
    const sourceBindings = bindings(issue);
    const validateIssue = (current: Issue) => {
      if (bindings(current) !== sourceBindings) throw conflict("Issue authority resources changed during acceptance");
    };
    const state: CollectionState = { witnesses: new Map(), collecting: true, credentialDeadline: null };
    const { identity, projectGuards, sourceWorkspace, resources } = authorityCollection(req, original, verified, executor, issue, requestedProjectId, state, board);
    await identity();
    await projectGuards(); // Before preparation can project a closed workspace.
    await sourceWorkspace();
    const patch = await resolvePatch(async current => {
      // Preparation independently reads the issue. Refuse a changed source
      // before its route callbacks can project any newly bound workspace, and
      // refresh authority for an unchanged source before preliminary policy.
      // This read-only guard does not replace lock-backed write acceptance.
      validateIssue(current);
      await identity(); await projectGuards(); await sourceWorkspace();
    });
    const selected = await resources(patch);
    // FK parents precede credential children: user→session/board key,
    // environment→agent→agent key, grant→access token. Resource parents
    // precede selected goal/project/workspace children. IDs sort within a
    // class; issue/topology writer coordination remains a separate contract.
    for (const { lock } of [...state.witnesses.values()].sort((a, b) => a.key.localeCompare(b.key))) await executor.execute(lock);
    state.collecting = false;
    // A deleted/replaced positive row never silently substitutes a new ID.
    await identity(); await projectGuards(); await sourceWorkspace(); await resources(patch);
    return { validateIssue, beforeWrite: async (current, effectivePatch) => {
      validateIssue(current);
      if (JSON.stringify(selection(current, effectivePatch)) !== selected) {
        throw conflict("Issue authority resources changed during acceptance");
      }
      await identity(); await projectGuards(); await sourceWorkspace(); await resources(effectivePatch);
      // Last synchronous liveness/time check is immediately before acceptance
      // writes. No external work or write-budget consumption occurs here.
      checkAuthorityTime(verified, state, board);
    } };
  };
}

// AgentDash: all targets share one positive witness collection and lock order.
export type TreeAuthorityTarget = { issue: Issue; effectivePatch: Patch; referencedAgentIds?: readonly string[] };
export type TreeAuthorityGuard = {
  checkTime(): void;
  validateTargets(current: readonly TreeAuthorityTarget[]): void;
  beforeWrite(current: readonly TreeAuthorityTarget[]): Promise<void>;
};
export function issueTreeCurrentAuthority(req: Request) {
  const original = { ...req.actor }, verified = req.verifiedCredential;
  const board = original.type === "board" && original.source !== "assistant_grant" ? currentBoardIdentity(req) : null;
  const fingerprint = (targets: readonly TreeAuthorityTarget[]) => JSON.stringify(targets.map(target =>
    [target.issue.id, bindings(target.issue), selection(target.issue, target.effectivePatch), strings([...(target.referencedAgentIds ?? [])])]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  async function prepare(reader: Pick<Db, "select">, targets: readonly TreeAuthorityTarget[]) {
    if (original.type !== "board") throw forbidden("Board access required");
    if (!targets.length || targets.some(target => target.issue.companyId !== targets[0].issue.companyId)) throw notFound("Issue not found");
    const state: CollectionState = { witnesses: new Map(), collecting: true, credentialDeadline: null };
    const originalTargets = fingerprint(targets);
    const collectors = targets.map(target => authorityCollection(req, original, verified, reader, target.issue, undefined, state, board));
    const collect = async () => {
      await collectors[0].identity();
      for (let index = 0; index < collectors.length; index++) {
        const collector = collectors[index];
        await collector.projectGuards(); await collector.sourceWorkspace();
        await collector.resources(targets[index].effectivePatch);
        await collector.referencedAgents(targets[index].referencedAgentIds ?? []);
      }
    };
    const validateTargets = (current: readonly TreeAuthorityTarget[]) => {
      if (fingerprint(current) !== originalTargets) throw conflict("Tree authority changed during acceptance");
    };
    await collect();
    return { state, collect, validateTargets };
  }
  return {
    async read(reader: Pick<Db, "select">, targets: readonly TreeAuthorityTarget[]) {
      const { state } = await prepare(reader, targets);
      checkAuthorityTime(verified, state, board);
    },
    async stage(executor: Db, targets: readonly TreeAuthorityTarget[]): Promise<TreeAuthorityGuard> {
      const prepared = await prepare(executor, targets);
      for (const { lock } of [...prepared.state.witnesses.values()].sort((a, b) => a.key.localeCompare(b.key))) await executor.execute(lock);
      prepared.state.collecting = false;
      await prepared.collect();
      return { validateTargets: prepared.validateTargets, checkTime: () => checkAuthorityTime(verified, prepared.state, board), async beforeWrite(current) {
        prepared.validateTargets(current);
        await prepared.collect();
        checkAuthorityTime(verified, prepared.state, board);
      } };
    },
  };
}
