import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_pluginEventBus) return;
  void _pluginEventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error } of errors) {
      logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
    }
  }).catch(() => {});
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: redactedDetails,
  });

  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: redactedDetails,
    },
  });

  const pluginEventType = eventTypeForActivityAction(input.action);
  if (pluginEventType) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: pluginEventType,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId,
      actorType: input.actorType,
      entityId: input.entityId,
      entityType: input.entityType,
      companyId: input.companyId,
      payload: {
        ...redactedDetails,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
      },
    };
    publishPluginDomainEvent(event);
  }
}

/**
 * AGE-91 — durable record for authority refusals.
 *
 * 403/409 authz refusals previously threw before any row was written and the
 * error handler only persists >= 500, so a refused write left no trace. This
 * helper writes one `authz.refused` activity row per refusal, WITHOUT changing
 * the thrown error: the HTTP status and body stay exactly as they were.
 *
 * Scope guards (per issue + AGE-91 review):
 *  - Anonymous 401s are NOT logged — there is no actor to attribute.
 *  - `details` carries only { method, routePath, reasonCode, targetCompanyId? }
 *    — never request bodies, never query strings (H2): routePath is the route
 *    PATTERN, not the raw URL.
 *  - An agent's refusal is charged to the agent's OWN company (H1): the
 *    helper never writes an agent-attributed row into the company the agent
 *    was refused on; the refused target goes to details.targetCompanyId.
 *  - runId is always null (M7): the header value carries an FK to
 *    heartbeat_runs, and an attacker-supplied uuid-shaped value would fail
 *    the insert and silently drop the refusal.
 *  - Repeat refusals from the same actor for the same reason+route inside a
 *    short window collapse to one row (M6) — refusal storms must not flood
 *    the activity feed the evaluator reads.
 *  - Logging must never break the request: failures are swallowed after a
 *    warn-level log, and the caller gets the original error regardless.
 *
 * Company attribution order: the call site's companyId when it matches the
 * actor's own scope; otherwise the server-derived actor company
 * (req.actor.companyId for agents, first membership/companyId for board
 * actors — M3), else the row is skipped rather than misattributed.
 */

/** Actor attribution for refusals raised outside an HTTP request (M4). */
export interface AuthzRefusalActorDescriptor {
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  /** The actor's own company. Required so an agent's refusal can never fall back to a foreign scope (H1). */
  companyId: string | null;
}

export interface AuthzRefusalInput {
  /** The express request, when the refusal happened on an HTTP path. */
  req?: Request;
  /** Actor attribution for non-HTTP callers (service-level verdicts, M4). */
  actor?: AuthzRefusalActorDescriptor;
  companyId: string | null;
  entityType: string;
  entityId: string | null;
  reasonCode: string;
  /** Company the actor was refused ON, when different from the row's company. */
  targetCompanyId?: string | null;
  /** Overrides for non-HTTP callers (req-derived otherwise). */
  method?: string;
  routePath?: string;
}

const AUTHZ_REFUSED_ACTION = "authz.refused";
const ROUTE_PATH_MAX_LENGTH = 200;
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_ENTRIES = 1_000;

/**
 * actor+reasonCode+route+entity -> window start. In-process only; restart
 * resets it. The entity is part of the key so that distinct forbidden acts on
 * distinct records are never collapsed: the window suppresses a retry loop
 * hammering the same act, not breadth.
 */
const recentRefusals = new Map<string, number>();

function dedupeKey(parts: {
  actorType: string;
  actorId: string;
  reasonCode: string;
  routePath: string;
  entityType: string;
  entityId: string | null;
}): string {
  return `${parts.actorType}:${parts.actorId}:${parts.reasonCode}:${parts.routePath}:${parts.entityType}:${parts.entityId ?? ""}`;
}

/**
 * The company a descriptor-attributed refusal is charged to. A user may fall
 * back to the caller's scope (their own refusal context); an agent never does,
 * so a service caller that omits the agent's company records nothing rather
 * than charging a foreign company (H1 holds on the service path too).
 */
function descriptorCompanyId(actor: AuthzRefusalActorDescriptor, callerCompanyId: string | null): string | null {
  if (actor.companyId) return actor.companyId;
  return actor.actorType === "user" ? callerCompanyId ?? null : null;
}

function isDuplicateRefusal(key: string, now: number): boolean {
  const windowStart = recentRefusals.get(key);
  if (windowStart !== undefined && now - windowStart < DEDUPE_WINDOW_MS) {
    return true;
  }
  if (recentRefusals.size >= DEDUPE_MAX_ENTRIES) {
    recentRefusals.clear();
  }
  recentRefusals.set(key, now);
  return false;
}

/**
 * Clear the in-process dedupe window. Test isolation only (the map is
 * module-level and would otherwise suppress identical refusals across test
 * cases); production restarts reset it naturally.
 */
export function resetAuthzRefusalDedupe(): void {
  recentRefusals.clear();
}

/**
 * The route PATTERN, never the raw URL (H2): query strings can carry search
 * text and emails, and specific ids make the field high-cardinality for the
 * evaluator. Falls back to req.path (still query-free) when the route is not
 * matched yet.
 */
function routePatternOf(req: Request): string {
  const routePath =
    (typeof req.baseUrl === "string" ? req.baseUrl : "") +
    (req.route?.path && typeof req.route.path === "string" ? req.route.path : "");
  const candidate = routePath || (typeof req.path === "string" ? req.path : "");
  return candidate.slice(0, ROUTE_PATH_MAX_LENGTH);
}

/** Server-derived company the actor BELONGS to (never the refused target). */
function actorCompanyIdFromReq(req: Request): string | null {
  const actor = req.actor;
  if (actor.type === "agent") {
    return actor.companyId ?? null;
  }
  if (actor.type === "board") {
    const membershipCompany = Array.isArray(actor.memberships)
      ? actor.memberships.find((m) => m.companyId)?.companyId ?? null
      : null;
    return membershipCompany ?? (Array.isArray(actor.companyIds) ? actor.companyIds[0] ?? null : null);
  }
  return null;
}

export async function logAuthzRefusal(
  db: Db,
  input: AuthzRefusalInput,
): Promise<void> {
  const { req } = input;

  let actorType: "agent" | "user";
  let actorId: string;
  let agentId: string | null;
  let actorCompanyId: string | null;
  let method: string;
  let routePath: string;

  if (req) {
    if (req.actor.type === "none" && !input.actor) {
      // No authenticated actor and no descriptor — nothing to attribute.
      return;
    }
    if (req.actor.type === "none" && input.actor) {
      // M4: an anonymous stand-in request from a service-level caller with a
      // real actor descriptor — attribute via the descriptor instead.
      actorType = input.actor.actorType;
      actorId = input.actor.actorId;
      agentId = input.actor.agentId ?? null;
      actorCompanyId = descriptorCompanyId(input.actor, input.companyId);
      method = input.method ?? "SERVICE";
      routePath = (input.routePath ?? "service").slice(0, ROUTE_PATH_MAX_LENGTH);
    } else {
      actorType = req.actor.type === "agent" ? "agent" : "user";
      actorId =
        req.actor.type === "agent"
          ? (req.actor.agentId ?? "unknown-agent")
          : (req.actor.userId ?? "board");
      agentId = req.actor.type === "agent" ? (req.actor.agentId ?? null) : null;
      actorCompanyId = actorCompanyIdFromReq(req);
      // Explicit overrides win (a caller that knows the matched route pattern,
      // e.g. the verdict service, is more accurate than req.path fallback).
      method = input.method ?? (typeof req.method === "string" ? req.method.toUpperCase() : "UNKNOWN");
      routePath = (input.routePath ?? routePatternOf(req)).slice(0, ROUTE_PATH_MAX_LENGTH);
    }
  } else if (input.actor) {
    // Non-HTTP caller (M4): the actor descriptor is authoritative. Unlike the
    // HTTP path, input.companyId is the service's own company scope (e.g. the
    // verdict's company, which a refused self-reviewer belongs to) — so it is
    // a safe attribution fallback here. H1's target/actor split is an
    // HTTP-request concern; service callers have no foreign target.
    actorType = input.actor.actorType;
    actorId = input.actor.actorId;
    agentId = input.actor.agentId ?? null;
    actorCompanyId = descriptorCompanyId(input.actor, input.companyId);
    method = input.method ?? "SERVICE";
    routePath = (input.routePath ?? "service").slice(0, ROUTE_PATH_MAX_LENGTH);
  } else {
    // Neither an HTTP request nor an actor descriptor — unattributable.
    return;
  }

  // H1: an agent's refusal is charged to the agent's own company, never to
  // the company it was refused on. Board/user rows keep the call-site target.
  let rowCompanyId: string | null;
  if (actorType === "agent") {
    rowCompanyId = actorCompanyId ?? null;
  } else {
    rowCompanyId = input.companyId ?? actorCompanyId ?? null;
  }
  if (!rowCompanyId) {
    // activity_log.companyId is NOT NULL and no company scope is derivable
    // for this actor. Skip rather than misattribute or break the 403/409.
    return;
  }

  const details: Record<string, unknown> = {
    method,
    routePath,
    reasonCode: input.reasonCode,
  };
  if (input.targetCompanyId && input.targetCompanyId !== rowCompanyId) {
    details.targetCompanyId = input.targetCompanyId;
  }

  const now = Date.now();
  if (
    isDuplicateRefusal(
      dedupeKey({
        actorType,
        actorId,
        reasonCode: input.reasonCode,
        routePath,
        entityType: input.entityType,
        entityId: input.entityId,
      }),
      now,
    )
  ) {
    return;
  }

  try {
    await logActivity(db, {
      companyId: rowCompanyId,
      actorType,
      actorId,
      action: AUTHZ_REFUSED_ACTION,
      entityType: input.entityType,
      entityId: input.entityId ?? "unknown",
      agentId,
      // M7: never insert the header-derived runId — it carries an FK to
      // heartbeat_runs and a forged uuid would fail the whole insert.
      runId: null,
      details,
    });
  } catch (err) {
    // A refused request must still get its 403/409. Observability failing is
    // warn-worthy, not request-failing.
    logger.warn({ err, action: AUTHZ_REFUSED_ACTION }, "authz.refused activity log failed");
  }
}
