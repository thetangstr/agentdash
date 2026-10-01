import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, heartbeatRuns, instanceUserRoles, issues, projects } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  isCanonicalUuid,
  isProjectVisible,
  pruneRelatedIssuesInActivityDetails,
  relatedIssueIdsInActivityDetails,
  resolveAgentVisibility,
  seesEverything,
} from "../routes/visibility.js";

/**
 * AgentDash (GH #830 part A follow-up): the live-events websocket applies the
 * A5 project rule from `routes/visibility.ts` per subscriber. An event about
 * an issue, run or project in a restricted project is not delivered to a
 * subscriber off that project's access list, exactly as the REST routes
 * answer 404 for the same resources.
 *
 * This module does not restate the rule. It works out which projects an
 * event is about, then asks `seesEverything` and `isProjectVisible` — the
 * same functions the REST guards use — with a request-shaped actor.
 *
 * Cost model:
 * - Event -> project resolution is done ONCE per event (memoized on the event
 *   object, which every subscriber receives by reference), not per socket.
 *   Issue -> project and run -> issue lookups are cached (issue: short TTL
 *   plus invalidation when an `issue` activity event arrives, since an issue
 *   can move projects; run: long TTL, a run's issue does not change).
 * - A company's project rows (visibility, creator) are cached per company
 *   with a short TTL, and dropped immediately when a `project` activity event
 *   arrives (project.updated / project.access_replaced / created / deleted).
 * - The per-subscriber decision for a RESTRICTED project (the only case that
 *   needs the access list) is cached per socket, keyed by that company's
 *   project generation, so an access-list change takes effect on the next
 *   event rather than after the TTL.
 * - The subscriber's own role (admin sees everything) is re-read on a TTL.
 * So a steady stream of run-log chunks costs no queries after the first.
 *
 * Fail closed: an event that names an issue or run we cannot resolve is
 * dropped for any subscriber who does not see everything, unless the company
 * has no restricted project at all (then there is nothing to hide).
 */

const ISSUE_TTL_MS = 10_000;
const RUN_TTL_MS = 5 * 60_000;
const PROJECTS_TTL_MS = 10_000;
const DECISION_TTL_MS = 10_000;
const ACTOR_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;

type ProjectRow = {
  id: string;
  companyId: string;
  visibility: string | null;
  createdByUserId: string | null;
};

export type LiveEventProjectRef =
  | { kind: "none" }
  | { kind: "projects"; projectIds: string[] }
  | { kind: "unresolved" };

export type LiveEventRefs = {
  issueIds: string[];
  runIds: string[];
  projectIds: string[];
  /** Agent visibility (2026-09-30): agents the event is about; delivery needs each to be visible. */
  agentIds: string[];
  /** A reference that is not a canonical UUID: cannot be resolved, fail closed. */
  malformed: boolean;
};

export type LiveEventActor = Request["actor"];

class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: V) {
    if (this.map.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
  delete(key: string) {
    this.map.delete(key);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * For an `issue.deleted` activity event that carries its project (written
 * since GH #863): the project id, or null for an issue with no project.
 * Undefined for any other event, or an older delete event without it.
 */
function deletedIssueProjectOf(event: LiveEvent): string | null | undefined {
  if (event.type !== "activity.logged") return undefined;
  const payload = asRecord(event.payload) ?? {};
  if (payload.action !== "issue.deleted" || payload.entityType !== "issue") return undefined;
  const details = asRecord(payload.details);
  if (!details || !("projectId" in details)) return undefined;
  const projectId = details.projectId;
  if (projectId === null) return null;
  return typeof projectId === "string" ? projectId : undefined;
}

/** Which issues, runs and projects does this event carry content about? */
export function liveEventRefs(event: LiveEvent): LiveEventRefs {
  const refs: LiveEventRefs = { issueIds: [], runIds: [], projectIds: [], agentIds: [], malformed: false };
  const payload = asRecord(event.payload) ?? {};
  const add = (list: string[], value: unknown, strict: boolean) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (isCanonicalUuid(value)) {
      if (!list.includes(value)) list.push(value);
    } else if (strict) {
      refs.malformed = true;
    }
  };

  // Agent references are collected loosely: an odd id is simply not an agent
  // reference, not a reason to fail closed (that is the project rule's job).
  add(refs.agentIds, payload.agentId, false);
  if (event.type === "activity.logged") {
    const entityType = payload.entityType;
    if (entityType === "agent") add(refs.agentIds, payload.entityId, false);
    const deletedIssueProject = deletedIssueProjectOf(event);
    if (deletedIssueProject !== undefined) {
      // GH #863 (#864 follow-up): the issue row is gone; its project travels
      // on the event. A null project is company-visible, like any issue.
      if (deletedIssueProject) add(refs.projectIds, deletedIssueProject, true);
      if (typeof payload.entityId !== "string" || !isCanonicalUuid(payload.entityId)) refs.malformed = true;
    } else if (entityType === "issue") add(refs.issueIds, payload.entityId, true);
    else if (entityType === "project") add(refs.projectIds, payload.entityId, true);
    else if (entityType === "heartbeat_run" || entityType === "run") add(refs.runIds, payload.entityId, true);
    add(refs.runIds, payload.runId, false);
    const details = asRecord(payload.details);
    if (details) {
      add(refs.issueIds, details.issueId, false);
      add(refs.projectIds, details.projectId, false);
    }
  } else if (event.type.startsWith("heartbeat.run.")) {
    add(refs.runIds, payload.runId, true);
  }
  return refs;
}

export function createLiveEventVisibility(db: Db, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const issueProject = new TtlCache<string | null>(ISSUE_TTL_MS, now);
  // GH #863 (#864 follow-up): a deleted issue's last project, kept as long as
  // a run on it can still emit events, so those events resolve instead of
  // failing closed.
  const deletedIssueProject = new TtlCache<string | null>(RUN_TTL_MS, now);
  const runIssue = new TtlCache<string | null>(RUN_TTL_MS, now);
  const companyProjects = new TtlCache<Promise<Map<string, ProjectRow>>>(PROJECTS_TTL_MS, now);
  const projectGeneration = new Map<string, number>();
  const resolved = new WeakMap<LiveEvent, Promise<LiveEventProjectRef>>();

  function generationOf(companyId: string) {
    return projectGeneration.get(companyId) ?? 0;
  }

  function invalidateFor(event: LiveEvent) {
    if (event.type !== "activity.logged") return;
    const payload = asRecord(event.payload) ?? {};
    if (payload.entityType === "project") {
      companyProjects.delete(event.companyId);
      projectGeneration.set(event.companyId, generationOf(event.companyId) + 1);
    } else if (payload.entityType === "issue" && typeof payload.entityId === "string") {
      issueProject.delete(payload.entityId);
      const deletedProject = deletedIssueProjectOf(event);
      if (deletedProject !== undefined) deletedIssueProject.set(payload.entityId, deletedProject);
    }
  }

  function loadCompanyProjects(companyId: string): Promise<Map<string, ProjectRow>> {
    const cached = companyProjects.get(companyId);
    if (cached) return cached;
    const pending = db
      .select({
        id: projects.id,
        companyId: projects.companyId,
        visibility: projects.visibility,
        createdByUserId: projects.createdByUserId,
      })
      .from(projects)
      .where(eq(projects.companyId, companyId))
      .then((rows) => new Map(rows.map((row) => [row.id, row])));
    companyProjects.set(companyId, pending);
    pending.catch(() => companyProjects.delete(companyId));
    return pending;
  }

  /** Issue id -> project id (null: no project); undefined: issue not found. */
  async function projectsOfIssues(issueIds: string[]): Promise<Map<string, string | null | undefined>> {
    const out = new Map<string, string | null | undefined>();
    const missing: string[] = [];
    for (const id of issueIds) {
      const hit = issueProject.get(id);
      const deleted = hit === undefined ? deletedIssueProject.get(id) : undefined;
      if (hit !== undefined) out.set(id, hit);
      else if (deleted !== undefined) out.set(id, deleted);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const rows = await db
        .select({ id: issues.id, projectId: issues.projectId })
        .from(issues)
        .where(inArray(issues.id, missing));
      for (const row of rows) {
        issueProject.set(row.id, row.projectId ?? null);
        out.set(row.id, row.projectId ?? null);
      }
      for (const id of missing) if (!out.has(id)) out.set(id, undefined);
    }
    return out;
  }

  /** Run id -> issue id (null: run has no issue); undefined: run not found. */
  async function issuesOfRuns(runIds: string[]): Promise<Map<string, string | null | undefined>> {
    const out = new Map<string, string | null | undefined>();
    const missing: string[] = [];
    for (const id of runIds) {
      const hit = runIssue.get(id);
      if (hit !== undefined) out.set(id, hit);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const rows = await db
        .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, missing));
      for (const row of rows) {
        // Same reading as assertRunVisible: only a canonical issueId names an issue.
        const issueId = row.contextSnapshot?.issueId;
        const value = typeof issueId === "string" && isCanonicalUuid(issueId) ? issueId : null;
        runIssue.set(row.id, value);
        out.set(row.id, value);
      }
      for (const id of missing) if (!out.has(id)) out.set(id, undefined);
    }
    return out;
  }

  async function resolveUncached(event: LiveEvent): Promise<LiveEventProjectRef> {
    const refs = liveEventRefs(event);
    if (refs.malformed) return { kind: "unresolved" };
    if (refs.issueIds.length === 0 && refs.runIds.length === 0 && refs.projectIds.length === 0) {
      return { kind: "none" };
    }
    const projectIds = new Set(refs.projectIds);
    const issueIds = new Set(refs.issueIds);
    if (refs.runIds.length > 0) {
      const runs = await issuesOfRuns(refs.runIds);
      for (const issueId of runs.values()) {
        if (issueId === undefined) return { kind: "unresolved" };
        if (issueId) issueIds.add(issueId);
      }
    }
    if (issueIds.size > 0) {
      const issueProjects = await projectsOfIssues([...issueIds]);
      for (const projectId of issueProjects.values()) {
        if (projectId === undefined) return { kind: "unresolved" };
        if (projectId) projectIds.add(projectId);
      }
    }
    return projectIds.size > 0 ? { kind: "projects", projectIds: [...projectIds] } : { kind: "none" };
  }

  /**
   * Which projects is this event about? Memoized per event object, so the
   * lookup runs once however many sockets receive the event. Call it
   * synchronously at emit time: cache invalidation happens on the first call.
   */
  function resolveEvent(event: LiveEvent): Promise<LiveEventProjectRef> {
    const hit = resolved.get(event);
    if (hit) return hit;
    invalidateFor(event);
    const pending = resolveUncached(event).catch(() => ({ kind: "unresolved" }) as const);
    resolved.set(event, pending);
    return pending;
  }

  /**
   * A per-socket filter. `loadActor` returns the subscriber's current actor
   * (the same shape the REST auth middleware puts on `req.actor`); it is
   * re-read on a TTL so a demoted admin stops seeing everything.
   */
  function createSubscriberFilter(input: {
    companyId: string;
    loadActor: () => Promise<LiveEventActor>;
  }) {
    const { companyId } = input;
    let actorReq: { value: Promise<Request>; expiresAt: number } | null = null;
    const decisions = new Map<string, { visible: boolean; generation: number; expiresAt: number }>();
    // AgentDash (GH #708): bumped by invalidateActor so a decision computed from
    // an actor loaded before the invalidation is not cached after it.
    let actorEpoch = 0;

    function currentReq(): Promise<Request> {
      if (actorReq && actorReq.expiresAt > now()) return actorReq.value;
      const value = input.loadActor().then((actor) => ({ actor }) as unknown as Request);
      const entry = { value, expiresAt: now() + ACTOR_TTL_MS };
      actorReq = entry;
      value.catch(() => {
        if (actorReq === entry) actorReq = null;
      });
      return value;
    }

    async function projectVisible(req: Request, projectId: string, epoch: number): Promise<boolean> {
      const row = (await loadCompanyProjects(companyId)).get(projectId);
      // Unknown here means another company or a dangling id; isProjectIdVisible
      // treats a dangling reference as company-visible, and a foreign project
      // cannot reach this company's stream.
      if (!row) return true;
      const generation = generationOf(companyId);
      const cached = decisions.get(projectId);
      if (cached && cached.generation === generation && cached.expiresAt > now()) return cached.visible;
      const visible = await isProjectVisible(db, req, row);
      if (epoch === actorEpoch) decisions.set(projectId, { visible, generation, expiresAt: now() + DECISION_TTL_MS });
      return visible;
    }

    /**
     * GH #863 (#868 follow-up): an activity event this subscriber may receive
     * can still name OTHER issues in its details (blockers, referenced
     * issues). Entries for issues the subscriber cannot see are pruned, the
     * same rule the REST activity routes apply. Returns the event itself when
     * nothing is hidden, so the common case allocates nothing.
     */
    async function redactForSubscriber(event: LiveEvent): Promise<LiveEvent> {
      if (event.type !== "activity.logged") return event;
      const payload = asRecord(event.payload);
      const details = payload?.details;
      const related = relatedIssueIdsInActivityDetails(details);
      if (related.length === 0) return event;
      const epoch = actorEpoch; // before the actor is read: see projectVisible
      const req = await currentReq();
      if (seesEverything(req, companyId)) return event;
      const projectsById = await projectsOfIssues(related.filter((id) => isCanonicalUuid(id)));
      const visible = new Set<string>();
      for (const [issueId, projectId] of projectsById) {
        // Unknown issue: fail closed. No project: company-visible.
        if (projectId === undefined) continue;
        if (projectId === null || (await projectVisible(req, projectId, epoch))) visible.add(issueId);
      }
      const pruned = pruneRelatedIssuesInActivityDetails(details, (id) => visible.has(id));
      if (pruned === details) return event;
      return { ...event, payload: { ...payload, details: pruned } };
    }

    /**
     * AgentDash (GH #708): forget the cached actor and project decisions, so a
     * role change (e.g. admin demoted to member) applies to the next event
     * instead of after ACTOR_TTL_MS.
     */
    function invalidateActor() {
      actorEpoch += 1;
      actorReq = null;
      decisions.clear();
    }

    return Object.assign(shouldDeliver, { redactForSubscriber, invalidateActor });

    async function shouldDeliver(event: LiveEvent): Promise<boolean> {
      // AgentDash (GH #708): the epoch is read before any actor is loaded, so an
      // invalidation at any later await keeps this call's decisions out of the cache.
      const epoch = actorEpoch;
      // Agent visibility (2026-09-30): an event about an agent the subscriber
      // cannot see is not delivered, whatever project it is in. The scope is
      // cached on the actor request, which currentReq() keeps for ACTOR_TTL_MS.
      const agentIds = liveEventRefs(event).agentIds;
      if (agentIds.length > 0) {
        const req = await currentReq();
        if (!seesEverything(req, companyId)) {
          const scope = await resolveAgentVisibility(db, req, companyId);
          if (scope.mode !== "all" && agentIds.some((id) => !scope.visibleAgentIds.has(id))) return false;
        }
      }
      const ref = await resolveEvent(event);
      if (ref.kind === "none") return true;
      const req = await currentReq();
      if (seesEverything(req, companyId)) return true;
      if (ref.kind === "unresolved") {
        const rows = await loadCompanyProjects(companyId);
        return ![...rows.values()].some((row) => row.visibility === "restricted");
      }
      for (const projectId of ref.projectIds) {
        if (!(await projectVisible(req, projectId, epoch))) return false;
      }
      return true;
    }
  }

  return { resolveEvent, createSubscriberFilter };
}

/**
 * The board actor for a websocket subscriber, loaded like the REST auth
 * middleware loads it (instance-admin flag plus active memberships).
 */
export async function loadBoardUserActor(db: Db, userId: string): Promise<LiveEventActor> {
  const [roleRow, memberships] = await Promise.all([
    db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        companyId: companyMemberships.companyId,
        membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      ),
  ]);
  return {
    type: "board",
    userId,
    companyIds: memberships.map((row) => row.companyId),
    memberships,
    isInstanceAdmin: Boolean(roleRow),
    source: "session",
  };
}
