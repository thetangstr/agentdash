// AgentDash (AGE-104 follow-up): unit tests for the corp-email signup guard.
// The guard moves the AGE-60 rule from company-creation to the signup
// endpoint so users see "use your work email" BEFORE they have an account
// stuck in a dead end.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { corpEmailSignupGuard } from "../middleware/corp-email-signup-guard.js";

function buildApp(opts: { enabled: boolean }) {
  const app = express();
  app.use(express.json());
  app.use(corpEmailSignupGuard(opts));
  // Stand-in for the real better-auth handler — proves the guard short-circuits.
  app.all("/api/auth/*authPath", (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  return app;
}

describe("corpEmailSignupGuard (AGE-104 follow-up)", () => {
  it("blocks free-mail signup with pro_requires_corp_email when enabled", async () => {
    const app = buildApp({ enabled: true });
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Jane", email: "jane@gmail.com", password: "hunter2hunter2" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "pro_requires_corp_email",
      error:
        "Pro accounts require a company email. Please sign up with your work email or use the Free self-hosted plan.",
    });
  });

  it("treats the FREE_MAIL_DOMAINS list case-insensitively", async () => {
    const app = buildApp({ enabled: true });
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Jane", email: "Jane@YAHOO.com", password: "hunter2hunter2" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("pro_requires_corp_email");
  });

  it("lets corp-email signups through to better-auth", async () => {
    const app = buildApp({ enabled: true });
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Jane", email: "jane@acme.com", password: "hunter2hunter2" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it("passes through when disabled (Free / local-trusted deployment)", async () => {
    const app = buildApp({ enabled: false });
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Jane", email: "jane@gmail.com", password: "hunter2hunter2" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it("does not interfere with sign-in or other auth paths", async () => {
    const app = buildApp({ enabled: true });
    const res = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "jane@gmail.com", password: "hunter2hunter2" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it("ignores requests with no email field (lets better-auth respond)", async () => {
    const app = buildApp({ enabled: true });
    const res = await request(app).post("/api/auth/sign-up/email").send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it("does not block malformed emails (no @) — better-auth will reject them", async () => {
    const app = buildApp({ enabled: true });
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Jane", email: "not-an-email", password: "hunter2hunter2" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });
});
