// AgentDash: Connectors (AGE-106) — unit tests
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionAutonomyConfig,
  ConnectionSendIdentity,
  ConnectorActionClass,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Mock the DB and dependencies so we can test pure service logic
// ---------------------------------------------------------------------------

// Autonomy resolution logic extracted for direct testing
// (mirrors the resolver in connectors.ts)

function resolveAutonomy(
  actionClass: ConnectorActionClass,
  wsAutonomy: ConnectionAutonomyConfig,
  connAutonomy: ConnectionAutonomyConfig | null,
  agentOverride: Partial<ConnectionAutonomyConfig> | null | undefined,
): string {
  // Start with workspace default
  let effective: string = wsAutonomy[actionClass];
  // Override with connection-level
  if (connAutonomy?.[actionClass]) {
    effective = connAutonomy[actionClass];
  }
  // Override with agent-level (highest priority)
  if (agentOverride?.[actionClass]) {
    effective = agentOverride[actionClass]!;
  }
  return effective;
}

function resolveSendIdentity(
  wsDefault: ConnectionSendIdentity,
  connIdentity: ConnectionSendIdentity | null,
  agentOverride: ConnectionSendIdentity | null | undefined,
): ConnectionSendIdentity {
  let identity: ConnectionSendIdentity = wsDefault;
  if (connIdentity) identity = connIdentity;
  if (agentOverride) identity = agentOverride;
  return identity;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Connector autonomy resolution", () => {
  const wsDefaults: ConnectionAutonomyConfig = {
    read: "full",
    draft: "full",
    send: "draft_only",
  };

  it("uses workspace defaults when no overrides exist", () => {
    expect(resolveAutonomy("read", wsDefaults, null, null)).toBe("full");
    expect(resolveAutonomy("draft", wsDefaults, null, null)).toBe("full");
    expect(resolveAutonomy("send", wsDefaults, null, null)).toBe("draft_only");
  });

  it("connection-level overrides workspace default", () => {
    const connAutonomy: ConnectionAutonomyConfig = {
      read: "full",
      draft: "draft_only",
      send: "blocked",
    };
    expect(resolveAutonomy("draft", wsDefaults, connAutonomy, null)).toBe("draft_only");
    expect(resolveAutonomy("send", wsDefaults, connAutonomy, null)).toBe("blocked");
  });

  it("per-agent override beats connection-level beats workspace default", () => {
    const connAutonomy: ConnectionAutonomyConfig = {
      read: "full",
      draft: "draft_only",
      send: "blocked",
    };
    const agentOverride: Partial<ConnectionAutonomyConfig> = {
      send: "full",
    };

    // Agent override takes precedence for send
    expect(resolveAutonomy("send", wsDefaults, connAutonomy, agentOverride)).toBe("full");
    // Connection override still applies for draft (no agent override)
    expect(resolveAutonomy("draft", wsDefaults, connAutonomy, agentOverride)).toBe("draft_only");
    // Workspace default for read (no override at any level)
    expect(resolveAutonomy("read", wsDefaults, connAutonomy, agentOverride)).toBe("full");
  });

  it("per-agent override beats workspace default even without connection override", () => {
    const agentOverride: Partial<ConnectionAutonomyConfig> = {
      read: "blocked",
      send: "full",
    };

    expect(resolveAutonomy("read", wsDefaults, null, agentOverride)).toBe("blocked");
    expect(resolveAutonomy("send", wsDefaults, null, agentOverride)).toBe("full");
    // No agent override for draft → falls through to workspace default
    expect(resolveAutonomy("draft", wsDefaults, null, agentOverride)).toBe("full");
  });
});

describe("Connector send identity resolution", () => {
  it("uses workspace default when no overrides", () => {
    expect(resolveSendIdentity("service", null, null)).toBe("service");
    expect(resolveSendIdentity("delegated", null, null)).toBe("delegated");
  });

  it("connection-level overrides workspace default", () => {
    expect(resolveSendIdentity("service", "delegated", null)).toBe("delegated");
  });

  it("agent-level overrides connection-level", () => {
    expect(resolveSendIdentity("service", "delegated", "service")).toBe("service");
  });

  it("agent-level overrides workspace default even without connection override", () => {
    expect(resolveSendIdentity("service", null, "delegated")).toBe("delegated");
  });
});

describe("Connector Zod validators", () => {
  it("createConnectionSchema accepts valid input", async () => {
    const { createConnectionSchema } = await import("@paperclipai/shared");
    const result = createConnectionSchema.safeParse({
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      sendIdentity: "delegated",
      autonomy: { read: "full", draft: "full", send: "draft_only" },
      visibility: "workspace",
      accountLabel: "user@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("createConnectionSchema rejects invalid autonomy level", async () => {
    const { createConnectionSchema } = await import("@paperclipai/shared");
    const result = createConnectionSchema.safeParse({
      provider: "google",
      autonomy: { read: "full", draft: "invalid", send: "blocked" },
    });
    expect(result.success).toBe(false);
  });

  it("createConnectionSchema uses defaults for optional fields", async () => {
    const { createConnectionSchema } = await import("@paperclipai/shared");
    const result = createConnectionSchema.safeParse({
      provider: "slack",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes).toEqual([]);
      expect(result.data.visibility).toBe("private");
    }
  });

  it("updateConnectionSchema accepts partial updates", async () => {
    const { updateConnectionSchema } = await import("@paperclipai/shared");
    const result = updateConnectionSchema.safeParse({
      visibility: "workspace",
    });
    expect(result.success).toBe(true);
  });

  it("connectorWorkspaceDefaultsSchema requires all fields", async () => {
    const { connectorWorkspaceDefaultsSchema } = await import("@paperclipai/shared");
    const result = connectorWorkspaceDefaultsSchema.safeParse({
      sendIdentity: "service",
      // missing autonomy
    });
    expect(result.success).toBe(false);
  });

  it("connectorWorkspaceDefaultsSchema accepts valid input", async () => {
    const { connectorWorkspaceDefaultsSchema } = await import("@paperclipai/shared");
    const result = connectorWorkspaceDefaultsSchema.safeParse({
      sendIdentity: "delegated",
      autonomy: { read: "full", draft: "full", send: "draft_only" },
    });
    expect(result.success).toBe(true);
  });

  it("agentConnectorOverridesSchema accepts partial autonomy", async () => {
    const { agentConnectorOverridesSchema } = await import("@paperclipai/shared");
    const result = agentConnectorOverridesSchema.safeParse({
      sendIdentity: "delegated",
      autonomy: { send: "full" },
    });
    expect(result.success).toBe(true);
  });

  it("connectorApprovalDecisionSchema validates", async () => {
    const { connectorApprovalDecisionSchema } = await import("@paperclipai/shared");
    const result = connectorApprovalDecisionSchema.safeParse({
      approved: true,
      note: "Looks good",
    });
    expect(result.success).toBe(true);
  });
});

describe("Connector constants", () => {
  it("exports expected connection constants", async () => {
    const shared = await import("@paperclipai/shared");
    expect(shared.CONNECTION_OWNER_TYPES).toEqual(["user", "agent"]);
    expect(shared.CONNECTION_STATUSES).toContain("active");
    expect(shared.CONNECTION_STATUSES).toContain("revoked");
    expect(shared.CONNECTION_SEND_IDENTITIES).toEqual(["service", "delegated", "delegated_attributed"]);
    expect(shared.CONNECTION_AUTONOMY_LEVELS).toContain("full");
    expect(shared.CONNECTION_AUTONOMY_LEVELS).toContain("draft_only");
    expect(shared.CONNECTION_AUTONOMY_LEVELS).toContain("blocked");
    expect(shared.CONNECTOR_ACTION_CLASSES).toEqual(["read", "draft", "send"]);
  });

  it("exports activity log actions for connectors", async () => {
    const shared = await import("@paperclipai/shared");
    expect(shared.ACTIVITY_LOG_ACTIONS_CONNECTORS).toContain("connection.created");
    expect(shared.ACTIVITY_LOG_ACTIONS_CONNECTORS).toContain("connection.revoked");
    expect(shared.ACTIVITY_LOG_ACTIONS_CONNECTORS).toContain("connection.approve");
  });
});
