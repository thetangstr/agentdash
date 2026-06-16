import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { agentApiKeys, agents, boardApiKeys } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";

// Table-aware db mock: routes select().from(table).where() to the configured rows,
// regardless of call order, and no-ops update(). Mirrors the drizzle shape the
// auth middleware + board-auth service use (.select().from().where().then()).
function tableAwareDb(opts: {
  boardRows?: unknown[];
  agentKeyRows?: unknown[];
  agentRows?: unknown[];
}) {
  const rowsFor = (table: unknown) => {
    if (table === boardApiKeys) return opts.boardRows ?? [];
    if (table === agentApiKeys) return opts.agentKeyRows ?? [];
    if (table === agents) return opts.agentRows ?? [];
    return [];
  };
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(rowsFor(table)),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as never;
}

const TOKEN = "agent-secret-token";
const agentKeyRow = {
  id: "key-1",
  agentId: "agent-1",
  companyId: "co-1",
  keyHash: "ignored-by-mock",
  revokedAt: null,
};
const activeAgent = { id: "agent-1", companyId: "co-1", status: "active" };

function appWith(db: unknown) {
  const app = express();
  app.use(actorMiddleware(db as never, { deploymentMode: "authenticated" }));
  app.get("/actor", (req, res) => res.json(req.actor));
  return app;
}

describe("actorMiddleware x-agent-key header", () => {
  it("authenticates an agent that sends its key via the documented x-agent-key header", async () => {
    const app = appWith(
      tableAwareDb({ boardRows: [], agentKeyRows: [agentKeyRow], agentRows: [activeAgent] }),
    );
    const res = await request(app).get("/actor").set("x-agent-key", TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "co-1",
      keyId: "key-1",
      source: "agent_key",
    });
  });

  it("still authenticates the same key via Authorization: Bearer (regression)", async () => {
    const app = appWith(
      tableAwareDb({ boardRows: [], agentKeyRows: [agentKeyRow], agentRows: [activeAgent] }),
    );
    const res = await request(app).get("/actor").set("authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "agent", agentId: "agent-1", source: "agent_key" });
  });

  it("does not grant access when neither header is present", async () => {
    const app = appWith(tableAwareDb({ agentKeyRows: [agentKeyRow], agentRows: [activeAgent] }));
    const res = await request(app).get("/actor");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "none" });
  });

  it("prefers an explicit Authorization: Bearer over x-agent-key when both are sent", async () => {
    // Bearer present -> x-agent-key mapping is skipped; existing behavior is preserved.
    const app = appWith(
      tableAwareDb({ boardRows: [], agentKeyRows: [agentKeyRow], agentRows: [activeAgent] }),
    );
    const res = await request(app)
      .get("/actor")
      .set("authorization", `Bearer ${TOKEN}`)
      .set("x-agent-key", "some-other-value");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "agent", agentId: "agent-1" });
  });
});
