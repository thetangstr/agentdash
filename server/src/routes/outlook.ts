// AgentDash: Outlook Connector (AGE-110)
import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { connectorService } from "../services/connectors.js";
import { outlookConnectorService } from "../services/outlook-connector.js";
import {
  OUTLOOK_SCOPES_READ_ONLY,
  OUTLOOK_SCOPES_READ_SEND,
  OUTLOOK_SCOPES_SHARED_MAILBOX,
} from "../services/outlook-connector.js";
import { badRequest } from "../errors.js";

export function outlookRoutes(db: Db) {
  const router = Router();
  const outlookSvc = outlookConnectorService(db);
  const connSvc = connectorService(db);

  // -------------------------------------------------------------------------
  // OAuth: initiate flow
  // -------------------------------------------------------------------------

  /**
   * POST /connectors/outlook/oauth/initiate
   * Body: { companyId, redirectUri, scopes?: "read_only" | "read_send" | "shared_mailbox",
   *         loginHint?, sharedMailbox? }
   *
   * Returns { authorizationUrl, connectionId }
   */
  router.post(
    "/companies/:companyId/connectors/outlook/oauth/initiate",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const { redirectUri, scopes: scopePreset, loginHint, sharedMailbox } = req.body;
      if (!redirectUri || typeof redirectUri !== "string") {
        throw badRequest("redirectUri is required");
      }

      let requestedScopes: string[];
      if (scopePreset === "shared_mailbox") {
        requestedScopes = OUTLOOK_SCOPES_SHARED_MAILBOX;
      } else if (scopePreset === "read_send") {
        requestedScopes = OUTLOOK_SCOPES_READ_SEND;
      } else {
        requestedScopes = OUTLOOK_SCOPES_READ_ONLY;
      }

      // Create a pending connection to store the OAuth state
      const stateToken = randomUUID();
      const pending = await connSvc.storeOAuthState(
        companyId,
        actor.actorType,
        actor.actorId,
        "microsoft",
        {
          stateToken,
          redirectUri,
          requestedScopes,
          scopePreset: scopePreset ?? "read_only",
          sharedMailbox: sharedMailbox ?? null,
        },
      );

      const authorizationUrl = outlookSvc.getAuthorizationUrl({
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
   * POST /connectors/outlook/oauth/callback
   * Body: { code, state, redirectUri }
   *
   * Exchanges the authorization code for tokens and finalizes the connection.
   */
  router.post(
    "/companies/:companyId/connectors/outlook/oauth/callback",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { code, state, redirectUri } = req.body;
      if (!code || !state || !redirectUri) {
        throw badRequest("code, state, and redirectUri are required");
      }

      // Parse state -> connectionId:stateToken
      const colonIdx = state.indexOf(":");
      if (colonIdx < 0) throw badRequest("Invalid OAuth state");
      const connectionId = state.slice(0, colonIdx);
      const stateToken = state.slice(colonIdx + 1);

      // Consume the stored OAuth state
      const storedState = await connSvc.consumeOAuthState(connectionId);
      if (!storedState) throw badRequest("OAuth state expired or already consumed");
      if (storedState.stateToken !== stateToken) throw badRequest("OAuth state mismatch");

      // Exchange code for tokens
      const tokenResult = await outlookSvc.exchangeCode(code, redirectUri);

      // Determine the actual granted scopes
      const grantedScopes = tokenResult.scope
        ? tokenResult.scope.split(" ").filter(Boolean)
        : (storedState.requestedScopes as string[]) ?? [];

      // Update the pending connection with real token data
      const actor = getActorInfo(req);
      const scopePreset = storedState.scopePreset as string;
      const sharedMailbox = storedState.sharedMailbox as string | null;

      // Resolve default autonomy based on scope level
      const canSend = scopePreset === "read_send" || scopePreset === "shared_mailbox";
      const defaultAutonomy = canSend
        ? { read: "full" as const, draft: "full" as const, send: "draft_only" as const }
        : { read: "full" as const, draft: "blocked" as const, send: "blocked" as const };

      // Resolve send identity: shared mailbox uses service identity, delegated otherwise
      const defaultSendIdentity = scopePreset === "shared_mailbox" ? "service" : "delegated";

      // Use the shared mailbox email as account label, or the user's email
      const accountLabel = sharedMailbox ?? tokenResult.email;

      // Create the real connection (replaces the pending one)
      const connection = await connSvc.create(companyId, {
        ownerType: actor.actorType,
        ownerId: actor.actorId,
        provider: "microsoft",
        scopes: grantedScopes,
        sendIdentity: defaultSendIdentity,
        autonomy: defaultAutonomy,
        visibility: "private",
        accountLabel,
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
   * GET /connectors/outlook/:connectionId/search?q=...&maxResults=...&skip=...
   */
  router.get(
    "/companies/:companyId/connectors/outlook/:connectionId/search",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;

      const q = typeof req.query.q === "string" ? req.query.q : "";
      if (!q) throw badRequest("Query parameter 'q' is required");

      const maxResults = typeof req.query.maxResults === "string"
        ? Math.min(50, Math.max(1, parseInt(req.query.maxResults, 10) || 20))
        : 20;
      const skip = typeof req.query.skip === "string"
        ? Math.max(0, parseInt(req.query.skip, 10) || 0)
        : undefined;

      const result = await outlookSvc.search(connectionId, companyId, {
        query: q,
        maxResults,
        skip,
      });
      res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Read: list messages
  // -------------------------------------------------------------------------

  /**
   * GET /connectors/outlook/:connectionId/messages?maxResults=...&skip=...&folderId=...
   */
  router.get(
    "/companies/:companyId/connectors/outlook/:connectionId/messages",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;

      const maxResults = typeof req.query.maxResults === "string"
        ? Math.min(50, Math.max(1, parseInt(req.query.maxResults, 10) || 20))
        : 20;
      const skip = typeof req.query.skip === "string"
        ? Math.max(0, parseInt(req.query.skip, 10) || 0)
        : undefined;
      const folderId = typeof req.query.folderId === "string"
        ? req.query.folderId
        : undefined;

      const result = await outlookSvc.listMessages(connectionId, companyId, {
        maxResults,
        skip,
        folderId,
      });
      res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Read: conversation
  // -------------------------------------------------------------------------

  /**
   * GET /connectors/outlook/:connectionId/conversations/:conversationId
   */
  router.get(
    "/companies/:companyId/connectors/outlook/:connectionId/conversations/:conversationId",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;
      const conversationId = req.params.conversationId as string;

      const result = await outlookSvc.readConversation(connectionId, companyId, conversationId);
      res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Draft
  // -------------------------------------------------------------------------

  /**
   * POST /connectors/outlook/:connectionId/drafts
   * Body: { to, subject, body, cc?, bcc?, conversationId?, inReplyTo? }
   */
  router.post(
    "/companies/:companyId/connectors/outlook/:connectionId/drafts",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;
      const actor = getActorInfo(req);

      const { to, subject, body, cc, bcc, conversationId, inReplyTo, agentName } = req.body;
      if (!to || !subject || !body) {
        throw badRequest("to, subject, and body are required");
      }

      const conn = await connSvc.getById(connectionId);
      if (!conn) throw badRequest("Connection not found");

      const result = await outlookSvc.createDraft(
        connectionId,
        companyId,
        { to, subject, body, cc, bcc, conversationId, inReplyTo },
        actor.actorId,
        agentName,
        conn.sendIdentity as any,
      );
      res.status(201).json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /**
   * POST /connectors/outlook/:connectionId/send
   * Body: { to, subject, body, cc?, bcc?, conversationId?, inReplyTo?, agentName?, agentId? }
   *
   * Respects autonomy settings:
   * - draft_only -> creates draft, returns { type: "drafted", approvalNeeded: true }
   * - full (autonomous) -> sends directly, returns { type: "sent" }
   * - blocked -> 403 error
   * - Read-only scope -> 422 error
   */
  router.post(
    "/companies/:companyId/connectors/outlook/:connectionId/send",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;
      const actor = getActorInfo(req);

      const {
        to, subject, body, cc, bcc, conversationId, inReplyTo,
        agentName, agentId,
      } = req.body;
      if (!to || !subject || !body) {
        throw badRequest("to, subject, and body are required");
      }

      // Resolve the effective autonomy and send identity
      const effectiveAgentId = agentId ?? actor.actorId;
      const resolution = await connSvc.resolveActingAs(
        companyId,
        effectiveAgentId,
        "send",
        "microsoft",
      );

      if (!resolution.ok) {
        res.status(403).json({
          error: resolution.blocked.message,
          code: resolution.blocked.reason,
        });
        return;
      }

      const result = await outlookSvc.sendEmail(
        connectionId,
        companyId,
        { to, subject, body, cc, bcc, conversationId, inReplyTo, agentName },
        {
          actorId: actor.actorId,
          agentId: effectiveAgentId,
          autonomyLevel: resolution.resolution.effectiveAutonomy,
          sendIdentity: resolution.resolution.sendIdentity,
        },
      );
      res.json(result);
    },
  );

  return router;
}
