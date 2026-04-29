// AgentDash (AGE-100): Free single-seat cap.
// Self-hosted Free deployments accept exactly one signup; subsequent
// signups return HTTP 403 free_tier_seat_cap.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { freeSeatCapMiddleware } from "../middleware/free-seat-cap.js";

let userCount = 0;

const fakeDb = {
  select: vi.fn(() => ({
    from: () => Promise.resolve([{ value: userCount }]),
  })),
} as any;

function buildApp(opts: { enabled: boolean }) {
  const app = express();
  app.use(express.json());
  app.use(freeSeatCapMiddleware(fakeDb, { enabled: opts.enabled }));
  // Stand-in for better-auth handler — only reached when middleware lets us through.
  app.all("/api/auth/*authPath", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  // Sanity: any non-auth route should be unaffected by the middleware.
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  userCount = 0;
});

describe("freeSeatCapMiddleware (AGE-100)", () => {
  it("allows the 1st signup on Free (count=0)", async () => {
    userCount = 0;
    const app = buildApp({ enabled: true });
    const res = await request(app).post("/api/auth/sign-up/email").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("blocks the 2nd signup on Free with 403 free_tier_seat_cap", async () => {
    userCount = 1;
    const app = buildApp({ enabled: true });
    const res = await request(app).post("/api/auth/sign-up/email").send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("free_tier_seat_cap");
    expect(res.body.error).toContain("Self-hosted Free supports one human");
  });

  it("blocks at any user count >= 1, including very many", async () => {
    userCount = 47;
    const app = buildApp({ enabled: true });
    const res = await request(app).post("/api/auth/sign-up/email").send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("free_tier_seat_cap");
  });

  it("does NOT gate when enabled=false (Pro deployment)", async () => {
    userCount = 100;
    const app = buildApp({ enabled: false });
    const res = await request(app).post("/api/auth/sign-up/email").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("ignores non-signup auth paths (sign-in, callback, etc)", async () => {
    userCount = 5;
    const app = buildApp({ enabled: true });
    for (const p of [
      "/api/auth/sign-in/email",
      "/api/auth/get-session",
      "/api/auth/callback/google",
    ]) {
      const res = await request(app).post(p).send({});
      expect(res.status).toBe(200);
    }
  });

  it("does not affect non-auth routes regardless of seat count", async () => {
    userCount = 999;
    const app = buildApp({ enabled: true });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});
