// AgentDash: Connectors (AGE-106)

import type {
  ConnectionOwnerType,
  ConnectionProvider,
  ConnectionStatus,
  ConnectionSendIdentity,
  ConnectionAutonomyLevel,
  ConnectionVisibility,
  ConnectorActionClass,
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
