// AgentDash: Connectors (AGE-106)
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  connections,
  connectorWorkspaceDefaults,
  agentConnectorOverrides,
} from "@paperclipai/db";
import type {
  ConnectionAutonomyConfig,
  ConnectionSendIdentity,
  ConnectionAutonomyLevel,
  ConnectorActionClass,
  ActingAsResult,
  ConnectorWorkspaceDefaults,
  AgentConnectorOverrides,
} from "@paperclipai/shared";
import { notFound, forbidden, conflict } from "../errors.js";
import { logActivity } from "./activity-log.js";

// ---------------------------------------------------------------------------
// Token encryption helpers — reuse local_encrypted provider
// ---------------------------------------------------------------------------

import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

interface TokenPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

async function encryptToken(token: TokenPayload): Promise<Record<string, unknown>> {
  const result = await localEncryptedProvider.createVersion({
    value: JSON.stringify(token),
    externalRef: null,
  });
  return result.material;
}

async function decryptToken(material: Record<string, unknown>): Promise<TokenPayload> {
  const json = await localEncryptedProvider.resolveVersion({
    material,
    externalRef: null,
  });
  return JSON.parse(json) as TokenPayload;
}

// ---------------------------------------------------------------------------
// Default autonomy config
// ---------------------------------------------------------------------------

const DEFAULT_AUTONOMY: ConnectionAutonomyConfig = {
  read: "full",
  draft: "full",
  send: "draft_only",
};

const DEFAULT_SEND_IDENTITY: ConnectionSendIdentity = "service";

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function connectorService(db: Db) {
  // -------------------------------------------------------------------------
  // Connection CRUD
  // -------------------------------------------------------------------------

  async function getById(id: string) {
    return db
      .select()
      .from(connections)
      .where(eq(connections.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function list(companyId: string, filters?: { provider?: string; status?: string; ownerId?: string }) {
    const conditions = [eq(connections.companyId, companyId)];
    if (filters?.provider) conditions.push(eq(connections.provider, filters.provider));
    if (filters?.status) conditions.push(eq(connections.status, filters.status));
    if (filters?.ownerId) conditions.push(eq(connections.ownerId, filters.ownerId));
    return db
      .select({
        id: connections.id,
        companyId: connections.companyId,
        ownerType: connections.ownerType,
        ownerId: connections.ownerId,
        provider: connections.provider,
        scopes: connections.scopes,
        sendIdentity: connections.sendIdentity,
        autonomy: connections.autonomy,
        visibility: connections.visibility,
        status: connections.status,
        accountLabel: connections.accountLabel,
        createdAt: connections.createdAt,
        revokedAt: connections.revokedAt,
      })
      .from(connections)
      .where(and(...conditions))
      .orderBy(desc(connections.createdAt));
  }

  async function create(
    companyId: string,
    input: {
      ownerType: string;
      ownerId: string;
      provider: string;
      scopes?: string[];
      sendIdentity?: string;
      autonomy?: ConnectionAutonomyConfig;
      visibility?: string;
      accountLabel?: string | null;
      token: TokenPayload;
    },
  ) {
    const wsDefaults = await getWorkspaceDefaults(companyId);
    const encryptedToken = await encryptToken(input.token);

    const row = await db
      .insert(connections)
      .values({
        companyId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        provider: input.provider,
        scopes: input.scopes ?? [],
        sendIdentity: input.sendIdentity ?? wsDefaults.sendIdentity,
        autonomy: input.autonomy ?? wsDefaults.autonomy,
        visibility: input.visibility ?? "private",
        status: "active",
        accountLabel: input.accountLabel ?? null,
        encryptedToken,
      })
      .returning()
      .then((rows) => rows[0]);

    await logActivity(db, {
      companyId,
      actorType: input.ownerType === "agent" ? "agent" : "user",
      actorId: input.ownerId,
      action: "connection.created",
      entityType: "connection",
      entityId: row.id,
      details: {
        provider: input.provider,
        sendIdentity: row.sendIdentity,
        visibility: row.visibility,
        accountLabel: row.accountLabel,
      },
    });

    return row;
  }

  async function update(
    connectionId: string,
    patch: {
      sendIdentity?: string;
      autonomy?: ConnectionAutonomyConfig;
      visibility?: string;
    },
  ) {
    const existing = await getById(connectionId);
    if (!existing) throw notFound("Connection not found");

    return db
      .update(connections)
      .set({
        sendIdentity: patch.sendIdentity ?? existing.sendIdentity,
        autonomy: patch.autonomy ?? existing.autonomy,
        visibility: patch.visibility ?? existing.visibility,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function revoke(connectionId: string, actorType: string, actorId: string) {
    const existing = await getById(connectionId);
    if (!existing) throw notFound("Connection not found");
    if (existing.status === "revoked") throw conflict("Connection already revoked");

    const now = new Date();
    const updated = await db
      .update(connections)
      .set({
        status: "revoked",
        revokedAt: now,
        // Clear the token on revocation for security
        encryptedToken: null,
        updatedAt: now,
      })
      .where(eq(connections.id, connectionId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actorType as "user" | "agent",
        actorId,
        action: "connection.revoked",
        entityType: "connection",
        entityId: connectionId,
        details: { provider: existing.provider, accountLabel: existing.accountLabel },
      });
    }

    return updated;
  }

  // -------------------------------------------------------------------------
  // Token access (for internal use by connector implementations)
  // -------------------------------------------------------------------------

  async function getDecryptedToken(connectionId: string): Promise<TokenPayload | null> {
    const conn = await getById(connectionId);
    if (!conn) return null;
    if (conn.status === "revoked") return null;
    if (!conn.encryptedToken) return null;
    return decryptToken(conn.encryptedToken as Record<string, unknown>);
  }

  async function refreshToken(connectionId: string, newToken: TokenPayload) {
    const encryptedMaterial = await encryptToken(newToken);
    return db
      .update(connections)
      .set({
        encryptedToken: encryptedMaterial,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  // -------------------------------------------------------------------------
  // Workspace defaults
  // -------------------------------------------------------------------------

  async function getWorkspaceDefaults(companyId: string): Promise<ConnectorWorkspaceDefaults> {
    const row = await db
      .select()
      .from(connectorWorkspaceDefaults)
      .where(eq(connectorWorkspaceDefaults.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    if (row) {
      return {
        sendIdentity: row.sendIdentity as ConnectionSendIdentity,
        autonomy: row.autonomy as ConnectionAutonomyConfig,
      };
    }

    return {
      sendIdentity: DEFAULT_SEND_IDENTITY,
      autonomy: DEFAULT_AUTONOMY,
    };
  }

  async function setWorkspaceDefaults(
    companyId: string,
    input: ConnectorWorkspaceDefaults,
  ) {
    const existing = await db
      .select()
      .from(connectorWorkspaceDefaults)
      .where(eq(connectorWorkspaceDefaults.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    if (existing) {
      return db
        .update(connectorWorkspaceDefaults)
        .set({
          sendIdentity: input.sendIdentity,
          autonomy: input.autonomy,
          updatedAt: new Date(),
        })
        .where(eq(connectorWorkspaceDefaults.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    }

    return db
      .insert(connectorWorkspaceDefaults)
      .values({
        companyId,
        sendIdentity: input.sendIdentity,
        autonomy: input.autonomy,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  // -------------------------------------------------------------------------
  // Agent overrides
  // -------------------------------------------------------------------------

  async function getAgentOverrides(companyId: string, agentId: string): Promise<AgentConnectorOverrides | null> {
    const row = await db
      .select()
      .from(agentConnectorOverrides)
      .where(
        and(
          eq(agentConnectorOverrides.companyId, companyId),
          eq(agentConnectorOverrides.agentId, agentId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!row) return null;

    return {
      sendIdentity: row.sendIdentity as ConnectionSendIdentity | undefined,
      autonomy: row.autonomy as Partial<ConnectionAutonomyConfig> | undefined,
    };
  }

  async function setAgentOverrides(
    companyId: string,
    agentId: string,
    input: AgentConnectorOverrides,
  ) {
    const existing = await db
      .select()
      .from(agentConnectorOverrides)
      .where(
        and(
          eq(agentConnectorOverrides.companyId, companyId),
          eq(agentConnectorOverrides.agentId, agentId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      return db
        .update(agentConnectorOverrides)
        .set({
          sendIdentity: input.sendIdentity ?? null,
          autonomy: input.autonomy ?? null,
          updatedAt: new Date(),
        })
        .where(eq(agentConnectorOverrides.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    }

    return db
      .insert(agentConnectorOverrides)
      .values({
        companyId,
        agentId,
        sendIdentity: input.sendIdentity ?? null,
        autonomy: input.autonomy ?? null,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  // -------------------------------------------------------------------------
  // Acting-as resolver
  // Resolution order: per-agent override → per-connection → workspace default
  // -------------------------------------------------------------------------

  async function resolveActingAs(
    companyId: string,
    agentId: string,
    actionClass: ConnectorActionClass,
    provider: string,
  ): Promise<ActingAsResult> {
    // 1. Find an active connection for this agent+provider
    const agentConnections = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.companyId, companyId),
          eq(connections.provider, provider),
          eq(connections.status, "active"),
          isNull(connections.revokedAt),
        ),
      )
      .orderBy(desc(connections.createdAt));

    // Filter to connections this agent can use:
    // - agent's own connections (ownerId = agentId, ownerType = "agent")
    // - workspace-visible connections from any owner
    const usable = agentConnections.filter(
      (c) =>
        (c.ownerType === "agent" && c.ownerId === agentId) ||
        c.visibility === "workspace",
    );

    if (usable.length === 0) {
      return {
        ok: false,
        blocked: {
          reason: "no_connection",
          message: `No authorized ${provider} connection available for this agent`,
        },
      };
    }

    const conn = usable[0];

    // 2. Resolve autonomy: per-agent → per-connection → workspace default
    const wsDefaults = await getWorkspaceDefaults(companyId);
    const agentOverride = await getAgentOverrides(companyId, agentId);

    const connAutonomy = conn.autonomy as ConnectionAutonomyConfig;
    const wsAutonomy = wsDefaults.autonomy;

    // Start with workspace default
    let effectiveAutonomy: ConnectionAutonomyLevel = wsAutonomy[actionClass];

    // Override with connection-level (if set and differs from default)
    if (connAutonomy[actionClass]) {
      effectiveAutonomy = connAutonomy[actionClass] as ConnectionAutonomyLevel;
    }

    // Override with agent-level (highest priority)
    if (agentOverride?.autonomy?.[actionClass]) {
      effectiveAutonomy = agentOverride.autonomy[actionClass] as ConnectionAutonomyLevel;
    }

    // 3. Check if blocked
    if (effectiveAutonomy === "blocked") {
      return {
        ok: false,
        blocked: {
          reason: "autonomy_blocked",
          message: `Agent is blocked from ${actionClass} actions on ${provider}`,
        },
      };
    }

    // 4. Resolve send identity: per-agent → per-connection → workspace default
    let sendIdentity: ConnectionSendIdentity = wsDefaults.sendIdentity;
    if (conn.sendIdentity) {
      sendIdentity = conn.sendIdentity as ConnectionSendIdentity;
    }
    if (agentOverride?.sendIdentity) {
      sendIdentity = agentOverride.sendIdentity;
    }

    return {
      ok: true,
      resolution: {
        connectionId: conn.id,
        provider: conn.provider,
        sendIdentity,
        effectiveAutonomy,
        ownerId: conn.ownerId,
        ownerType: conn.ownerType as "user" | "agent",
        accountLabel: conn.accountLabel,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Audit logging helpers
  // -------------------------------------------------------------------------

  async function logConnectorAction(
    companyId: string,
    connectionId: string,
    action: string,
    actorType: "user" | "agent" | "system",
    actorId: string,
    details?: Record<string, unknown>,
  ) {
    await logActivity(db, {
      companyId,
      actorType,
      actorId,
      action,
      entityType: "connection",
      entityId: connectionId,
      details: details ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // OAuth state management (PKCE flow)
  // -------------------------------------------------------------------------

  async function storeOAuthState(
    companyId: string,
    ownerType: string,
    ownerId: string,
    provider: string,
    state: Record<string, unknown>,
  ) {
    // Create a pending connection row to store the OAuth state
    return db
      .insert(connections)
      .values({
        companyId,
        ownerType,
        ownerId,
        provider,
        scopes: [],
        status: "active",
        oauthState: state,
        encryptedToken: null,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function consumeOAuthState(connectionId: string): Promise<Record<string, unknown> | null> {
    const conn = await getById(connectionId);
    if (!conn || !conn.oauthState) return null;

    // Clear the state after consuming
    await db
      .update(connections)
      .set({ oauthState: null, updatedAt: new Date() })
      .where(eq(connections.id, connectionId));

    return conn.oauthState as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    getById,
    list,
    create,
    update,
    revoke,
    getDecryptedToken,
    refreshToken,
    getWorkspaceDefaults,
    setWorkspaceDefaults,
    getAgentOverrides,
    setAgentOverrides,
    resolveActingAs,
    logConnectorAction,
    storeOAuthState,
    consumeOAuthState,
  };
}
