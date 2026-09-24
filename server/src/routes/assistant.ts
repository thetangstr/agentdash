import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assistantDigestService } from "../services/assistant-digest.js";
import { approvalAuthorityService } from "../services/approval-authority.js";
import { approvalService, issueApprovalService } from "../services/index.js";
import { APPROVAL_RISK_ORDER, summarizeApprovalRisk } from "../services/approval-risk.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * AgentDash assistant MCP (M1, GH #676): the HTTP surface the assistant
 * toolset wraps. Board actors only — the assistant acts for a person, and an
 * agent key reaching these routes would read another human's digest.
 *
 * Both routes are read-only projections; every write an assistant can ever
 * take goes through the existing approval-decision routes with the person's
 * authority re-resolved there (M3/M4).
 */

/**
 * `since` must be an ISO 8601 date or datetime. `new Date` alone is not a
 * validator — it accepts bare numerals like "1" and locale strings, so the
 * shape is pinned before parsing.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

function parseSince(raw: string | undefined): { since: Date } | { error: string } {
  if (raw === undefined) return { since: new Date(Date.now() - 24 * 60 * 60 * 1000) };
  if (!ISO_8601.test(raw.trim())) {
    return { error: "since must be an ISO 8601 timestamp" };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: "since must be an ISO 8601 timestamp" };
  }
  return { since: parsed };
}

/** Human phrasing for an approval kind — one clause, payload stays out. */
const APPROVAL_KIND_PHRASES: Record<string, string> = {
  hire_agent: "hire a new agent",
  approve_issue: "close out a task",
  send_email: "send an email",
  connector_send: "send a message through a connector",
  environment_provision: "provision an environment",
  budget_override: "change a budget",
};

export function assistantRoutes(db: Db) {
  const router = Router();
  const digest = assistantDigestService(db);
  const authority = approvalAuthorityService(db);
  const approvals = approvalService(db);
  const issueApprovals = issueApprovalService(db);

  router.get("/companies/:companyId/assistant/digest", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = parseSince(req.query.since as string | undefined);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const projectId = (req.query.projectId as string | undefined) ?? null;
    res.json(
      await digest.digest({
        companyId,
        userId: req.actor.userId ?? null,
        since: parsed.since,
        projectId,
      }),
    );
  });

  /**
   * Approvals waiting on this person, with `canDecide` computed per row by
   * probing the one authority service — the same shape `decisionActionsFor`
   * uses in steward-inbox. A `canDecide:false` row is still listed: "Priya's
   * request is waiting but you cannot decide it" is an answer a person needs.
   */
  router.get("/companies/:companyId/assistant/pending-decisions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const pending = await approvals.list(companyId, undefined);
    const open = pending.filter((row) => row.status === "pending" || row.status === "revision_requested");

    const audience = await digest.audienceAgents(companyId, req.actor.userId ?? null);
    const mineIds = new Set(audience.map((agent) => agent.id));
    const nameById = new Map(audience.map((agent) => [agent.id, agent.name]));

    // Agentless approvals are board-filed — an admin can still decide them,
    // so they belong in the list rather than silently dropped.
    const scoped = open.filter(
      (row) => !row.requestedByAgentId || mineIds.has(row.requestedByAgentId),
    );

    // "Most urgent first" is the tool's contract — rank by the board's own
    // risk order, ties broken by longest wait, before the cap.
    const ranked = scoped
      .map((approval) => ({
        approval,
        risk: summarizeApprovalRisk(approval.type, approval.payload),
      }))
      .sort((a, b) => {
        const byRisk = APPROVAL_RISK_ORDER[a.risk.level] - APPROVAL_RISK_ORDER[b.risk.level];
        if (byRisk !== 0) return byRisk;
        return (a.approval.createdAt?.getTime?.() ?? 0) - (b.approval.createdAt?.getTime?.() ?? 0);
      });

    const decisions = await Promise.all(
      ranked.slice(0, 50).map(async ({ approval, risk }) => {
        let canDecide = false;
        try {
          // Match the real decision path: requireDecisionActor returns null
          // when the company needs no decision role (non-MK), and the caller
          // substitutes "admin" — null means allowed, not refused. Only a
          // thrown refusal means this person cannot decide.
          await authority.requireDecisionActor(approval as never, req.actor as never);
          canDecide = true;
        } catch {
          canDecide = false;
        }
        const linked = await issueApprovals.listIssuesForApproval(approval.id).catch(() => []);
        const first = Array.isArray(linked) ? linked[0] : null;
        const phrase = APPROVAL_KIND_PHRASES[approval.type] ?? `act on "${approval.type}"`;
        const asker = approval.requestedByAgentId ? nameById.get(approval.requestedByAgentId) ?? "An agent" : "The board";
        return {
          approvalId: approval.id,
          kind: approval.type,
          revision: approval.revision,
          askedBy: approval.requestedByAgentId ? nameById.get(approval.requestedByAgentId) ?? null : null,
          summary: `${asker} asks to ${phrase}.`,
          relatedItem: first
            ? { id: first.id, identifier: first.identifier ?? null, title: first.title ?? null }
            : null,
          waitingSince: approval.createdAt?.toISOString?.() ?? null,
          canDecide,
          risk,
        };
      }),
    );

    // "What's waiting on me" is broader than approvals — see the service.
    const tasks = await digest.tasksAssignedTo(companyId, req.actor.userId ?? null);

    res.json({
      decisions,
      total: scoped.length,
      shown: decisions.length,
      tasksAssignedToYou: tasks.items,
      tasksAssignedToYouTotal: tasks.total,
    });
  });

  return router;
}
