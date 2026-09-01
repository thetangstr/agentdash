import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { mcpRoutes } from "../routes/mcp.js";

/**
 * The turnkey harness endpoint: URL + agent key and nothing else.
 *
 * Verified against a live instance with a real MCP protocol client before this
 * test existed — serverInfo `agentdash`, the agent's own 3,013-char playbook as
 * instructions, 71 tools, a live tool call. This pins the contract those
 * observations relied on: an agent key initializes, anything else is told
 * plainly what to present, and the endpoint answers JSON-RPC rather than
 * hanging a stream.
 */

function appWithActor(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", mcpRoutes());
  return app;
}

const AGENT_ACTOR = {
  type: "agent",
  agentId: "00000000-0000-4000-8000-0000000000a1",
  companyId: "00000000-0000-4000-8000-0000000000c1",
};

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "endpoint-test", version: "0.0.1" },
  },
};

describe("POST /api/mcp", () => {
  it("initializes for an agent key and identifies itself with per-agent instructions", async () => {
    const res = await request(appWithActor(AGENT_ACTOR))
      .post("/api/mcp")
      .set("Authorization", "Bearer pcp_test_key")
      .set("Accept", "application/json, text/event-stream")
      .send(INITIALIZE);

    expect(res.status).toBe(200);
    expect(res.body?.result?.serverInfo?.name).toBe("agentdash");
    // The greeting is the point: the harness is briefed as ONE specific agent,
    // not handed the operator's provisioning playbook.
    expect(String(res.body?.result?.instructions)).toMatch(/you are (an agentdash agent|connected)/i);
  });

  it("refuses a non-agent actor and says what to present instead", async () => {
    const res = await request(appWithActor({ type: "board", userId: "u1" }))
      .post("/api/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send(INITIALIZE);

    expect(res.status).toBe(401);
    expect(res.body?.error).toMatch(/agent key/i);
  });

  it("answers GET with an explanation, not a 404 that reads as a wrong URL", async () => {
    const res = await request(appWithActor(AGENT_ACTOR)).get("/api/mcp");
    expect(res.status).toBe(405);
    expect(res.body?.error).toMatch(/stateless/i);
  });
});
