// AgentDash (per-steward document access, slice 5): an agent proposes a new
// file for its steward's own OneDrive.
//
// Agent-authenticated and company-bound; a person never files an agent's
// proposal. Gated by the per-company flag `document_access_enabled`: with it
// off the route answers 404, as if it did not exist (D2: no profile check).
//
// Answers 202 with an approval id. Nothing has been written to Microsoft at
// that point, and an agent that receives this must not tell anyone it has:
// the steward decides, and only then does the server upload the copy.
import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { microsoftDocumentProposalService } from "../services/microsoft-document-proposals.js";
import { assertCompanyAccess } from "./authz.js";
import { assertIssueIdVisible } from "./visibility.js";

export function microsoftDocumentProposalRoutes(db: Db) {
  const router = Router();
  const flags = featureFlagsService(db);
  const proposals = microsoftDocumentProposalService(db);

  function requireAgent(req: Request, companyId: string): string {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return req.actor.agentId;
  }

  /**
   * Body: { target: {path} | {folderId, driveId?}, fileName, attachmentId,
   * sourceItemId?, summary, operation? ("upload_new", the only one) }.
   * Returns 202 { approvalId, expiresAt, status, proposedFileName, issueId }.
   */
  router.post("/companies/:companyId/documents/microsoft/propose", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await flags.isEnabled(companyId, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS))) {
      throw notFound("Not found");
    }
    const agentId = requireAgent(req, companyId);

    const result = await proposals.propose({
      companyId,
      agentId,
      body: (req.body ?? {}) as Record<string, unknown>,
      assertIssueVisible: (issueId) => assertIssueIdVisible(db, req, issueId, "Attachment"),
    });

    res.status(202).json({
      approvalId: result.approvalId,
      expiresAt: result.expiresAt.toISOString(),
      status: "pending_steward_approval",
      proposedFileName: result.proposedFileName,
      issueId: result.issueId,
    });
  });

  return router;
}
