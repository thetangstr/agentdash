// The browser signup funnel was completely open.
//
// Verified 2026-07-31: Better Auth's POST /api/auth/sign-up/email had no
// invite-code gate. The only signup middleware was corpEmailSignupGuard, which
// is disabled by default. Meanwhile the MCP self-serve path WAS gated — so the
// funnel control everyone believed was in place covered one of two doors.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inviteCodeSignupGuard } from "../middleware/invite-code-signup-guard.js";

/** Mounts the guard exactly where app.ts does: in front of the auth router. */
function buildApp(enabled: boolean) {
  const seen: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  app.use("/api/auth", inviteCodeSignupGuard({ enabled }));
  app.use("/api/auth", (req, res) => {
    // Stands in for Better Auth: records what actually reached it.
    seen.push({ ...(req.body as Record<string, unknown>) });
    res.status(200).json({ ok: true });
  });
  return { app, seen };
}

beforeEach(() => {
  process.env.AGENTDASH_INVITE_CODES = "GENERAL-CODE";
  process.env.AGENTDASH_MK_INVITE_CODES = "PARTNER-ALPHA";
});

afterEach(() => {
  delete process.env.AGENTDASH_INVITE_CODES;
  delete process.env.AGENTDASH_MK_INVITE_CODES;
  vi.restoreAllMocks();
});

describe("invite-code signup guard", () => {
  it("is off by default, so existing installs and local dev are untouched", async () => {
    const { app, seen } = buildApp(false);

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x" });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("refuses signup with no code when enabled", async () => {
    const { app, seen } = buildApp(true);

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("invite_code_required");
    expect(seen, "signup reached the auth layer despite the refusal").toHaveLength(0);
  });

  it("refuses a wrong code", async () => {
    const { app, seen } = buildApp(true);

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteCode: "GUESSED" });

    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("gives the same answer for a missing and a wrong code", async () => {
    // Distinguishing them tells a guesser whether they are close.
    const { app } = buildApp(true);

    const missing = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x" });
    const wrong = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteCode: "GUESSED" });

    expect(missing.body).toEqual(wrong.body);
  });

  it("accepts a general invite code", async () => {
    const { app, seen } = buildApp(true);

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteCode: "GENERAL-CODE" });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("accepts an MK code too, so a design partner needs only one secret", async () => {
    const { app, seen } = buildApp(true);

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteCode: "PARTNER-ALPHA" });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("strips the code before the auth layer sees the body", async () => {
    // Better Auth does not model an inviteCode field; passing it through risks
    // a validation error or, worse, persistence of a shared secret.
    const { app, seen } = buildApp(true);

    await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteCode: "GENERAL-CODE" });

    expect(seen[0].inviteCode).toBeUndefined();
    expect(seen[0].email).toBe("a@b.com");
  });

  it("leaves sign-IN alone", async () => {
    // Only signup is gated. Locking out existing users would be an outage.
    const { app, seen } = buildApp(true);

    const res = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "a@b.com", password: "x" });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("refuses when no codes are configured at all", async () => {
    // Fail closed: enabling the gate with an empty list must not mean "allow
    // everyone", which is the failure mode an empty allowlist usually has.
    delete process.env.AGENTDASH_INVITE_CODES;
    delete process.env.AGENTDASH_MK_INVITE_CODES;
    const { app, seen } = buildApp(true);

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteCode: "ANYTHING" });

    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});
