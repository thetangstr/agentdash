// AgentDash: Connectors (AGE-106)
import { z } from "zod";
import {
  CONNECTION_OWNER_TYPES,
  CONNECTION_STATUSES,
  CONNECTION_SEND_IDENTITIES,
  CONNECTION_AUTONOMY_LEVELS,
  CONNECTION_VISIBILITIES,
  CONNECTOR_ACTION_CLASSES,
  MCP_TOOL_ACTION_CLASSES,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Autonomy config schema
// ---------------------------------------------------------------------------

export const connectionAutonomyConfigSchema = z.object({
  read: z.enum(CONNECTION_AUTONOMY_LEVELS),
  draft: z.enum(CONNECTION_AUTONOMY_LEVELS),
  send: z.enum(CONNECTION_AUTONOMY_LEVELS),
});

export type ConnectionAutonomyConfigInput = z.infer<typeof connectionAutonomyConfigSchema>;

// ---------------------------------------------------------------------------
// Create connection (OAuth callback result)
// ---------------------------------------------------------------------------

export const createConnectionSchema = z.object({
  provider: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  sendIdentity: z.enum(CONNECTION_SEND_IDENTITIES).optional(),
  autonomy: connectionAutonomyConfigSchema.optional(),
  visibility: z.enum(CONNECTION_VISIBILITIES).default("private"),
  accountLabel: z.string().optional().nullable(),
});

export type CreateConnection = z.infer<typeof createConnectionSchema>;

// ---------------------------------------------------------------------------
// Update connection
// ---------------------------------------------------------------------------

export const updateConnectionSchema = z.object({
  sendIdentity: z.enum(CONNECTION_SEND_IDENTITIES).optional(),
  autonomy: connectionAutonomyConfigSchema.optional(),
  visibility: z.enum(CONNECTION_VISIBILITIES).optional(),
});

export type UpdateConnection = z.infer<typeof updateConnectionSchema>;

// ---------------------------------------------------------------------------
// Workspace connector defaults
// ---------------------------------------------------------------------------

export const connectorWorkspaceDefaultsSchema = z.object({
  sendIdentity: z.enum(CONNECTION_SEND_IDENTITIES),
  autonomy: connectionAutonomyConfigSchema,
});

export type ConnectorWorkspaceDefaultsInput = z.infer<typeof connectorWorkspaceDefaultsSchema>;

// ---------------------------------------------------------------------------
// Per-agent connector overrides
// ---------------------------------------------------------------------------

export const agentConnectorOverridesSchema = z.object({
  sendIdentity: z.enum(CONNECTION_SEND_IDENTITIES).optional(),
  autonomy: connectionAutonomyConfigSchema.partial().optional(),
});

export type AgentConnectorOverridesInput = z.infer<typeof agentConnectorOverridesSchema>;

// ---------------------------------------------------------------------------
// OAuth2 authorization initiation
// ---------------------------------------------------------------------------

export const initiateOAuthSchema = z.object({
  provider: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  redirectUri: z.string().url(),
});

export type InitiateOAuth = z.infer<typeof initiateOAuthSchema>;

// ---------------------------------------------------------------------------
// OAuth2 callback
// ---------------------------------------------------------------------------

export const oauthCallbackSchema = z.object({
  provider: z.string().min(1),
  code: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().url(),
});

export type OAuthCallback = z.infer<typeof oauthCallbackSchema>;

// ---------------------------------------------------------------------------
// Connector approval decision
// ---------------------------------------------------------------------------

export const connectorApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  note: z.string().optional(),
});

export type ConnectorApprovalDecision = z.infer<typeof connectorApprovalDecisionSchema>;

// ---------------------------------------------------------------------------
// MCP Client (AGE-107)
// ---------------------------------------------------------------------------

/** Register an MCP server as a connection. */
export const registerMcpServerSchema = z.object({
  /** HTTPS endpoint of the MCP server. */
  serverUrl: z.string().url().refine(
    (url) => url.startsWith("https://"),
    { message: "MCP server URL must use HTTPS" },
  ),
  /** Auth type: "api_key" or "oauth_token". */
  authType: z.enum(["api_key", "oauth_token"]),
  /** The API key or OAuth token value. */
  authValue: z.string().min(1),
  /** Human-readable display name for the MCP server. */
  displayName: z.string().min(1).max(200),
  /** Autonomy settings for this connection. */
  autonomy: connectionAutonomyConfigSchema.optional(),
  /** Visibility: who in the workspace can use this connection. */
  visibility: z.enum(CONNECTION_VISIBILITIES).default("private"),
});

export type RegisterMcpServer = z.infer<typeof registerMcpServerSchema>;

/** Call an MCP tool. */
export const callMcpToolSchema = z.object({
  /** The tool name to invoke. */
  toolName: z.string().min(1),
  /** Arguments to pass to the tool. */
  arguments: z.record(z.unknown()).default({}),
  /** The agent making the call (for autonomy + audit). */
  agentId: z.string().uuid(),
});

export type CallMcpTool = z.infer<typeof callMcpToolSchema>;
