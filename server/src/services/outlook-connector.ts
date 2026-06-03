// AgentDash: Outlook Connector (AGE-110)
import type { Db } from "@paperclipai/db";
import type {
  ConnectionSendIdentity,
  ConnectorActionClass,
  ConnectorDefinition,
} from "@paperclipai/shared";
import { connectorService } from "./connectors.js";
import { logActivity } from "./activity-log.js";
import { badRequest, forbidden, notFound, unprocessable } from "../errors.js";

// ---------------------------------------------------------------------------
// Microsoft Graph scope constants
// ---------------------------------------------------------------------------

/** Read-only access to the user's mail. */
export const OUTLOOK_SCOPE_MAIL_READ = "https://graph.microsoft.com/Mail.Read";
/** Read-write access to the user's mail (required for drafts). */
export const OUTLOOK_SCOPE_MAIL_READWRITE = "https://graph.microsoft.com/Mail.ReadWrite";
/** Send mail on behalf of the user. */
export const OUTLOOK_SCOPE_MAIL_SEND = "https://graph.microsoft.com/Mail.Send";
/** Read-only access to shared mailboxes. */
export const OUTLOOK_SCOPE_MAIL_READ_SHARED = "https://graph.microsoft.com/Mail.Read.Shared";
/** Send from shared mailboxes. */
export const OUTLOOK_SCOPE_MAIL_SEND_SHARED = "https://graph.microsoft.com/Mail.Send.Shared";
/** Offline access for refresh tokens. */
export const OUTLOOK_SCOPE_OFFLINE_ACCESS = "offline_access";
/** OpenID Connect profile. */
export const OUTLOOK_SCOPE_OPENID = "openid";
/** User profile info. */
export const OUTLOOK_SCOPE_PROFILE = "profile";
/** User email claim. */
export const OUTLOOK_SCOPE_EMAIL = "email";

/** Minimum scopes for read-only delegated access. */
export const OUTLOOK_SCOPES_READ_ONLY = [
  OUTLOOK_SCOPE_OFFLINE_ACCESS,
  OUTLOOK_SCOPE_OPENID,
  OUTLOOK_SCOPE_PROFILE,
  OUTLOOK_SCOPE_EMAIL,
  OUTLOOK_SCOPE_MAIL_READ,
];

/** Scopes for read + send delegated access. */
export const OUTLOOK_SCOPES_READ_SEND = [
  OUTLOOK_SCOPE_OFFLINE_ACCESS,
  OUTLOOK_SCOPE_OPENID,
  OUTLOOK_SCOPE_PROFILE,
  OUTLOOK_SCOPE_EMAIL,
  OUTLOOK_SCOPE_MAIL_READ,
  OUTLOOK_SCOPE_MAIL_READWRITE,
  OUTLOOK_SCOPE_MAIL_SEND,
];

/** Scopes for shared/service mailbox access (read + send). */
export const OUTLOOK_SCOPES_SHARED_MAILBOX = [
  OUTLOOK_SCOPE_OFFLINE_ACCESS,
  OUTLOOK_SCOPE_OPENID,
  OUTLOOK_SCOPE_PROFILE,
  OUTLOOK_SCOPE_EMAIL,
  OUTLOOK_SCOPE_MAIL_READ,
  OUTLOOK_SCOPE_MAIL_READWRITE,
  OUTLOOK_SCOPE_MAIL_SEND,
  OUTLOOK_SCOPE_MAIL_READ_SHARED,
  OUTLOOK_SCOPE_MAIL_SEND_SHARED,
];

// ---------------------------------------------------------------------------
// Connector definition (registered in the connector framework)
// ---------------------------------------------------------------------------

export const OUTLOOK_CONNECTOR_DEFINITION: ConnectorDefinition = {
  provider: "microsoft",
  displayName: "Outlook",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  defaultScopes: OUTLOOK_SCOPES_READ_ONLY,
  actions: [
    {
      name: "outlook.search",
      label: "Search emails",
      actionClass: "read",
      requiredScopes: [OUTLOOK_SCOPE_MAIL_READ],
    },
    {
      name: "outlook.read",
      label: "Read email",
      actionClass: "read",
      requiredScopes: [OUTLOOK_SCOPE_MAIL_READ],
    },
    {
      name: "outlook.list",
      label: "List emails",
      actionClass: "read",
      requiredScopes: [OUTLOOK_SCOPE_MAIL_READ],
    },
    {
      name: "outlook.draft",
      label: "Create draft",
      actionClass: "draft",
      requiredScopes: [OUTLOOK_SCOPE_MAIL_READWRITE],
    },
    {
      name: "outlook.send",
      label: "Send email",
      actionClass: "send",
      requiredScopes: [OUTLOOK_SCOPE_MAIL_SEND],
    },
  ],
};

// ---------------------------------------------------------------------------
// Microsoft Graph API helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

function getOAuthConfig() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw badRequest(
      "Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.",
    );
  }
  return { clientId, clientSecret };
}

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

/**
 * Build the attribution footer for delegated_attributed send identity.
 */
function attributionFooter(agentName: string): string {
  return `\n\n---\nDrafted by ${agentName}`;
}

/**
 * Build the Graph API base path for a connection.
 * - Delegated connections use /me/...
 * - Shared/service mailbox connections use /users/{sharedMailbox}/...
 */
function graphMailPath(sharedMailbox?: string | null): string {
  if (sharedMailbox) {
    return `${GRAPH_BASE_URL}/users/${encodeURIComponent(sharedMailbox)}`;
  }
  return `${GRAPH_BASE_URL}/me`;
}

/**
 * Make an authenticated request to Microsoft Graph.
 */
async function graphFetch(
  accessToken: string,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(path, {
    method: opts?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    if (res.status === 401) {
      throw forbidden("Microsoft Graph access token expired or revoked");
    }
    throw badRequest(`Microsoft Graph API error ${res.status}: ${errBody}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outlook service types
// ---------------------------------------------------------------------------

export interface OutlookSearchOptions {
  query: string;
  maxResults?: number;
  skip?: number;
}

export interface OutlookMessageSummary {
  id: string;
  conversationId: string;
  snippet: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  isRead: boolean;
  hasAttachments: boolean;
}

export interface OutlookConversation {
  id: string;
  messages: OutlookMessageSummary[];
}

export interface OutlookDraftInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  conversationId?: string;
  inReplyTo?: string;
}

export interface OutlookSendInput extends OutlookDraftInput {
  /** Agent name for delegated_attributed identity. */
  agentName?: string;
}

export interface OutlookDraftResult {
  draftId: string;
  conversationId: string;
}

export interface OutlookSendResult {
  messageId: string;
  conversationId: string;
}

// ---------------------------------------------------------------------------
// Graph API response shapes (internal)
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

interface GraphMessagesListResponse {
  value?: GraphMessageResponse[];
  "@odata.nextLink"?: string;
}

interface GraphDraftResponse {
  id?: string;
  conversationId?: string;
}

interface GraphSendMailResponse {
  // sendMail returns 202 with no body
}

interface GraphUserProfile {
  mail?: string;
  userPrincipalName?: string;
  displayName?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers — parse Graph responses
// ---------------------------------------------------------------------------

function parseMessage(msg: GraphMessageResponse): OutlookMessageSummary {
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

function buildRecipients(emailList: string): Array<{ emailAddress: { address: string } }> {
  return emailList
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function outlookConnectorService(db: Db) {
  const connSvc = connectorService(db);

  // -------------------------------------------------------------------------
  // OAuth helpers
  // -------------------------------------------------------------------------

  /**
   * Generate the Microsoft OAuth2 authorization URL.
   */
  function getAuthorizationUrl(opts: {
    redirectUri: string;
    scopes: string[];
    state: string;
    loginHint?: string;
  }): string {
    const { clientId } = getOAuthConfig();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: opts.redirectUri,
      scope: opts.scopes.join(" "),
      state: opts.state,
      response_mode: "query",
      prompt: "consent",
    });
    if (opts.loginHint) {
      params.set("login_hint", opts.loginHint);
    }
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens.
   */
  async function exchangeCode(code: string, redirectUri: string) {
    const { clientId, clientSecret } = getOAuthConfig();

    const res = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      },
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw badRequest(
        `Failed to exchange authorization code: ${errBody}`,
      );
    }

    const tokens = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };

    if (!tokens.access_token) {
      throw badRequest(
        "Failed to exchange authorization code — no access token returned",
      );
    }

    // Fetch the user's email from Graph profile
    const profile = (await graphFetch(
      tokens.access_token,
      `${GRAPH_BASE_URL}/me`,
    )) as GraphUserProfile;
    const email = profile.mail ?? profile.userPrincipalName ?? null;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? undefined,
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined,
      tokenType: tokens.token_type ?? "Bearer",
      scope: tokens.scope ?? "",
      email,
    };
  }

  /**
   * Get a valid access token for a connection, refreshing if needed.
   */
  async function getAccessToken(connectionId: string): Promise<{
    accessToken: string;
    sharedMailbox: string | null;
  }> {
    const token = await connSvc.getDecryptedToken(connectionId);
    if (!token) {
      throw notFound("Connection token not found or connection revoked");
    }

    const conn = await connSvc.getById(connectionId);
    // Determine if this is a shared mailbox connection from oauthState or accountLabel
    // The sharedMailbox field is stored during OAuth callback if mode is "shared"
    const sharedMailbox =
      (conn?.oauthState as Record<string, unknown> | null)?.sharedMailbox as string | null ??
      null;

    // Check if token needs refresh
    if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now() + 60_000) {
      if (!token.refreshToken) {
        throw forbidden("Access token expired and no refresh token available. Reconnect.");
      }

      const { clientId, clientSecret } = getOAuthConfig();
      const res = await fetch(
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: token.refreshToken,
            grant_type: "refresh_token",
          }).toString(),
        },
      );

      if (!res.ok) {
        throw forbidden("Failed to refresh Microsoft access token. Reconnect.");
      }

      const newTokens = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
      };

      if (!newTokens.access_token) {
        throw forbidden("Token refresh returned no access token. Reconnect.");
      }

      // Persist the refreshed token
      try {
        await connSvc.refreshToken(connectionId, {
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token ?? token.refreshToken,
          expiresAt: newTokens.expires_in
            ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
            : token.expiresAt,
          tokenType: newTokens.token_type ?? token.tokenType,
          scope: newTokens.scope ?? token.scope,
        });
      } catch {
        // Token refresh persistence is best-effort; the next call will retry
      }

      return { accessToken: newTokens.access_token, sharedMailbox };
    }

    return { accessToken: token.accessToken, sharedMailbox };
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Search the owner's mailbox via Microsoft Graph $search or $filter.
   */
  async function search(
    connectionId: string,
    companyId: string,
    opts: OutlookSearchOptions,
  ): Promise<{ messages: OutlookMessageSummary[]; nextLink?: string }> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];
    if (!hasScope(scopes, OUTLOOK_SCOPE_MAIL_READ)) {
      throw forbidden("Connection does not have Mail.Read scope");
    }

    const { accessToken, sharedMailbox } = await getAccessToken(connectionId);
    const basePath = graphMailPath(sharedMailbox);
    const top = Math.min(50, Math.max(1, opts.maxResults ?? 20));

    // Use $search for full-text search on Outlook messages
    const params = new URLSearchParams({
      $search: `"${opts.query}"`,
      $top: String(top),
      $select: "id,conversationId,bodyPreview,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments",
      $orderby: "receivedDateTime desc",
    });
    if (opts.skip) {
      params.set("$skip", String(opts.skip));
    }

    const result = (await graphFetch(
      accessToken,
      `${basePath}/messages?${params.toString()}`,
    )) as GraphMessagesListResponse;

    const messages = (result.value ?? []).map(parseMessage);

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.read",
      "agent",
      conn.ownerId,
      { action: "outlook.search", query: opts.query, resultCount: messages.length },
    );

    return {
      messages,
      nextLink: result["@odata.nextLink"] ?? undefined,
    };
  }

  /**
   * List messages (recent inbox).
   */
  async function listMessages(
    connectionId: string,
    companyId: string,
    opts?: { maxResults?: number; skip?: number; folderId?: string },
  ): Promise<{ messages: OutlookMessageSummary[]; nextLink?: string }> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];
    if (!hasScope(scopes, OUTLOOK_SCOPE_MAIL_READ)) {
      throw forbidden("Connection does not have Mail.Read scope");
    }

    const { accessToken, sharedMailbox } = await getAccessToken(connectionId);
    const basePath = graphMailPath(sharedMailbox);
    const top = Math.min(50, Math.max(1, opts?.maxResults ?? 20));

    const folder = opts?.folderId ?? "inbox";
    const params = new URLSearchParams({
      $top: String(top),
      $select: "id,conversationId,bodyPreview,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments",
      $orderby: "receivedDateTime desc",
    });
    if (opts?.skip) {
      params.set("$skip", String(opts.skip));
    }

    const result = (await graphFetch(
      accessToken,
      `${basePath}/mailFolders/${encodeURIComponent(folder)}/messages?${params.toString()}`,
    )) as GraphMessagesListResponse;

    const messages = (result.value ?? []).map(parseMessage);

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.read",
      "agent",
      conn.ownerId,
      { action: "outlook.list", resultCount: messages.length },
    );

    return {
      messages,
      nextLink: result["@odata.nextLink"] ?? undefined,
    };
  }

  /**
   * Read a full conversation (thread) by conversationId.
   * Microsoft Graph does not have a direct "get thread" endpoint like Gmail.
   * We filter messages by conversationId.
   */
  async function readConversation(
    connectionId: string,
    companyId: string,
    conversationId: string,
  ): Promise<OutlookConversation> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];
    if (!hasScope(scopes, OUTLOOK_SCOPE_MAIL_READ)) {
      throw forbidden("Connection does not have Mail.Read scope");
    }

    const { accessToken, sharedMailbox } = await getAccessToken(connectionId);
    const basePath = graphMailPath(sharedMailbox);

    const params = new URLSearchParams({
      $filter: `conversationId eq '${conversationId}'`,
      $select: "id,conversationId,bodyPreview,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments",
      $orderby: "receivedDateTime asc",
      $top: "50",
    });

    const result = (await graphFetch(
      accessToken,
      `${basePath}/messages?${params.toString()}`,
    )) as GraphMessagesListResponse;

    const messages = (result.value ?? []).map(parseMessage);

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.read",
      "agent",
      conn.ownerId,
      { action: "outlook.read_conversation", conversationId, messageCount: messages.length },
    );

    return { id: conversationId, messages };
  }

  // -------------------------------------------------------------------------
  // Draft operation
  // -------------------------------------------------------------------------

  /**
   * Create an Outlook draft message.
   * Used for draft_only autonomy — the draft sits in Outlook until approved.
   */
  async function createDraft(
    connectionId: string,
    companyId: string,
    input: OutlookDraftInput,
    actorId: string,
    agentName?: string,
    sendIdentity?: ConnectionSendIdentity,
  ): Promise<OutlookDraftResult> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];
    if (!hasDraftScopes(scopes)) {
      throw forbidden(
        "Connection does not have Mail.ReadWrite scope — read-only connection cannot create drafts",
      );
    }

    const { accessToken, sharedMailbox } = await getAccessToken(connectionId);
    const basePath = graphMailPath(sharedMailbox);

    let body = input.body;
    if (sendIdentity === "delegated_attributed" && agentName) {
      body += attributionFooter(agentName);
    }

    const draftBody: Record<string, unknown> = {
      subject: input.subject,
      body: {
        contentType: "text",
        content: body,
      },
      toRecipients: buildRecipients(input.to),
    };
    if (input.cc) draftBody.ccRecipients = buildRecipients(input.cc);
    if (input.bcc) draftBody.bccRecipients = buildRecipients(input.bcc);

    const draft = (await graphFetch(accessToken, `${basePath}/messages`, {
      method: "POST",
      body: draftBody,
    })) as GraphDraftResponse;

    const result: OutlookDraftResult = {
      draftId: draft.id ?? "",
      conversationId: draft.conversationId ?? "",
    };

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.draft",
      "agent",
      actorId,
      {
        action: "outlook.draft",
        draftId: result.draftId,
        to: input.to,
        subject: input.subject,
        sendIdentity: sendIdentity ?? conn.sendIdentity,
      },
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Send operation
  // -------------------------------------------------------------------------

  /**
   * Send an email via Microsoft Graph.
   *
   * Enforces:
   * - Read-only scope blocks any send attempt
   * - draft_only autonomy creates a draft + returns approval-needed signal
   * - autonomous + send scope sends directly
   */
  async function sendEmail(
    connectionId: string,
    companyId: string,
    input: OutlookSendInput,
    opts: {
      actorId: string;
      agentId: string;
      autonomyLevel: string;
      sendIdentity: ConnectionSendIdentity;
    },
  ): Promise<
    | { type: "sent"; result: OutlookSendResult }
    | { type: "drafted"; result: OutlookDraftResult; approvalNeeded: true }
  > {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];

    // Determine if this is a shared mailbox and check appropriate scopes
    const { accessToken, sharedMailbox } = await getAccessToken(connectionId);
    const needsSharedScopes = !!sharedMailbox;

    // AC: Read-only scope blocks any send attempt with a clear error
    if (needsSharedScopes && !hasSharedSendScopes(scopes)) {
      throw unprocessable(
        "Cannot send email: shared mailbox connection does not have Mail.Send.Shared scope. " +
          "Reconnect with shared mailbox scopes to enable sending.",
        { code: "OUTLOOK_SHARED_READ_ONLY_SCOPE" },
      );
    }

    if (!needsSharedScopes && !hasSendScopes(scopes)) {
      throw unprocessable(
        "Cannot send email: connection has read-only scopes. " +
          "Reconnect with read+send scopes to enable sending.",
        { code: "OUTLOOK_READ_ONLY_SCOPE" },
      );
    }

    // AC: draft_only creates an Outlook draft + approval request; nothing sends until approved
    if (opts.autonomyLevel === "draft_only") {
      const draftResult = await createDraft(
        connectionId,
        companyId,
        input,
        opts.actorId,
        input.agentName,
        opts.sendIdentity,
      );

      return {
        type: "drafted",
        result: draftResult,
        approvalNeeded: true,
      };
    }

    // AC: autonomous + send scope sends as the configured identity; audited
    const basePath = graphMailPath(sharedMailbox);

    let body = input.body;
    if (opts.sendIdentity === "delegated_attributed" && input.agentName) {
      body += attributionFooter(input.agentName);
    }

    const sendMailBody: Record<string, unknown> = {
      message: {
        subject: input.subject,
        body: {
          contentType: "text",
          content: body,
        },
        toRecipients: buildRecipients(input.to),
      },
      saveToSentItems: true,
    };

    const message = sendMailBody.message as Record<string, unknown>;
    if (input.cc) message.ccRecipients = buildRecipients(input.cc);
    if (input.bcc) message.bccRecipients = buildRecipients(input.bcc);

    // sendMail returns 202 Accepted with no body
    await graphFetch(accessToken, `${basePath}/sendMail`, {
      method: "POST",
      body: sendMailBody,
    });

    const result: OutlookSendResult = {
      // sendMail does not return a messageId; use a placeholder
      messageId: `sent-${Date.now()}`,
      conversationId: input.conversationId ?? "",
    };

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.send",
      "agent",
      opts.actorId,
      {
        action: "outlook.send",
        to: input.to,
        subject: input.subject,
        sendIdentity: opts.sendIdentity,
        agentId: opts.agentId,
        autonomyLevel: opts.autonomyLevel,
      },
    );

    return { type: "sent", result };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    definition: OUTLOOK_CONNECTOR_DEFINITION,
    getAuthorizationUrl,
    exchangeCode,
    search,
    listMessages,
    readConversation,
    createDraft,
    sendEmail,
  };
}
