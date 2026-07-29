// AgentDash: Gmail Connector actions — "easier way" integration test.
//
// Demonstrates testing the connector end-to-end WITHOUT real OAuth or network:
//   - vi.mock("googleapis") feeds a fake Gmail API (the SDK seam)
//   - vi.mock the connectors service to supply a fixture token + connection row
// The real gmail-connector logic runs against these fakes: scope guards,
// company-ownership guards, header parsing, and connector-action logging.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted shared state + fakes (vi.mock factories run before module init, so
// anything they reference must be created inside vi.hoisted).
const h = vi.hoisted(() => {
  const fakeGmail = {
    users: {
      messages: { list: vi.fn(), get: vi.fn() },
      threads: { get: vi.fn() },
      drafts: { create: vi.fn() },
      getProfile: vi.fn(),
    },
  };
  const state = {
    conn: null as Record<string, unknown> | null,
    token: null as Record<string, unknown> | null,
    actions: [] as unknown[][],
  };
  const fakeConnSvc = {
    getById: vi.fn(async () => state.conn),
    getDecryptedToken: vi.fn(async () => state.token),
    logConnectorAction: vi.fn(async (...args: unknown[]) => {
      state.actions.push(args);
    }),
    refreshToken: vi.fn(async () => undefined),
  };
  return { fakeGmail, state, fakeConnSvc };
});

vi.mock("googleapis", () => ({
  google: {
    auth: {
      // Minimal OAuth2 stand-in: the connector only needs setCredentials + the
      // token-refresh event listener registration; it never makes a real call.
      OAuth2: class {
        setCredentials() {}
        on() {}
        generateAuthUrl() {
          return "https://accounts.google.com/o/oauth2/v2/auth?mock=1";
        }
      },
    },
    gmail: () => h.fakeGmail,
  },
}));

// gmail-connector imports "./connectors.js"; from this test file that resolves
// to the same module, so the mock applies inside the connector too.
vi.mock("../services/connectors.js", () => ({
  connectorService: () => h.fakeConnSvc,
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

import {
  gmailConnectorService,
  GMAIL_SCOPE_READONLY,
  GMAIL_SCOPE_COMPOSE,
} from "../services/gmail-connector.js";

// getOAuth2Client() reads these before constructing the (mocked) client.
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function svc() {
  // db is forwarded to the (mocked) connectorService, which ignores it.
  return gmailConnectorService({} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.actions = [];
  h.state.conn = {
    id: "conn-1",
    companyId: "company-1",
    ownerType: "agent",
    ownerId: "agent-1",
    scopes: [GMAIL_SCOPE_READONLY],
  };
  h.state.token = {
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    expiresAt: FUTURE,
    tokenType: "Bearer",
    scope: GMAIL_SCOPE_READONLY,
  };
});

describe("Gmail connector actions (mocked Gmail API + fixture token)", () => {
  it("searches messages, parses headers, and logs a read action", async () => {
    h.fakeGmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: "m1" }], nextPageToken: "next-page" },
    });
    h.fakeGmail.users.messages.get.mockResolvedValue({
      data: {
        id: "m1",
        threadId: "t1",
        snippet: "hello there",
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          headers: [
            { name: "Subject", value: "Quarterly report" },
            { name: "From", value: "alice@acme.com" },
            { name: "To", value: "me@demo.com" },
            { name: "Date", value: "Wed, 04 Jun 2026 10:00:00 -0700" },
          ],
        },
      },
    });

    const result = await svc().search("conn-1", "company-1", { query: "is:unread" });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: "m1",
      threadId: "t1",
      snippet: "hello there",
      subject: "Quarterly report",
      from: "alice@acme.com",
      to: "me@demo.com",
      labelIds: ["INBOX", "UNREAD"],
    });
    expect(result.nextPageToken).toBe("next-page");

    // The Gmail API was called with the search query.
    expect(h.fakeGmail.users.messages.list).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "me", q: "is:unread" }),
    );
    // A connection.read action was logged for audit/autonomy.
    expect(h.fakeConnSvc.logConnectorAction).toHaveBeenCalledTimes(1);
    const [, connId, action, , , meta] = h.state.actions[0];
    expect(connId).toBe("conn-1");
    expect(action).toBe("connection.read");
    expect(meta).toMatchObject({ action: "gmail.search", resultCount: 1 });
  });

  it("rejects search when the connection lacks the gmail.readonly scope", async () => {
    h.state.conn = { ...(h.state.conn as object), scopes: [] };
    await expect(svc().search("conn-1", "company-1", { query: "x" })).rejects.toThrow(
      /gmail.readonly/,
    );
    expect(h.fakeGmail.users.messages.list).not.toHaveBeenCalled();
  });

  it("rejects access when the connection belongs to another company", async () => {
    await expect(
      svc().search("conn-1", "other-company", { query: "x" }),
    ).rejects.toThrow(/another company/);
  });

  it("rejects createDraft when the connection lacks the gmail.compose scope", async () => {
    // Default fixture has readonly only.
    await expect(
      svc().createDraft(
        "conn-1",
        "company-1",
        { to: ["x@y.com"], subject: "Hi", body: "Body" },
        "agent-1",
      ),
    ).rejects.toThrow(/gmail.compose/);
    expect(h.fakeGmail.users.drafts.create).not.toHaveBeenCalled();
  });

  it("creates a draft when the connection has the gmail.compose scope", async () => {
    h.state.conn = {
      ...(h.state.conn as object),
      scopes: [GMAIL_SCOPE_READONLY, GMAIL_SCOPE_COMPOSE],
    };
    h.fakeGmail.users.getProfile.mockResolvedValue({
      data: { emailAddress: "me@demo.com" },
    });
    h.fakeGmail.users.drafts.create.mockResolvedValue({
      data: { id: "draft-1", message: { id: "msg-9" } },
    });

    const result = await svc().createDraft(
      "conn-1",
      "company-1",
      { to: ["alice@acme.com"], subject: "Re: report", body: "Thanks!" },
      "agent-1",
    );

    expect(result.draftId).toBe("draft-1");
    expect(h.fakeGmail.users.drafts.create).toHaveBeenCalledTimes(1);
  });
});
