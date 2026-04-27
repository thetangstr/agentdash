// AgentDash (AGE-58): Supertest cases for the WorkOS webhook route.
// Tests: valid signature accepts, invalid → 401, user.created upserts authUsers,
// user.updated upserts, replay protection (idempotent re-delivery).

import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { workosWebhookHandler } from "../routes/auth-webhooks.js";
import type { Db } from "@agentdash/db";

// ---------------------------------------------------------------------------
// Mock activity-log so we don't need a real DB for logging
// ---------------------------------------------------------------------------

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test_webhook_secret_abc123";

/** Build a WorkOS-style signature header: `t=<timestamp>,v1=<hmac>` */
function buildSignatureHeader(body: string, secret: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const payload = `${ts}.${body}`;
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${ts},v1=${hmac}`;
}

/** Build a minimal WorkOS user event payload. */
function buildUserEvent(
  eventType: "user.created" | "user.updated",
  userId = "user_wos_test_1",
): { body: string; event: object } {
  const event = {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    event: eventType,
    data: {
      id: userId,
      email: `${userId}@acme.com`,
      first_name: "Test",
      last_name: "User",
    },
  };
  return { body: JSON.stringify(event), event };
}

/** Build a stub Db instance for webhook tests. */
function buildStubDb(opts: {
  existingUser?: boolean;
  insertSpy?: ReturnType<typeof vi.fn>;
  updateSpy?: ReturnType<typeof vi.fn>;
}): Db {
  const { existingUser = false, insertSpy, updateSpy } = opts;

  const insertMock = insertSpy ?? vi.fn(() => ({
    values: vi.fn().mockResolvedValue(undefined),
  }));

  const updateMock = updateSpy ?? vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    then: (fn: (rows: unknown[]) => unknown) =>
      Promise.resolve(fn(existingUser ? [{ id: "user_wos_test_1" }] : [])),
  };

  return {
    select: vi.fn(() => selectChain),
    insert: insertMock,
    update: updateMock,
  } as unknown as Db;
}

/** Build a minimal Express app mounting only the WorkOS webhook handler. */
function buildApp(db: Db, secret = TEST_SECRET) {
  const app = express();
  // The route needs rawBody — wire it up as app.ts does.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.post("/api/auth/webhooks/workos", workosWebhookHandler(db, secret));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkOS webhook route (AGE-58)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Signature validation
  // -------------------------------------------------------------------------

  describe("signature validation", () => {
    it("returns 401 when workos-signature header is missing", async () => {
      const db = buildStubDb({});
      const app = buildApp(db);
      const { body } = buildUserEvent("user.created");

      const res = await request(app)
        .post("/api/auth/webhooks/workos")
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/signature/i);
    });

    it("returns 401 when workos-signature uses the wrong secret", async () => {
      const db = buildStubDb({});
      const app = buildApp(db);
      const { body } = buildUserEvent("user.created");
      const badSig = buildSignatureHeader(body, "wrong_secret");

      const res = await request(app)
        .post("/api/auth/webhooks/workos")
        .set("Content-Type", "application/json")
        .set("workos-signature", badSig)
        .send(body);

      expect(res.status).toBe(401);
    });

    it("accepts a request with a valid workos-signature", async () => {
      const db = buildStubDb({});
      const app = buildApp(db);
      const { body } = buildUserEvent("user.created");
      const sig = buildSignatureHeader(body, TEST_SECRET);

      const res = await request(app)
        .post("/api/auth/webhooks/workos")
        .set("Content-Type", "application/json")
        .set("workos-signature", sig)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // user.created — inserts into authUsers
  // -------------------------------------------------------------------------

  describe("user.created event", () => {
    it("inserts a new authUsers row when user does not exist", async () => {
      const insertValuesMock = vi.fn().mockResolvedValue(undefined);
      const insertMock = vi.fn(() => ({ values: insertValuesMock }));
      const db = buildStubDb({ existingUser: false, insertSpy: insertMock });
      const app = buildApp(db);

      const userId = "user_wos_new_1";
      const { body } = buildUserEvent("user.created", userId);
      const sig = buildSignatureHeader(body, TEST_SECRET);

      const res = await request(app)
        .post("/api/auth/webhooks/workos")
        .set("Content-Type", "application/json")
        .set("workos-signature", sig)
        .send(body);

      expect(res.status).toBe(200);
      expect(insertMock).toHaveBeenCalled();
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: userId, email: `${userId}@acme.com` }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // user.updated — upserts authUsers
  // -------------------------------------------------------------------------

  describe("user.updated event", () => {
    it("updates an existing authUsers row when user already exists", async () => {
      const setMock = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      const updateMock = vi.fn(() => ({ set: setMock }));
      const db = buildStubDb({ existingUser: true, updateSpy: updateMock });
      const app = buildApp(db);

      const userId = "user_wos_test_1";
      const { body } = buildUserEvent("user.updated", userId);
      const sig = buildSignatureHeader(body, TEST_SECRET);

      const res = await request(app)
        .post("/api/auth/webhooks/workos")
        .set("Content-Type", "application/json")
        .set("workos-signature", sig)
        .send(body);

      expect(res.status).toBe(200);
      expect(updateMock).toHaveBeenCalled();
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({ email: `${userId}@acme.com` }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Replay protection — idempotent re-delivery
  // -------------------------------------------------------------------------

  describe("replay protection", () => {
    it("processes the same event twice without error (idempotent upsert)", async () => {
      const db = buildStubDb({ existingUser: false });
      const app = buildApp(db);

      const { body } = buildUserEvent("user.created", "user_wos_replay");
      const sig = buildSignatureHeader(body, TEST_SECRET);

      // First delivery
      const res1 = await request(app)
        .post("/api/auth/webhooks/workos")
        .set("Content-Type", "application/json")
        .set("workos-signature", sig)
        .send(body);

      // Second delivery (same event) — should not error
      const res2 = await request(app)
        .post("/api/auth/webhooks/workos")
        .set("Content-Type", "application/json")
        .set("workos-signature", sig)
        .send(body);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown event types
  // -------------------------------------------------------------------------

  describe("unknown event types", () => {
    it("returns 200 without error for unknown event types", async () => {
      const db = buildStubDb({});
      const app = buildApp(db);

      const unknownEvent = JSON.stringify({
        id: "evt_unknown_1",
        event: "organization.created",
        data: { id: "org_1" },
      });
      const sig = buildSignatureHeader(unknownEvent, TEST_SECRET);

      const res = await request(app)
        .post("/api/auth/webhooks/workos")
        .set("Content-Type", "application/json")
        .set("workos-signature", sig)
        .send(unknownEvent);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });
});
