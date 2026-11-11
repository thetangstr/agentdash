import { and, inArray, like, not, or, type SQL } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import {
  activityVisibilityCondition,
  agentVisibilityCondition,
  canReadCompanySpend,
  redactHiddenIssuesInActivityRows,
  resolveAgentVisibility,
} from "../routes/visibility.js";

/**
 * AgentDash admin powers (part 4): the ONE read filter over the activity log.
 *
 * The company activity feed (`GET /companies/:companyId/activity`) and the
 * admin audit (`GET /companies/:companyId/audit` and `audit.csv`) both read
 * through this scope, so the audit can never show a row, or a field of a row,
 * that the same person could not already read in the feed. It adds filters
 * and paging, never read authority.
 *
 * - `visibleWhere`: rows about an issue or project the actor cannot see
 *   (A5, GH #830), monetary rows without spend access (#1057), and rows about
 *   an agent the actor cannot see (agent visibility, 2026-09-30) are absent.
 * - `redact(rows)`: hidden budget amounts are dropped from the details of the
 *   rows that remain, and blocker/referenced-issue entries follow issue
 *   visibility (GH #863).
 */
export interface ActivityReadScope {
  canReadSpend: boolean;
  visibleWhere: SQL | undefined;
  redact<R extends { details?: Record<string, unknown> | null }>(rows: R[]): Promise<R[]>;
}

export async function buildActivityReadScope(db: Db, req: Request, companyId: string): Promise<ActivityReadScope> {
  await resolveAgentVisibility(db, req, companyId);
  const canReadSpend = await canReadCompanySpend(db, req, companyId);
  const visibleWhere = and(
    activityVisibilityCondition(req, companyId),
    // AgentDash (#1057): monetary activity is no exception to spend access.
    canReadSpend ? undefined : not(or(
      inArray(activityLog.entityType, ["cost_event", "finance_event", "budget_policy", "budget_incident"]),
      like(activityLog.action, "cost.%"), like(activityLog.action, "finance.%"), like(activityLog.action, "budget.%"),
      inArray(activityLog.action, ["company.budget_updated", "agent.budget_updated"]),
    )!),
    // Agent visibility (2026-09-30): rows about an invisible agent are absent.
    agentVisibilityCondition(req, companyId, activityLog.agentId),
  );
  return {
    canReadSpend,
    visibleWhere,
    async redact(rows) {
      // Generic company/agent update events may carry these fields alongside
      // nonfinancial edits; preserve the event while omitting hidden amounts.
      const spendSafe = canReadSpend ? rows : rows.map((row) => {
        if (!row.details) return row;
        const { budgetMonthlyCents: _budget, spentMonthlyCents: _spent, ...details } = row.details;
        return { ...row, details };
      });
      // GH #863: blocker and referenced-issue entries in details follow visibility.
      return redactHiddenIssuesInActivityRows(db, req, companyId, spendSafe);
    },
  };
}
