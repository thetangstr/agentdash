// AgentDash: Gmail Connector (AGE-109) — unit tests
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Test helpers: RFC 2822 builder & base64url encoder (mirrors service logic)
// ---------------------------------------------------------------------------

function buildRfc2822(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${opts.subject}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("");
  lines.push(opts.body);
  return lines.join("\r\n");
}

function encodeMessage(raw: string): string {
  return Buffer.from(raw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function attributionFooter(agentName: string): string {
  return `\n\n---\nDrafted by ${agentName}`;
}

// ---------------------------------------------------------------------------
// Tests: RFC 2822 message building
// ---------------------------------------------------------------------------

describe("Gmail RFC 2822 message builder", () => {
  it("builds a basic email", () => {
    const raw = buildRfc2822({
      from: "alice@example.com",
      to: "bob@example.com",
      subject: "Hello",
      body: "Hi Bob, how are you?",
    });

    expect(raw).toContain("From: alice@example.com");
    expect(raw).toContain("To: bob@example.com");
    expect(raw).toContain("Subject: Hello");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toContain("Hi Bob, how are you?");
  });

  it("includes cc and bcc when provided", () => {
    const raw = buildRfc2822({
      from: "alice@example.com",
      to: "bob@example.com",
      subject: "Test",
      body: "body",
      cc: "carol@example.com",
      bcc: "dave@example.com",
    });

    expect(raw).toContain("Cc: carol@example.com");
    expect(raw).toContain("Bcc: dave@example.com");
  });

  it("omits cc and bcc when not provided", () => {
    const raw = buildRfc2822({
      from: "alice@example.com",
      to: "bob@example.com",
      subject: "Test",
      body: "body",
    });

    expect(raw).not.toContain("Cc:");
    expect(raw).not.toContain("Bcc:");
  });

  it("includes In-Reply-To and References for thread replies", () => {
    const raw = buildRfc2822({
      from: "alice@example.com",
      to: "bob@example.com",
      subject: "Re: Hello",
      body: "Thanks!",
      inReplyTo: "<msg-123@example.com>",
      references: "<msg-100@example.com> <msg-123@example.com>",
    });

    expect(raw).toContain("In-Reply-To: <msg-123@example.com>");
    expect(raw).toContain("References: <msg-100@example.com> <msg-123@example.com>");
  });
});

// ---------------------------------------------------------------------------
// Tests: base64url encoding
// ---------------------------------------------------------------------------

describe("Gmail base64url encoding", () => {
  it("encodes a simple message", () => {
    const encoded = encodeMessage("Hello World");
    expect(encoded).toBe(Buffer.from("Hello World").toString("base64").replace(/=+$/, ""));
    // Must not contain + or /
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("replaces + with - and / with _", () => {
    // Create a string that produces + and / in base64
    const testStr = "subjects?with+special/chars";
    const encoded = encodeMessage(testStr);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  it("strips trailing = padding", () => {
    // "A" encodes to "QQ==" in base64
    const encoded = encodeMessage("A");
    expect(encoded).not.toContain("=");
  });
});

// ---------------------------------------------------------------------------
// Tests: attribution footer
// ---------------------------------------------------------------------------

describe("Gmail attribution footer", () => {
  it("generates the correct footer", () => {
    const footer = attributionFooter("ResearchBot");
    expect(footer).toBe("\n\n---\nDrafted by ResearchBot");
  });

  it("appends the footer to a message body for delegated_attributed identity", () => {
    const body = "Here is the report you requested.";
    const withFooter = body + attributionFooter("AnalystAgent");
    expect(withFooter).toContain("Here is the report you requested.");
    expect(withFooter).toContain("---\nDrafted by AnalystAgent");
  });
});

// ---------------------------------------------------------------------------
// Tests: scope validation logic
// ---------------------------------------------------------------------------

describe("Gmail scope validation", () => {
  const GMAIL_SCOPE_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
  const GMAIL_SCOPE_SEND = "https://mail.google.com/auth/gmail.send";
  const GMAIL_SCOPE_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

  function hasScope(grantedScopes: string[], required: string): boolean {
    return grantedScopes.includes(required);
  }

  function hasSendScopes(grantedScopes: string[]): boolean {
    return hasScope(grantedScopes, GMAIL_SCOPE_SEND) && hasScope(grantedScopes, GMAIL_SCOPE_COMPOSE);
  }

  it("read-only scopes allow read but not send", () => {
    const scopes = [GMAIL_SCOPE_READONLY];
    expect(hasScope(scopes, GMAIL_SCOPE_READONLY)).toBe(true);
    expect(hasSendScopes(scopes)).toBe(false);
  });

  it("read+send scopes allow both read and send", () => {
    const scopes = [GMAIL_SCOPE_READONLY, GMAIL_SCOPE_SEND, GMAIL_SCOPE_COMPOSE];
    expect(hasScope(scopes, GMAIL_SCOPE_READONLY)).toBe(true);
    expect(hasSendScopes(scopes)).toBe(true);
  });

  it("partial send scopes (send only, no compose) block send", () => {
    const scopes = [GMAIL_SCOPE_READONLY, GMAIL_SCOPE_SEND];
    expect(hasSendScopes(scopes)).toBe(false);
  });

  it("partial send scopes (compose only, no send) block send", () => {
    const scopes = [GMAIL_SCOPE_READONLY, GMAIL_SCOPE_COMPOSE];
    expect(hasSendScopes(scopes)).toBe(false);
  });

  it("empty scopes block everything", () => {
    const scopes: string[] = [];
    expect(hasScope(scopes, GMAIL_SCOPE_READONLY)).toBe(false);
    expect(hasSendScopes(scopes)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: autonomy enforcement logic (mirrors send flow)
// ---------------------------------------------------------------------------

describe("Gmail autonomy enforcement", () => {
  function enforceSendAutonomy(
    autonomyLevel: string,
    hasSendScope: boolean,
  ): { action: "send" | "draft" | "blocked"; error?: string } {
    // Read-only scope blocks any send attempt
    if (!hasSendScope) {
      return {
        action: "blocked",
        error: "Cannot send email: connection has read-only scopes.",
      };
    }

    // draft_only creates a Gmail draft; nothing sends until approved
    if (autonomyLevel === "draft_only") {
      return { action: "draft" };
    }

    // blocked autonomy
    if (autonomyLevel === "blocked") {
      return { action: "blocked", error: "Agent is blocked from send actions" };
    }

    // full (autonomous) sends directly
    return { action: "send" };
  }

  it("read-only scope blocks send with clear error", () => {
    const result = enforceSendAutonomy("full", false);
    expect(result.action).toBe("blocked");
    expect(result.error).toContain("read-only scopes");
  });

  it("draft_only creates draft instead of sending", () => {
    const result = enforceSendAutonomy("draft_only", true);
    expect(result.action).toBe("draft");
    expect(result.error).toBeUndefined();
  });

  it("blocked autonomy blocks the send action", () => {
    const result = enforceSendAutonomy("blocked", true);
    expect(result.action).toBe("blocked");
    expect(result.error).toBeDefined();
  });

  it("full autonomy + send scopes allows sending", () => {
    const result = enforceSendAutonomy("full", true);
    expect(result.action).toBe("send");
    expect(result.error).toBeUndefined();
  });

  it("read-only scope blocks send even with full autonomy", () => {
    // Scope check takes precedence over autonomy
    const result = enforceSendAutonomy("full", false);
    expect(result.action).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Tests: send identity modes
// ---------------------------------------------------------------------------

describe("Gmail send identity", () => {
  it("delegated sends from owner's email without modification", () => {
    const body = "Hello there";
    const sendIdentity = "delegated";
    const result = sendIdentity === "delegated_attributed"
      ? body + attributionFooter("TestAgent")
      : body;
    expect(result).toBe("Hello there");
  });

  it("delegated_attributed appends agent footer", () => {
    const body = "Hello there";
    const sendIdentity = "delegated_attributed";
    const agentName = "SalesBot";
    const result = sendIdentity === "delegated_attributed"
      ? body + attributionFooter(agentName)
      : body;
    expect(result).toContain("Hello there");
    expect(result).toContain("Drafted by SalesBot");
  });

  it("service sends from configured alias (no footer)", () => {
    const body = "Hello there";
    const sendIdentity = "service";
    const result = sendIdentity === "delegated_attributed"
      ? body + attributionFooter("TestAgent")
      : body;
    expect(result).toBe("Hello there");
  });
});

// ---------------------------------------------------------------------------
// Tests: connector definition constants
// ---------------------------------------------------------------------------

describe("Gmail connector definition", () => {
  it("exports expected scope constants", async () => {
    const {
      GMAIL_SCOPE_READONLY,
      GMAIL_SCOPE_SEND,
      GMAIL_SCOPE_COMPOSE,
      GMAIL_SCOPES_READ_ONLY,
      GMAIL_SCOPES_READ_SEND,
    } = await import("../services/gmail-connector.js");

    expect(GMAIL_SCOPE_READONLY).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(GMAIL_SCOPE_SEND).toBe("https://mail.google.com/auth/gmail.send");
    expect(GMAIL_SCOPE_COMPOSE).toBe("https://www.googleapis.com/auth/gmail.compose");
    expect(GMAIL_SCOPES_READ_ONLY).toEqual([GMAIL_SCOPE_READONLY]);
    expect(GMAIL_SCOPES_READ_SEND).toEqual([GMAIL_SCOPE_READONLY, GMAIL_SCOPE_SEND, GMAIL_SCOPE_COMPOSE]);
  });

  it("defines gmail actions with correct action classes", async () => {
    const { GMAIL_CONNECTOR_DEFINITION } = await import("../services/gmail-connector.js");

    expect(GMAIL_CONNECTOR_DEFINITION.provider).toBe("google");
    expect(GMAIL_CONNECTOR_DEFINITION.displayName).toBe("Gmail");

    const actions = GMAIL_CONNECTOR_DEFINITION.actions;
    const readActions = actions.filter((a) => a.actionClass === "read");
    const draftActions = actions.filter((a) => a.actionClass === "draft");
    const sendActions = actions.filter((a) => a.actionClass === "send");

    expect(readActions.length).toBe(3); // search, read, list
    expect(draftActions.length).toBe(1); // draft
    expect(sendActions.length).toBe(1); // send

    // Read actions only need readonly scope
    for (const action of readActions) {
      expect(action.requiredScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    }

    // Send action needs both send + compose
    expect(sendActions[0].requiredScopes).toContain("https://mail.google.com/auth/gmail.send");
    expect(sendActions[0].requiredScopes).toContain("https://www.googleapis.com/auth/gmail.compose");
  });
});

// ---------------------------------------------------------------------------
// Tests: updated send identity constants include delegated_attributed
// ---------------------------------------------------------------------------

describe("Send identity constants", () => {
  it("includes delegated_attributed in CONNECTION_SEND_IDENTITIES", async () => {
    const shared = await import("@paperclipai/shared");
    expect(shared.CONNECTION_SEND_IDENTITIES).toContain("service");
    expect(shared.CONNECTION_SEND_IDENTITIES).toContain("delegated");
    expect(shared.CONNECTION_SEND_IDENTITIES).toContain("delegated_attributed");
  });
});
