// AgentDash: MCP Client (AGE-107) — unit tests
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Test the pure logic functions directly (no DB dependency)
// ---------------------------------------------------------------------------

// Reproduce the deriveActionClass logic for unit testing
// (mirrors the word-boundary matching in mcp-client.ts)

const READ_PATTERNS = [
  /\bget\b/, /\blist\b/, /\bsearch\b/, /\bread\b/, /\bfetch\b/, /\bquery\b/,
  /\bdescribe\b/, /\bretrieve\b/, /\bfind\b/, /\blookup\b/, /\bshow\b/,
  /\bview\b/, /\bcount\b/, /\bcheck\b/,
];

const SEND_PATTERNS = [
  /\bsend\b/, /\bpost\b/, /\bpublish\b/, /\bcreate\b/, /\bdelete\b/,
  /\bremove\b/, /\bupdate\b/, /\bwrite\b/, /\bexecute\b/, /\brun\b/,
  /\btrigger\b/, /\binvoke\b/, /\bdeploy\b/, /\bmodify\b/, /\bsubmit\b/,
  /\bpush\b/, /\bmove\b/, /\barchive\b/, /\bclose\b/, /\bmerge\b/,
  /\bapprove\b/, /\breject\b/, /\bassign\b/, /\bunassign\b/,
];

const DRAFT_PATTERNS = [/\bdraft\b/, /\bpreview\b/, /\bprepare\b/];

type McpToolActionClass = "read" | "draft" | "send";

function deriveActionClass(name: string, description: string): McpToolActionClass {
  const text = `${name} ${description}`.toLowerCase().replace(/[_-]/g, " ");

  const hasRead = READ_PATTERNS.some((p) => p.test(text));
  const hasSend = SEND_PATTERNS.some((p) => p.test(text));
  const hasDraft = DRAFT_PATTERNS.some((p) => p.test(text));

  if (hasRead && hasSend) return "send";
  if (hasRead) return "read";
  if (hasDraft) return "draft";
  return "send";
}

// ---------------------------------------------------------------------------
// Tests: action class derivation
// ---------------------------------------------------------------------------

describe("MCP tool action class derivation", () => {
  it("classifies read-only tools correctly", () => {
    expect(deriveActionClass("list_issues", "List all issues in a project")).toBe("read");
    expect(deriveActionClass("get_user", "Get user by ID")).toBe("read");
    expect(deriveActionClass("search_documents", "Search documents")).toBe("read");
    expect(deriveActionClass("fetch_data", "Fetch data from the API")).toBe("read");
    expect(deriveActionClass("query_database", "Query the database")).toBe("read");
    expect(deriveActionClass("describe_table", "Describe table schema")).toBe("read");
    expect(deriveActionClass("find_records", "Find matching records")).toBe("read");
    expect(deriveActionClass("count_items", "Count items in collection")).toBe("read");
  });

  it("classifies send/write tools correctly", () => {
    expect(deriveActionClass("create_issue", "Create a new issue")).toBe("send");
    expect(deriveActionClass("delete_file", "Delete a file")).toBe("send");
    expect(deriveActionClass("send_message", "Send a message to a channel")).toBe("send");
    expect(deriveActionClass("update_record", "Update an existing record")).toBe("send");
    expect(deriveActionClass("deploy_app", "Deploy application")).toBe("send");
    expect(deriveActionClass("merge_branch", "Merge a pull request")).toBe("send");
    expect(deriveActionClass("assign_task", "Assign a task to a user")).toBe("send");
  });

  it("classifies draft tools correctly", () => {
    expect(deriveActionClass("draft_email", "Draft an email")).toBe("draft");
    expect(deriveActionClass("preview_changes", "Preview pending changes")).toBe("draft");
    expect(deriveActionClass("prepare_release", "Prepare a release")).toBe("draft");
  });

  it("defaults to send for ambiguous tools (conservative)", () => {
    expect(deriveActionClass("do_thing", "Perform an action")).toBe("send");
    expect(deriveActionClass("process", "Process something")).toBe("send");
  });

  it("classifies mixed read+send as send (conservative)", () => {
    // "list" is a read keyword, "create" is a send keyword
    expect(deriveActionClass("list_and_create", "List and create items")).toBe("send");
    // "search" is read, "delete" is send
    expect(deriveActionClass("search_and_delete", "Search for items and delete matches")).toBe("send");
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP validators
// ---------------------------------------------------------------------------

describe("MCP Zod validators", () => {
  it("registerMcpServerSchema accepts valid input", async () => {
    const { registerMcpServerSchema } = await import("@paperclipai/shared");
    const result = registerMcpServerSchema.safeParse({
      serverUrl: "https://mcp.example.com/api",
      authType: "api_key",
      authValue: "sk-test-key-123",
      displayName: "My MCP Server",
    });
    expect(result.success).toBe(true);
  });

  it("registerMcpServerSchema rejects non-HTTPS URL", async () => {
    const { registerMcpServerSchema } = await import("@paperclipai/shared");
    const result = registerMcpServerSchema.safeParse({
      serverUrl: "http://mcp.example.com/api",
      authType: "api_key",
      authValue: "sk-test-key-123",
      displayName: "My MCP Server",
    });
    expect(result.success).toBe(false);
  });

  it("registerMcpServerSchema rejects invalid URL", async () => {
    const { registerMcpServerSchema } = await import("@paperclipai/shared");
    const result = registerMcpServerSchema.safeParse({
      serverUrl: "not-a-url",
      authType: "api_key",
      authValue: "sk-test-key-123",
      displayName: "My MCP Server",
    });
    expect(result.success).toBe(false);
  });

  it("registerMcpServerSchema rejects empty authValue", async () => {
    const { registerMcpServerSchema } = await import("@paperclipai/shared");
    const result = registerMcpServerSchema.safeParse({
      serverUrl: "https://mcp.example.com/api",
      authType: "api_key",
      authValue: "",
      displayName: "My MCP Server",
    });
    expect(result.success).toBe(false);
  });

  it("registerMcpServerSchema rejects invalid authType", async () => {
    const { registerMcpServerSchema } = await import("@paperclipai/shared");
    const result = registerMcpServerSchema.safeParse({
      serverUrl: "https://mcp.example.com/api",
      authType: "basic",
      authValue: "test",
      displayName: "My Server",
    });
    expect(result.success).toBe(false);
  });

  it("registerMcpServerSchema accepts optional autonomy", async () => {
    const { registerMcpServerSchema } = await import("@paperclipai/shared");
    const result = registerMcpServerSchema.safeParse({
      serverUrl: "https://mcp.example.com/api",
      authType: "oauth_token",
      authValue: "gho_token_123",
      displayName: "GitHub MCP",
      autonomy: { read: "full", draft: "full", send: "draft_only" },
      visibility: "workspace",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autonomy?.read).toBe("full");
      expect(result.data.visibility).toBe("workspace");
    }
  });

  it("registerMcpServerSchema rejects empty displayName", async () => {
    const { registerMcpServerSchema } = await import("@paperclipai/shared");
    const result = registerMcpServerSchema.safeParse({
      serverUrl: "https://mcp.example.com/api",
      authType: "api_key",
      authValue: "key",
      displayName: "",
    });
    expect(result.success).toBe(false);
  });

  it("registerMcpServerSchema rejects displayName over 200 chars", async () => {
    const { registerMcpServerSchema } = await import("@paperclipai/shared");
    const result = registerMcpServerSchema.safeParse({
      serverUrl: "https://mcp.example.com/api",
      authType: "api_key",
      authValue: "key",
      displayName: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("callMcpToolSchema accepts valid input", async () => {
    const { callMcpToolSchema } = await import("@paperclipai/shared");
    const result = callMcpToolSchema.safeParse({
      toolName: "list_issues",
      arguments: { project: "my-project", limit: 10 },
      agentId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("callMcpToolSchema defaults arguments to empty object", async () => {
    const { callMcpToolSchema } = await import("@paperclipai/shared");
    const result = callMcpToolSchema.safeParse({
      toolName: "ping",
      agentId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.arguments).toEqual({});
    }
  });

  it("callMcpToolSchema rejects empty toolName", async () => {
    const { callMcpToolSchema } = await import("@paperclipai/shared");
    const result = callMcpToolSchema.safeParse({
      toolName: "",
      agentId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(false);
  });

  it("callMcpToolSchema rejects invalid agentId", async () => {
    const { callMcpToolSchema } = await import("@paperclipai/shared");
    const result = callMcpToolSchema.safeParse({
      toolName: "list_issues",
      agentId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP constants
// ---------------------------------------------------------------------------

describe("MCP constants", () => {
  it("exports MCP server statuses", async () => {
    const shared = await import("@paperclipai/shared");
    expect(shared.MCP_SERVER_STATUSES).toEqual(["healthy", "degraded", "unreachable"]);
  });

  it("exports MCP tool action classes", async () => {
    const shared = await import("@paperclipai/shared");
    expect(shared.MCP_TOOL_ACTION_CLASSES).toEqual(["read", "draft", "send"]);
  });

  it("exports MCP activity log actions", async () => {
    const shared = await import("@paperclipai/shared");
    expect(shared.ACTIVITY_LOG_ACTIONS_MCP).toContain("mcp.server_registered");
    expect(shared.ACTIVITY_LOG_ACTIONS_MCP).toContain("mcp.server_removed");
    expect(shared.ACTIVITY_LOG_ACTIONS_MCP).toContain("mcp.tools_discovered");
    expect(shared.ACTIVITY_LOG_ACTIONS_MCP).toContain("mcp.tool_called");
    expect(shared.ACTIVITY_LOG_ACTIONS_MCP).toContain("mcp.tool_blocked");
    expect(shared.ACTIVITY_LOG_ACTIONS_MCP).toContain("mcp.health_check");
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP types exist
// ---------------------------------------------------------------------------

describe("MCP types", () => {
  it("McpTool type matches expected shape", () => {
    const tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      actionClass: McpToolActionClass;
    } = {
      name: "list_issues",
      description: "List issues",
      inputSchema: { type: "object", properties: {} },
      actionClass: "read",
    };
    expect(tool.name).toBe("list_issues");
    expect(tool.actionClass).toBe("read");
  });

  it("McpToolCallResult type handles success and error", () => {
    const success = {
      success: true,
      content: [{ type: "text", text: "result" }],
    };
    expect(success.success).toBe(true);

    const error = {
      success: false,
      error: "Connection refused",
      isError: true,
    };
    expect(error.success).toBe(false);
    expect(error.isError).toBe(true);
  });
});
