// AgentDash: invite-code validation endpoint — POST /api/invites/validate.
// The cloud side of the fresh-install funnel gate: constant-shape {valid}
// responses, codes from AGENTDASH_INVITE_CODES, auth-tier rate limiter.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inviteCodeRoutes } from "../routes/invite-codes.js";

const rateLimiterMiddleware = vi.fn(
  (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
);
vi.mock("../middleware/rate-limit.js", () => ({
  createAuthRateLimiter: vi.fn(() => rateLimiterMiddleware),
}));

import { createAuthRateLimiter } from "../middleware/rate-limit.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", inviteCodeRoutes({ deploymentMode: "authenticated" }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENTDASH_INVITE_CODES = "AGD-ALPHA-1234, AGD-BETA-5678";
});

afterEach(() => {
  delete process.env.AGENTDASH_INVITE_CODES;
});

describe("POST /api/invites/validate", () => {
  it("valid:true for a configured code (whitespace in env tolerated)", async () => {
    for (const code of ["AGD-ALPHA-1234", "AGD-BETA-5678"]) {
      const res = await request(buildApp()).post("/api/invites/validate").send({ code });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true });
    }
  });

  it("valid:false for an unknown code — same shape, no hints", async () => {
    const res = await request(buildApp())
      .post("/api/invites/validate")
      .send({ code: "AGD-NOPE-0000" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it("valid:false when no codes are configured at all (never valid-by-default)", async () => {
    delete process.env.AGENTDASH_INVITE_CODES;
    const res = await request(buildApp())
      .post("/api/invites/validate")
      .send({ code: "ANYTHING" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it("trims the candidate code before comparing", async () => {
    const res = await request(buildApp())
      .post("/api/invites/validate")
      .send({ code: "  AGD-ALPHA-1234  " });
    expect(res.body).toEqual({ valid: true });
  });

  it("400 invalid_body on a missing or empty code", async () => {
    for (const body of [{}, { code: "" }, { code: 42 }]) {
      const res = await request(buildApp()).post("/api/invites/validate").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_body");
    }
  });

  it("wires the auth-tier rate limiter in front of the handler", async () => {
    const app = buildApp();
    expect(createAuthRateLimiter).toHaveBeenCalledWith({ deploymentMode: "authenticated" });
    rateLimiterMiddleware.mockClear();
    await request(app).post("/api/invites/validate").send({ code: "AGD-ALPHA-1234" });
    expect(rateLimiterMiddleware).toHaveBeenCalledTimes(1);
  });
});
