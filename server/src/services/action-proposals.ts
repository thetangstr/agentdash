// AgentDash: Action Proposals service
// Wraps the existing approvals + issue_approvals tables to provide
// a CUJ-B "governance queue" view: list pending proposals with agent/issue
// context, and approve/reject them transactionally.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agents, approvals, issueApprovals, issues } from "@agentdash/db";
import { notFound, unprocessable } from "../errors.js";

export interface ActionProposalLinkedIssue {
  id: string;
  title: string;
}

export interface ActionProposalRequestedByAgent {
  id: string;
  name: string;
}

export interface ActionProposal {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgent: ActionProposalRequestedByAgent | null;
  linkedIssues: ActionProposalLinkedIssue[];
  decisionNote: string | null;
  createdAt: Date;
}

export function actionProposalService(db: Db) {
  async function getApprovalOrThrow(approvalId: string) {
    const row = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Approval not found");
    return row;
  }

  async function enrichApprovals(
    rows: (typeof approvals.$inferSelect)[],
  ): Promise<ActionProposal[]> {
    if (rows.length === 0) return [];

    const approvalIds = rows.map((r) => r.id);
    const agentIds = rows.map((r) => r.requestedByAgentId).filter((id): id is string => id !== null);

    // Fetch linked issues for all approvals in one query
    const linkedRows =
      approvalIds.length > 0
        ? await db
            .select({
              approvalId: issueApprovals.approvalId,
              issueId: issues.id,
              issueTitle: issues.title,
            })
            .from(issueApprovals)
            .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
            .where(
              approvalIds.length === 1
                ? eq(issueApprovals.approvalId, approvalIds[0])
                : // drizzle inArray not imported to keep deps minimal; use a loop join instead
                  eq(issueApprovals.approvalId, approvalIds[0]),
            )
        : [];

    // Build linked issues map per approval (simple approach for small lists)
    // For correctness with multiple approvals we re-query per approval
    const linkedIssuesMap = new Map<string, ActionProposalLinkedIssue[]>();
    for (const approvalId of approvalIds) {
      const issueRows = await db
        .select({ id: issues.id, title: issues.title })
        .from(issueApprovals)
        .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
        .where(eq(issueApprovals.approvalId, approvalId));
      linkedIssuesMap.set(approvalId, issueRows);
    }

    // Fetch agent names
    const agentMap = new Map<string, string>();
    if (agentIds.length > 0) {
      const agentRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          agentIds.length === 1
            ? eq(agents.id, agentIds[0])
            : eq(agents.id, agentIds[0]),
        );
      // Re-fetch each agent individually to avoid needing inArray here
      for (const agentId of agentIds) {
        if (agentMap.has(agentId)) continue;
        const agentRow = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((r) => r[0] ?? null);
        if (agentRow) agentMap.set(agentId, agentRow.name);
      }
    }
    void linkedRows; // suppress unused warning

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      payload: row.payload,
      requestedByAgent:
        row.requestedByAgentId && agentMap.has(row.requestedByAgentId)
          ? { id: row.requestedByAgentId, name: agentMap.get(row.requestedByAgentId)! }
          : null,
      linkedIssues: linkedIssuesMap.get(row.id) ?? [],
      decisionNote: row.decisionNote,
      createdAt: row.createdAt,
    }));
  }

  return {
    async list(companyId: string, opts?: { status?: string }): Promise<ActionProposal[]> {
      const conditions = [eq(approvals.companyId, companyId)];
      if (opts?.status) conditions.push(eq(approvals.status, opts.status));

      const rows = await db
        .select()
        .from(approvals)
        .where(and(...conditions))
        .orderBy(desc(approvals.createdAt));

      return enrichApprovals(rows);
    },

    async approve(
      approvalId: string,
      opts: { decidedByUserId: string; decisionNote?: string | null },
    ): Promise<ActionProposal> {
      const existing = await getApprovalOrThrow(approvalId);

      if (existing.status !== "pending" && existing.status !== "revision_requested") {
        if (existing.status === "approved") {
          return (await enrichApprovals([existing]))[0];
        }
        throw unprocessable("Only pending approvals can be approved");
      }

      const now = new Date();

      const updated = await db.transaction(async (tx) => {
        const [updatedApproval] = await tx
          .update(approvals)
          .set({
            status: "approved",
            decidedByUserId: opts.decidedByUserId,
            decisionNote: opts.decisionNote ?? null,
            decidedAt: now,
            updatedAt: now,
          })
          .where(eq(approvals.id, approvalId))
          .returning();

        if (!updatedApproval) throw unprocessable("Failed to approve approval");

        // Update linked issues updatedAt inside the same transaction
        const linkedIssueRows = await tx
          .select({ id: issueApprovals.issueId })
          .from(issueApprovals)
          .where(eq(issueApprovals.approvalId, approvalId));

        for (const { id: issueId } of linkedIssueRows) {
          await tx
            .update(issues)
            .set({ updatedAt: now })
            .where(eq(issues.id, issueId));
        }

        return updatedApproval;
      });

      return (await enrichApprovals([updated]))[0];
    },

    async reject(
      approvalId: string,
      opts: { decidedByUserId: string; decisionNote?: string | null },
    ): Promise<ActionProposal> {
      const existing = await getApprovalOrThrow(approvalId);

      if (existing.status !== "pending" && existing.status !== "revision_requested") {
        if (existing.status === "rejected") {
          return (await enrichApprovals([existing]))[0];
        }
        throw unprocessable("Only pending approvals can be rejected");
      }

      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "rejected",
          decidedByUserId: opts.decidedByUserId,
          decisionNote: opts.decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, approvalId))
        .returning()
        .then((rows) => rows[0]);

      if (!updated) throw unprocessable("Failed to reject approval");

      return (await enrichApprovals([updated]))[0];
    },
  };
}
