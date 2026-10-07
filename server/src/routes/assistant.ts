import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  assistantConfirmActionSchema,
  assistantPrepareDecisionSchema,
  assistantPrepareHireSchema,
  updateAssistantGrantSchema,
} from "@paperclipai/shared";
import { assistantDigestService } from "../services/assistant-digest.js";
import { assistantOAuthService } from "../services/assistant-oauth.js";
import { waitingOnYouService } from "../services/waiting-on-you.js";
import {
  assistantGatedActionsService,
  type AssistantApprovalVisibility,
} from "../services/assistant-gated-actions.js";
import { validate } from "../middleware/validate.js";
import { forbidden, HttpError, notFound } from "../errors.js";
import { actorHumanRole, assertBoard, assertCompanyAccess } from "./authz.js";
import {
  assertAgentIdVisible,
  assertApprovalProjectVisible,
  listVisibleIssueIds,
  projectVisibilityCondition,
  resolveAgentVisibility,
} from "./visibility.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

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

export function assistantRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; autoDispatchQueuedRuns?: boolean } = {},
) {
  const router = Router();
  const digest = assistantDigestService(db);
  const waitingOnYou = waitingOnYouService(db);
  // Lazy: the gated service pulls in the decision-effects chain (heartbeat
  // etc.), which tests that only exercise the read surface don't mock.
  let gatedSvc: ReturnType<typeof assistantGatedActionsService> | null = null;
  const gated = () => (gatedSvc ??= assistantGatedActionsService(db, options));

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
    // AgentDash consolidation PR-A (review H3): the digest applies project
    // visibility, and a projectId the caller cannot see (restricted, another
    // company's, or unknown) is not_found, never a silent empty digest and
    // never 403 — invisible means nonexistent (routes/visibility.ts).
    const visibleProjectIds = await digest.visibleProjectIds(
      companyId,
      projectVisibilityCondition(req, companyId),
    );
    if (projectId !== null && !visibleProjectIds.has(projectId)) {
      throw notFound("Project not found");
    }
    res.json(
      await digest.digest({
        companyId,
        userId: req.actor.userId ?? null,
        since: parsed.since,
        projectId,
        visibleProjectIds,
      }),
    );
  });

  /**
   * What is waiting on this person: approvals with `canDecide`, plus open
   * issues assigned to them. AgentDash: UX-3 (#784) — the definition lives in
   * services/waiting-on-you.ts so the web Home and the assistant's
   * list_pending_decisions read the same thing from this same route.
   */
  router.get("/companies/:companyId/assistant/pending-decisions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // The review list applies the composed issue rule (restricted projects
    // and owner-only agents), so the agent scope is resolved for this request.
    await resolveAgentVisibility(db, req, companyId);
    const result = await waitingOnYou.list(companyId, req.actor as never, {}, req);
    // AgentDash (GH #830 follow-up): an approval's linked issue is named by
    // identifier and title; one in a restricted project the caller is off
    // the list for is dropped from the row, as on GET /approvals/:id/issues.
    const relatedIds = result.decisions
      .map((decision) => decision.relatedItem?.id)
      .filter((id): id is string => typeof id === "string");
    if (relatedIds.length > 0) {
      const visible = await listVisibleIssueIds(db, req, companyId, relatedIds);
      result.decisions = result.decisions.map((decision) =>
        decision.relatedItem && !visible.has(decision.relatedItem.id) ? { ...decision, relatedItem: null } : decision,
      );
    }
    res.json(result);
  });

  /**
   * GH #677 — My Agent → Connections: the OAuth grants this person has given
   * assistant clients in this company. Same `me/` shape as bridge endpoints:
   * a person lists and revokes their own connections, never someone else's.
   */
  const oauth = assistantOAuthService(db);

  router.get("/companies/:companyId/me/assistant-grants", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const grants = await oauth.listGrantsForUser(companyId, req.actor.userId!);
    res.json({
      grants: grants.map((grant) => ({
        id: grant.id,
        clientId: grant.clientId,
        clientName: grant.clientName,
        redirectHost: grant.redirectHost,
        scopes: grant.scopes,
        decisionsNeedTap: grant.decisionsNeedTap,
        createdAt: grant.createdAt?.toISOString?.() ?? null,
        lastUsedAt: grant.lastUsedAt?.toISOString?.() ?? null,
      })),
    });
  });

  /**
   * GH #679 (spec §7.2): "decisions need a tap". The person flips this on
   * their own connection; the assistant never touches it — it is the control
   * that makes `confirm_action` hand back the approval link instead of
   * executing.
   */
  router.patch(
    "/companies/:companyId/me/assistant-grants/:grantId",
    validate(updateAssistantGrantSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const updated = await oauth.updateGrantPreferences(
        req.params.grantId as string,
        req.actor.userId!,
        companyId,
        { decisionsNeedTap: req.body.decisionsNeedTap },
      );
      if (!updated) {
        res.status(404).json({ error: "Assistant connection not found" });
        return;
      }
      res.json({ grantId: updated.id, decisionsNeedTap: updated.decisionsNeedTap });
    },
  );

  router.post("/companies/:companyId/me/assistant-grants/:grantId/revoke", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const revoked = await oauth.revokeGrant(
      req.params.grantId as string,
      req.actor.userId!,
      companyId,
    );
    if (!revoked) {
      res.status(404).json({ error: "Assistant connection not found" });
      return;
    }
    res.json({ revoked: true, grantId: revoked.id });
  });

  /**
   * GH #679 (M4, spec §7): the gated actions — the only writes that exist to
   * be confirmed, and the only routes a `pcin_` decide-scope credential can
   * reach. A handle minted at prepare is spent once at confirm, 15 minutes
   * dead; authority is re-resolved at confirm, never trusted from prepare.
   *
   * These routes exist for the assistant connection ONLY. A board actor
   * calling them directly gets 403 — the board has the direct approval and
   * hire routes; the two-step flow is the credential boundary, not a UX
   * choice the caller gets to skip.
   */
  function requireAssistantGrantActor(req: Parameters<typeof assertBoard>[0], companyId: string) {
    assertBoard(req);
    if (req.actor.source !== "assistant_grant" || !req.actor.assistantGrantId || !req.actor.userId) {
      throw forbidden("These routes are for assistant connections — use the approval and hire routes directly");
    }
    return {
      userId: req.actor.userId,
      grantId: req.actor.assistantGrantId,
      clientName: req.actor.assistantClientName ?? "assistant",
      // The board hire route keys on `actorHumanRole` — the normalized,
      // active-membership-aware read of req.actor.memberships — and so do
      // we: the pcpa_/pcin_ resolution already proved the membership is
      // active, so this mirrors "any active member may hire" exactly.
      membershipRole: actorHumanRole(req, companyId),
    };
  }

  /**
   * GH #916: the assistant decision surface follows the same visibility rule
   * as GET /approvals/:id — an approval raised by an agent the person cannot
   * see, or a budget override on a project they are off the list for (GH
   * #902), does not exist. The approval id arrives in the body (prepare) or
   * inside the handle (confirm), so the check is handed to the service.
   */
  function approvalVisibleTo(req: Parameters<typeof assertBoard>[0]): AssistantApprovalVisibility {
    return async (approval) => {
      try {
        if (approval.requestedByAgentId) {
          await assertAgentIdVisible(db, req, approval.requestedByAgentId, "Approval");
        }
        await assertApprovalProjectVisible(db, req, approval);
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return false;
        throw err;
      }
    };
  }

  router.post(
    "/companies/:companyId/assistant/actions/prepare-decision",
    validate(assistantPrepareDecisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actor = requireAssistantGrantActor(req, companyId);
      assertCompanyAccess(req, companyId);
      const result = await gated().prepareDecision(companyId, actor, req.body, {
        approvalVisible: approvalVisibleTo(req),
      });
      res.status(result.ok ? 200 : (result.status ?? 422)).json(result);
    },
  );

  router.post(
    "/companies/:companyId/assistant/actions/prepare-hire",
    validate(assistantPrepareHireSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actor = requireAssistantGrantActor(req, companyId);
      assertCompanyAccess(req, companyId);
      const result = await gated().prepareHire(companyId, actor, req.body);
      res.status(result.ok ? 200 : (result.status ?? 422)).json(result);
    },
  );

  router.post(
    "/companies/:companyId/assistant/actions/confirm",
    validate(assistantConfirmActionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actor = requireAssistantGrantActor(req, companyId);
      assertCompanyAccess(req, companyId);
      const result = await gated().confirm(companyId, actor, req.body, {
        approvalVisible: approvalVisibleTo(req),
      });
      res.status(result.ok ? 200 : (result.status ?? 422)).json(result);
    },
  );

  return router;
}
