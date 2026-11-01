// AgentDash (cloud MCP toolset, doc/plans/2026-10-31-cloud-mcp-toolset.md):
// the agent front door, two transports over one dispatcher (front-door/agent.ts).
//
//   POST /api/cloud/agent/<op>   JSON; what stdio `agentdash-mcp` with
//                                AGENTDASH_TOOLSET=cloud calls.
//   POST /api/cloud/mcp          a stateless streamable-HTTP MCP endpoint with
//                                the SAME tool definitions (@agentdash/mcp-server,
//                                toolset "cloud"), whose backend calls the
//                                dispatcher in process with this request's
//                                visitor, so every limit applies per caller
//                                exactly as over REST.
//
// Both sit inside publicRoutes, so they inherit no-store and the JSON-only
// rule, and are reached through www's existing /api/cloud/* rewrite.
import { Router, type Request, type Response, type Router as ExpressRouter } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAgentDashServer, NO_INSTANCE_API_URL } from "@agentdash/mcp-server";
import type { CloudConfig } from "../config.js";
import type { AgentDoor } from "../front-door/agent.js";
import { MemoryLimiter } from "../front-door/rate-limit.js";
import type { Logger } from "../logger.js";
import { visitorOf } from "./public.js";

export function agentRoutes(opts: {
  agent: AgentDoor;
  log: Logger;
  config: Pick<CloudConfig, "clientIpSource" | "privateNetwork" | "frontDoor">;
}): ExpressRouter {
  const { agent, log, config } = opts;
  const router = Router();
  const mcpLimiter = new MemoryLimiter(120, 60_000);
  const MAX_BATCH = 10;
  const siteOrigin = new URL(config.frontDoor.siteUrl).origin.toLowerCase();

  router.post("/agent/:op", async (req, res) => {
    const op = String(req.params.op ?? "");
    const answer = await agent.call(op, (req.body ?? {}) as Record<string, unknown>, visitorOf(req, config));
    res.status(answer.status).json(answer.body);
  });

  /**
   * Streamable HTTP requires the server to check Origin (DNS rebinding): a
   * browser-originated call must come from www itself. Agents and connectors
   * send no Origin, which is fine.
   */
  function allowedOrigin(req: Request): boolean {
    const origin = req.header("origin");
    if (!origin) return true;
    try {
      return new URL(origin).origin.toLowerCase() === siteOrigin;
    } catch {
      return false;
    }
  }

  router.post("/mcp", async (req: Request, res: Response) => {
    const visitor = visitorOf(req, config);
    // A JSON-RPC batch counts once per message, and stays small.
    const messages = Array.isArray(req.body) ? req.body.length : 1;
    if (messages > MAX_BATCH) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: `At most ${MAX_BATCH} messages per request.` }, id: null });
      return;
    }
    let allowed = true;
    for (let i = 0; i < Math.max(messages, 1) && allowed; i++) allowed = mcpLimiter.take(visitor.ip ?? "unknown");
    if (!allowed) {
      res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests. Slow down a little." }, id: null });
      return;
    }
    if (!allowedOrigin(req)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Origin not allowed" }, id: null });
      return;
    }
    // No instance credential, ever: the cloud tools reach only the dispatcher.
    const server = createAgentDashServer(
      { apiUrl: NO_INSTANCE_API_URL, apiKey: "", companyId: null, agentId: null, runId: null },
      { toolset: "cloud", cloud: { backend: { call: (op, input) => agent.call(op, input, visitor) } } },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("cloud mcp request failed", { err });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error handling MCP request" }, id: null });
    }
  });

  // Stateless: no SSE stream to open and no session to end.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  router.get("/mcp", notAllowed);
  router.delete("/mcp", notAllowed);

  return router;
}
