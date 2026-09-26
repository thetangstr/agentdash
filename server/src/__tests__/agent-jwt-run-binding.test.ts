// AgentDash (GH #782): a run JWT carries the run it was minted for as
// `jwtRunId`, which an X-Paperclip-Run-Id header cannot change. The agent git
// credential endpoint relies on it.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, boardApiKeys } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";

const AGENT_ID = randomUUID();
const COMPANY_ID = randomUUID();
const RUN_ID = randomUUID();

function db() {
  const rowsFor = (table: unknown) => {
    if (table === agents) return [{ id: AGENT_ID, companyId: COMPANY_ID, status: "active", role: "engineer" }];
    if (table === boardApiKeys || table === agentApiKeys) return [];
    return [];
  };
  return {
    select: () => ({ from: (table: unknown) => ({ where: () => Promise.resolve(rowsFor(table)) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as never;
}

describe("run JWT binding", () => {
  const saved = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret-for-run-binding-0123456789";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = saved;
  });

  function app() {
    const a = express();
    a.use(actorMiddleware(db(), { deploymentMode: "authenticated" }));
    a.get("/actor", (req, res) => res.json(req.actor));
    return a;
  }

  it("exposes the signed run id, and a header does not replace it", async () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "hermes_local", RUN_ID);
    expect(token).toBeTruthy();
    const plain = await request(app()).get("/actor").set("authorization", `Bearer ${token}`);
    expect(plain.body).toMatchObject({ type: "agent", source: "agent_jwt", runId: RUN_ID, jwtRunId: RUN_ID });

    const other = randomUUID();
    const spoofed = await request(app())
      .get("/actor")
      .set("authorization", `Bearer ${token}`)
      .set("x-paperclip-run-id", other);
    expect(spoofed.body).toMatchObject({ source: "agent_jwt", runId: other, jwtRunId: RUN_ID });
  });
});
