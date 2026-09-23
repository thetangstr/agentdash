import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assistantDigestService } from "../services/assistant-digest.js";
import { approvalAuthorityService } from "../services/approval-authority.js";
import { approvalService, issueApprovalService } from "../services/index.js";
import { summarizeApprovalRisk } from "../services/approval-risk.js";
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

/** `since` must be an ISO 8601 timestamp the server can parse. */
function parseSince(raw: string | undefined): { since: Date } | { error: string } {
  if (raw === undefined) return { since: new Date(Date.now() - 24 * 60 * 60 * 1000) };
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

    const scoped = open.filter(
      (row) => row.requestedByAgentId && mineIds.has(row.requestedByAgentId),
    );

    const decisions = await Promise.all(
      scoped.slice(0, 50).map(async (approval) => {
        let canDecide = false;
        try {
          // Null means "no decision role" (e.g. a non-MK company) — only a
          // thrown refusal and a null return are both "cannot decide".
          canDecide =
            (await authority.requireDecisionActor(approval as never, req.actor as never)) !== null;
        } catch {
          canDecide = false;
        }
        const linked = await issueApprovals.listIssuesForApproval(approval.id).catch(() => []);
        const first = Array.isArray(linked) ? linked[0] : null;
        const risk = summarizeApprovalRisk(approval.type, approval.payload);
        const phrase = APPROVAL_KIND_PHRASES[approval.type] ?? `act on "${approval.type}"`;
        return {
          approvalId: approval.id,
          kind: approval.type,
          revision: approval.revision,
          askedBy: approval.requestedByAgentId ? nameById.get(approval.requestedByAgentId) ?? null : null,
          summary: `${nameById.get(approval.requestedByAgentId ?? "") ?? "An agent"} asks to ${phrase}.`,
          relatedItem: first
            ? { id: first.id, identifier: first.identifier ?? null, title: first.title ?? null }
            : null,
          waitingSince: approval.createdAt?.toISOString?.() ?? null,
          canDecide,
          risk,
        };
      }),
    );

    res.json({ decisions, total: scoped.length, shown: decisions.length });
  });

  return router;
}
