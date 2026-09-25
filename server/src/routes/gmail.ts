// AgentDash: Gmail Connector (AGE-109)
import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { assertCanSetCompanyDirection, assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { connectorService } from "../services/connectors.js";
import { gmailConnectorService } from "../services/gmail-connector.js";
import {
  GMAIL_SCOPES_READ_ONLY,
  GMAIL_SCOPES_READ_SEND,
} from "../services/gmail-connector.js";
import { badRequest } from "../errors.js";
import type { Request, Response } from "express";
import type { ConnectorActionClass } from "@paperclipai/shared";
import { authorizeNamedConnection } from "./connector-acting-as.js";

export function gmailRoutes(db: Db) {
  const router = Router();
  const gmailSvc = gmailConnectorService(db);
  const connSvc = connectorService(db);

  // AgentDash (security): shared with the Slack route — see connector-acting-as.ts.
  // Returns the resolution, or writes a 403 and returns null.
  async function authorizeConnection(
    req: Request,
    res: Response,
    companyId: string,
    connectionId: string,
    actionClass: ConnectorActionClass,
    requestedAgentId?: unknown,
  ) {
    const result = await authorizeNamedConnection(connSvc, req, {
      companyId,
      connectionId,
      provider: "google",
      actionClass,
      requestedAgentId,
    });
    if (!result.ok) {
      res.status(403).json({ error: result.message, code: result.code });
      return null;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // OAuth: initiate flow
  // -------------------------------------------------------------------------

  /**
   * POST /connectors/gmail/oauth/initiate
   * Body: { companyId, redirectUri, scopes?: "read_only" | "read_send", loginHint? }
   *
   * Returns { authorizationUrl, connectionId }
   */
  router.post(
    "/companies/:companyId/connectors/gmail/oauth/initiate",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const { redirectUri, scopes: scopePreset, loginHint } = req.body;
      if (!redirectUri || typeof redirectUri !== "string") {
        throw badRequest("redirectUri is required");
      }

      const requestedScopes =
        scopePreset === "read_send" ? GMAIL_SCOPES_READ_SEND : GMAIL_SCOPES_READ_ONLY;

      // Create a pending connection to store the OAuth state
      const stateToken = randomUUID();
      const pending = await connSvc.storeOAuthState(
        companyId,
        actor.actorType,
        actor.actorId,
        "google",
        { stateToken, redirectUri, requestedScopes, scopePreset: scopePreset ?? "read_only" },
      );

      const authorizationUrl = gmailSvc.getAuthorizationUrl({
        redirectUri,
        scopes: requestedScopes,
        state: `${pending.id}:${stateToken}`,
        loginHint,
      });

      res.json({ authorizationUrl, connectionId: pending.id });
    },
  );

  // -------------------------------------------------------------------------
  // OAuth: callback
  // -------------------------------------------------------------------------

  /**
   * POST /connectors/gmail/oauth/callback
   * Body: { code, state, redirectUri }
   *
   * Exchanges the authorization code for tokens and finalizes the connection.
   */
  router.post(
    "/companies/:companyId/connectors/gmail/oauth/callback",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { code, state, redirectUri } = req.body;
      if (!code || !state || !redirectUri) {
        throw badRequest("code, state, and redirectUri are required");
      }

      // Parse state → connectionId:stateToken
      const colonIdx = state.indexOf(":");
      if (colonIdx < 0) throw badRequest("Invalid OAuth state");
      const connectionId = state.slice(0, colonIdx);
      const stateToken = state.slice(colonIdx + 1);

      // Consume the stored OAuth state
      const storedState = await connSvc.consumeOAuthState(connectionId);
      if (!storedState) throw badRequest("OAuth state expired or already consumed");
      if (storedState.stateToken !== stateToken) throw badRequest("OAuth state mismatch");

      // Exchange code for tokens
      const tokenResult = await gmailSvc.exchangeCode(code, redirectUri);

      // Determine the actual granted scopes
      const grantedScopes = tokenResult.scope
        ? tokenResult.scope.split(" ").filter(Boolean)
        : (storedState.requestedScopes as string[]) ?? [];

      // Update the pending connection with real token data
      const actor = getActorInfo(req);
      const scopePreset = storedState.scopePreset as string;

      // Resolve default autonomy based on scope level
      const defaultAutonomy = scopePreset === "read_send"
        ? { read: "full" as const, draft: "full" as const, send: "draft_only" as const }
        : { read: "full" as const, draft: "blocked" as const, send: "blocked" as const };

      // Create the real connection (replaces the pending one)
      const connection = await connSvc.create(companyId, {
        ownerType: actor.actorType,
        ownerId: actor.actorId,
        provider: "google",
        scopes: grantedScopes,
        sendIdentity: "delegated",
        autonomy: defaultAutonomy,
        visibility: "private",
        accountLabel: tokenResult.email,
        token: {
          accessToken: tokenResult.accessToken,
          refreshToken: tokenResult.refreshToken,
          expiresAt: tokenResult.expiresAt,
          tokenType: tokenResult.tokenType,
          scope: tokenResult.scope,
        },
      });

      // Strip sensitive fields
      const { encryptedToken, oauthState, ...safe } = connection;
      res.status(201).json(safe);
    },
  );

  // -------------------------------------------------------------------------
  // Read: search
  // -------------------------------------------------------------------------

  /**
   * GET /connectors/gmail/:connectionId/search?q=...&maxResults=...&pageToken=...
   */
  router.get(
    "/companies/:companyId/connectors/gmail/:connectionId/search",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;

      const q = typeof req.query.q === "string" ? req.query.q : "";
      if (!q) throw badRequest("Query parameter 'q' is required");

      const maxResults = typeof req.query.maxResults === "string"
        ? Math.min(100, Math.max(1, parseInt(req.query.maxResults, 10) || 20))
        : 20;
      const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;

      const authorized = await authorizeConnection(req, res, companyId, connectionId, "read");
      if (!authorized) return;

      const result = await gmailSvc.search(authorized.resolution.connectionId, companyId, {
        query: q,
        maxResults,
        pageToken,
      });
      res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Read: list messages
  // -------------------------------------------------------------------------

  /**
   * GET /connectors/gmail/:connectionId/messages?maxResults=...&pageToken=...&labelIds=...
   */
  router.get(
    "/companies/:companyId/connectors/gmail/:connectionId/messages",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;

      const maxResults = typeof req.query.maxResults === "string"
        ? Math.min(100, Math.max(1, parseInt(req.query.maxResults, 10) || 20))
        : 20;
      const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;
      const labelIds = typeof req.query.labelIds === "string"
        ? req.query.labelIds.split(",").filter(Boolean)
        : undefined;

      const authorized = await authorizeConnection(req, res, companyId, connectionId, "read");
      if (!authorized) return;

      const result = await gmailSvc.listMessages(authorized.resolution.connectionId, companyId, {
        maxResults,
        pageToken,
        labelIds,
      });
      res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Read: thread
  // -------------------------------------------------------------------------

  /**
   * GET /connectors/gmail/:connectionId/threads/:threadId
   */
  router.get(
    "/companies/:companyId/connectors/gmail/:connectionId/threads/:threadId",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;
      const threadId = req.params.threadId as string;

      const authorized = await authorizeConnection(req, res, companyId, connectionId, "read");
      if (!authorized) return;

      const result = await gmailSvc.readThread(authorized.resolution.connectionId, companyId, threadId);
      res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Draft
  // -------------------------------------------------------------------------

  /**
   * POST /connectors/gmail/:connectionId/drafts
   * Body: { to, subject, body, cc?, bcc?, threadId?, inReplyTo?, references? }
   */
  router.post(
    "/companies/:companyId/connectors/gmail/:connectionId/drafts",
    async (req, res) => {
      assertCanSetCompanyDirection(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;
      const actor = getActorInfo(req);

      const { to, subject, body, cc, bcc, threadId, inReplyTo, references, agentName } = req.body;
      if (!to || !subject || !body) {
        throw badRequest("to, subject, and body are required");
      }

      const authorized = await authorizeConnection(req, res, companyId, connectionId, "draft");
      if (!authorized) return;

      const result = await gmailSvc.createDraft(
        authorized.resolution.connectionId,
        companyId,
        { to, subject, body, cc, bcc, threadId, inReplyTo, references },
        actor.actorId,
        agentName,
        authorized.resolution.sendIdentity,
      );
      res.status(201).json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /**
   * POST /connectors/gmail/:connectionId/send
   * Body: { to, subject, body, cc?, bcc?, threadId?, inReplyTo?, references?, agentName?, agentId? }
   *
   * Respects autonomy settings:
   * - draft_only → creates draft, returns { type: "drafted", approvalNeeded: true }
   * - full (autonomous) → sends directly, returns { type: "sent" }
   * - blocked → 422 error
   * - Read-only scope → 422 error
   */
  router.post(
    "/companies/:companyId/connectors/gmail/:connectionId/send",
    async (req, res) => {
      assertCanSetCompanyDirection(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;
      const actor = getActorInfo(req);

      const {
        to, subject, body, cc, bcc, threadId, inReplyTo, references,
        agentName, agentId,
      } = req.body;
      if (!to || !subject || !body) {
        throw badRequest("to, subject, and body are required");
      }

      // AgentDash (security): bind authorization to the connection named in the
      // path, so the send below can only use a connection this caller may use.
      // The owner of a private connection may send from it directly.
      const authorized = await authorizeConnection(req, res, companyId, connectionId, "send", agentId);
      if (!authorized) return;
      const effectiveAgentId = authorized.actingId;

      // AgentDash (security): only the authorized connection is ever decrypted.
      const result = await gmailSvc.sendEmail(
        authorized.resolution.connectionId,
        companyId,
        { to, subject, body, cc, bcc, threadId, inReplyTo, references, agentName },
        {
          actorId: actor.actorId,
          agentId: effectiveAgentId,
          autonomyLevel: authorized.resolution.effectiveAutonomy,
          sendIdentity: authorized.resolution.sendIdentity,
        },
      );
      res.json(result);
    },
  );

  return router;
}
