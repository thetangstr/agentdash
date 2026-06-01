// AgentDash: Connectors (AGE-106)
import { z } from "zod";
import {
  CONNECTION_OWNER_TYPES,
  CONNECTION_STATUSES,
  CONNECTION_SEND_IDENTITIES,
  CONNECTION_AUTONOMY_LEVELS,
  CONNECTION_VISIBILITIES,
  CONNECTOR_ACTION_CLASSES,
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
