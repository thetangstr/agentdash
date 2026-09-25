import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { createOAuthEndpointRateLimiter } from "../middleware/rate-limit.js";
import {
  ASSISTANT_SCOPES,
} from "@paperclipai/shared";
import {
  assistantOAuthService,
  assistantResourceUri,
  issuerBaseUrlStrict,
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

  // Per-endpoint limiters, applied route-locally — this router mounts at the
  // app root, so a blanket router.use() would rate-limit every anonymous
  // request in the app (SPA pages, assets, plugin UI), not just the AS.
  // Tighter than the /api default where a hit costs more than a read:
  // /authorize inserts a row (and may fire an outbound CIMD fetch) and
  // /register inserts one; /token is keyed client_id+IP so a shared-egress
  // client population does not share one bucket. No-ops in tests and
  // local_trusted mode, like everywhere else the limiter is used.
  const metaLimiter = createOAuthEndpointRateLimiter({
    deploymentMode: opts.deploymentMode, envKey: "AGENTDASH_RATE_LIMIT_OAUTH_META_MAX", defaultMax: 200,
  });
  const authorizeLimiter = createOAuthEndpointRateLimiter({
    deploymentMode: opts.deploymentMode, envKey: "AGENTDASH_RATE_LIMIT_OAUTH_AUTHORIZE_MAX", defaultMax: 100,
  });
  const registerLimiter = createOAuthEndpointRateLimiter({
    deploymentMode: opts.deploymentMode, envKey: "AGENTDASH_RATE_LIMIT_OAUTH_REGISTER_MAX", defaultMax: 30,
  });
  const consentLimiter = createOAuthEndpointRateLimiter({
    deploymentMode: opts.deploymentMode, envKey: "AGENTDASH_RATE_LIMIT_OAUTH_CONSENT_MAX", defaultMax: 120,
  });
  const tokenLimiter = createOAuthEndpointRateLimiter({
    deploymentMode: opts.deploymentMode, envKey: "AGENTDASH_RATE_LIMIT_OAUTH_TOKEN_MAX", defaultMax: 60,
    keyByClientId: true,
  });
  const revokeLimiter = createOAuthEndpointRateLimiter({
    deploymentMode: opts.deploymentMode, envKey: "AGENTDASH_RATE_LIMIT_OAUTH_REVOKE_MAX", defaultMax: 60,
  });

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
    authorization_servers: [issuerBaseUrlStrict(req, opts.deploymentMode)],
    scopes_supported: [...ASSISTANT_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "AgentDash assistant MCP",
  });

  router.get("/.well-known/oauth-protected-resource", metaLimiter, wrap((req, res) => {
    res.json(protectedResourceMetadata(req));
  }));
  router.get("/.well-known/oauth-protected-resource/api/mcp/assistant", metaLimiter, wrap((req, res) => {
    res.json(protectedResourceMetadata(req));
  }));

  router.get("/.well-known/oauth-authorization-server", metaLimiter, wrap((req, res) => {
    const base = issuerBaseUrlStrict(req, opts.deploymentMode);
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
  }));

  /** Responses carrying credentials or registration details must not be cached (RFC 6749 §5.1). */
  const noStore = (res: Response) => {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
  };

  router.post(
    "/oauth/register",
    registerLimiter,
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
    authorizeLimiter,
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
        // Minting path — the audience bound into the request row must come
        // from the configured issuer, never the request's Host header, in
        // authenticated mode.
        canonicalResource: `${issuerBaseUrlStrict(req, opts.deploymentMode)}/api/mcp/assistant`,
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
    consentLimiter,
    wrap(async (req, res) => {
      // Clickjacking guard, defense-in-depth with the page-level headers in
      // app.ts — a framed consent flow must not render anywhere.
      res.set("Content-Security-Policy", "frame-ancestors 'none'");
      res.set("X-Frame-Options", "DENY");
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
    consentLimiter,
    boardMutationGuard(),
    wrap(async (req, res) => {
      res.set("Content-Security-Policy", "frame-ancestors 'none'");
      res.set("X-Frame-Options", "DENY");
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
        issuerBase: issuerBaseUrlStrict(req, opts.deploymentMode),
      });
      res.json({ redirect: result.redirect });
    }),
  );

  router.post(
    "/oauth/token",
    tokenLimiter,
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
            canonicalResource: `${issuerBaseUrlStrict(req, opts.deploymentMode)}/api/mcp/assistant`,
            resource: body.resource,
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
    revokeLimiter,
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
