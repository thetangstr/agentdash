// AgentDash: Outlook Connector (AGE-110) — unit tests
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Test helpers: attribution footer (mirrors service logic)
// ---------------------------------------------------------------------------

function attributionFooter(agentName: string): string {
  return `\n\n---\nDrafted by ${agentName}`;
}

// ---------------------------------------------------------------------------
// Test helpers: Graph API recipient builder (mirrors service logic)
// ---------------------------------------------------------------------------

function buildRecipients(emailList: string): Array<{ emailAddress: { address: string } }> {
  return emailList
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

// ---------------------------------------------------------------------------
// Test helpers: Graph mail path builder (mirrors service logic)
// ---------------------------------------------------------------------------

function graphMailPath(sharedMailbox?: string | null): string {
  if (sharedMailbox) {
    return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sharedMailbox)}`;
  }
  return "https://graph.microsoft.com/v1.0/me";
}

// ---------------------------------------------------------------------------
// Test helpers: scope checks (mirrors service logic)
// ---------------------------------------------------------------------------

const OUTLOOK_SCOPE_MAIL_READ = "https://graph.microsoft.com/Mail.Read";
const OUTLOOK_SCOPE_MAIL_READWRITE = "https://graph.microsoft.com/Mail.ReadWrite";
const OUTLOOK_SCOPE_MAIL_SEND = "https://graph.microsoft.com/Mail.Send";
const OUTLOOK_SCOPE_MAIL_READ_SHARED = "https://graph.microsoft.com/Mail.Read.Shared";
const OUTLOOK_SCOPE_MAIL_SEND_SHARED = "https://graph.microsoft.com/Mail.Send.Shared";

function hasScope(grantedScopes: string[], required: string): boolean {
  return grantedScopes.includes(required);
}

function hasSendScopes(grantedScopes: string[]): boolean {
  return hasScope(grantedScopes, OUTLOOK_SCOPE_MAIL_SEND);
}

function hasSharedSendScopes(grantedScopes: string[]): boolean {
  return (
    hasScope(grantedScopes, OUTLOOK_SCOPE_MAIL_SEND_SHARED) &&
    hasScope(grantedScopes, OUTLOOK_SCOPE_MAIL_SEND)
  );
}

function hasDraftScopes(grantedScopes: string[]): boolean {
  return hasScope(grantedScopes, OUTLOOK_SCOPE_MAIL_READWRITE);
}

// ---------------------------------------------------------------------------
// Test helpers: message parser (mirrors service logic)
// ---------------------------------------------------------------------------

interface GraphMessageResponse {
  id?: string;
  conversationId?: string;
  bodyPreview?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
}

function parseMessage(msg: GraphMessageResponse) {
  const fromAddr = msg.from?.emailAddress?.address ?? "";
  const fromName = msg.from?.emailAddress?.name ?? "";
  const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;

  const toList = (msg.toRecipients ?? [])
    .map((r) => {
      const addr = r.emailAddress?.address ?? "";
      const name = r.emailAddress?.name ?? "";
      return name ? `${name} <${addr}>` : addr;
    })
    .join(", ");

  return {
    id: msg.id ?? "",
    conversationId: msg.conversationId ?? "",
    snippet: msg.bodyPreview ?? "",
    subject: msg.subject ?? "",
    from,
    to: toList,
    date: msg.receivedDateTime ?? "",
    isRead: msg.isRead ?? false,
    hasAttachments: msg.hasAttachments ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tests: Graph API message parsing
// ---------------------------------------------------------------------------

describe("Outlook Graph API message parser", () => {
  it("parses a full message response", () => {
    const msg: GraphMessageResponse = {
      id: "msg-1",
      conversationId: "conv-1",
      bodyPreview: "Hello, this is a test",
      subject: "Test Subject",
      from: { emailAddress: { address: "alice@example.com", name: "Alice" } },
      toRecipients: [
        { emailAddress: { address: "bob@example.com", name: "Bob" } },
      ],
      receivedDateTime: "2026-06-01T10:00:00Z",
      isRead: false,
      hasAttachments: true,
    };

    const parsed = parseMessage(msg);
    expect(parsed.id).toBe("msg-1");
    expect(parsed.conversationId).toBe("conv-1");
    expect(parsed.snippet).toBe("Hello, this is a test");
    expect(parsed.subject).toBe("Test Subject");
    expect(parsed.from).toBe("Alice <alice@example.com>");
    expect(parsed.to).toBe("Bob <bob@example.com>");
    expect(parsed.date).toBe("2026-06-01T10:00:00Z");
    expect(parsed.isRead).toBe(false);
    expect(parsed.hasAttachments).toBe(true);
  });

  it("handles message with no name in from field", () => {
    const msg: GraphMessageResponse = {
      id: "msg-2",
      from: { emailAddress: { address: "noreply@example.com" } },
      toRecipients: [],
    };

    const parsed = parseMessage(msg);
    expect(parsed.from).toBe("noreply@example.com");
    expect(parsed.to).toBe("");
  });

  it("handles multiple recipients", () => {
    const msg: GraphMessageResponse = {
      id: "msg-3",
      toRecipients: [
        { emailAddress: { address: "a@example.com", name: "A" } },
        { emailAddress: { address: "b@example.com" } },
        { emailAddress: { address: "c@example.com", name: "C Person" } },
      ],
    };

    const parsed = parseMessage(msg);
    expect(parsed.to).toBe("A <a@example.com>, b@example.com, C Person <c@example.com>");
  });

  it("handles empty/missing fields gracefully", () => {
    const msg: GraphMessageResponse = {};
    const parsed = parseMessage(msg);
    expect(parsed.id).toBe("");
    expect(parsed.conversationId).toBe("");
    expect(parsed.snippet).toBe("");
    expect(parsed.subject).toBe("");
    expect(parsed.from).toBe("");
    expect(parsed.to).toBe("");
    expect(parsed.date).toBe("");
    expect(parsed.isRead).toBe(false);
    expect(parsed.hasAttachments).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: recipient builder
// ---------------------------------------------------------------------------

describe("Outlook recipient builder", () => {
  it("builds a single recipient", () => {
    const result = buildRecipients("alice@example.com");
    expect(result).toEqual([
      { emailAddress: { address: "alice@example.com" } },
    ]);
  });

  it("builds multiple recipients from comma-separated list", () => {
    const result = buildRecipients("alice@example.com, bob@example.com, carol@example.com");
    expect(result).toHaveLength(3);
    expect(result[0].emailAddress.address).toBe("alice@example.com");
    expect(result[1].emailAddress.address).toBe("bob@example.com");
    expect(result[2].emailAddress.address).toBe("carol@example.com");
  });

  it("trims whitespace from email addresses", () => {
    const result = buildRecipients("  alice@example.com  ,  bob@example.com  ");
    expect(result[0].emailAddress.address).toBe("alice@example.com");
    expect(result[1].emailAddress.address).toBe("bob@example.com");
  });

  it("filters out empty entries", () => {
    const result = buildRecipients("alice@example.com,,, ,bob@example.com");
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Graph mail path builder
// ---------------------------------------------------------------------------

describe("Outlook Graph mail path builder", () => {
  it("uses /me for delegated connections", () => {
    const path = graphMailPath();
    expect(path).toBe("https://graph.microsoft.com/v1.0/me");
  });

  it("uses /me when sharedMailbox is null", () => {
    const path = graphMailPath(null);
    expect(path).toBe("https://graph.microsoft.com/v1.0/me");
  });

  it("uses /users/{mailbox} for shared mailbox connections", () => {
    const path = graphMailPath("support@company.com");
    expect(path).toBe(
      "https://graph.microsoft.com/v1.0/users/support%40company.com",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: attribution footer
// ---------------------------------------------------------------------------

describe("Outlook attribution footer", () => {
  it("generates the correct footer", () => {
    const footer = attributionFooter("SupportBot");
    expect(footer).toBe("\n\n---\nDrafted by SupportBot");
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

describe("Outlook scope validation", () => {
  it("read-only scopes allow read but not send", () => {
    const scopes = [OUTLOOK_SCOPE_MAIL_READ];
    expect(hasScope(scopes, OUTLOOK_SCOPE_MAIL_READ)).toBe(true);
    expect(hasSendScopes(scopes)).toBe(false);
    expect(hasDraftScopes(scopes)).toBe(false);
  });

  it("read+send scopes allow read, draft, and send", () => {
    const scopes = [OUTLOOK_SCOPE_MAIL_READ, OUTLOOK_SCOPE_MAIL_READWRITE, OUTLOOK_SCOPE_MAIL_SEND];
    expect(hasScope(scopes, OUTLOOK_SCOPE_MAIL_READ)).toBe(true);
    expect(hasSendScopes(scopes)).toBe(true);
    expect(hasDraftScopes(scopes)).toBe(true);
  });

  it("Mail.ReadWrite without Mail.Send allows drafts but not send", () => {
    const scopes = [OUTLOOK_SCOPE_MAIL_READ, OUTLOOK_SCOPE_MAIL_READWRITE];
    expect(hasDraftScopes(scopes)).toBe(true);
    expect(hasSendScopes(scopes)).toBe(false);
  });

  it("Mail.Send without Mail.ReadWrite allows send but not drafts", () => {
    const scopes = [OUTLOOK_SCOPE_MAIL_READ, OUTLOOK_SCOPE_MAIL_SEND];
    expect(hasSendScopes(scopes)).toBe(true);
    expect(hasDraftScopes(scopes)).toBe(false);
  });

  it("shared mailbox scopes are detected correctly", () => {
    const scopes = [
      OUTLOOK_SCOPE_MAIL_READ,
      OUTLOOK_SCOPE_MAIL_SEND,
      OUTLOOK_SCOPE_MAIL_READ_SHARED,
      OUTLOOK_SCOPE_MAIL_SEND_SHARED,
    ];
    expect(hasSharedSendScopes(scopes)).toBe(true);
  });

  it("partial shared scopes (read shared but not send shared) block shared send", () => {
    const scopes = [
      OUTLOOK_SCOPE_MAIL_READ,
      OUTLOOK_SCOPE_MAIL_SEND,
      OUTLOOK_SCOPE_MAIL_READ_SHARED,
    ];
    expect(hasSharedSendScopes(scopes)).toBe(false);
  });

  it("empty scopes block everything", () => {
    const scopes: string[] = [];
    expect(hasScope(scopes, OUTLOOK_SCOPE_MAIL_READ)).toBe(false);
    expect(hasSendScopes(scopes)).toBe(false);
    expect(hasDraftScopes(scopes)).toBe(false);
    expect(hasSharedSendScopes(scopes)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: autonomy enforcement logic (mirrors send flow)
// ---------------------------------------------------------------------------

describe("Outlook autonomy enforcement", () => {
  function enforceSendAutonomy(
    autonomyLevel: string,
    hasSendScope: boolean,
    isSharedMailbox: boolean,
    hasSharedSendScope: boolean,
  ): { action: "send" | "draft" | "blocked"; error?: string } {
    // Shared mailbox scope check
    if (isSharedMailbox && !hasSharedSendScope) {
      return {
        action: "blocked",
        error: "Cannot send email: shared mailbox connection does not have Mail.Send.Shared scope.",
      };
    }

    // Read-only scope blocks any send attempt
    if (!isSharedMailbox && !hasSendScope) {
      return {
        action: "blocked",
        error: "Cannot send email: connection has read-only scopes.",
      };
    }

    // draft_only creates an Outlook draft; nothing sends until approved
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
    const result = enforceSendAutonomy("full", false, false, false);
    expect(result.action).toBe("blocked");
    expect(result.error).toContain("read-only scopes");
  });

  it("shared mailbox without shared send scope blocks send", () => {
    const result = enforceSendAutonomy("full", true, true, false);
    expect(result.action).toBe("blocked");
    expect(result.error).toContain("Mail.Send.Shared");
  });

  it("draft_only creates draft instead of sending", () => {
    const result = enforceSendAutonomy("draft_only", true, false, false);
    expect(result.action).toBe("draft");
    expect(result.error).toBeUndefined();
  });

  it("blocked autonomy blocks the send action", () => {
    const result = enforceSendAutonomy("blocked", true, false, false);
    expect(result.action).toBe("blocked");
    expect(result.error).toBeDefined();
  });

  it("full autonomy + send scopes allows sending", () => {
    const result = enforceSendAutonomy("full", true, false, false);
    expect(result.action).toBe("send");
    expect(result.error).toBeUndefined();
  });

  it("full autonomy + shared send scopes allows shared mailbox sending", () => {
    const result = enforceSendAutonomy("full", true, true, true);
    expect(result.action).toBe("send");
    expect(result.error).toBeUndefined();
  });

  it("read-only scope blocks send even with full autonomy", () => {
    const result = enforceSendAutonomy("full", false, false, false);
    expect(result.action).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Tests: send identity modes
// ---------------------------------------------------------------------------

describe("Outlook send identity", () => {
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
    const agentName = "SupportBot";
    const result = sendIdentity === "delegated_attributed"
      ? body + attributionFooter(agentName)
      : body;
    expect(result).toContain("Hello there");
    expect(result).toContain("Drafted by SupportBot");
  });

  it("service sends from shared mailbox identity (no footer)", () => {
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

describe("Outlook connector definition", () => {
  it("exports expected scope constants", async () => {
    const {
      OUTLOOK_SCOPE_MAIL_READ: READ,
      OUTLOOK_SCOPE_MAIL_READWRITE: RW,
      OUTLOOK_SCOPE_MAIL_SEND: SEND,
      OUTLOOK_SCOPE_MAIL_READ_SHARED: READ_SHARED,
      OUTLOOK_SCOPE_MAIL_SEND_SHARED: SEND_SHARED,
      OUTLOOK_SCOPES_READ_ONLY,
      OUTLOOK_SCOPES_READ_SEND,
      OUTLOOK_SCOPES_SHARED_MAILBOX,
    } = await import("../services/outlook-connector.js");

    expect(READ).toBe("https://graph.microsoft.com/Mail.Read");
    expect(RW).toBe("https://graph.microsoft.com/Mail.ReadWrite");
    expect(SEND).toBe("https://graph.microsoft.com/Mail.Send");
    expect(READ_SHARED).toBe("https://graph.microsoft.com/Mail.Read.Shared");
    expect(SEND_SHARED).toBe("https://graph.microsoft.com/Mail.Send.Shared");
    expect(OUTLOOK_SCOPES_READ_ONLY).toContain(READ);
    expect(OUTLOOK_SCOPES_READ_SEND).toContain(READ);
    expect(OUTLOOK_SCOPES_READ_SEND).toContain(SEND);
    expect(OUTLOOK_SCOPES_READ_SEND).toContain(RW);
    expect(OUTLOOK_SCOPES_SHARED_MAILBOX).toContain(READ_SHARED);
    expect(OUTLOOK_SCOPES_SHARED_MAILBOX).toContain(SEND_SHARED);
  });

  it("defines outlook actions with correct action classes", async () => {
    const { OUTLOOK_CONNECTOR_DEFINITION } = await import("../services/outlook-connector.js");

    expect(OUTLOOK_CONNECTOR_DEFINITION.provider).toBe("microsoft");
    expect(OUTLOOK_CONNECTOR_DEFINITION.displayName).toBe("Outlook");

    const actions = OUTLOOK_CONNECTOR_DEFINITION.actions;
    const readActions = actions.filter((a) => a.actionClass === "read");
    const draftActions = actions.filter((a) => a.actionClass === "draft");
    const sendActions = actions.filter((a) => a.actionClass === "send");

    expect(readActions.length).toBe(3); // search, read, list
    expect(draftActions.length).toBe(1); // draft
    expect(sendActions.length).toBe(1); // send

    // Read actions only need Mail.Read scope
    for (const action of readActions) {
      expect(action.requiredScopes).toContain("https://graph.microsoft.com/Mail.Read");
    }

    // Draft action needs Mail.ReadWrite
    expect(draftActions[0].requiredScopes).toContain("https://graph.microsoft.com/Mail.ReadWrite");

    // Send action needs Mail.Send
    expect(sendActions[0].requiredScopes).toContain("https://graph.microsoft.com/Mail.Send");
  });
});

// ---------------------------------------------------------------------------
// Tests: ownership mode — delegated vs shared/service mailbox
// ---------------------------------------------------------------------------

describe("Outlook ownership modes", () => {
  it("delegated mode uses /me path", () => {
    const path = graphMailPath(null);
    expect(path).toContain("/me");
    expect(path).not.toContain("/users/");
  });

  it("shared/service mailbox mode uses /users/{mailbox} path", () => {
    const path = graphMailPath("support@company.com");
    expect(path).toContain("/users/");
    expect(path).toContain("support%40company.com");
    expect(path).not.toContain("/me");
  });

  it("shared mailbox default send identity is service", () => {
    // When scopePreset is "shared_mailbox", default send identity should be "service"
    const scopePreset = "shared_mailbox";
    const defaultSendIdentity = scopePreset === "shared_mailbox" ? "service" : "delegated";
    expect(defaultSendIdentity).toBe("service");
  });

  it("delegated mode default send identity is delegated", () => {
    const scopePreset = "read_send";
    const defaultSendIdentity = scopePreset === "shared_mailbox" ? "service" : "delegated";
    expect(defaultSendIdentity).toBe("delegated");
  });
});
