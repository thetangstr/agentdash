/// <reference path="../types/agentdash-mcp-server.d.ts" />

import { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAgentDashServer } from "@agentdash/mcp-server";
import { ASSISTANT_SCOPE_READ } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { issuerBaseUrl } from "../services/assistant-oauth.js";
import {
  mintAssistantLoopbackToken,
  revokeAssistantLoopbackToken,
} from "../services/assistant-loopback.js";

/**
 * The turnkey MCP endpoint: `POST /api/mcp`, bearer = the agent's key.
 *
 * Before this, connecting a person's coding agent meant an npx command against
 * a tarball plus four environment variables — and the identity ones were
 * redundant by construction, because the auth middleware already resolves an
 * agent key to its agent AND company. This endpoint completes that thought:
 * the key is the whole configuration. A harness needs exactly two facts —
 * this URL and that key — and everything else it learns by asking.
 *
 * "It knows what to say to you" is not new machinery: `createAgentDashServer`
 * already selects the per-agent playbook as the server's `instructions` when
 * the config carries an agentId, so the harness is greeted as the specific
 * agent whose key it presented, with that agent's operating contract. Serving
 * the operator's playbook to a person's harness was the observed failure this
 * guards against — it told the harness to go provision a company instead of
 * doing the work it was given.
 *
 * Stateless deliberately (`sessionIdGenerator: undefined`): one server per
 * request, no session table, nothing to leak between two laptops sharing an
 * agent key, and a reconnecting client just works. The cost is re-running
 * `initialize` per request, which the SDK client does for us.
 *
 * Tool calls loop back over loopback HTTP with the caller's own bearer, so
 * every action carries exactly the caller's authority — this endpoint grants
 * nothing the key did not already have, and the audit trail records the agent,
 * never a shared service identity. Loopback is always in the private-hostname
 * allow set, so this works whatever public name the instance answers on.
 */
export function mcpRoutes() {
  const router = Router();

  function bearerToken(req: Request): string | null {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1]!.trim() : null;
  }

  /**
   * The scheme this request's listener speaks. Behind a TLS-terminating
   * proxy the socket is plain HTTP; on an instance that terminates TLS
   * itself the loopback must dial https or every tool call fails on the
   * handshake.
   */
  function loopbackApiUrl(req: Request): string {
    const scheme = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
    return `${scheme}://127.0.0.1:${req.socket.localPort}/api`;
  }

  router.post("/mcp", async (req: Request, res: Response) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({
        error:
          "Connect with an agent key: Authorization: Bearer <key>. "
          + "The key identifies which agent you are — there is nothing else to configure.",
      });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Authorization: Bearer <agent key> is required" });
      return;
    }

    // Loop back over this same listener. `localPort` is the port this request
    // actually arrived on, so the config is correct no matter which instance
    // this is or what PORT it was started with.
    const server = createAgentDashServer({
      apiUrl: loopbackApiUrl(req),
      apiKey: token,
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      runId: null,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err, agentId: req.actor.agentId }, "[mcp] request failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error handling MCP request" },
          id: null,
        });
      }
    }
  });

  /**
   * GH #677: the person-facing assistant endpoint. Bearer = an OAuth access
   * token minted against an `assistant_grant` — never an agent key, never a
   * session cookie. Three layers hold it in:
   *
   *   1. The auth middleware only mints an `assistant_grant` actor when the
   *     (method, path) is on ASSISTANT_ROUTE_SCOPES and the grant's scopes
   *     cover it — so by the time this handler runs, the route+scope check
   *     already passed.
   *   2. This handler re-checks the actor source, so a future route addition
   *     cannot accidentally serve MCP to another credential type.
   *   3. The MCP server it spawns uses the assistant toolset and loops back
   *     with the caller's own token, so tool calls carry exactly the grant's
   *     authority — company-pinned, scope-limited, revocable.
   *
   * Origin validation is the Streamable-HTTP MUST: browser-originated calls
   * must declare an Origin the instance recognizes (its own host, or the
   * configured public URL). Non-browser clients send none, which is fine —
   * the threat model is a page on another origin driving the endpoint, not
   * a missing header.
   */
  function allowedOrigin(req: Request): boolean {
    const origin = req.header("origin");
    if (!origin) return true;
    let normalized: string;
    try {
      const url = new URL(origin);
      normalized = `${url.protocol}//${url.host}`.toLowerCase();
    } catch {
      return false;
    }
    const trusted = new Set<string>();
    const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || req.header("host")?.trim();
    if (host) {
      trusted.add(`http://${host}`.toLowerCase());
      trusted.add(`https://${host}`.toLowerCase());
    }
    try {
      const publicOrigin = new URL(issuerBaseUrl(req));
      trusted.add(`${publicOrigin.protocol}//${publicOrigin.host}`.toLowerCase());
    } catch {
      // issuerBaseUrl should always parse; if it somehow does not, only
      // host-derived origins remain trusted.
    }
    return trusted.has(normalized);
  }

  router.post("/mcp/assistant", async (req: Request, res: Response) => {
    const resourceMetadataUrl = `${issuerBaseUrl(req)}/.well-known/oauth-protected-resource/api/mcp/assistant`;
    const challenge =
      `Bearer resource_metadata="${resourceMetadataUrl}", scope="${ASSISTANT_SCOPE_READ}"`;
    if (
      req.actor.source !== "assistant_grant"
      || req.actor.assistantLoopback
      || !req.actor.companyId
      || !req.actor.assistantGrantId
      || !req.actor.userId
    ) {
      res.set(
        "WWW-Authenticate",
        `${challenge}, error="invalid_token", error_description="An assistant access token is required"`,
      );
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    if (!allowedOrigin(req)) {
      res.status(403).json({ error: "Untrusted Origin" });
      return;
    }

    // Tool calls loop back over this listener on an INTERNAL credential —
    // never on the caller's `pcpa_` token, which is valid on zero raw REST
    // routes. The loopback actor keeps the grant's company pin and scopes;
    // the token dies when this response does (see assistant-loopback.ts).
    const loopbackToken = mintAssistantLoopbackToken({
      userId: req.actor.userId,
      companyId: req.actor.companyId,
      membershipRole: req.actor.memberships?.[0]?.membershipRole ?? null,
      grantId: req.actor.assistantGrantId,
      scopes: req.actor.assistantScopes ?? [],
      clientName: req.actor.assistantClientName ?? "assistant",
    });

    const server = createAgentDashServer(
      {
        apiUrl: loopbackApiUrl(req),
        apiKey: loopbackToken,
        companyId: req.actor.companyId,
        agentId: null,
        runId: null,
        // GH #745 review: the grant's scopes filter the advertised surface —
        // a read-only grant is not shown the work tools at all.
        assistantScopes: req.actor.assistantScopes ?? [],
      },
      { toolset: "assistant" },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      revokeAssistantLoopbackToken(loopbackToken);
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err, grantId: req.actor.assistantGrantId }, "[mcp] assistant request failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error handling MCP request" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-initiated stream and no session to delete.
  // Answer plainly rather than 404, so a client probing the endpoint learns
  // what it is talking to instead of concluding the URL is wrong.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      error: "This MCP endpoint is stateless: POST JSON-RPC messages to it. GET/DELETE have no meaning here.",
    });
  };
  router.get("/mcp", methodNotAllowed);
  router.delete("/mcp", methodNotAllowed);
  router.get("/mcp/assistant", methodNotAllowed);
  router.delete("/mcp/assistant", methodNotAllowed);

  return router;
}
