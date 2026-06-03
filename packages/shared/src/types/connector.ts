// AgentDash: Connectors (AGE-106)

import type {
  ConnectionOwnerType,
  ConnectionProvider,
  ConnectionStatus,
  ConnectionSendIdentity,
  ConnectionAutonomyLevel,
  ConnectionVisibility,
  ConnectorActionClass,
  McpServerStatus,
  McpToolActionClass,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Autonomy config — per-action-class autonomy level
// ---------------------------------------------------------------------------

export interface ConnectionAutonomyConfig {
  read: ConnectionAutonomyLevel;
  draft: ConnectionAutonomyLevel;
  send: ConnectionAutonomyLevel;
}

// ---------------------------------------------------------------------------
// Connection entity — the core model
// ---------------------------------------------------------------------------

export interface Connection {
  id: string;
  companyId: string;
  ownerType: ConnectionOwnerType;
  ownerId: string;
  provider: ConnectionProvider;
  scopes: string[];
  sendIdentity: ConnectionSendIdentity;
  autonomy: ConnectionAutonomyConfig;
  visibility: ConnectionVisibility;
  status: ConnectionStatus;
  /** Display label for the connected account (e.g. email, workspace name). */
  accountLabel: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Workspace-level connector defaults
// ---------------------------------------------------------------------------

export interface ConnectorWorkspaceDefaults {
  sendIdentity: ConnectionSendIdentity;
  autonomy: ConnectionAutonomyConfig;
}

// ---------------------------------------------------------------------------
// Per-agent connector overrides
// ---------------------------------------------------------------------------

export interface AgentConnectorOverrides {
  sendIdentity?: ConnectionSendIdentity;
  autonomy?: Partial<ConnectionAutonomyConfig>;
}

// ---------------------------------------------------------------------------
// Acting-as resolution result
// ---------------------------------------------------------------------------

export interface ActingAsResolution {
  connectionId: string;
  provider: ConnectionProvider;
  sendIdentity: ConnectionSendIdentity;
  effectiveAutonomy: ConnectionAutonomyLevel;
  ownerId: string;
  ownerType: ConnectionOwnerType;
  accountLabel: string | null;
}

export interface ActingAsBlocked {
  reason: "no_connection" | "not_authorized" | "connection_revoked" | "autonomy_blocked";
  message: string;
}

export type ActingAsResult =
  | { ok: true; resolution: ActingAsResolution }
  | { ok: false; blocked: ActingAsBlocked };

// ---------------------------------------------------------------------------
// Connector capability interface — individual connectors register here
// ---------------------------------------------------------------------------

export interface ConnectorActionDefinition {
  /** Machine name, e.g. "gmail.send", "slack.post_message". */
  name: string;
  /** Human-readable label. */
  label: string;
  /** Which action class this belongs to for autonomy gating. */
  actionClass: ConnectorActionClass;
  /** OAuth scopes required to perform this action. */
  requiredScopes: string[];
}

export interface ConnectorDefinition {
  /** Provider key, e.g. "google", "slack". */
  provider: string;
  /** Human-readable display name. */
  displayName: string;
  /** OAuth2 authorize URL template. */
  authorizeUrl: string;
  /** OAuth2 token endpoint. */
  tokenUrl: string;
  /** Default scopes requested on initial connection. */
  defaultScopes: string[];
  /** Actions this connector supports. */
  actions: ConnectorActionDefinition[];
}

// ---------------------------------------------------------------------------
// Connector approval request payload
// ---------------------------------------------------------------------------

export interface ConnectorApprovalPayload {
  connectionId: string;
  agentId: string;
  action: string;
  actionClass: ConnectorActionClass;
  provider: ConnectionProvider;
  sendIdentity: ConnectionSendIdentity;
  draftPayload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MCP Client types (AGE-107)
// ---------------------------------------------------------------------------

/** A discovered tool from an MCP server. */
export interface McpTool {
  /** Tool name as reported by the MCP server. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Derived action class for autonomy gating. */
  actionClass: McpToolActionClass;
}

/** MCP server configuration stored on a connection. */
export interface McpServerConfig {
  /** HTTPS endpoint of the MCP server. */
  serverUrl: string;
  /** Auth type: "api_key" or "oauth_token". */
  authType: "api_key" | "oauth_token";
  /** Discovered tools — populated on registration and refreshed periodically. */
  tools: McpTool[];
  /** Last time tools were successfully discovered. */
  toolsDiscoveredAt: string | null;
  /** Current health status. */
  healthStatus: McpServerStatus;
  /** Last time a health check was performed. */
  lastHealthCheckAt: string | null;
  /** Human-readable display name for the MCP server. */
  displayName: string;
}

/** Result of calling an MCP tool. */
export interface McpToolCallResult {
  /** Whether the call succeeded. */
  success: boolean;
  /** The tool's response content (array of content blocks per MCP spec). */
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  /** Error message if the call failed. */
  error?: string;
  /** Whether the result is partial / was truncated. */
  isError?: boolean;
}

/** Health check result for an MCP server. */
export interface McpHealthCheckResult {
  connectionId: string;
  serverUrl: string;
  status: McpServerStatus;
  latencyMs: number;
  toolCount: number;
  error?: string;
  checkedAt: string;
}
