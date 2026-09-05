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
 * Scope guards (per issue):
 *  - Anonymous 401s are NOT logged — there is no actor to attribute.
 *  - `details` carries only { method, routePath, reasonCode } — never request
 *    bodies.
 *  - Logging must never break the request: failures are swallowed after a
 *    warn-level log, and the caller gets the original error regardless.
 *
 * companyId may be null when the guard refuses before the company scope is
 * known (e.g. no authenticated actor company, or a board actor outside the
 * company). Those refusals still need an actor-attributed record, so the row
 * falls back to the actor's own company when one exists.
 */
export interface AuthzRefusalInput {
  req: Request;
  companyId: string | null;
  entityType: string;
  entityId: string | null;
  reasonCode: string;
}

const AUTHZ_REFUSED_ACTION = "authz.refused";

export async function logAuthzRefusal(
  db: Db,
  input: AuthzRefusalInput,
): Promise<void> {
  const { req } = input;
  if (req.actor.type === "none") {
    // No authenticated actor — nothing to attribute the refusal to.
    return;
  }

  const actorType = req.actor.type === "agent" ? "agent" : "user";
  const actorId =
    req.actor.type === "agent"
      ? (req.actor.agentId ?? "unknown-agent")
      : (req.actor.userId ?? "board");
  const agentId = req.actor.type === "agent" ? (req.actor.agentId ?? null) : null;
  const resolvedCompanyId = input.companyId ?? req.actor.companyId ?? null;
  if (!resolvedCompanyId) {
    // activity_log.companyId is NOT NULL and no company scope is derivable
    // from the request or the actor. Skip rather than break the 403/409.
    return;
  }

  const details: Record<string, unknown> = {
    method: typeof req.method === "string" ? req.method.toUpperCase() : "UNKNOWN",
    routePath: req.originalUrl ?? req.url ?? "",
    reasonCode: input.reasonCode,
  };

  try {
    await logActivity(db, {
      companyId: resolvedCompanyId,
      actorType,
      actorId,
      action: AUTHZ_REFUSED_ACTION,
      entityType: input.entityType,
      entityId: input.entityId ?? "unknown",
      agentId,
      runId: req.actor.runId ?? null,
      details,
    });
  } catch (err) {
    // A refused request must still get its 403/409. Observability failing is
    // warn-worthy, not request-failing.
    logger.warn({ err, action: AUTHZ_REFUSED_ACTION }, "authz.refused activity log failed");
  }
}
