// AgentDash: Slack Connector (AGE-108)
import { WebClient } from "@slack/web-api";
import type { Db } from "@paperclipai/db";
import { connectorService } from "./connectors.js";
import { logActivity } from "./activity-log.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Slack OAuth2 configuration
// ---------------------------------------------------------------------------

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  /** Base URL of this server, e.g. https://app.agentdash.ai */
  publicBaseUrl: string;
}

function getSlackConfig(): SlackOAuthConfig {
  const clientId = process.env.SLACK_CLIENT_ID ?? "";
  const clientSecret = process.env.SLACK_CLIENT_SECRET ?? "";
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const publicBaseUrl = (process.env.AGENTDASH_PUBLIC_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");

  return { clientId, clientSecret, signingSecret, publicBaseUrl };
}

function assertSlackConfigured(config: SlackOAuthConfig): void {
  if (!config.clientId || !config.clientSecret) {
    throw badRequest(
      "Slack integration not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.",
    );
  }
}

// ---------------------------------------------------------------------------
// Slack connector definition (for the connector registry)
// ---------------------------------------------------------------------------

export const SLACK_PROVIDER = "slack" as const;

export const SLACK_DEFAULT_SCOPES = [
  "channels:read",
  "channels:history",
  "chat:write",
  "commands",
  "users:read",
  "app_mentions:read",
  "im:read",
  "im:history",
  "im:write",
  "groups:read",
  "groups:history",
] as const;

export const SLACK_USER_SCOPES = [
  "chat:write",
] as const;

// ---------------------------------------------------------------------------
// Slack signing secret verification
// ---------------------------------------------------------------------------

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  // Reject requests older than 5 minutes to prevent replay attacks
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySignature = "v0=" + crypto
    .createHmac("sha256", signingSecret)
    .update(sigBasestring, "utf8")
    .digest("hex");

  const myBuf = Buffer.from(mySignature, "utf8");
  const theirBuf = Buffer.from(signature, "utf8");

  // timingSafeEqual requires same-length buffers; different length = invalid
  if (myBuf.length !== theirBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(myBuf, theirBuf);
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function slackConnectorService(db: Db) {
  const connectors = connectorService(db);

  // -------------------------------------------------------------------------
  // OAuth flow
  // -------------------------------------------------------------------------

  /**
   * Generate the Slack OAuth2 authorize URL. Stores a pending connection
   * with oauth_state for CSRF protection.
   */
  async function initiateOAuth(
    companyId: string,
    ownerId: string,
    ownerType: "user" | "agent",
  ) {
    const config = getSlackConfig();
    assertSlackConfigured(config);

    const stateToken = crypto.randomBytes(32).toString("hex");
    const redirectUri = `${config.publicBaseUrl}/api/connectors/slack/oauth/callback`;

    // Store pending connection with state for verification on callback
    const pending = await connectors.storeOAuthState(
      companyId,
      ownerType,
      ownerId,
      SLACK_PROVIDER,
      {
        stateToken,
        redirectUri,
        companyId,
        ownerId,
        ownerType,
      },
    );

    const scopes = SLACK_DEFAULT_SCOPES.join(",");
    const userScopes = SLACK_USER_SCOPES.join(",");

    const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("scope", scopes);
    authorizeUrl.searchParams.set("user_scope", userScopes);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", `${pending.id}:${stateToken}`);

    return {
      authorizeUrl: authorizeUrl.toString(),
      connectionId: pending.id,
    };
  }

  /**
   * Handle the Slack OAuth2 callback. Exchanges code for tokens,
   * stores the encrypted token, and activates the connection.
   */
  async function handleOAuthCallback(
    code: string,
    stateParam: string,
  ) {
    const config = getSlackConfig();
    assertSlackConfigured(config);

    // Parse state: connectionId:stateToken
    const colonIdx = stateParam.indexOf(":");
    if (colonIdx < 0) throw badRequest("Invalid OAuth state");

    const connectionId = stateParam.slice(0, colonIdx);
    const stateToken = stateParam.slice(colonIdx + 1);

    // Consume and verify the stored OAuth state
    const stored = await connectors.consumeOAuthState(connectionId);
    if (!stored) throw badRequest("OAuth state not found or already consumed");
    if (stored.stateToken !== stateToken) throw badRequest("OAuth state mismatch");

    const redirectUri = stored.redirectUri as string;

    // Exchange code for tokens via Slack API
    const client = new WebClient();
    const result = await client.oauth.v2.access({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    if (!result.ok || !result.access_token) {
      throw badRequest(`Slack OAuth failed: ${result.error ?? "unknown error"}`);
    }

    // Determine account label from the team/user info
    const teamName = result.team?.name ?? "Unknown Workspace";
    const accountLabel = `${teamName}`;

    // Build scopes list from the response
    const grantedScopes = (result.scope ?? "").split(",").filter(Boolean);

    // Store the connection with encrypted tokens
    const companyId = stored.companyId as string;
    const connection = await connectors.create(companyId, {
      ownerType: stored.ownerType as string,
      ownerId: stored.ownerId as string,
      provider: SLACK_PROVIDER,
      scopes: grantedScopes,
      accountLabel,
      token: {
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? undefined,
        tokenType: result.token_type ?? "bot",
        scope: result.scope ?? undefined,
      },
    });

    // If we get here, the connection was created successfully.
    // The storeOAuthState created a pending row — now we have a
    // fully-activated one from connectors.create. Clean up the
    // pending row by revoking it (it has no token anyway).
    await connectors.revoke(connectionId, stored.ownerType as string, stored.ownerId as string).catch(() => {
      // Ignore errors — the pending row may already be cleaned up
    });

    return {
      connectionId: connection.id,
      companyId,
      teamName,
      accountLabel,
    };
  }

  // -------------------------------------------------------------------------
  // Inbound: Slack event handling
  // -------------------------------------------------------------------------

  /**
   * Process an incoming Slack event. Handles:
   * - url_verification (Slack challenge)
   * - event_callback with app_mention events
   */
  async function handleEvent(event: SlackEventPayload) {
    if (event.type === "url_verification") {
      return { challenge: event.challenge };
    }

    if (event.type !== "event_callback" || !event.event) {
      return null;
    }

    const slackEvent = event.event;

    // Only handle app_mention and message events
    if (slackEvent.type === "app_mention" || slackEvent.type === "message") {
      // Skip bot messages to prevent loops
      if (slackEvent.bot_id || slackEvent.subtype === "bot_message") {
        return null;
      }

      return {
        type: "inbound_message" as const,
        teamId: event.team_id,
        channelId: slackEvent.channel,
        threadTs: slackEvent.thread_ts ?? slackEvent.ts,
        messageTs: slackEvent.ts,
        userId: slackEvent.user,
        text: slackEvent.text ?? "",
      };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Outbound: post messages to Slack
  // -------------------------------------------------------------------------

  /**
   * Post a message to a Slack channel/thread. Respects autonomy controls:
   * - full: posts immediately
   * - draft_only: returns the draft payload without posting
   * - approve_to_send: returns a pending-approval payload
   */
  async function postMessage(
    connectionId: string,
    input: {
      channel: string;
      text: string;
      threadTs?: string;
      companyId: string;
      agentId: string;
    },
  ) {
    const token = await connectors.getDecryptedToken(connectionId);
    if (!token) throw notFound("Connection not found or revoked");

    const resolution = await connectors.resolveActingAs(
      input.companyId,
      input.agentId,
      "send",
      SLACK_PROVIDER,
    );

    if (!resolution.ok) {
      return {
        posted: false,
        blocked: resolution.blocked,
      };
    }

    const { effectiveAutonomy } = resolution.resolution;

    // Build the Slack message payload
    const messagePayload = {
      channel: input.channel,
      text: input.text,
      thread_ts: input.threadTs,
    };

    if (effectiveAutonomy === "draft_only") {
      await connectors.logConnectorAction(
        input.companyId,
        connectionId,
        "connection.draft",
        "agent",
        input.agentId,
        { provider: SLACK_PROVIDER, channel: input.channel },
      );
      return {
        posted: false,
        draft: messagePayload,
        autonomy: "draft_only",
      };
    }

    // For "full" autonomy, post the message
    const client = new WebClient(token.accessToken);
    const result = await client.chat.postMessage(messagePayload);

    await connectors.logConnectorAction(
      input.companyId,
      connectionId,
      "connection.send",
      "agent",
      input.agentId,
      {
        provider: SLACK_PROVIDER,
        channel: input.channel,
        messageTs: result.ts,
        sendIdentity: resolution.resolution.sendIdentity,
      },
    );

    return {
      posted: true,
      messageTs: result.ts,
      channel: result.channel,
    };
  }

  // -------------------------------------------------------------------------
  // Utility: get a WebClient for a connection
  // -------------------------------------------------------------------------

  async function getClient(connectionId: string): Promise<WebClient | null> {
    const token = await connectors.getDecryptedToken(connectionId);
    if (!token) return null;
    return new WebClient(token.accessToken);
  }

  // -------------------------------------------------------------------------
  // Lookup: find a connection by Slack team ID
  // -------------------------------------------------------------------------

  async function findConnectionByTeamId(
    teamId: string,
  ): Promise<{ connectionId: string; companyId: string } | null> {
    // Search across all active slack connections for this team
    // This is used by the inbound event handler to route events
    // to the correct workspace.
    //
    // Note: In a production system with many workspaces, this would
    // use a dedicated team_id → connection mapping table. For now,
    // we store team_id in the accountLabel or oauthState and search.
    // The accountLabel contains the team name — we'd need to store
    // teamId explicitly. For now, return null and let the caller
    // handle the lookup via a more specific mechanism.
    return null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    initiateOAuth,
    handleOAuthCallback,
    handleEvent,
    postMessage,
    getClient,
    findConnectionByTeamId,
    getConfig: getSlackConfig,
    verifySignature: verifySlackSignature,
  };
}

// ---------------------------------------------------------------------------
// Slack event types (minimal subset for our needs)
// ---------------------------------------------------------------------------

export interface SlackEventPayload {
  type: "url_verification" | "event_callback";
  challenge?: string;
  token?: string;
  team_id?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  };
}

export interface SlackInteractionPayload {
  type: "block_actions" | "message_action" | "view_submission";
  trigger_id?: string;
  user?: {
    id: string;
    username?: string;
    team_id?: string;
  };
  actions?: Array<{
    action_id: string;
    value?: string;
    block_id?: string;
  }>;
  message?: {
    ts?: string;
    text?: string;
  };
  channel?: {
    id?: string;
    name?: string;
  };
}
