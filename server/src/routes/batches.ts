import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  ASSISTANT_BATCH_KINDS,
  ASSISTANT_SCOPE_ADMIN,
  ASSISTANT_SCOPE_DECIDE,
  assistantBatchConfirmSchema,
  assistantBatchPrepareSchema,
  assistantStepUpChallenge,
  batchApplyHereSchema,
  batchConfirmSchema,
  batchPreviewSchema,
  batchReconcileSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { batchService, type BatchServiceOptions } from "../services/batch/engine.js";
import { BATCH_KINDS } from "../services/batch/kinds.js";
import { describeChangeAsText, resolveAssistantTargets } from "../services/batch/assistant-targets.js";
import { batchReviewUrl } from "../lib/public-base-url.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

/**
 * AgentDash admin powers, part 2: the batch routes.
 *
 * Every write is per record through that record's own single-record route
 * (services/batch/runner.ts); these routes only preview, confirm, read,
 * cancel and record verdicts. Guards: board access to the company, plus the
 * kind's own preview guard; confirm and cancel belong to the person who
 * previewed; reading another person's batch and recording verdicts are for
 * owners and admins.
 */
export function batchRoutes(db: Db, options: BatchServiceOptions = {}) {
  const router = Router();
  const svc = batchService(db, options);

  router.post("/companies/:companyId/batches/preview", validate(batchPreviewSchema), async (req, res) => {
    res.json(await svc.preview(req, req.params.companyId as string, req.body));
  });

  router.post("/companies/:companyId/batches/:batchId/confirm", validate(batchConfirmSchema), async (req, res) => {
    res.status(202).json(await svc.confirm(req, req.params.companyId as string, req.params.batchId as string, req.body));
  });

  router.get("/companies/:companyId/batches", async (req, res) => {
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    res.json({ batches: await svc.list(req, req.params.companyId as string, { limit: Number.isFinite(limit) ? limit : undefined }) });
  });

  router.get("/companies/:companyId/batches/:batchId", async (req, res) => {
    res.json(await svc.get(req, req.params.companyId as string, req.params.batchId as string));
  });

  router.post("/companies/:companyId/batches/:batchId/cancel", async (req, res) => {
    res.json(await svc.cancel(req, req.params.companyId as string, req.params.batchId as string));
  });

  router.post(
    "/companies/:companyId/batches/:batchId/items/:itemId/reconcile",
    validate(batchReconcileSchema),
    async (req, res) => {
      res.json(await svc.reconcile(
        req,
        req.params.companyId as string,
        req.params.batchId as string,
        req.params.itemId as string,
        req.body,
      ));
    },
  );

  /**
   * AgentDash admin powers (part 5): the code that confirms a batch the
   * person's own Claude prepared. Browser only (the engine refuses grants,
   * their loopback, board keys and batch item credentials; this is a POST,
   * so the browser-origin guard applies); creator only. The response is the
   * only place the code ever appears.
   */
  router.post("/companies/:companyId/batches/:batchId/confirm-code", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await svc.mintConfirmCode(req, req.params.companyId as string, req.params.batchId as string));
  });

  /** "Apply here": the creator's own browser session spends an assistant-prepared batch. */
  router.post("/companies/:companyId/batches/:batchId/apply-here", validate(batchApplyHereSchema), async (req, res) => {
    res.status(202).json(await svc.applyHere(req, req.params.companyId as string, req.params.batchId as string));
  });

  /**
   * The admin scope is a step-up: a grant without it is told exactly which
   * scopes to ask for on reconnect (RFC 6750 `insufficient_scope`).
   */
  function requireAdminScope(req: Request, res: Response, also?: string): boolean {
    if (req.actor.source !== "assistant_grant") return true; // the engine refuses anyone else
    const scopes = req.actor.assistantScopes ?? [];
    for (const required of [ASSISTANT_SCOPE_ADMIN, ...(also ? [also] : [])]) {
      if (scopes.includes(required)) continue;
      res.set("WWW-Authenticate", assistantStepUpChallenge(scopes, required));
      res.status(403).json({ error: "insufficient_scope", required_scope: required });
      return false;
    }
    return true;
  }

  /**
   * prepare_batch_change: resolves the named records on the server, then
   * stores a preview with origin `assistant`. Prepares, never applies; the
   * answer carries a review link, never a code.
   */
  router.post("/companies/:companyId/assistant/batches/prepare", validate(assistantBatchPrepareSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { kind: kindKey, targets, change } = req.body as { kind: string; targets: string[]; change: Record<string, unknown> };
    // Deciding approvals also needs the decide scope (review of 8f1b669b0).
    if (!requireAdminScope(req, res, kindKey.startsWith("approval.") ? ASSISTANT_SCOPE_DECIDE : undefined)) return;
    const kinds = options.kinds ?? BATCH_KINDS;
    const kind = Object.prototype.hasOwnProperty.call(kinds, kindKey) ? kinds[kindKey] : undefined;
    if (!kind) throw badRequest("This kind of batch change is not available.");
    if (!(ASSISTANT_BATCH_KINDS as readonly string[]).includes(kindKey)) {
      throw badRequest("This kind of batch change cannot be prepared from an assistant.");
    }
    // Access first (grant, admin, switch), so nothing is resolved for someone who may not prepare.
    await svc.assertAssistantAccess(req, companyId, kindKey);
    const parsedChange = kind.parseChange(change);
    const resolved = await resolveAssistantTargets(db, req, companyId, kind, parsedChange, targets);
    if (!resolved.ok) {
      res.status(422).json({
        ok: false,
        outcome: resolved.problems.some((problem) => problem.kind === "needs_clarification") ? "needs_clarification" : "not_found",
        problems: resolved.problems,
        message: "Some of the records could not be told apart or found, so no batch was prepared. Ask the person which they mean, then prepare it again.",
      });
      return;
    }
    const preview = await svc.previewAssistant(req, companyId, { kind: kindKey, ids: resolved.ids, change });
    const counts = {
      willChange: preview.items.length,
      notFound: preview.omitted.notFound,
      alreadyThatWay: preview.omitted.noop,
      notDecidable: preview.omitted.notDecidable,
    };
    if (!preview.batchId) {
      res.json({
        ok: true,
        batchId: null,
        summary: `Nothing to change: none of the ${kind.noun}s named would change.`,
        counts,
        notDecidable: preview.notDecidable.map((entry) => ({ label: entry.label, reason: entry.reason })),
      });
      return;
    }
    const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
    res.json({
      ok: true,
      batchId: preview.batchId,
      summary: `${counts.willChange} ${kind.noun}${counts.willChange === 1 ? "" : "s"} would change. Nothing changes until the person opens the review link, checks it, and reads you the code shown there (or applies it there).`,
      counts,
      sample: preview.items.slice(0, 10).map((item) => `${item.label}: ${describeChangeAsText(item.before, item.after)}`),
      notDecidable: preview.notDecidable.map((entry) => ({ label: entry.label, reason: entry.reason })),
      reviewUrl: company ? batchReviewUrl(company.issuePrefix, preview.batchId) : undefined,
      expiresAt: preview.expiresAt,
    });
  });

  /** confirm_batch_change: the code the person read back from their browser. */
  router.post("/companies/:companyId/assistant/batches/:batchId/confirm", validate(assistantBatchConfirmSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requireAdminScope(req, res)) return;
    const result = await svc.confirmAssistant(req, companyId, req.params.batchId as string, (req.body as { code: string }).code);
    res.status(202).json(result);
  });

  return Object.assign(router, { batchService: svc });
}
