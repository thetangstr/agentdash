import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { meCapabilityRoutes } from "../routes/me-capabilities.js";

/**
 * The contract this endpoint exists to keep: the UI asks, and the answer comes
 * from the same predicate the enforcing route uses.
 *
 * Before it, `ui/src` had no permission system whatsoever — so once the
 * direction guard landed, a member could open a goal, see Edit, click, and get
 * a bare 403. A boundary that only announces itself after you press the button
 * reads as a broken product.
 *
 * The load-bearing property tested here is agreement: whatever this returns for
 * `direction:set` must match what `assertCanSetCompanyDirection` would do. They
 * share one implementation precisely so a test can assert that and mean it.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";

const mockAccess = vi.hoisted(() => ({ canUser: vi.fn() }));
vi.mock("../services/index.js", () => ({ accessService: () => mockAccess }));

function appFor(actor: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", meCapabilityRoutes({} as never));
  // Surface thrown HttpErrors as their status rather than a 500.
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

function human(role: string | null, opts: { instanceAdmin?: boolean } = {}) {
  return {
    type: "board",
    source: "session",
    userId: "user-1",
    isInstanceAdmin: opts.instanceAdmin ?? false,
    companyIds: [COMPANY],
    memberships: role ? [{ companyId: COMPANY, membershipRole: role, status: "active" }] : [],
  };
}

describe("GET /api/me/capabilities", () => {
  it("tells an owner they may set direction", async () => {
    mockAccess.canUser.mockResolvedValue(true);
    const res = await request(appFor(human("owner"))).get(`/api/me/capabilities?companyId=${COMPANY}`);
    expect(res.status).toBe(200);
    expect(res.body.capabilities["direction:set"]).toBe(true);
    expect(res.body.membershipRole).toBe("owner");
  });

  it("tells a member they may NOT — the case that produced a mystery 403", async () => {
    mockAccess.canUser.mockResolvedValue(false);
    const res = await request(appFor(human("member"))).get(`/api/me/capabilities?companyId=${COMPANY}`);
    expect(res.status).toBe(200);
    expect(res.body.capabilities["direction:set"]).toBe(false);
  });

  it("says no to everything for an agent", async () => {
    mockAccess.canUser.mockResolvedValue(true);
    const actor = { type: "agent", agentId: "agent-1", companyId: COMPANY };
    const res = await request(appFor(actor)).get(`/api/me/capabilities?companyId=${COMPANY}`);
    expect(res.status).toBe(200);
    expect(res.body.capabilities["direction:set"]).toBe(false);
  });

  it("reflects a delegated permission rather than the role title", async () => {
    // An owner can grant `tasks:assign` to a member; the UI must show the
    // delegation, not infer from the role and be wrong.
    mockAccess.canUser.mockImplementation(async (_c: string, _u: string, key: string) =>
      key === "tasks:assign",
    );
    const res = await request(appFor(human("member"))).get(`/api/me/capabilities?companyId=${COMPANY}`);
    expect(res.body.capabilities["tasks:assign"]).toBe(true);
    expect(res.body.capabilities["agents:create"]).toBe(false);
  });

  it("fails closed when the access service throws", async () => {
    // An error must never read as permission.
    mockAccess.canUser.mockRejectedValue(new Error("db down"));
    const res = await request(appFor(human("member"))).get(`/api/me/capabilities?companyId=${COMPANY}`);
    expect(res.status).toBe(200);
    expect(res.body.capabilities["agents:create"]).toBe(false);
    expect(res.body.capabilities["tasks:assign"]).toBe(false);
  });

  it("requires a companyId rather than guessing one", async () => {
    mockAccess.canUser.mockResolvedValue(false);
    const res = await request(appFor(human("owner"))).get("/api/me/capabilities");
    expect(res.status).toBe(400);
  });

  it("refuses to answer about a company the caller cannot see", async () => {
    mockAccess.canUser.mockResolvedValue(false);
    const outsider = { ...human("owner"), companyIds: ["22222222-2222-4222-8222-222222222222"] };
    const res = await request(appFor(outsider)).get(`/api/me/capabilities?companyId=${COMPANY}`);
    expect(res.status).toBe(403);
  });
});
