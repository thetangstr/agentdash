// AgentDash (per-steward document access, slice 2): Microsoft 365 sign-in for
// a person's own documents, and the one place a Graph access token comes from.
//
// ## The interface later slices use
//
//   microsoftGraphAuthService(db).tokenForConnection(connectionId)
//     -> Promise<{ accessToken: string; grantedScopes: string[] }>
//
// - `connectionId` must come from `connectorService.resolveActingAs(...)` for
//   provider "microsoft" (slice 1), never from a request. This function does
//   not authorize; it only turns an already-authorized row into a token.
// - It refreshes when the stored access token expires within 60 s, persists
//   the new access token and any rotated refresh token, and returns ONLY the
//   access token and the scopes it carries. The refresh token never leaves
//   this module. Concurrent callers for one connection share one refresh.
// - It throws `MicrosoftGraphAuthError` with a stable `reason`:
//     not_configured          ENTRA_* missing, or Microsoft rejected the app's own credentials
//     not_connected           no live Microsoft credential on that row
//     reconnect_required      Microsoft refused the refresh token (row is now `error`)
//     microsoft_unreachable   network failure or a Microsoft 5xx/429 (row unchanged)
//     malformed_token_response Microsoft answered without a usable token
// - It records write capability (`grantedScopes` may include Files.ReadWrite)
//   but does not refuse on it: the write path (slice 5/8) decides.
// - `grantedScopes` is the connection's recorded grant, which never exceeds
//   the tier the person chose at connect (see "Scopes" below). The access
//   token itself may carry more if the tenant consented to more; AgentDash's
//   limit is the recorded set, and every check must read that.
// - A refresh is tied to the credential it started from: if the person
//   reconnects or disconnects while it is in flight, it stores nothing, never
//   marks the new connection failed, and answers from the row as it now is.
// - The access token must never reach an agent, a log or a response body.
//
// `microsoftGraphBaseUrl()` is the Graph root every Graph caller should use, so
// one environment override (`MICROSOFT_GRAPH_BASE_URL`) points tests at a local
// server.
//
// ## The connect flow (routes/microsoft-documents.ts)
//
// Authorization code + PKCE, confidential client (`ENTRA_TENANT_ID`,
// `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, single tenant). `beginConnect`
// stores the state and PKCE verifier on the person's one live `microsoft` row
// (reusing it when it exists, so slice 1's unique index never blocks a
// reconnect, and a working connection keeps working until the new grant
// lands). `completeConnect` spends the state exactly once, exchanges the code,
// reads `/me` for the account label, and updates that same row in place.
//
// Scopes: tier `read` asks for openid profile offline_access User.Read
// Files.Read.All Sites.Read.All. Tier `read_propose` adds Files.ReadWrite (the
// person's own OneDrive, for proposed copies) and User.ReadBasic.All (slice 8's
// recipient check). Nothing tenant-wide for writing is ever requested (D5, D11).
//
// The chosen tier is an upper bound. Microsoft can list scopes nobody asked
// for (tenant-wide admin consent on a shared app registration), and a refresh
// token is good for everything already consented. So the row records only
// `granted ∩ requested-for-tier`, a refresh asks for that recorded set and
// nothing else, and the recorded set can shrink on refresh but never grow.
// A grant without the read scopes is refused at connect (`consent_incomplete`).
//
// The redirect URI must be on this instance's own configured origin
// (`PAPERCLIP_PUBLIC_URL` or the declared origins); loopback is accepted only
// when the instance runs in `local_trusted` mode.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, like, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, connections } from "@paperclipai/db";
import { HttpError, badRequest, notFound, serviceUnavailable } from "../errors.js";
import { unwrapPgError, PG_UNIQUE_VIOLATION } from "../lib/pg-error.js";
import { configuredPublicBaseUrl } from "../lib/public-base-url.js";
import { mintingOrigins, normalizeOrigin } from "../lib/declared-origins.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { connectorService } from "./connectors.js";
import { grantedWriteScopes } from "./entra-obo.js";

export const MICROSOFT_PROVIDER = "microsoft";

/** Sign-in scopes: identity and a refresh token, no data access. */
const SIGN_IN_SCOPES = ["openid", "profile", "offline_access"] as const;
/** Tier `read`: the person's files and the sites they can open. */
export const MICROSOFT_READ_SCOPES = ["User.Read", "Files.Read.All", "Sites.Read.All"] as const;
/** Added by tier `read_propose`: new files in their own OneDrive, and directory lookup. */
export const MICROSOFT_PROPOSE_SCOPES = ["Files.ReadWrite", "User.ReadBasic.All"] as const;

export const MICROSOFT_CONNECTION_TIERS = ["read", "read_propose"] as const;
export type MicrosoftConnectionTier = (typeof MICROSOFT_CONNECTION_TIERS)[number];

export type MicrosoftGraphAuthFailureReason =
  | "not_configured"
  | "not_connected"
  | "reconnect_required"
  | "microsoft_unreachable"
  | "malformed_token_response";

export class MicrosoftGraphAuthError extends Error {
  readonly reason: MicrosoftGraphAuthFailureReason;
  constructor(reason: MicrosoftGraphAuthFailureReason, message: string) {
    super(message);
    this.name = "MicrosoftGraphAuthError";
    this.reason = reason;
  }
}

/** What `tokenForConnection` returns. Deliberately nothing else. */
export interface MicrosoftGraphToken {
  accessToken: string;
  grantedScopes: string[];
}

/** The person-facing description of their connection. Never carries a credential. */
export interface MicrosoftConnectionView {
  id: string;
  account: string | null;
  scopes: string[];
  writeScopes: string[];
  tier: MicrosoftConnectionTier | null;
  status: "pending" | "active" | "expired" | "error";
  lastError: { reason: string; message: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** Refresh this long before expiry, so a token never dies mid-request. */
const REFRESH_SKEW_MS = 60_000;
/** An unfinished sign-in is good for this long. */
const STATE_TTL_MS = 15 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const CALLBACK_PATH = "/connect/microsoft/callback";
const ACTIVITY_PREFIX = "connection.microsoft_";
const ACTIVITY = {
  connected: "connection.microsoft_connected",
  connectFailed: "connection.microsoft_connect_failed",
  refreshFailed: "connection.microsoft_refresh_failed",
} as const;

const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE_PREFIX = "https://graph.microsoft.com/";

/** Graph root for every Graph call. Override with `MICROSOFT_GRAPH_BASE_URL`. */
export function microsoftGraphBaseUrl(): string {
  return (process.env.MICROSOFT_GRAPH_BASE_URL?.trim() || DEFAULT_GRAPH_BASE).replace(/\/+$/, "");
}

function authorityBaseUrl(): string {
  return (process.env.ENTRA_AUTHORITY_URL?.trim() || DEFAULT_AUTHORITY).replace(/\/+$/, "");
}

interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

function readConfig(): EntraConfig | null {
  const tenantId = process.env.ENTRA_TENANT_ID?.trim();
  const clientId = process.env.ENTRA_CLIENT_ID?.trim();
  const clientSecret = process.env.ENTRA_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

/** Whether this instance can sign anyone in to Microsoft at all. */
export function microsoftSignInConfigured(): boolean {
  return readConfig() !== null;
}

const NOT_CONFIGURED_MESSAGE =
  "Microsoft sign-in is not configured on this AgentDash instance. An administrator must set ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET.";

function requireConfigForRoute(): EntraConfig {
  const config = readConfig();
  if (!config) throw serviceUnavailable(NOT_CONFIGURED_MESSAGE, { code: "microsoft_not_configured" });
  return config;
}

function oauthUrl(config: EntraConfig, endpoint: "authorize" | "token"): string {
  return `${authorityBaseUrl()}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/${endpoint}`;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `https://graph.microsoft.com/Files.Read.All` and `Files.Read.All` are the same grant. */
function normalizeScopes(scope: string): string[] {
  const out: string[] = [];
  for (const raw of scope.trim().split(/\s+/)) {
    if (!raw) continue;
    const name = raw.startsWith(GRAPH_SCOPE_PREFIX) ? raw.slice(GRAPH_SCOPE_PREFIX.length) : raw;
    if (["openid", "profile", "email", "offline_access"].includes(name.toLowerCase())) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function hasScope(scopes: readonly string[], wanted: string): boolean {
  return scopes.some((s) => s.toLowerCase() === wanted.toLowerCase());
}

/** The tier is what Microsoft actually granted, not what was asked for. */
function tierFromScopes(scopes: readonly string[]): MicrosoftConnectionTier {
  return hasScope(scopes, "Files.ReadWrite") ? "read_propose" : "read";
}

/**
 * What a connection may record: the granted scopes that the tier asked for,
 * in the tier's own spelling and order. Anything else Microsoft lists (a
 * tenant-wide consent the person never chose) is dropped.
 */
function boundScopes(granted: readonly string[], allowed: readonly string[]): string[] {
  return allowed.filter((scope) => hasScope(granted, scope));
}

/** The data scopes a tier asks for, without the sign-in scopes. */
function dataScopesForTier(tier: MicrosoftConnectionTier): string[] {
  return normalizeScopes(requestedScopesForTier(tier).join(" "));
}

export function requestedScopesForTier(tier: MicrosoftConnectionTier): string[] {
  return [
    ...SIGN_IN_SCOPES,
    ...MICROSOFT_READ_SCOPES,
    ...(tier === "read_propose" ? MICROSOFT_PROPOSE_SCOPES : []),
  ];
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface MicrosoftConnectOptions {
  /**
   * Accept a loopback (`localhost`, `127.0.0.1`, `[::1]`) redirect URI. Only a
   * `local_trusted` instance sets this: anywhere else a loopback URI names a
   * machine that is not this instance.
   */
  allowLoopbackRedirect?: boolean;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The origins this instance answers on, as its operator configured them. */
function instanceOrigins(): Set<string> {
  const origins = new Set(mintingOrigins());
  const configured = normalizeOrigin(configuredPublicBaseUrl());
  if (configured) origins.add(configured);
  return origins;
}

/**
 * The redirect URI the browser returns to: AgentDash's own callback page, on
 * this instance's configured origin, over HTTPS (Microsoft accepts plain HTTP
 * only for localhost). Microsoft enforces the registered value too, but an app
 * registration can list more than one instance (or a stale dev URI), so the
 * origin is pinned here and Microsoft's check is not the only guard.
 */
function validateRedirectUri(value: unknown, options: MicrosoftConnectOptions): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw badRequest("redirectUri is required");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest("redirectUri must be an absolute URL");
  }
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw badRequest("redirectUri must use HTTPS; Microsoft accepts plain HTTP only for localhost");
  }
  if (!url.pathname.endsWith(CALLBACK_PATH) || url.search || url.hash || url.username || url.password) {
    throw badRequest(`redirectUri must be this instance's ${CALLBACK_PATH} page`);
  }
  if (loopback) {
    if (!options.allowLoopbackRedirect) {
      throw badRequest("redirectUri may name localhost only on a local instance; use this instance's public address");
    }
    return value;
  }
  const origins = instanceOrigins();
  if (origins.size === 0) {
    throw badRequest(
      "This AgentDash instance has no configured public address, so it cannot receive a Microsoft sign-in. An administrator must set PAPERCLIP_PUBLIC_URL.",
    );
  }
  if (!origins.has(url.origin.toLowerCase())) {
    throw badRequest(`redirectUri must be on this instance's own address (${[...origins].join(", ")})`);
  }
  return value;
}

function parseTier(value: unknown): MicrosoftConnectionTier {
  if (value === undefined || value === null) return "read";
  if (typeof value === "string" && (MICROSOFT_CONNECTION_TIERS as readonly string[]).includes(value)) {
    return value as MicrosoftConnectionTier;
  }
  throw badRequest(`tier must be one of: ${MICROSOFT_CONNECTION_TIERS.join(", ")}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_STATE_MESSAGE =
  "This Microsoft sign-in is invalid, expired or already used. Start connecting again from My Agent.";

function parseState(value: unknown): { connectionId: string; stateToken: string } {
  if (typeof value !== "string" || value.length > 512) throw badRequest(INVALID_STATE_MESSAGE);
  const colon = value.indexOf(":");
  const connectionId = colon > 0 ? value.slice(0, colon) : "";
  const stateToken = colon > 0 ? value.slice(colon + 1) : "";
  if (!UUID_RE.test(connectionId) || stateToken.length === 0) throw badRequest(INVALID_STATE_MESSAGE);
  return { connectionId, stateToken };
}

/**
 * The `error` Microsoft put on the callback, mapped to a fixed reason and
 * message. A tenant that has turned off user consent answers
 * `consent_required` or `interaction_required` (or shows its "Need admin
 * approval" page): that is an administrator's step, not the person declining,
 * and saying "declined" would send them in circles. Anything unrecognized gets
 * a generic message and never echoes the code it was sent.
 */
function providerErrorFailure(error: unknown): { reason: string; message: string; status: number } {
  const code = typeof error === "string" ? error : "";
  if (code === "access_denied") {
    return {
      reason: "consent_declined",
      message: "Microsoft sign-in was cancelled or declined, so nothing was connected. Connect again to retry.",
      status: 400,
    };
  }
  if (code === "consent_required" || code === "interaction_required") {
    return {
      reason: "admin_consent_required",
      message:
        "Your organization requires an administrator to approve AgentDash before you can connect. Ask your Microsoft 365 administrator to grant consent, then connect again.",
      status: 403,
    };
  }
  return {
    reason: "provider_error",
    message:
      "Microsoft could not finish the sign-in, so nothing was connected. Try again; if it keeps happening, ask an administrator to check the Microsoft app registration.",
    status: 502,
  };
}

interface StoredState {
  stateToken: string;
  codeVerifier: string;
  redirectUri: string;
  tier: MicrosoftConnectionTier;
  requestedScopes: string[];
  issuedAt: string;
}

function readStoredState(value: unknown): StoredState | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s.stateToken !== "string" ||
    typeof s.codeVerifier !== "string" ||
    typeof s.redirectUri !== "string" ||
    typeof s.issuedAt !== "string" ||
    !Array.isArray(s.requestedScopes)
  ) {
    return null;
  }
  return {
    stateToken: s.stateToken,
    codeVerifier: s.codeVerifier,
    redirectUri: s.redirectUri,
    tier: s.tier === "read_propose" ? "read_propose" : "read",
    requestedScopes: s.requestedScopes.filter((x): x is string => typeof x === "string"),
    issuedAt: s.issuedAt,
  };
}

interface TokenEndpointSuccess {
  ok: true;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  tokenType: string;
  scope: string | null;
}
type TokenEndpointResult =
  | TokenEndpointSuccess
  | { ok: false; kind: "unreachable" | "refused" | "client_rejected" | "malformed"; error: string | null };

async function callTokenEndpoint(config: EntraConfig, form: Record<string, string>): Promise<TokenEndpointResult> {
  let response: Response;
  try {
    response = await fetch(oauthUrl(config, "token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...form,
      }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error }, "microsoft token endpoint unreachable");
    return { ok: false, kind: "unreachable", error: null };
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : null;
    if (response.status >= 500 || response.status === 429) return { ok: false, kind: "unreachable", error };
    if (error === "invalid_client" || error === "unauthorized_client") {
      return { ok: false, kind: "client_rejected", error };
    }
    return { ok: false, kind: "refused", error };
  }
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    return { ok: false, kind: "malformed", error: null };
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in ?? 3600);
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : null,
    expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    scope: typeof body.scope === "string" && body.scope.trim().length > 0 ? body.scope : null,
  };
}

/** In-flight refreshes, one per connection, so concurrent callers share it. */
const inflightRefresh = new Map<string, Promise<MicrosoftGraphToken>>();

/** Test seam, named like `__resetEntraOboCache`. */
export function __resetMicrosoftGraphAuthState(): void {
  inflightRefresh.clear();
}

export function microsoftGraphAuthService(db: Db, options: MicrosoftConnectOptions = {}) {
  const connectors = connectorService(db);

  async function liveRowFor(companyId: string, userId: string) {
    return db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.companyId, companyId),
          eq(connections.provider, MICROSOFT_PROVIDER),
          eq(connections.ownerType, "user"),
          eq(connections.ownerId, userId),
          isNull(connections.revokedAt),
        ),
      )
      .orderBy(desc(connections.createdAt))
      .then((rows) => rows[0] ?? null);
  }

  async function logEvent(
    row: { id: string; companyId: string },
    actor: { type: "user" | "system"; id: string },
    action: string,
    details: Record<string, unknown>,
  ) {
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      entityType: "connection",
      entityId: row.id,
      details: { provider: MICROSOFT_PROVIDER, ...details },
    });
  }

  // -------------------------------------------------------------------------
  // tokenForConnection
  // -------------------------------------------------------------------------

  /** How many times a refresh that lost a race to a reconnect starts over. */
  const MAX_REFRESH_ATTEMPTS = 3;

  async function refresh(connectionId: string, attempt = 1): Promise<MicrosoftGraphToken> {
    const row = await connectors.getById(connectionId);
    if (!row || row.provider !== MICROSOFT_PROVIDER || row.revokedAt || row.status === "revoked" || !row.encryptedToken) {
      throw new MicrosoftGraphAuthError("not_connected", "There is no connected Microsoft account for this connection");
    }
    if (row.status === "error" || row.status === "expired") {
      throw new MicrosoftGraphAuthError(
        "reconnect_required",
        "Microsoft no longer accepts this connection; its owner must reconnect Microsoft from My Agent",
      );
    }
    // The credential this refresh starts from. Every write below is
    // conditional on the row still holding exactly this ciphertext (each
    // encryption is fresh, so a reconnect or a disconnect always changes it).
    const startedFrom = row.encryptedToken as Record<string, unknown>;
    const token = await connectors.getDecryptedToken(connectionId);
    if (!token) {
      throw new MicrosoftGraphAuthError("not_connected", "There is no connected Microsoft account for this connection");
    }
    // The recorded grant, already bounded by the tier at connect.
    const recorded = (row.scopes ?? []) as string[];
    const expiresAtMs = token.expiresAt ? Date.parse(token.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
      return { accessToken: token.accessToken, grantedScopes: recorded };
    }

    /** The row changed under this refresh: answer from the row as it is now. */
    const startOver = (): Promise<MicrosoftGraphToken> => {
      if (attempt >= MAX_REFRESH_ATTEMPTS) {
        throw new MicrosoftGraphAuthError(
          "not_connected",
          "This Microsoft connection kept changing while it was being refreshed; try again",
        );
      }
      return refresh(connectionId, attempt + 1);
    };

    const config = readConfig();
    if (!config) throw new MicrosoftGraphAuthError("not_configured", NOT_CONFIGURED_MESSAGE);
    if (!token.refreshToken) {
      if (!(await markRefreshFailed(row, startedFrom, "reconnect_required", null))) return startOver();
      throw new MicrosoftGraphAuthError(
        "reconnect_required",
        "This Microsoft connection has no refresh token; its owner must reconnect Microsoft from My Agent",
      );
    }

    const result = await callTokenEndpoint(config, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      // Ask for exactly the recorded grant: a refresh never widens it, even
      // though Microsoft would honour anything already consented.
      scope: [...recorded, "offline_access"].join(" "),
    });
    if (!result.ok) {
      if (result.kind === "unreachable") {
        throw new MicrosoftGraphAuthError("microsoft_unreachable", "Microsoft could not be reached to refresh this connection");
      }
      if (result.kind === "client_rejected") {
        // The app registration's credentials, not the person's grant: do not
        // make every person reconnect for an operator fix.
        logger.error({ error: result.error }, "microsoft rejected this instance's client credentials on refresh");
        throw new MicrosoftGraphAuthError(
          "not_configured",
          "Microsoft rejected this AgentDash instance's app credentials; an administrator must check ENTRA_CLIENT_SECRET",
        );
      }
      if (result.kind === "malformed") {
        throw new MicrosoftGraphAuthError("malformed_token_response", "Microsoft returned no usable token");
      }
      // A refusal of the refresh token this attempt started from says nothing
      // about a credential that replaced it meanwhile.
      if (!(await markRefreshFailed(row, startedFrom, "reconnect_required", result.error))) return startOver();
      throw new MicrosoftGraphAuthError(
        "reconnect_required",
        result.error === "interaction_required"
          ? "Microsoft requires its owner to sign in again (a sign-in or multi-factor policy); reconnect Microsoft from My Agent"
          : "Microsoft no longer accepts this connection; its owner must reconnect Microsoft from My Agent",
      );
    }

    // Microsoft may omit `scope` ("the token is for the scopes requested");
    // whatever it lists, the grant can shrink here but never grow.
    const grantedScopes = result.scope ? boundScopes(normalizeScopes(result.scope), recorded) : recorded;
    const stored = await connectors.refreshToken(
      connectionId,
      {
        accessToken: result.accessToken,
        // Microsoft rotates refresh tokens; keep the old one only if it did not.
        refreshToken: result.refreshToken ?? token.refreshToken,
        expiresAt: result.expiresAt,
        tokenType: result.tokenType,
        scope: grantedScopes.join(" "),
      },
      { expectedEncryptedToken: startedFrom, scopes: grantedScopes },
    );
    // Disconnected (no row) or reconnected (different credential) meanwhile:
    // this token must not be stored, and must not be handed out either.
    if (!stored) return startOver();
    return { accessToken: result.accessToken, grantedScopes };
  }

  /** Marks the row `error`, unless its credential changed since `startedFrom`. Returns whether it did. */
  async function markRefreshFailed(
    row: { id: string; companyId: string },
    startedFrom: Record<string, unknown>,
    reason: MicrosoftGraphAuthFailureReason,
    microsoftError: string | null,
  ): Promise<boolean> {
    const marked = await db
      .update(connections)
      .set({ status: "error", updatedAt: new Date() })
      .where(
        and(
          eq(connections.id, row.id),
          isNull(connections.revokedAt),
          sql`${connections.encryptedToken} = ${JSON.stringify(startedFrom)}::jsonb`,
        ),
      )
      .returning({ id: connections.id })
      .then((rows) => rows.length > 0);
    if (!marked) return false;
    await logEvent(row, { type: "system", id: "microsoft-graph-auth" }, ACTIVITY.refreshFailed, {
      reason,
      // Microsoft's error code only; its description can carry trace ids.
      microsoftError,
      message:
        microsoftError === "interaction_required"
          ? "Microsoft requires you to sign in again (a sign-in or multi-factor policy). Reconnect Microsoft."
          : "Microsoft no longer accepts this connection. Reconnect Microsoft.",
    });
    return true;
  }

  /**
   * A Graph access token for an already-authorized connection. See the header
   * comment for the contract; the refresh token never leaves this module.
   */
  async function tokenForConnection(connectionId: string): Promise<MicrosoftGraphToken> {
    const inflight = inflightRefresh.get(connectionId);
    if (inflight) return inflight;
    const pending = refresh(connectionId).finally(() => {
      inflightRefresh.delete(connectionId);
    });
    inflightRefresh.set(connectionId, pending);
    return pending;
  }

  // -------------------------------------------------------------------------
  // Connect flow (the person's own connection)
  // -------------------------------------------------------------------------

  async function beginConnect(
    companyId: string,
    userId: string,
    input: { redirectUri: unknown; tier: unknown },
  ): Promise<{ authorizationUrl: string; connectionId: string }> {
    const config = requireConfigForRoute();
    const redirectUri = validateRedirectUri(input.redirectUri, options);
    const tier = parseTier(input.tier);
    const requestedScopes = requestedScopesForTier(tier);
    const codeVerifier = base64Url(randomBytes(32));
    const stateToken = base64Url(randomBytes(24));
    const state: StoredState = {
      stateToken,
      codeVerifier,
      redirectUri,
      tier,
      requestedScopes,
      issuedAt: new Date().toISOString(),
    };

    // One live row per person (slice 1's unique index). Reuse it whatever its
    // state: a pending row gets a fresh state (older authorize URLs die), and
    // a connected row keeps its working credential until the new grant lands.
    let connectionId: string | null = null;
    for (let attempt = 0; attempt < 3 && !connectionId; attempt += 1) {
      const existing = await liveRowFor(companyId, userId);
      if (existing) {
        const updated = await db
          .update(connections)
          .set({ oauthState: state as unknown as Record<string, unknown>, updatedAt: new Date() })
          .where(and(eq(connections.id, existing.id), isNull(connections.revokedAt)))
          .returning({ id: connections.id })
          .then((rows) => rows[0] ?? null);
        connectionId = updated?.id ?? null;
        continue;
      }
      try {
        const created = await connectors.storeOAuthState(
          companyId,
          "user",
          userId,
          MICROSOFT_PROVIDER,
          state as unknown as Record<string, unknown>,
        );
        connectionId = created.id;
      } catch (error) {
        // A concurrent initiate inserted first; reuse its row on the next pass.
        if (unwrapPgError(error).code !== PG_UNIQUE_VIOLATION) throw error;
      }
    }
    if (!connectionId) throw new HttpError(409, "Another Microsoft sign-in is starting for you; try again");

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: requestedScopes.join(" "),
      state: `${connectionId}:${stateToken}`,
      code_challenge: base64Url(createHash("sha256").update(codeVerifier).digest()),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return { authorizationUrl: `${oauthUrl(config, "authorize")}?${params.toString()}`, connectionId };
  }

  async function completeConnect(
    companyId: string,
    userId: string,
    input: { code: unknown; error: unknown; state: unknown; redirectUri: unknown },
  ): Promise<MicrosoftConnectionView> {
    const config = requireConfigForRoute();
    const { connectionId, stateToken } = parseState(input.state);
    const row = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.companyId, companyId),
          eq(connections.provider, MICROSOFT_PROVIDER),
          eq(connections.ownerType, "user"),
          eq(connections.ownerId, userId),
          isNull(connections.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    const stored = readStoredState(row?.oauthState);
    // A guess, another person's state, or a stale URL changes nothing and
    // does not burn the real state.
    if (!row || !stored || !safeEqual(stored.stateToken, stateToken)) throw badRequest(INVALID_STATE_MESSAGE);
    if (typeof input.redirectUri !== "string" || input.redirectUri !== stored.redirectUri) {
      throw badRequest("redirectUri does not match the one this sign-in started with");
    }

    // Spend the state exactly once, even against a concurrent callback.
    const spent = await db
      .update(connections)
      .set({ oauthState: null, updatedAt: new Date() })
      .where(
        and(
          eq(connections.id, row.id),
          isNull(connections.revokedAt),
          sql`${connections.oauthState} ->> 'stateToken' = ${stateToken}`,
        ),
      )
      .returning({ id: connections.id })
      .then((rows) => rows.length);
    if (spent === 0) throw badRequest(INVALID_STATE_MESSAGE);
    if (Date.parse(stored.issuedAt) + STATE_TTL_MS < Date.now()) throw badRequest(INVALID_STATE_MESSAGE);

    const actor = { type: "user" as const, id: userId };
    const fail = async (reason: string, message: string, status: number) => {
      await logEvent(row, actor, ACTIVITY.connectFailed, { reason, message });
      return new HttpError(status, message, { code: reason });
    };

    if (input.error !== undefined && input.error !== null) {
      // Only the OAuth error code selects a message, and every message is
      // fixed text: Microsoft's error_description is never forwarded or shown,
      // because anyone can craft a callback URL that carries one.
      const failure = providerErrorFailure(input.error);
      throw await fail(failure.reason, failure.message, failure.status);
    }
    if (typeof input.code !== "string" || input.code.length === 0 || input.code.length > 4096) {
      throw badRequest("code is required");
    }

    const exchanged = await callTokenEndpoint(config, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: stored.redirectUri,
      code_verifier: stored.codeVerifier,
      scope: stored.requestedScopes.join(" "),
    });
    if (!exchanged.ok) {
      if (exchanged.kind === "unreachable") {
        throw await fail("microsoft_unreachable", "Microsoft could not be reached to finish signing in. Try again.", 502);
      }
      if (exchanged.kind === "client_rejected") {
        throw await fail(
          "not_configured",
          "Microsoft rejected this AgentDash instance's app credentials. An administrator must check the Entra app registration.",
          502,
        );
      }
      if (exchanged.kind === "malformed") {
        throw await fail("malformed_token_response", "Microsoft returned no usable token. Try connecting again.", 502);
      }
      throw await fail("code_rejected", "Microsoft did not accept this sign-in. Start connecting again.", 400);
    }
    if (!exchanged.refreshToken) {
      // Without a refresh token the connection dies within the hour, which is
      // the failure this slice exists to fix. Refuse rather than store it.
      throw await fail(
        "malformed_token_response",
        "Microsoft did not grant lasting access (no refresh token). Try connecting again.",
        502,
      );
    }
    // `scope` is optional in a code redemption: omitted means "the scopes
    // requested". Either way the tier chosen at connect is the upper bound.
    const scopes = boundScopes(
      normalizeScopes(exchanged.scope ?? stored.requestedScopes.join(" ")),
      dataScopesForTier(stored.tier),
    );
    const missing = MICROSOFT_READ_SCOPES.filter((scope) => !hasScope(scopes, scope));
    if (missing.length > 0) {
      throw await fail(
        "consent_incomplete",
        `Microsoft did not grant ${missing.join(", ")}, so AgentDash cannot read your documents. Your organization may require an administrator to consent to these permissions; ask your Microsoft 365 administrator, then connect again.`,
        403,
      );
    }

    let account: string | null = null;
    try {
      const me = await fetch(`${microsoftGraphBaseUrl()}/me?$select=userPrincipalName,mail`, {
        method: "GET",
        headers: { authorization: `Bearer ${exchanged.accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!me.ok) throw new Error(`graph /me answered ${me.status}`);
      const body = (await me.json().catch(() => ({}))) as Record<string, unknown>;
      account =
        typeof body.userPrincipalName === "string"
          ? body.userPrincipalName
          : typeof body.mail === "string"
            ? body.mail
            : null;
    } catch (error) {
      logger.warn({ err: error }, "microsoft graph /me probe failed after sign-in");
      throw await fail("profile_unavailable", "Signed in, but Microsoft did not return your profile. Try connecting again.", 502);
    }

    const reconnected = row.encryptedToken !== null;
    const updated = await connectors.completeOAuthConnection(row.id, {
      scopes,
      accountLabel: account,
      sendIdentity: "delegated",
      token: {
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        expiresAt: exchanged.expiresAt,
        tokenType: exchanged.tokenType,
        scope: scopes.join(" "),
      },
    });
    if (!updated) throw notFound("This Microsoft connection was disconnected while signing in");
    inflightRefresh.delete(row.id);
    await logEvent(row, actor, ACTIVITY.connected, {
      tier: tierFromScopes(scopes),
      requestedTier: stored.tier,
      scopes,
      writeScopes: grantedWriteScopes(scopes),
      accountLabel: account,
      reconnected,
    });
    return toView(updated, null);
  }

  // -------------------------------------------------------------------------
  // Health and disconnect
  // -------------------------------------------------------------------------

  /**
   * D7: no error column. The last error is the latest `connection.microsoft_*`
   * activity row when that row is a failure; a later success clears it.
   */
  async function lastErrorFor(row: typeof connections.$inferSelect): Promise<MicrosoftConnectionView["lastError"]> {
    const latest = await db
      .select({ action: activityLog.action, details: activityLog.details, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, row.companyId),
          eq(activityLog.entityType, "connection"),
          eq(activityLog.entityId, row.id),
          like(activityLog.action, `${ACTIVITY_PREFIX}%`),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (latest && latest.action.endsWith("_failed")) {
      const details = (latest.details ?? {}) as Record<string, unknown>;
      return {
        reason: typeof details.reason === "string" ? details.reason : "unknown",
        message: typeof details.message === "string" ? details.message : "The last Microsoft operation failed.",
        at: latest.createdAt.toISOString(),
      };
    }
    if (row.status === "error" || row.status === "expired") {
      return {
        reason: "reconnect_required",
        message: "Microsoft no longer accepts this connection. Reconnect Microsoft.",
        at: row.updatedAt.toISOString(),
      };
    }
    return null;
  }

  function toView(
    row: typeof connections.$inferSelect,
    lastError: MicrosoftConnectionView["lastError"],
  ): MicrosoftConnectionView {
    const scopes = (row.scopes ?? []) as string[];
    const connected = row.encryptedToken !== null;
    const status: MicrosoftConnectionView["status"] = !connected
      ? "pending"
      : row.status === "error" || row.status === "expired"
        ? row.status
        : "active";
    return {
      id: row.id,
      account: row.accountLabel,
      scopes,
      writeScopes: grantedWriteScopes(scopes),
      tier: connected ? tierFromScopes(scopes) : null,
      status,
      lastError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function health(companyId: string, userId: string): Promise<MicrosoftConnectionView | null> {
    const row = await liveRowFor(companyId, userId);
    if (!row) return null;
    return toView(row, await lastErrorFor(row));
  }

  async function disconnect(companyId: string, userId: string): Promise<{ connectionId: string }> {
    const row = await liveRowFor(companyId, userId);
    if (!row) throw notFound("You have no Microsoft connection to disconnect");
    await connectors.revoke(row.id, "user", userId);
    await db.update(connections).set({ oauthState: null }).where(eq(connections.id, row.id));
    inflightRefresh.delete(row.id);
    return { connectionId: row.id };
  }

  return { tokenForConnection, beginConnect, completeConnect, health, disconnect };
}

export type MicrosoftGraphAuthService = ReturnType<typeof microsoftGraphAuthService>;
