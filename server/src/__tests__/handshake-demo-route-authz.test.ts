import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AgentDash (security): POST /api/handshake-demo/go seeds companies by fixed
// global names and drives their agents with no tenant check. It must be off
// unless AGENTDASH_HANDSHAKE_DEMO_ENABLED is set, and instance-admin only.

const advance = vi.hoisted(() => vi.fn(async () => ({ steps: [], done: false })));

vi.mock("../services/handshake-demo.js", () => ({
  handshakeDemoService: () => ({ advance }),
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ handshakeDemoRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/handshake-demo.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", handshakeDemoRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const member = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: ["c-1"] };
const admin = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true, companyIds: [] };
const localBoard = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

describe.sequential("handshake demo route gating", () => {
  const original = process.env.AGENTDASH_HANDSHAKE_DEMO_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AGENTDASH_HANDSHAKE_DEMO_ENABLED;
    else process.env.AGENTDASH_HANDSHAKE_DEMO_ENABLED = original;
  });

  it.each([["member", member], ["admin", admin], ["local board", localBoard]])(
    "404s for %s when the flag is unset",
    async (_label, actor) => {
      delete process.env.AGENTDASH_HANDSHAKE_DEMO_ENABLED;
      const app = await createApp(actor);
      const res = await request(app).post("/api/handshake-demo/go").send({});
      expect(res.status).toBe(404);
      expect(advance).not.toHaveBeenCalled();
    },
    20_000,
  );

  it("403s a non-admin company member when the flag is on", async () => {
    process.env.AGENTDASH_HANDSHAKE_DEMO_ENABLED = "true";
    const app = await createApp(member);
    const res = await request(app).post("/api/handshake-demo/go").send({});
    expect(res.status).toBe(403);
    expect(advance).not.toHaveBeenCalled();
  }, 20_000);

  it.each([["admin", admin], ["local board", localBoard]])(
    "allows %s when the flag is on",
    async (_label, actor) => {
      process.env.AGENTDASH_HANDSHAKE_DEMO_ENABLED = "1";
      const app = await createApp(actor);
      const res = await request(app).post("/api/handshake-demo/go").send({});
      expect(res.status).toBe(200);
      expect(advance).toHaveBeenCalledTimes(1);
    },
    20_000,
  );
});
