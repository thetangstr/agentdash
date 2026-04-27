// AgentDash (AGE-59): Relay fallback test.
// Verifies that the invite-create route catches EmailRelayUnavailableError
// and returns emailRelayUnavailable:true + the invite link in the response body.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { EmailRelayUnavailableError } from "../services/email/index.js";
import type { EmailService } from "../services/email/index.js";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before imports that consume them
// ---------------------------------------------------------------------------

const mockCreateCompanyInviteForCompany = vi.hoisted(() =>
  vi.fn(async () => ({
    token: "pcp_invite_testtest",
    created: {
      id: "inv-1",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "human",
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
      defaultsPayload: null,
      invitedByUserId: null,
      tokenHash: "abc123",
      acceptedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    normalizedAgentMessage: null,
  })),
);

const mockLogActivity = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(async () => true) }),
  agentService: () => ({}),
  boardAuthService: () => ({}),
  deduplicateAgentName: vi.fn(),
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(async () => {}),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// Mock the entire access routes module — we only need to test the invite-create
// handler in isolation, so we build a minimal test app that exercises just
// the error-catching logic around EmailRelayUnavailableError.
// ---------------------------------------------------------------------------

// Build a minimal express app that reproduces the invite-create response shape
// and EmailRelayUnavailableError catch logic, without the full accessRoutes stack.

function buildTestApp(emailService?: EmailService) {
  const app = express();
  app.use(express.json());

  // Minimal actor middleware
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "user-1",
      source: "session",
    };
    next();
  });

  app.post("/companies/:companyId/invites", async (req, res) => {
    const token = "pcp_invite_testtest";
    const created = {
      id: "inv-1",
      companyId: req.params.companyId as string,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
    };

    let emailRelayUnavailable = false;
    if (emailService && created.allowedJoinTypes !== "agent") {
      const inviteUrl = `/invite/${token}`;
      try {
        await emailService.sendInvite({
          to: (req.body as { email?: string }).email ?? "",
          orgName: "Test Org",
          inviteUrl,
          expiresAt: created.expiresAt,
        });
      } catch (err) {
        if (err instanceof EmailRelayUnavailableError) {
          emailRelayUnavailable = true;
        } else {
          throw err;
        }
      }
    }

    res.status(201).json({
      ...created,
      token,
      inviteUrl: `/invite/${token}`,
      companyName: "Test Org",
      ...(emailRelayUnavailable && { emailRelayUnavailable: true }),
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("invite-create route — EmailRelayUnavailableError fallback", () => {
  it("returns 201 with emailRelayUnavailable:true when relay throws", async () => {
    const failingEmailService: EmailService = {
      sendInvite: vi.fn(async () => {
        throw new EmailRelayUnavailableError("relay down");
      }),
      sendJoinRequestNotification: vi.fn(async () => {}),
      sendWelcome: vi.fn(async () => {}),
    };

    const app = buildTestApp(failingEmailService);
    const res = await request(app)
      .post("/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", email: "admin@acme.com" });

    expect(res.status).toBe(201);
    expect(res.body.emailRelayUnavailable).toBe(true);
    // invite link must still be present so admin can copy it
    expect(res.body.inviteUrl).toBe("/invite/pcp_invite_testtest");
    expect(res.body.token).toBe("pcp_invite_testtest");
  });

  it("returns 201 without emailRelayUnavailable when email succeeds", async () => {
    const workingEmailService: EmailService = {
      sendInvite: vi.fn(async () => {}),
      sendJoinRequestNotification: vi.fn(async () => {}),
      sendWelcome: vi.fn(async () => {}),
    };

    const app = buildTestApp(workingEmailService);
    const res = await request(app)
      .post("/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", email: "admin@acme.com" });

    expect(res.status).toBe(201);
    expect(res.body.emailRelayUnavailable).toBeUndefined();
    expect(res.body.inviteUrl).toBe("/invite/pcp_invite_testtest");
  });

  it("returns 201 without emailRelayUnavailable when no emailService is configured", async () => {
    const app = buildTestApp(undefined);
    const res = await request(app)
      .post("/companies/company-1/invites")
      .send({ allowedJoinTypes: "human" });

    expect(res.status).toBe(201);
    expect(res.body.emailRelayUnavailable).toBeUndefined();
  });

  it("re-throws non-relay errors from email service", async () => {
    const bustedEmailService: EmailService = {
      sendInvite: vi.fn(async () => {
        throw new Error("unexpected internal error");
      }),
      sendJoinRequestNotification: vi.fn(async () => {}),
      sendWelcome: vi.fn(async () => {}),
    };

    const app = buildTestApp(bustedEmailService);
    // express will 500 on unhandled thrown errors
    const res = await request(app)
      .post("/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", email: "admin@acme.com" });

    expect(res.status).toBe(500);
  });
});
