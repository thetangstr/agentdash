// AgentDash (per-steward document access, slice 2): a person connects their
// own Microsoft 365 account from My Agent.
//
// Every route here is board-user only and binds to the authenticated caller:
// there is no `userId` parameter, because a personal identity a colleague can
// attach on your behalf is not a personal identity (same rule as the
// SharePoint and HubSpot "me" routes). Agents never call these routes and
// never receive a token: they read through the server, as their steward
// (slice 1 resolution, slice 3 reads).
//
// Gated by the per-company flag `document_access_enabled`: with it off every
// route answers 404, as if it did not exist. No product-profile check (D2).
//
// Responses describe the connection (account, scopes, tier, status, last
// error) and never carry an access token, refresh token, code or verifier.
import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS, type DeploymentMode } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { featureFlagsService } from "../services/feature-flags.js";
import {
  microsoftGraphAuthService,
  microsoftSignInConfigured,
} from "../services/microsoft-graph-auth.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function microsoftDocumentsRoutes(db: Db, opts: { deploymentMode?: DeploymentMode } = {}) {
  const router = Router();
  const flags = featureFlagsService(db);
  // A loopback redirect URI names this machine only on a local instance.
  const auth = microsoftGraphAuthService(db, {
    allowLoopbackRedirect: opts.deploymentMode === "local_trusted",
  });

  /** Company access first (403 for outsiders), then the flag (404 when off). */
  async function requireDocumentAccessCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (!(await flags.isEnabled(companyId, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS))) {
      throw notFound("Not found");
    }
  }

  function requireBoardUser(req: Request): string {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    return req.actor.userId;
  }

  /**
   * GET: the caller's own connection, or null. `configured` says whether
   * this instance can sign anyone in to Microsoft at all, so the page can say
   * "ask an administrator" instead of offering a Connect button that fails.
   */
  router.get("/companies/:companyId/me/connections/microsoft", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireDocumentAccessCompany(req, companyId);
    const userId = requireBoardUser(req);
    res.json({
      configured: microsoftSignInConfigured(),
      connection: await auth.health(companyId, userId),
    });
  });

  /**
   * Body: { redirectUri, tier?: "read" | "read_propose" }.
   * Returns { authorizationUrl, connectionId }; the browser goes to the URL.
   */
  router.post("/companies/:companyId/me/connections/microsoft/oauth/initiate", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireDocumentAccessCompany(req, companyId);
    const userId = requireBoardUser(req);
    const result = await auth.beginConnect(companyId, userId, {
      redirectUri: req.body?.redirectUri,
      tier: req.body?.tier,
    });
    res.json(result);
  });

  /**
   * Body: { code, state, redirectUri } from the callback page, or
   * { error, state, redirectUri } when the person declined at Microsoft.
   * Returns { connection } on success.
   */
  router.post("/companies/:companyId/me/connections/microsoft/oauth/callback", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireDocumentAccessCompany(req, companyId);
    const userId = requireBoardUser(req);
    const connection = await auth.completeConnect(companyId, userId, {
      code: req.body?.code,
      error: req.body?.error,
      state: req.body?.state,
      redirectUri: req.body?.redirectUri,
    });
    res.json({ connection });
  });

  /**
   * Disconnect: the stored credential is deleted and agents stop resolving it
   * at once (a refresh already in flight stores and returns nothing). The
   * person's consent in Microsoft is theirs to remove there.
   *
   * Behind the same flag as every other route (plan: flag off means 404
   * everywhere), so an operator who turns the flag off for a company must
   * also revoke that company's `microsoft` rows; see the plan's "Migrations
   * and flag" section.
   */
  router.post("/companies/:companyId/me/connections/microsoft/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireDocumentAccessCompany(req, companyId);
    const userId = requireBoardUser(req);
    const { connectionId } = await auth.disconnect(companyId, userId);
    res.json({ connectionId, revoked: true });
  });

  return router;
}
