// AgentDash: Gmail Connector (AGE-109)
import { google } from "googleapis";
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
// Gmail scope constants
// ---------------------------------------------------------------------------

/** Read-only access to the user's mailbox. */
export const GMAIL_SCOPE_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
/** Send email on behalf of the user. */
export const GMAIL_SCOPE_SEND = "https://mail.google.com/auth/gmail.send";
/** Compose drafts. */
export const GMAIL_SCOPE_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

/** Minimum scopes for read-only access. */
export const GMAIL_SCOPES_READ_ONLY = [GMAIL_SCOPE_READONLY];
/** Scopes for read + send access. */
export const GMAIL_SCOPES_READ_SEND = [GMAIL_SCOPE_READONLY, GMAIL_SCOPE_SEND, GMAIL_SCOPE_COMPOSE];

// ---------------------------------------------------------------------------
// Connector definition (registered in the connector framework)
// ---------------------------------------------------------------------------

export const GMAIL_CONNECTOR_DEFINITION: ConnectorDefinition = {
  provider: "google",
  displayName: "Gmail",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  defaultScopes: GMAIL_SCOPES_READ_ONLY,
  actions: [
    {
      name: "gmail.search",
      label: "Search emails",
      actionClass: "read",
      requiredScopes: [GMAIL_SCOPE_READONLY],
    },
    {
      name: "gmail.read",
      label: "Read email thread",
      actionClass: "read",
      requiredScopes: [GMAIL_SCOPE_READONLY],
    },
    {
      name: "gmail.list",
      label: "List emails",
      actionClass: "read",
      requiredScopes: [GMAIL_SCOPE_READONLY],
    },
    {
      name: "gmail.draft",
      label: "Create draft",
      actionClass: "draft",
      requiredScopes: [GMAIL_SCOPE_COMPOSE],
    },
    {
      name: "gmail.send",
      label: "Send email",
      actionClass: "send",
      requiredScopes: [GMAIL_SCOPE_SEND, GMAIL_SCOPE_COMPOSE],
    },
  ],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw badRequest(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret);
}

function hasScope(grantedScopes: string[], required: string): boolean {
  return grantedScopes.includes(required);
}

function hasSendScopes(grantedScopes: string[]): boolean {
  return hasScope(grantedScopes, GMAIL_SCOPE_SEND) && hasScope(grantedScopes, GMAIL_SCOPE_COMPOSE);
}

/**
 * Build the attribution footer for delegated_attributed send identity.
 */
function attributionFooter(agentName: string): string {
  return `\n\n---\nDrafted by ${agentName}`;
}

/**
 * Encode an RFC 2822 message for the Gmail API (base64url).
 */
function encodeMessage(raw: string): string {
  return Buffer.from(raw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build an RFC 2822 email string.
 */
function buildRfc2822(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${opts.subject}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("");
  lines.push(opts.body);
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Gmail service types
// ---------------------------------------------------------------------------

export interface GmailSearchOptions {
  query: string;
  maxResults?: number;
  pageToken?: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  snippet: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  labelIds: string[];
}

export interface GmailThread {
  id: string;
  messages: GmailMessageSummary[];
  snippet: string;
}

export interface GmailDraftInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

export interface GmailSendInput extends GmailDraftInput {
  /** Agent name for delegated_attributed identity. */
  agentName?: string;
}

export interface GmailDraftResult {
  draftId: string;
  messageId: string;
  threadId: string;
}

export interface GmailSendResult {
  messageId: string;
  threadId: string;
  labelIds: string[];
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function gmailConnectorService(db: Db) {
  const connSvc = connectorService(db);

  // -------------------------------------------------------------------------
  // OAuth helpers
  // -------------------------------------------------------------------------

  /**
   * Generate the Google OAuth2 authorization URL.
   * Called when a user initiates a Gmail connection.
   */
  function getAuthorizationUrl(opts: {
    redirectUri: string;
    scopes: string[];
    state: string;
    loginHint?: string;
  }): string {
    const oauth2 = getOAuth2Client();
    return oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: opts.scopes,
      state: opts.state,
      login_hint: opts.loginHint,
      include_granted_scopes: true,
      redirect_uri: opts.redirectUri,
    });
  }

  /**
   * Exchange an authorization code for tokens.
   */
  async function exchangeCode(code: string, redirectUri: string) {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken({ code, redirect_uri: redirectUri });
    if (!tokens.access_token) {
      throw badRequest("Failed to exchange authorization code — no access token returned");
    }

    // Fetch the user's email to use as accountLabel
    oauth2.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress ?? null;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? undefined,
      expiresAt: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : undefined,
      tokenType: tokens.token_type ?? "Bearer",
      scope: tokens.scope ?? "",
      email,
    };
  }

  /**
   * Get an authenticated Gmail client for a connection.
   * Handles token refresh transparently.
   */
  async function getGmailClient(connectionId: string) {
    const token = await connSvc.getDecryptedToken(connectionId);
    if (!token) {
      throw notFound("Connection token not found or connection revoked");
    }

    const oauth2 = getOAuth2Client();
    oauth2.setCredentials({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expiry_date: token.expiresAt ? new Date(token.expiresAt).getTime() : undefined,
      token_type: token.tokenType ?? "Bearer",
    });

    // Listen for token refresh events and persist the new token
    oauth2.on("tokens", async (newTokens) => {
      try {
        await connSvc.refreshToken(connectionId, {
          accessToken: newTokens.access_token ?? token.accessToken,
          refreshToken: newTokens.refresh_token ?? token.refreshToken,
          expiresAt: newTokens.expiry_date
            ? new Date(newTokens.expiry_date).toISOString()
            : token.expiresAt,
          tokenType: newTokens.token_type ?? token.tokenType,
          scope: newTokens.scope ?? token.scope,
        });
      } catch {
        // Token refresh persistence is best-effort; the next call will retry
      }
    });

    return {
      gmail: google.gmail({ version: "v1", auth: oauth2 }),
      oauth2,
    };
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Search the owner's mailbox.
   */
  async function search(
    connectionId: string,
    companyId: string,
    opts: GmailSearchOptions,
  ): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string }> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];
    if (!hasScope(scopes, GMAIL_SCOPE_READONLY)) {
      throw forbidden("Connection does not have gmail.readonly scope");
    }

    const { gmail } = await getGmailClient(connectionId);

    const listResult = await gmail.users.messages.list({
      userId: "me",
      q: opts.query,
      maxResults: opts.maxResults ?? 20,
      pageToken: opts.pageToken,
    });

    const messageIds = listResult.data.messages ?? [];
    const messages: GmailMessageSummary[] = [];

    for (const msg of messageIds) {
      if (!msg.id) continue;
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      messages.push({
        id: detail.data.id ?? msg.id,
        threadId: detail.data.threadId ?? "",
        snippet: detail.data.snippet ?? "",
        subject: getHeader("Subject"),
        from: getHeader("From"),
        to: getHeader("To"),
        date: getHeader("Date"),
        labelIds: detail.data.labelIds ?? [],
      });
    }

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.read",
      "agent",
      conn.ownerId,
      { action: "gmail.search", query: opts.query, resultCount: messages.length },
    );

    return {
      messages,
      nextPageToken: listResult.data.nextPageToken ?? undefined,
    };
  }

  /**
   * List messages (no search query — recent inbox).
   */
  async function listMessages(
    connectionId: string,
    companyId: string,
    opts?: { maxResults?: number; pageToken?: string; labelIds?: string[] },
  ): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string }> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];
    if (!hasScope(scopes, GMAIL_SCOPE_READONLY)) {
      throw forbidden("Connection does not have gmail.readonly scope");
    }

    const { gmail } = await getGmailClient(connectionId);

    const listResult = await gmail.users.messages.list({
      userId: "me",
      maxResults: opts?.maxResults ?? 20,
      pageToken: opts?.pageToken,
      labelIds: opts?.labelIds ?? ["INBOX"],
    });

    const messageIds = listResult.data.messages ?? [];
    const messages: GmailMessageSummary[] = [];

    for (const msg of messageIds) {
      if (!msg.id) continue;
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      messages.push({
        id: detail.data.id ?? msg.id,
        threadId: detail.data.threadId ?? "",
        snippet: detail.data.snippet ?? "",
        subject: getHeader("Subject"),
        from: getHeader("From"),
        to: getHeader("To"),
        date: getHeader("Date"),
        labelIds: detail.data.labelIds ?? [],
      });
    }

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.read",
      "agent",
      conn.ownerId,
      { action: "gmail.list", resultCount: messages.length },
    );

    return {
      messages,
      nextPageToken: listResult.data.nextPageToken ?? undefined,
    };
  }

  /**
   * Read a full thread.
   */
  async function readThread(
    connectionId: string,
    companyId: string,
    threadId: string,
  ): Promise<GmailThread> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];
    if (!hasScope(scopes, GMAIL_SCOPE_READONLY)) {
      throw forbidden("Connection does not have gmail.readonly scope");
    }

    const { gmail } = await getGmailClient(connectionId);

    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const messages: GmailMessageSummary[] = (thread.data.messages ?? []).map((msg) => {
      const headers = msg.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      return {
        id: msg.id ?? "",
        threadId: msg.threadId ?? threadId,
        snippet: msg.snippet ?? "",
        subject: getHeader("Subject"),
        from: getHeader("From"),
        to: getHeader("To"),
        date: getHeader("Date"),
        labelIds: msg.labelIds ?? [],
      };
    });

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.read",
      "agent",
      conn.ownerId,
      { action: "gmail.read_thread", threadId, messageCount: messages.length },
    );

    return {
      id: thread.data.id ?? threadId,
      messages,
      snippet: thread.data.snippet ?? "",
    };
  }

  // -------------------------------------------------------------------------
  // Draft operation
  // -------------------------------------------------------------------------

  /**
   * Create a Gmail draft.
   * Used for draft_only autonomy — the draft sits in Gmail until approved.
   */
  async function createDraft(
    connectionId: string,
    companyId: string,
    input: GmailDraftInput,
    actorId: string,
    agentName?: string,
    sendIdentity?: ConnectionSendIdentity,
  ): Promise<GmailDraftResult> {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];
    if (!hasScope(scopes, GMAIL_SCOPE_COMPOSE)) {
      throw forbidden("Connection does not have gmail.compose scope — read-only connection cannot create drafts");
    }

    const { gmail } = await getGmailClient(connectionId);

    // Determine the from address
    const profile = await gmail.users.getProfile({ userId: "me" });
    const fromEmail = profile.data.emailAddress ?? "";

    let body = input.body;
    if (sendIdentity === "delegated_attributed" && agentName) {
      body += attributionFooter(agentName);
    }

    const raw = buildRfc2822({
      from: fromEmail,
      to: input.to,
      subject: input.subject,
      body,
      cc: input.cc,
      bcc: input.bcc,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });

    const encoded = encodeMessage(raw);
    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw: encoded,
          threadId: input.threadId,
        },
      },
    });

    const result: GmailDraftResult = {
      draftId: draft.data.id ?? "",
      messageId: draft.data.message?.id ?? "",
      threadId: draft.data.message?.threadId ?? "",
    };

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.draft",
      "agent",
      actorId,
      {
        action: "gmail.draft",
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
   * Send an email via Gmail.
   *
   * Enforces:
   * - Read-only scope blocks any send attempt
   * - draft_only autonomy creates a draft + returns approval-needed signal
   * - approve_to_send is not yet implemented (future: routes approval to owner)
   * - autonomous + read+send scope sends directly
   */
  async function sendEmail(
    connectionId: string,
    companyId: string,
    input: GmailSendInput,
    opts: {
      actorId: string;
      agentId: string;
      autonomyLevel: string;
      sendIdentity: ConnectionSendIdentity;
    },
  ): Promise<
    | { type: "sent"; result: GmailSendResult }
    | { type: "drafted"; result: GmailDraftResult; approvalNeeded: true }
  > {
    const conn = await connSvc.getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (conn.companyId !== companyId) throw forbidden("Connection belongs to another company");

    const scopes = (conn.scopes ?? []) as string[];

    // AC: Read-only scope blocks any send attempt with a clear error
    if (!hasSendScopes(scopes)) {
      throw unprocessable(
        "Cannot send email: connection has read-only scopes. " +
          "Reconnect with read+send scopes to enable sending.",
        { code: "GMAIL_READ_ONLY_SCOPE" },
      );
    }

    // AC: draft_only creates a Gmail draft + approval request; nothing sends until approved
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

    // AC: autonomous + read+send sends as the configured identity; audited
    const { gmail } = await getGmailClient(connectionId);

    const profile = await gmail.users.getProfile({ userId: "me" });
    const fromEmail = profile.data.emailAddress ?? "";

    let body = input.body;
    if (opts.sendIdentity === "delegated_attributed" && input.agentName) {
      body += attributionFooter(input.agentName);
    }

    const raw = buildRfc2822({
      from: fromEmail,
      to: input.to,
      subject: input.subject,
      body,
      cc: input.cc,
      bcc: input.bcc,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });

    const encoded = encodeMessage(raw);
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encoded,
        threadId: input.threadId,
      },
    });

    const result: GmailSendResult = {
      messageId: sent.data.id ?? "",
      threadId: sent.data.threadId ?? "",
      labelIds: sent.data.labelIds ?? [],
    };

    await connSvc.logConnectorAction(
      companyId,
      connectionId,
      "connection.send",
      "agent",
      opts.actorId,
      {
        action: "gmail.send",
        messageId: result.messageId,
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
    definition: GMAIL_CONNECTOR_DEFINITION,
    getAuthorizationUrl,
    exchangeCode,
    search,
    listMessages,
    readThread,
    createDraft,
    sendEmail,
  };
}
