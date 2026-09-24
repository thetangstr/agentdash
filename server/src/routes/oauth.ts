import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { createDefaultApiRateLimiter } from "../middleware/rate-limit.js";
import {
  ASSISTANT_SCOPES,
} from "@paperclipai/shared";
import {
  assistantOAuthService,
  assistantResourceUri,
  issuerBaseUrl,
  OAuthError,
} from "../services/assistant-oauth.js";

/**
 * AgentDash assistant MCP (GH #677): the OAuth 2.1 authorization-server
 * endpoints, mounted at the app root (not /api).
 *
 * Route map:
 *   GET  /.well-known/oauth-protected-resource[/api/mcp/assistant] — RFC 9728 PRM
 *   GET  /.well-known/oauth-authorization-server                   — RFC 8414 AS metadata
 *   POST /oauth/register            — Dynamic Client Registration
 *   GET  /oauth/authorize           — validates, then 302s to the consent UI
 *   GET  /oauth/consent/:requestId  — consent view (signed-in person only)
 *   POST /oauth/consent/:requestId/decision — approve/deny → client redirect
 *   POST /oauth/token               — authorization_code + refresh_token
 *   POST /oauth/revoke              — RFC 7009, always 200
 *
 * The consent view/decision endpoints take JSON rather than an HTML form so
 * the consent screen lives in the React app with the rest of the person-facing
 * UI; they authenticate on the same better-auth session actor as everything
 * else.
 */
export function oauthRoutes(db: Db, opts: { deploymentMode?: DeploymentMode } = {}) {
  const router = Router();
  const oauth = assistantOAuthService(db);

  // These endpoints live at the app root, outside the /api limiter — and
  // /oauth/authorize writes an auth-request row on every GET, so anonymous
  // callers get the same 200/15min ceiling as API mutations. No-ops in tests
  // and local_trusted mode, like everywhere else it is used.
  router.use(createDefaultApiRateLimiter({ deploymentMode: opts.deploymentMode }));

  /** Uniform OAuth error shape; everything else falls through to the app handler. */
  const wrap =
    (handler: (req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handler(req, res);
      } catch (err) {
        if (err instanceof OAuthError) {
          res.status(err.status).json({ error: err.error, error_description: err.message });
          return;
        }
        next(err);
      }
    };

  const protectedResourceMetadata = (req: Request) => ({
    resource: assistantResourceUri(req),
    authorization_servers: [issuerBaseUrl(req)],
    scopes_supported: [...ASSISTANT_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "AgentDash assistant MCP",
  });

  router.get("/.well-known/oauth-protected-resource", (req, res) => {
    res.json(protectedResourceMetadata(req));
  });
  router.get("/.well-known/oauth-protected-resource/api/mcp/assistant", (req, res) => {
    res.json(protectedResourceMetadata(req));
  });

  router.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = issuerBaseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...ASSISTANT_SCOPES],
      // CIMD: client_id may be an https URL naming a client metadata document.
      client_id_metadata_document_supported: true,
      // RFC 8707: the token endpoint honors the resource parameter.
      resource_parameter_supported: true,
    });
  });

  /** Responses carrying credentials or registration details must not be cached (RFC 6749 §5.1). */
  const noStore = (res: Response) => {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
  };

  router.post(
    "/oauth/register",
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const client = await oauth.registerClient(body);
      noStore(res);
      res.status(201).json({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }),
  );

  /**
   * Validate + park the request, then send the person's browser to the React
   * consent screen. Errors here answer JSON rather than redirecting — the
   * redirect URI is only trustworthy after it validates, and a failed
   * authorize must never bounce to an unverified URL.
   */
  router.get(
    "/oauth/authorize",
    wrap(async (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const clientId = q.client_id;
      if (!clientId) throw new OAuthError("invalid_request", "client_id is required");
      const request = await oauth.beginAuthorize({
        clientId,
        redirectUri: q.redirect_uri,
        responseType: q.response_type,
        state: q.state,
        scope: q.scope,
        resource: q.resource,
        codeChallenge: q.code_challenge,
        codeChallengeMethod: q.code_challenge_method,
        canonicalResource: assistantResourceUri(req),
      });
      res.redirect(`/oauth/consent?request=${encodeURIComponent(request.id)}`);
    }),
  );

  function consentActor(req: Request): string | null {
    // An assistant_grant credential must never mint further grants, and the
    // local_implicit actor has no real user to bind one to.
    if (req.actor.type !== "board" || !req.actor.userId) return null;
    if (req.actor.source === "assistant_grant" || req.actor.source === "local_implicit") return null;
    return req.actor.userId;
  }

  router.get(
    "/oauth/consent/:requestId",
    wrap(async (req, res) => {
      const userId = consentActor(req);
      if (!userId) {
        res.status(401).json({ error: "Sign in to continue" });
        return;
      }
      const view = await oauth.consentView(req.params.requestId as string, userId);
      if (!view) {
        res.status(404).json({ error: "This consent request is no longer pending" });
        return;
      }
      res.json(view);
    }),
  );

  // The decision POST is the one browser-session mutation in this router, and
  // it lives outside /api where the global boardMutationGuard is mounted — so
  // it gets the same trusted-origin check applied here, route-locally. The
  // machine endpoints (register/token/revoke) are not session flows and do not
  // need it.
  router.post(
    "/oauth/consent/:requestId/decision",
    boardMutationGuard(),
    wrap(async (req, res) => {
      const userId = consentActor(req);
      if (!userId) {
        res.status(401).json({ error: "Sign in to continue" });
        return;
      }
      const body = (req.body ?? {}) as { approved?: boolean; companyId?: string; scopes?: unknown };
      if (body.approved === false) {
        const denied = await oauth.denyConsent({ requestId: req.params.requestId as string });
        res.json(denied);
        return;
      }
      if (typeof body.companyId !== "string" || !body.companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      const scopes = Array.isArray(body.scopes)
        ? body.scopes.filter((s): s is string => typeof s === "string")
        : [];
      const result = await oauth.approveConsent({
        requestId: req.params.requestId as string,
        userId,
        companyId: body.companyId,
        scopes,
        issuerBase: issuerBaseUrl(req),
      });
      res.json({ redirect: result.redirect });
    }),
  );

  router.post(
    "/oauth/token",
    wrap(async (req, res) => {
      noStore(res);
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      if (body.grant_type === "authorization_code") {
        if (!body.code) throw new OAuthError("invalid_request", "code is required");
        if (!body.client_id) throw new OAuthError("invalid_request", "client_id is required");
        res.json(
          await oauth.exchangeCode({
            code: body.code,
            clientId: body.client_id,
            redirectUri: body.redirect_uri,
            codeVerifier: body.code_verifier,
            resource: body.resource,
          }),
        );
        return;
      }
      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
        if (!body.client_id) throw new OAuthError("invalid_request", "client_id is required");
        res.json(
          await oauth.refreshAccessToken({
            refreshToken: body.refresh_token,
            clientId: body.client_id,
            canonicalResource: assistantResourceUri(req),
          }),
        );
        return;
      }
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }),
  );

  /**
   * RFC 7009: 200 whether or not the token existed — the response tells the
   * caller nothing it could not already guess, and the effect is immediate.
   */
  router.post(
    "/oauth/revoke",
    wrap(async (req, res) => {
      const token = (req.body as Record<string, unknown> | undefined)?.token;
      if (typeof token === "string" && token) {
        await oauth.revokeToken(token);
      }
      res.status(200).json({});
    }),
  );

  return router;
}
