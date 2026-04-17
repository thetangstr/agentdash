// AgentDash: Feed service
// Aggregates approvals + event tables into a unified activity feed.
// Pragmatic design: fan out N separate selects (one per source table),
// tag each row with a stable `type`, merge in TypeScript, sort by `at` DESC,
// apply cursor pagination. Each source query is bounded by `(limit + 1) * N`
// at worst; we then trim to `limit` after merging.

import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  agents,
  approvals,
  costEvents,
  financeEvents,
  heartbeatRunEvents,
  killSwitchEvents,
  skillUsageEvents,
} from "@agentdash/db";

export type FeedEvent = {
  id: string;
  type: string;
  title: string;
  actorAgentId?: string | null;
  actorUserId?: string | null;
  refType?: string | null;
  refId?: string | null;
  at: Date;
  meta?: Record<string, unknown>;
};

export type FeedListResult = {
  events: FeedEvent[];
  nextCursor: string | null;
};

type Cursor = { at: Date; id: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(c: Cursor): string {
  const raw = `${c.at.toISOString()}|${c.id}`;
  // Use btoa for portability; Node >= 16 has it as a global.
  return btoa(raw);
}

function decodeCursor(s: string): Cursor | null {
  try {
    const raw = atob(s);
    const idx = raw.indexOf("|");
    if (idx < 0) return null;
    const atStr = raw.slice(0, idx);
    const id = raw.slice(idx + 1);
    const at = new Date(atStr);
    if (Number.isNaN(at.getTime())) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export function feedService(db: Db) {
  return {
    async list(
      companyId: string,
      opts: { userId?: string; cursor?: string | null; limit?: number } = {},
    ): Promise<FeedListResult> {
      const userId = opts.userId ?? null;
      const requestedLimit = opts.limit ?? DEFAULT_LIMIT;
      const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT));
      const fetchPerSource = limit + 1; // small buffer so we can compute nextCursor

      const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

      // Resolve agent IDs owned by the user when filtering by userId.
      // Used for skill/heartbeat filters which reference agentId (no user column).
      let ownedAgentIds: string[] | null = null;
      if (userId) {
        const ownedRows = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.ownerUserId, userId)));
        ownedAgentIds = ownedRows.map((r) => r.id as string);
      }

      // --- approvals ------------------------------------------------------
      const approvalConditions: SQL[] = [eq(approvals.companyId, companyId)];
      if (cursor) {
        approvalConditions.push(
          or(
            lt(approvals.createdAt, cursor.at),
            and(eq(approvals.createdAt, cursor.at), lt(approvals.id, cursor.id)) as SQL,
          ) as SQL,
        );
      }
      if (userId) {
        approvalConditions.push(
          or(
            eq(approvals.requestedByUserId, userId),
            eq(approvals.decidedByUserId, userId),
          ) as SQL,
        );
      }
      const approvalRows = await db
        .select()
        .from(approvals)
        .where(and(...approvalConditions))
        .orderBy(desc(approvals.createdAt))
        .limit(fetchPerSource);

      // --- cost_events ---------------------------------------------------
      // Skip entirely when filtering by user — no user dimension on cost rows.
      let costRows: (typeof costEvents.$inferSelect)[] = [];
      if (!userId) {
        const costConditions: SQL[] = [eq(costEvents.companyId, companyId)];
        if (cursor) {
          costConditions.push(
            or(
              lt(costEvents.occurredAt, cursor.at),
              and(
                eq(costEvents.occurredAt, cursor.at),
                lt(costEvents.id, cursor.id),
              ) as SQL,
            ) as SQL,
          );
        }
        costRows = await db
          .select()
          .from(costEvents)
          .where(and(...costConditions))
          .orderBy(desc(costEvents.occurredAt))
          .limit(fetchPerSource);
      }

      // --- finance_events -------------------------------------------------
      // Skip entirely when filtering by user — no user dimension on finance rows.
      let financeRows: (typeof financeEvents.$inferSelect)[] = [];
      if (!userId) {
        const financeConditions: SQL[] = [eq(financeEvents.companyId, companyId)];
        if (cursor) {
          financeConditions.push(
            or(
              lt(financeEvents.occurredAt, cursor.at),
              and(
                eq(financeEvents.occurredAt, cursor.at),
                lt(financeEvents.id, cursor.id),
              ) as SQL,
            ) as SQL,
          );
        }
        financeRows = await db
          .select()
          .from(financeEvents)
          .where(and(...financeConditions))
          .orderBy(desc(financeEvents.occurredAt))
          .limit(fetchPerSource);
      }

      // --- kill_switch_events --------------------------------------------
      const killConditions: SQL[] = [eq(killSwitchEvents.companyId, companyId)];
      if (cursor) {
        killConditions.push(
          or(
            lt(killSwitchEvents.triggeredAt, cursor.at),
            and(
              eq(killSwitchEvents.triggeredAt, cursor.at),
              lt(killSwitchEvents.id, cursor.id),
            ) as SQL,
          ) as SQL,
        );
      }
      if (userId) {
        killConditions.push(eq(killSwitchEvents.triggeredByUserId, userId));
      }
      const killRows = await db
        .select()
        .from(killSwitchEvents)
        .where(and(...killConditions))
        .orderBy(desc(killSwitchEvents.triggeredAt))
        .limit(fetchPerSource);

      // --- skill_usage_events --------------------------------------------
      // When filtering by user, scope to events from agents the user owns.
      // If the user owns no agents, skip the query entirely.
      let skillRows: (typeof skillUsageEvents.$inferSelect)[] = [];
      if (!userId || (ownedAgentIds && ownedAgentIds.length > 0)) {
        const skillConditions: SQL[] = [eq(skillUsageEvents.companyId, companyId)];
        if (cursor) {
          skillConditions.push(
            or(
              lt(skillUsageEvents.usedAt, cursor.at),
              and(
                eq(skillUsageEvents.usedAt, cursor.at),
                lt(skillUsageEvents.id, cursor.id),
              ) as SQL,
            ) as SQL,
          );
        }
        if (userId && ownedAgentIds && ownedAgentIds.length > 0) {
          skillConditions.push(inArray(skillUsageEvents.agentId, ownedAgentIds));
        }
        skillRows = await db
          .select()
          .from(skillUsageEvents)
          .where(and(...skillConditions))
          .orderBy(desc(skillUsageEvents.usedAt))
          .limit(fetchPerSource);
      }

      // --- heartbeat_run_events ------------------------------------------
      // Note: heartbeat_run_events.id is bigserial (number), so we use
      // createdAt only for the cursor comparison here.
      let heartbeatRows: (typeof heartbeatRunEvents.$inferSelect)[] = [];
      if (!userId || (ownedAgentIds && ownedAgentIds.length > 0)) {
        const heartbeatConditions: SQL[] = [eq(heartbeatRunEvents.companyId, companyId)];
        if (cursor) {
          heartbeatConditions.push(lt(heartbeatRunEvents.createdAt, cursor.at));
        }
        if (userId && ownedAgentIds && ownedAgentIds.length > 0) {
          heartbeatConditions.push(inArray(heartbeatRunEvents.agentId, ownedAgentIds));
        }
        heartbeatRows = await db
          .select()
          .from(heartbeatRunEvents)
          .where(and(...heartbeatConditions))
          .orderBy(desc(heartbeatRunEvents.createdAt))
          .limit(fetchPerSource);
      }

      // --- normalize into FeedEvent shape --------------------------------
      const merged: FeedEvent[] = [];

      for (const r of approvalRows) {
        merged.push({
          id: r.id,
          type: "approval_decision",
          title: `Approval ${r.type} — ${r.status}`,
          actorAgentId: r.requestedByAgentId ?? null,
          actorUserId: r.decidedByUserId ?? null,
          refType: "approval",
          refId: r.id,
          at: r.createdAt,
          meta: {
            status: r.status,
            approvalType: r.type,
            decisionNote: r.decisionNote,
          },
        });
      }

      for (const r of costRows) {
        merged.push({
          id: r.id,
          type: "cost_event",
          title: `Cost ${r.provider}/${r.model} — ${r.costCents}¢`,
          actorAgentId: r.agentId ?? null,
          actorUserId: null,
          refType: r.heartbeatRunId ? "heartbeat_run" : null,
          refId: r.heartbeatRunId ?? null,
          at: r.occurredAt,
          meta: {
            provider: r.provider,
            model: r.model,
            costCents: r.costCents,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
          },
        });
      }

      for (const r of financeRows) {
        merged.push({
          id: r.id,
          type: "finance",
          title: `Finance ${r.eventKind} ${r.direction} ${r.amountCents}¢`,
          actorAgentId: r.agentId ?? null,
          actorUserId: null,
          refType: r.heartbeatRunId ? "heartbeat_run" : null,
          refId: r.heartbeatRunId ?? null,
          at: r.occurredAt,
          meta: {
            eventKind: r.eventKind,
            direction: r.direction,
            amountCents: r.amountCents,
            currency: r.currency,
            biller: r.biller,
          },
        });
      }

      for (const r of killRows) {
        merged.push({
          id: r.id,
          type: "kill_switch",
          title: `Kill switch ${r.action} — ${r.scope}`,
          actorAgentId: null,
          actorUserId: r.triggeredByUserId ?? null,
          refType: r.scope,
          refId: r.scopeId,
          at: r.triggeredAt,
          meta: {
            action: r.action,
            scope: r.scope,
            reason: r.reason,
          },
        });
      }

      for (const r of skillRows) {
        merged.push({
          id: r.id,
          type: "skill_use",
          title: `Skill used`,
          actorAgentId: r.agentId ?? null,
          actorUserId: null,
          refType: "skill",
          refId: r.skillId,
          at: r.usedAt,
          meta: {
            skillId: r.skillId,
            versionId: r.versionId,
            issueId: r.issueId,
          },
        });
      }

      for (const r of heartbeatRows) {
        merged.push({
          id: String(r.id),
          type: "heartbeat",
          title: `Heartbeat ${r.eventType}`,
          actorAgentId: r.agentId ?? null,
          actorUserId: null,
          refType: "heartbeat_run",
          refId: r.runId,
          at: r.createdAt,
          meta: {
            eventType: r.eventType,
            stream: r.stream,
            level: r.level,
            message: r.message,
          },
        });
      }

      // Sort DESC by (at, id)
      merged.sort((a, b) => {
        const dt = b.at.getTime() - a.at.getTime();
        if (dt !== 0) return dt;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

      // Defensive in-memory cursor filter. The per-source WHERE clauses
      // above already enforce this in the DB, but re-applying here guards
      // against source tables whose native id type (e.g. bigserial) can't
      // safely participate in the SQL tiebreak.
      const filtered = cursor
        ? merged.filter((e) => {
            if (e.at.getTime() < cursor.at.getTime()) return true;
            if (e.at.getTime() > cursor.at.getTime()) return false;
            return e.id < cursor.id;
          })
        : merged;

      const page = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      const nextCursor =
        hasMore && page.length > 0
          ? encodeCursor({ at: page[page.length - 1].at, id: page[page.length - 1].id })
          : null;

      return { events: page, nextCursor };
    },
  };
}
