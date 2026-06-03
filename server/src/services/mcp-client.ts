// AgentDash: MCP Client (AGE-107)
//
// Connects to vendor-maintained MCP servers, discovers tools, and exposes
// them to agents through the connector framework's autonomy model.
//
// Transport: HTTPS/SSE (the standard for remote MCP servers). Uses fetch-based
// client — no full MCP SDK dependency.

import type { Db } from "@paperclipai/db";
import { connections } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import type {
  McpTool,
  McpServerConfig,
  McpToolCallResult,
  McpHealthCheckResult,
  McpToolActionClass,
  ConnectionAutonomyConfig,
} from "@paperclipai/shared";
import { connectorService } from "./connectors.js";
import { logActivity } from "./activity-log.js";
import { notFound, badRequest, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// MCP JSON-RPC transport — lightweight fetch-based client
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let _rpcIdCounter = 0;

async function mcpRpc(
  serverUrl: string,
  authHeader: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> {
  const id = ++_rpcIdCounter;
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method,
    ...(params ? { params } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`MCP server returned HTTP ${res.status}: ${res.statusText}`);
    }

    const json = (await res.json()) as JsonRpcResponse;

    if (json.error) {
      throw new Error(`MCP RPC error [${json.error.code}]: ${json.error.message}`);
    }

    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool action class derivation
// ---------------------------------------------------------------------------

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

/**
 * Derive the action class for autonomy gating from the tool's name and
 * description. Uses word-boundary matching to avoid false positives
 * (e.g. "preview" should not match "view"). Conservative: defaults to
 * "send" (most restricted) when uncertain.
 */
export function deriveActionClass(name: string, description: string): McpToolActionClass {
  // Convert underscores/hyphens to spaces for word boundary matching
  const text = `${name} ${description}`.toLowerCase().replace(/[_-]/g, " ");

  const hasRead = READ_PATTERNS.some((p) => p.test(text));
  const hasSend = SEND_PATTERNS.some((p) => p.test(text));
  const hasDraft = DRAFT_PATTERNS.some((p) => p.test(text));

  // If both read and send keywords, classify as send (conservative)
  if (hasRead && hasSend) return "send";

  // Pure read
  if (hasRead) return "read";

  // Draft indicators
  if (hasDraft) return "draft";

  // Default to "send" (most restricted) for safety
  return "send";
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function mcpClientService(db: Db) {
  const connSvc = connectorService(db);

  // -------------------------------------------------------------------------
  // Register an MCP server
  // -------------------------------------------------------------------------

  async function register(
    companyId: string,
    ownerType: string,
    ownerId: string,
    input: {
      serverUrl: string;
      authType: "api_key" | "oauth_token";
      authValue: string;
      displayName: string;
      autonomy?: ConnectionAutonomyConfig;
      visibility?: string;
    },
  ) {
    // 1. Discover tools from the MCP server to validate connectivity
    const authHeader = input.authType === "api_key"
      ? `Bearer ${input.authValue}`
      : `Bearer ${input.authValue}`;

    let tools: McpTool[];
    try {
      tools = await discoverToolsFromServer(input.serverUrl, authHeader);
    } catch (err) {
      throw badRequest(
        `Cannot connect to MCP server: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. Create the connection via the connector framework
    const mcpConfig: McpServerConfig = {
      serverUrl: input.serverUrl,
      authType: input.authType,
      tools,
      toolsDiscoveredAt: new Date().toISOString(),
      healthStatus: "healthy",
      lastHealthCheckAt: new Date().toISOString(),
      displayName: input.displayName,
    };

    const conn = await connSvc.create(companyId, {
      ownerType,
      ownerId,
      provider: "mcp",
      scopes: tools.map((t) => t.name),
      sendIdentity: "service",
      autonomy: input.autonomy,
      visibility: input.visibility,
      accountLabel: input.displayName,
      token: {
        accessToken: input.authValue,
        tokenType: input.authType,
      },
    });

    // 3. Store MCP-specific config in the connection's oauthState field
    //    (reusing the JSONB column for MCP metadata since MCP connections
    //    don't use OAuth state)
    await db
      .update(connections)
      .set({
        oauthState: mcpConfig as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, conn.id));

    // 4. Audit
    await logActivity(db, {
      companyId,
      actorType: ownerType as "user" | "agent",
      actorId: ownerId,
      action: "mcp.server_registered",
      entityType: "connection",
      entityId: conn.id,
      details: {
        serverUrl: input.serverUrl,
        displayName: input.displayName,
        toolCount: tools.length,
        toolNames: tools.map((t) => t.name),
      },
    });

    return {
      connectionId: conn.id,
      displayName: input.displayName,
      serverUrl: input.serverUrl,
      tools,
      healthStatus: "healthy" as const,
    };
  }

  // -------------------------------------------------------------------------
  // Discover tools from an MCP server
  // -------------------------------------------------------------------------

  async function discoverToolsFromServer(
    serverUrl: string,
    authHeader: string,
  ): Promise<McpTool[]> {
    // Initialize the MCP session
    const initResult = await mcpRpc(serverUrl, authHeader, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agentdash", version: "1.0.0" },
    }) as { protocolVersion?: string; capabilities?: Record<string, unknown> } | undefined;

    if (!initResult) {
      throw new Error("MCP server returned empty initialize response");
    }

    // Send initialized notification (no response expected, but some servers require it)
    // We send it as a request with a dummy id; the server may ignore or respond.
    try {
      await mcpRpc(serverUrl, authHeader, "notifications/initialized", {});
    } catch {
      // Some servers don't respond to notifications — that's fine
    }

    // List tools
    const toolsResult = await mcpRpc(serverUrl, authHeader, "tools/list", {}) as {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    } | undefined;

    const rawTools = toolsResult?.tools ?? [];
    return rawTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
      actionClass: deriveActionClass(t.name, t.description ?? ""),
    }));
  }

  // -------------------------------------------------------------------------
  // List tools for a connection
  // -------------------------------------------------------------------------

  async function listTools(connectionId: string): Promise<McpTool[]> {
    const config = await getMcpConfig(connectionId);
    if (!config) throw notFound("MCP connection not found or not an MCP connection");
    return config.tools;
  }

  // -------------------------------------------------------------------------
  // Refresh tools (re-discover from server)
  // -------------------------------------------------------------------------

  async function refreshTools(connectionId: string): Promise<McpTool[]> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.provider !== "mcp") throw badRequest("Connection is not an MCP connection");

    const token = await connSvc.getDecryptedToken(connectionId);
    if (!token) throw badRequest("Connection has no valid token");

    const config = await getMcpConfig(connectionId);
    if (!config) throw notFound("MCP config not found");

    const authHeader = `Bearer ${token.accessToken}`;

    let tools: McpTool[];
    try {
      tools = await discoverToolsFromServer(config.serverUrl, authHeader);
    } catch (err) {
      // Update health status to degraded but don't fail — return cached tools
      await updateMcpConfig(connectionId, {
        ...config,
        healthStatus: "degraded",
        lastHealthCheckAt: new Date().toISOString(),
      });
      logger.warn(
        { connectionId, err: err instanceof Error ? err.message : String(err) },
        "Failed to refresh MCP tools, returning cached tools",
      );
      return config.tools;
    }

    // Update config with new tools
    await updateMcpConfig(connectionId, {
      ...config,
      tools,
      toolsDiscoveredAt: new Date().toISOString(),
      healthStatus: "healthy",
      lastHealthCheckAt: new Date().toISOString(),
    });

    await logActivity(db, {
      companyId: conn.companyId,
      actorType: "system",
      actorId: "mcp-client",
      action: "mcp.tools_discovered",
      entityType: "connection",
      entityId: connectionId,
      details: {
        toolCount: tools.length,
        toolNames: tools.map((t) => t.name),
      },
    });

    return tools;
  }

  // -------------------------------------------------------------------------
  // Call an MCP tool — with autonomy gating and audit
  // -------------------------------------------------------------------------

  async function callTool(
    companyId: string,
    connectionId: string,
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to a different company");
    if (conn.provider !== "mcp") throw badRequest("Connection is not an MCP connection");
    if (conn.status !== "active") throw badRequest("Connection is not active");

    const config = await getMcpConfig(connectionId);
    if (!config) throw notFound("MCP config not found");

    // 1. Find the tool
    const tool = config.tools.find((t) => t.name === toolName);
    if (!tool) throw notFound(`Tool "${toolName}" not found on this MCP server`);

    // 2. Autonomy gating — use the connector framework's acting-as resolver
    const actingAs = await connSvc.resolveActingAs(
      companyId,
      agentId,
      tool.actionClass,
      "mcp",
    );

    if (!actingAs.ok) {
      // Audit the blocked call
      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "mcp.tool_blocked",
        entityType: "connection",
        entityId: connectionId,
        details: {
          toolName,
          actionClass: tool.actionClass,
          blockReason: actingAs.blocked.reason,
          blockMessage: actingAs.blocked.message,
        },
      });

      return {
        success: false,
        error: actingAs.blocked.message,
        isError: true,
      };
    }

    // 3. Check draft_only — if the effective autonomy is draft_only, return
    //    the call as a draft rather than executing it
    if (actingAs.resolution.effectiveAutonomy === "draft_only") {
      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "mcp.tool_called",
        entityType: "connection",
        entityId: connectionId,
        details: {
          toolName,
          actionClass: tool.actionClass,
          autonomy: "draft_only",
          draft: true,
          arguments: args,
        },
      });

      return {
        success: true,
        content: [{
          type: "text",
          text: `[DRAFT] Tool call "${toolName}" requires approval. Arguments: ${JSON.stringify(args)}`,
        }],
      };
    }

    // 4. Execute the tool call
    const token = await connSvc.getDecryptedToken(connectionId);
    if (!token) throw badRequest("Connection has no valid token");

    const authHeader = `Bearer ${token.accessToken}`;

    let result: McpToolCallResult;
    try {
      const rpcResult = await mcpRpc(serverUrl(config), authHeader, "tools/call", {
        name: toolName,
        arguments: args,
      }) as { content?: Array<{ type: string; text?: string; [key: string]: unknown }>; isError?: boolean } | undefined;

      result = {
        success: true,
        content: rpcResult?.content ?? [],
        isError: rpcResult?.isError ?? false,
      };
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }

    // 5. Audit the call
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "mcp.tool_called",
      entityType: "connection",
      entityId: connectionId,
      details: {
        toolName,
        actionClass: tool.actionClass,
        autonomy: actingAs.resolution.effectiveAutonomy,
        success: result.success,
        isError: result.isError,
        // Don't log full arguments/response for security — just tool name and outcome
      },
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------------

  async function healthCheck(connectionId: string): Promise<McpHealthCheckResult> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.provider !== "mcp") throw badRequest("Connection is not an MCP connection");

    const config = await getMcpConfig(connectionId);
    if (!config) throw notFound("MCP config not found");

    const token = await connSvc.getDecryptedToken(connectionId);
    if (!token) {
      return {
        connectionId,
        serverUrl: config.serverUrl,
        status: "unreachable",
        latencyMs: 0,
        toolCount: config.tools.length,
        error: "No valid token",
        checkedAt: new Date().toISOString(),
      };
    }

    const authHeader = `Bearer ${token.accessToken}`;
    const start = Date.now();

    try {
      // Ping via initialize — the lightest RPC call
      await mcpRpc(config.serverUrl, authHeader, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentdash", version: "1.0.0" },
      }, 10_000);

      const latencyMs = Date.now() - start;
      const status = latencyMs > 5_000 ? "degraded" : "healthy";

      // Update stored health status
      await updateMcpConfig(connectionId, {
        ...config,
        healthStatus: status,
        lastHealthCheckAt: new Date().toISOString(),
      });

      const result: McpHealthCheckResult = {
        connectionId,
        serverUrl: config.serverUrl,
        status,
        latencyMs,
        toolCount: config.tools.length,
        checkedAt: new Date().toISOString(),
      };

      await logActivity(db, {
        companyId: conn.companyId,
        actorType: "system",
        actorId: "mcp-client",
        action: "mcp.health_check",
        entityType: "connection",
        entityId: connectionId,
        details: { status, latencyMs },
      });

      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;

      await updateMcpConfig(connectionId, {
        ...config,
        healthStatus: "unreachable",
        lastHealthCheckAt: new Date().toISOString(),
      });

      const result: McpHealthCheckResult = {
        connectionId,
        serverUrl: config.serverUrl,
        status: "unreachable",
        latencyMs,
        toolCount: config.tools.length,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };

      await logActivity(db, {
        companyId: conn.companyId,
        actorType: "system",
        actorId: "mcp-client",
        action: "mcp.health_check",
        entityType: "connection",
        entityId: connectionId,
        details: {
          status: "unreachable",
          latencyMs,
          error: result.error,
        },
      });

      return result;
    }
  }

  // -------------------------------------------------------------------------
  // Batch health check (all MCP connections in a company)
  // -------------------------------------------------------------------------

  async function healthCheckAll(companyId: string): Promise<McpHealthCheckResult[]> {
    const mcpConnections = await connSvc.list(companyId, { provider: "mcp", status: "active" });
    const results: McpHealthCheckResult[] = [];

    for (const conn of mcpConnections) {
      try {
        const result = await healthCheck(conn.id);
        results.push(result);
      } catch (err) {
        results.push({
          connectionId: conn.id,
          serverUrl: "unknown",
          status: "unreachable",
          latencyMs: 0,
          toolCount: 0,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Remove an MCP server (revoke the connection)
  // -------------------------------------------------------------------------

  async function remove(
    connectionId: string,
    actorType: string,
    actorId: string,
  ) {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.provider !== "mcp") throw badRequest("Connection is not an MCP connection");

    await connSvc.revoke(connectionId, actorType, actorId);

    await logActivity(db, {
      companyId: conn.companyId,
      actorType: actorType as "user" | "agent",
      actorId,
      action: "mcp.server_removed",
      entityType: "connection",
      entityId: connectionId,
      details: {
        accountLabel: conn.accountLabel,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async function getMcpConfig(connectionId: string): Promise<McpServerConfig | null> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) return null;
    if (conn.provider !== "mcp") return null;
    if (!conn.oauthState) return null;
    return conn.oauthState as unknown as McpServerConfig;
  }

  async function updateMcpConfig(connectionId: string, config: McpServerConfig) {
    await db
      .update(connections)
      .set({
        oauthState: config as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId));
  }

  function serverUrl(config: McpServerConfig): string {
    return config.serverUrl;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    register,
    listTools,
    refreshTools,
    callTool,
    healthCheck,
    healthCheckAll,
    remove,
    deriveActionClass,
  };
}
