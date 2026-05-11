// AgentDash (#207): adapters that satisfy heartbeatDigest's Deps interface so
// the dailyDigest scheduler in server/src/index.ts can wire it up against the
// real DB + Resend transport. Kept separate from heartbeat-digest.ts so that
// service stays a pure orchestrator (testable with mocks) and these adapters
// own the persistence concerns.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companyMemberships,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { sendEmail } from "../auth/email.js";

interface Activity {
  agentName: string;
  summary: string;
}

interface DigestUser {
  id: string;
  email: string;
  timezone?: string;
}

/**
 * Lists every authenticated user with a verified email AND at least one active
 * "user" company membership. Per onboarding spec §5 the digest goes to all
 * conversation participants — we approximate "participant" as "active member
 * of any company" until we wire per-conversation participant lookup.
 *
 * Timezone is left undefined; v1 ticks once per UTC day. Per-user timezone is
 * a follow-up (#207 acceptance criteria explicitly defer it).
 */
export function digestUserAdapter(db: Db) {
  return {
    listForDigest: async (): Promise<DigestUser[]> => {
      const rows = await db
        .selectDistinct({
          id: authUsers.id,
          email: authUsers.email,
        })
        .from(authUsers)
        .innerJoin(
          companyMemberships,
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, authUsers.id),
            eq(companyMemberships.status, "active"),
          ),
        )
        .where(eq(authUsers.emailVerified, true));
      return rows.map((row) => ({ id: row.id, email: row.email }));
    },
  };
}

/**
 * For a given user, returns chat-worthy agent activity from the last `hours`
 * hours, scoped to companies the user is an active member of. One row per
 * agent — multiple updates from the same agent are summarised into a single
 * line ("Reese: 14 outreach drafts overnight + 2 more updates").
 *
 * Filters to actorType="agent" so system events and human edits don't leak
 * into the digest. Per the chat-substrate spec the digest mirrors the
 * agent_status_v1 cards, which are also agent-authored.
 */
export function digestActivityAdapter(db: Db) {
  return {
    listSince: async (userId: string, sinceHours: number): Promise<Activity[]> => {
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

      // Companies the user can see.
      const memberships = await db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        );
      const companyIds = memberships.map((m) => m.companyId);
      if (companyIds.length === 0) return [];

      // One row per agent — count + most recent action serve as the summary.
      const rows = await db
        .select({
          agentId: activityLog.agentId,
          agentName: agents.name,
          count: sql<number>`count(*)::int`,
          latestAction: sql<string>`(array_agg(${activityLog.action} ORDER BY ${activityLog.createdAt} DESC))[1]`,
          latestAt: sql<Date>`max(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .innerJoin(agents, eq(agents.id, activityLog.agentId))
        .where(
          and(
            inArray(activityLog.companyId, companyIds),
            eq(activityLog.actorType, "agent"),
            gte(activityLog.createdAt, since),
          ),
        )
        .groupBy(activityLog.agentId, agents.name)
        .orderBy(desc(sql`max(${activityLog.createdAt})`));

      return rows
        .filter((row) => !!row.agentName)
        .map((row) => ({
          agentName: row.agentName,
          summary:
            row.count > 1
              ? `${row.count} updates (latest: ${row.latestAction})`
              : row.latestAction,
        }));
    },
  };
}

/**
 * Wraps the existing Resend wrapper. Failures are caught + logged inside
 * sendEmail (it never throws), but we still surface here so callers can
 * react if needed; today the heartbeatDigest service ignores per-message
 * failures and continues with the next user.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function digestEmailAdapter() {
  return {
    send: async (msg: { to: string; subject: string; body: string }): Promise<void> => {
      const result = await sendEmail({
        to: msg.to,
        subject: msg.subject,
        text: msg.body,
        html: `<pre style="font-family: -apple-system, system-ui, sans-serif; white-space: pre-wrap;">${escapeHtml(msg.body)}</pre>`,
      });
      if (result.status !== "sent") {
        logger.warn(
          { to: msg.to, status: result.status, error: result.error },
          "[digest] heartbeat digest email not sent",
        );
      }
    },
  };
}
