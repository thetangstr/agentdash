// AgentDash (AGE-59): EmailService interface contract + factory selection tests.
// Tests relay backend success/error paths using mocked fetch.
// Tests factory selects the correct backend from config.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createEmailService,
  EmailRelayUnavailableError,
  type EmailServiceConfig,
} from "../services/email/index.js";
import type { Db } from "@agentdash/db";

// ---------------------------------------------------------------------------
// Mock logActivity so tests don't need a fully wired DB
// ---------------------------------------------------------------------------

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Stub DB (minimal — logActivity is mocked so we only need insert stub)
// ---------------------------------------------------------------------------

function buildStubDb(): Db {
  return {} as unknown as Db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RELAY_CONFIG: EmailServiceConfig = {
  emailBackend: "relay",
  emailRelayUrl: "https://relay.agentdash.com/transactional",
  emailRelayInstanceId: "test-instance",
  emailRelaySigningKey: "test-signing-key",
};

const WORKOS_CONFIG: EmailServiceConfig = {
  emailBackend: "workos",
  resendApiKey: "re_test_key",
};

// ---------------------------------------------------------------------------
// Factory selection
// ---------------------------------------------------------------------------

describe("createEmailService — factory selection", () => {
  it("returns relay backend when emailBackend=relay", () => {
    const db = buildStubDb();
    const svc = createEmailService(RELAY_CONFIG, db, "company-1");
    expect(svc).toBeDefined();
    expect(typeof svc.sendInvite).toBe("function");
    expect(typeof svc.sendJoinRequestNotification).toBe("function");
    expect(typeof svc.sendWelcome).toBe("function");
  });

  it("returns workos backend when emailBackend=workos", () => {
    const db = buildStubDb();
    const svc = createEmailService(WORKOS_CONFIG, db, "company-1");
    expect(svc).toBeDefined();
    expect(typeof svc.sendInvite).toBe("function");
  });

  it("throws on unknown backend", () => {
    const db = buildStubDb();
    expect(() =>
      createEmailService(
        { emailBackend: "unknown" as "relay" },
        db,
        "company-1",
      ),
    ).toThrow("Unknown EMAIL_BACKEND");
  });
});

// ---------------------------------------------------------------------------
// AgentDashRelayEmailService — success path
// ---------------------------------------------------------------------------

describe("AgentDashRelayEmailService — success path", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the relay endpoint on sendInvite", async () => {
    const db = buildStubDb();
    const svc = createEmailService(RELAY_CONFIG, db, "company-1");

    await svc.sendInvite({
      to: "admin@acme.com",
      orgName: "Acme Corp",
      inviteUrl: "https://app.agentdash.com/invite/pcp_invite_abcd1234",
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, opts] = (global.fetch as ReturnType<typeof vi.spyOn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.agentdash.com/transactional");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.to).toBe("admin@acme.com");
    expect(body.instanceId).toBe("test-instance");
    expect(typeof body.signature).toBe("string");
  });

  it("calls the relay endpoint on sendJoinRequestNotification", async () => {
    const db = buildStubDb();
    const svc = createEmailService(RELAY_CONFIG, db, "company-1");

    await svc.sendJoinRequestNotification({
      to: "owner@acme.com",
      orgName: "Acme Corp",
      requesterEmail: "newbie@acme.com",
      approveUrl: "https://app.agentdash.com/people?approve=req-1",
    });

    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("calls the relay endpoint on sendWelcome", async () => {
    const db = buildStubDb();
    const svc = createEmailService(RELAY_CONFIG, db, "company-1");

    await svc.sendWelcome({
      to: "jane@acme.com",
      orgName: "Acme Corp",
      name: "Jane",
    });

    expect(global.fetch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// AgentDashRelayEmailService — error paths
// ---------------------------------------------------------------------------

describe("AgentDashRelayEmailService — error paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws EmailRelayUnavailableError on network failure", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Network error"));
    const db = buildStubDb();
    const svc = createEmailService(RELAY_CONFIG, db, "company-1");

    await expect(
      svc.sendInvite({
        to: "admin@acme.com",
        orgName: "Acme Corp",
        inviteUrl: "https://app.agentdash.com/invite/abc",
        expiresAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(EmailRelayUnavailableError);
  });

  it("throws EmailRelayUnavailableError on 5xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );
    const db = buildStubDb();
    const svc = createEmailService(RELAY_CONFIG, db, "company-1");

    await expect(
      svc.sendInvite({
        to: "admin@acme.com",
        orgName: "Acme Corp",
        inviteUrl: "https://app.agentdash.com/invite/abc",
        expiresAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(EmailRelayUnavailableError);
  });

  it("throws EmailRelayUnavailableError on 4xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    const db = buildStubDb();
    const svc = createEmailService(RELAY_CONFIG, db, "company-1");

    await expect(
      svc.sendInvite({
        to: "admin@acme.com",
        orgName: "Acme Corp",
        inviteUrl: "https://app.agentdash.com/invite/abc",
        expiresAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(EmailRelayUnavailableError);
  });

  it("EmailRelayUnavailableError has correct name", () => {
    const err = new EmailRelayUnavailableError("test error");
    expect(err.name).toBe("EmailRelayUnavailableError");
    expect(err.message).toBe("test error");
    expect(err instanceof Error).toBe(true);
  });
});
