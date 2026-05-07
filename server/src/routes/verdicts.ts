// AgentDash: goals-eval-hitl
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createVerdictInputSchema,
  verdictEntityTypeSchema,
  type VerdictEntityType,
} from "@paperclipai/shared";
import { HttpError, badRequest } from "../errors.js";
import { approvalService } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { verdictsService } from "../services/verdicts.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Verdict HTTP routes — Phase D1.
 *
 * Mounted under /api by app.ts. All endpoints are company-scoped via
 * assertCompanyAccess. Service-layer guards (neutral validator,
 * CHECK constraints, DoD presence) are authoritative; routes translate
 * thrown HttpError into 4xx with a `code` envelope.
 */
export function verdictRoutes(db: Db) {
  const router = Router();
  // Fix #179: wire approvals + issue-approvals deps so that POST /verdicts
  // with outcome=escalated_to_human auto-creates the matching
  // verdict_escalation approval (and links it to the issue). Without these
  // deps the verdict-approval bridge has nothing to react to.
  const svc = verdictsService(db, {
    approvalsService: approvalService(db),
    issueApprovalsService: issueApprovalService(db),
  });

  router.post("/companies/:companyId/verdicts", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const parsed = createVerdictInputSchema.safeParse({
        ...req.body,
        companyId,
      });
      if (!parsed.success) {
        throw badRequest("Invalid verdict input", {
          code: "VERDICT_INPUT_INVALID",
          issues: parsed.error.issues,
        });
      }
      const verdict = await svc.create(parsed.data);
      res.status(201).json(verdict);
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/verdicts", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const entityTypeRaw = req.query.entityType;
      const entityIdRaw = req.query.entityId;
      if (typeof entityTypeRaw !== "string" || typeof entityIdRaw !== "string") {
        throw badRequest("entityType and entityId query params are required");
      }
      const entityTypeParsed = verdictEntityTypeSchema.safeParse(entityTypeRaw);
      if (!entityTypeParsed.success) {
        throw badRequest("Invalid entityType", {
          code: "VERDICT_INPUT_INVALID",
          issues: entityTypeParsed.error.issues,
        });
      }
      const entityType: VerdictEntityType = entityTypeParsed.data;
      const rows = await svc.listForEntity(companyId, entityType, entityIdRaw);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/coverage", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const includeBreakdown = req.query.breakdown === "true";
      const result = await svc.coverage(companyId, { includeBreakdown });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/companies/:companyId/issues/:issueId/review-timeline",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const issueId = req.params.issueId as string;
        assertCompanyAccess(req, companyId);
        const rows = await svc.issueReviewTimeline(companyId, issueId);
        res.json(rows);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// Suppress unused-import lint: HttpError type kept for future error-mapping
// helpers that may augment err.details with a stable code envelope.
void HttpError;
