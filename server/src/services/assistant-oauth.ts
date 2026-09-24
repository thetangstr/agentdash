import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Request } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assistantAccessTokens,
  assistantAuthRequests,
  assistantGrants,
  assistantOauthClients,
  assistantRefreshTokens,
  companies,
  companyMemberships,
} from "@paperclipai/db";
import {
  ASSISTANT_ACCESS_TOKEN_PREFIX,
  ASSISTANT_ACCESS_TOKEN_TTL_MS,
  ASSISTANT_AUTH_REQUEST_TTL_MS,
  ASSISTANT_CLIENT_ID_PREFIX,
  ASSISTANT_REFRESH_TOKEN_PREFIX,
  ASSISTANT_REFRESH_TOKEN_TTL_MS,
  ASSISTANT_SCOPES,
  isAssistantScope,
  type AssistantScope,
} from "@paperclipai/shared";
import { configuredPublicBaseUrl } from "../lib/public-base-url.js";

/**
 * AgentDash assistant MCP (GH #677): a minimal, first-party OAuth 2.1
 * authorization server.
 *
 * Why first-party: better-auth 1.6.23's oidc-provider plugin ships PKCE/S256
 * and DCR-shaped registration, but its implementation contains no RFC 8707
 * `resource` handling at all, no CIMD, and no way to bind a token to a
 * company-scoped, revocable grant. The authorization model this feature needs
 * is exactly those three things, so the plugin would have been a shell around
 * code we still had to write.
 *
 * The model in one paragraph: a CLIENT registers (DCR row, or a CIMD document
 * fetched under SSRF guards). An AUTH REQUEST is a pending consent — it
 * remembers the exact client, redirect URI, PKCE challenge, resource, and
 * scope ceiling the client asked for. A person approves it, which mints a
 * GRANT (user × client × company → scopes) and a single-use code. The code
 * exchanges for a TOKEN PAIR bound to the grant and a refresh FAMILY. Every
 * trust decision lands on one of those rows, and every row is company-scoped.
 */

const CODE_PREFIX = "pcpc_";
const ISSUER_RESOURCE_PATH = "/api/mcp/assistant";

/** CIMD fetch limits — the metadata document is attacker-controlled input. */
const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_MAX_REDIRECTS = 3;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function opaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function nowPlus(ms: number): Date {
  return new Date(Date.now() + ms);
}

/** Canonical issuer base: configured public URL wins; request origin is the dev fallback. */
export function issuerBaseUrl(req?: Pick<Request, "protocol" | "get">): string {
  const configured = configuredPublicBaseUrl();
  if (configured) return configured;
  if (req) return `${req.protocol}://${req.get("host")}`;
  return "http://localhost:3100";
}

/**
 * The RFC 8707 audience every assistant token is bound to. Derived from the
 * configured public base URL — never from the request Host — so a token
 * minted for this instance cannot be replayed against another, and the
 * protected-resource metadata advertises exactly this string.
 */
export function assistantResourceUri(req?: Pick<Request, "protocol" | "get">): string {
  return `${issuerBaseUrl(req)}${ISSUER_RESOURCE_PATH}`;
}

/** OAuth error payload helper — consistent `{error, error_description?}` bodies. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

// ---------------------------------------------------------------------------
// SSRF guard for CIMD fetches
// ---------------------------------------------------------------------------

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return isPrivateIpv4(bare.split(".").map(Number));
  }
  if (bare.includes(":")) {
    if (bare === "::1" || bare === "::") return true;
    // IPv4-mapped IPv6 — re-check the embedded v4.
    const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]!.split(".").map(Number));
    if (bare.startsWith("fe80:") || bare.startsWith("fe90:") || bare.startsWith("fea0:") || bare.startsWith("feb0:")) return true;
    if (bare.startsWith("fc") || bare.startsWith("fd")) return true;
    if (bare.startsWith("2001:db8")) return true; // documentation range
    if (bare === "::ffff:0.0.0.0") return true;
  }
  return false;
}

/**
 * Resolve the host and refuse any address family we should not dial: private,
 * loopback, link-local, CGNAT, reserved, or documentation ranges. Literal-IP
 * URLs short-circuit DNS. This is deliberately stricter than `isSafeFetchUrl`
 * in assess.ts — a CIMD document URL comes from an OAuth client we have never
 * met, and DNS is where "safe-looking hostname" becomes "internal address".
 */
async function assertPublicFetchUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new OAuthError("invalid_client_metadata", "client_id is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new OAuthError("invalid_client_metadata", "client_id must be an https URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "metadata.google.internal") {
    throw new OAuthError("invalid_client_metadata", "client_id host is not public");
  }
  if (isPrivateIpLiteral(host)) {
    throw new OAuthError("invalid_client_metadata", "client_id host is not public");
  }
  if (/\d+\.\d+\.\d+\.\d+/.test(host) || host.includes(":")) {
    // Literal IP that passed the private check — public literal, allow.
    return parsed;
  }
  const addresses = await dnsLookup(host, { all: true }).catch(() => {
    throw new OAuthError("invalid_client_metadata", "client_id host does not resolve");
  });
  if (addresses.length === 0) {
    throw new OAuthError("invalid_client_metadata", "client_id host does not resolve");
  }
  for (const { address } of addresses) {
    if (isPrivateIpLiteral(address)) {
      throw new OAuthError("invalid_client_metadata", "client_id resolves to a non-public address");
    }
  }
  return parsed;
}

/**
 * Fetch a CIMD document with the whole guardrail set: https only, every
 * resolved address public, redirects re-validated hop-by-hop (a public URL
 * redirecting to 169.254.169.254 is the classic bypass), 5s total budget, and
 * a streamed 64 KB cap so a hostile server cannot buffer-bomb us.
 */
async function fetchClientMetadataDocument(url: string): Promise<Record<string, unknown>> {
  let current = url;
  for (let hop = 0; hop <= CIMD_MAX_REDIRECTS; hop += 1) {
    const parsed = await assertPublicFetchUrl(current);
    const res = await fetch(parsed, {
      redirect: "manual",
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
      headers: { accept: "application/json" },
    }).catch((err) => {
      throw new OAuthError("invalid_client_metadata", `client metadata fetch failed: ${String(err)}`);
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      void res.body?.cancel().catch(() => {});
      if (!location) throw new OAuthError("invalid_client_metadata", "client metadata redirect has no Location");
      current = new URL(location, parsed).toString();
      continue;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new OAuthError("invalid_client_metadata", `client metadata fetch returned ${res.status}`);
    }
    const body = res.body;
    if (!body) throw new OAuthError("invalid_client_metadata", "client metadata response has no body");
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > CIMD_MAX_BYTES) {
          throw new OAuthError("invalid_client_metadata", "client metadata document exceeds 64 KB");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client_metadata", "client metadata document is not JSON");
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new OAuthError("invalid_client_metadata", "client metadata document is not an object");
    }
    return json as Record<string, unknown>;
  }
  throw new OAuthError("invalid_client_metadata", "client metadata redirected too many times");
}

// ---------------------------------------------------------------------------
// Redirect-URI validation (shared by DCR registration and CIMD documents)
// ---------------------------------------------------------------------------

/**
 * Absolute http(s) URI, no fragment. `http:` is accepted only for loopback
 * targets — the native-app loopback pattern from RFC 8252, which is how MCP
 * clients on the same machine actually redirect. Everything else must be
 * https, because an authorization code on a plaintext non-loopback redirect
 * is a code on the wire.
 */
export function validateRedirectUri(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri is not a valid URL");
  }
  if (parsed.hash) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri must not contain a fragment");
  }
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const loopback =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      host === "::1" ||
      /^127\.\d+\.\d+\.\d+$/.test(host);
    if (loopback) return parsed.toString();
  }
  throw new OAuthError("invalid_redirect_uri", "redirect_uri must be https (http is loopback-only)");
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function assistantOAuthService(db: Db) {
  async function findClientRow(clientId: string) {
    return db
      .select()
      .from(assistantOauthClients)
      .where(eq(assistantOauthClients.clientId, clientId))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * RFC 7591-ish dynamic registration for public clients. No client secret is
   * minted — PKCE is the credential — which is why the response carries no
   * `client_secret` and `token_endpoint_auth_method` is `none`.
   */
  async function registerClient(body: Record<string, unknown>) {
    const redirectUrisRaw = body.redirect_uris;
    if (!Array.isArray(redirectUrisRaw) || redirectUrisRaw.length === 0 || redirectUrisRaw.length > 10) {
      throw new OAuthError("invalid_client_metadata", "redirect_uris must be a non-empty array (max 10)");
    }
    const redirectUris = redirectUrisRaw.map((uri) => {
      if (typeof uri !== "string") {
        throw new OAuthError("invalid_redirect_uri", "redirect_uris entries must be strings");
      }
      return validateRedirectUri(uri);
    });
    const clientName =
      typeof body.client_name === "string" && body.client_name.trim()
        ? body.client_name.trim().slice(0, 200)
        : "MCP client";
    const clientId = `${ASSISTANT_CLIENT_ID_PREFIX}${randomBytes(24).toString("base64url")}`;
    const [row] = await db
      .insert(assistantOauthClients)
      .values({
        clientId,
        registrationType: "dcr",
        clientName,
        redirectUris,
        metadataJson: {
          client_name: clientName,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
      })
      .returning();
    return row!;
  }

  /**
   * Resolve `client_id` from an authorize request. A `dcr_…` id (or any
   * non-URL value) must already be registered. An https URL is CIMD: fetch
   * the document under SSRF guards, enforce that its redirect URIs are
   * same-origin with the document, and cache the row so grants survive a
   * re-resolution.
   */
  async function resolveClient(clientId: string) {
    const existing = await findClientRow(clientId);
    if (existing) return existing;
    if (!/^https:\/\//i.test(clientId)) {
      throw new OAuthError("invalid_client", "unknown client_id", 400);
    }
    const doc = await fetchClientMetadataDocument(clientId);
    const docOrigin = new URL(clientId).origin;
    const rawUris = doc.redirect_uris;
    if (!Array.isArray(rawUris) || rawUris.length === 0) {
      throw new OAuthError("invalid_client_metadata", "metadata document has no redirect_uris");
    }
    const redirectUris = rawUris.map((uri) => {
      if (typeof uri !== "string") {
        throw new OAuthError("invalid_client_metadata", "redirect_uris entries must be strings");
      }
      const validated = validateRedirectUri(uri);
      // The document may only speak for its own origin. A metadata document at
      // attacker.example naming a redirect on victim.example must not turn a
      // consent screen into a code-delivery mechanism for that origin.
      if (new URL(validated).origin !== docOrigin) {
        throw new OAuthError(
          "invalid_client_metadata",
          "CIMD redirect_uris must share the client_id document's origin",
        );
      }
      return validated;
    });
    const clientName =
      typeof doc.client_name === "string" && doc.client_name.trim()
        ? doc.client_name.trim().slice(0, 200)
        : new URL(clientId).hostname;
    const [row] = await db
      .insert(assistantOauthClients)
      .values({
        clientId,
        registrationType: "cimd",
        clientName,
        redirectUris,
        metadataJson: doc,
      })
      .onConflictDoUpdate({
        target: assistantOauthClients.clientId,
        set: { clientName, redirectUris, metadataJson: doc, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /**
   * Validate a `/oauth/authorize` request and persist it as a pending consent.
   * Everything the consent screen will display is fixed here — the later
   * approve call cannot be talked into widening any of it.
   */
  async function beginAuthorize(params: {
    clientId: string;
    redirectUri: string | undefined;
    responseType: string | undefined;
    state: string | undefined;
    scope: string | undefined;
    resource: string | undefined;
    codeChallenge: string | undefined;
    codeChallengeMethod: string | undefined;
    canonicalResource: string;
  }) {
    if (params.responseType !== "code") {
      throw new OAuthError("unsupported_response_type", "response_type must be code");
    }
    const client = await resolveClient(params.clientId);

    // Exact-match redirect_uri, always required. Optional-and-substring
    // matching is where oauth redirect validation bugs live.
    const redirectUri = params.redirectUri ? validateRedirectUri(params.redirectUri) : undefined;
    const registered = client.redirectUris;
    if (!redirectUri || !registered.includes(redirectUri)) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uri is not registered for this client");
    }

    // PKCE: required, S256 only. A missing challenge or `plain` is a hard
    // refusal, not a downgrade.
    if (!params.codeChallenge || params.codeChallenge.length < 43 || params.codeChallenge.length > 128) {
      throw new OAuthError("invalid_request", "code_challenge is required (43-128 chars)");
    }
    if (!/^[A-Za-z0-9\-._~]+$/.test(params.codeChallenge)) {
      throw new OAuthError("invalid_request", "code_challenge contains invalid characters");
    }
    if (params.codeChallengeMethod !== "S256") {
      throw new OAuthError("invalid_request", "code_challenge_method must be S256");
    }

    // RFC 8707: the resource is required and must be exactly this resource.
    // "Some other audience" is not a smaller grant we can still honor — it is
    // a request we were never meant to serve.
    if (params.resource !== params.canonicalResource) {
      throw new OAuthError("invalid_target", "resource must be the canonical assistant MCP resource URI");
    }

    const requestedScopes = (params.scope ?? "")
      .split(/\s+/)
      .filter((s): s is AssistantScope => Boolean(s) && isAssistantScope(s));
    // Unknown scope strings are dropped rather than honored — the consent
    // screen shows the person what was actually granted, and the grant row
    // records only scopes we understand.
    const scope = requestedScopes.length > 0 ? requestedScopes.join(" ") : ASSISTANT_SCOPES[0];

    const [row] = await db
      .insert(assistantAuthRequests)
      .values({
        clientRowId: client.id,
        redirectUri,
        state: params.state ?? null,
        scope,
        resource: params.canonicalResource,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: "S256",
        status: "pending",
        expiresAt: nowPlus(ASSISTANT_AUTH_REQUEST_TTL_MS),
      })
      .returning();
    return row!;
  }

  async function getPendingRequest(requestId: string) {
    const row = await db
      .select()
      .from(assistantAuthRequests)
      .where(eq(assistantAuthRequests.id, requestId))
      .then((rows) => rows[0] ?? null);
    if (!row || row.status !== "pending") return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await db
        .update(assistantAuthRequests)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(assistantAuthRequests.id, row.id));
      return null;
    }
    return row;
  }

  /** What the consent screen renders. Companies are the person's live memberships. */
  async function consentView(requestId: string, userId: string) {
    const request = await getPendingRequest(requestId);
    if (!request) return null;
    const [client, memberships] = await Promise.all([
      db
        .select()
        .from(assistantOauthClients)
        .where(eq(assistantOauthClients.id, request.clientRowId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId, name: companies.name })
        .from(companyMemberships)
        .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);
    if (!client) return null;
    return {
      requestId: request.id,
      clientName: client.clientName,
      redirectHost: new URL(request.redirectUri).host,
      requestedScopes: request.scope.split(/\s+/).filter(Boolean),
      resource: request.resource,
      companies: memberships.map((m) => ({ id: m.companyId, name: m.name })),
    };
  }

  function buildRedirect(request: { redirectUri: string; state: string | null }, params: Record<string, string>) {
    const url = new URL(request.redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /**
   * The person approved. Persist (or widen) the grant, mint a single-use
   * code, and hand back the redirect the browser should take. `scopes` are
   * clamped to what the client requested — the UI can only ever narrow.
   */
  async function approveConsent(input: {
    requestId: string;
    userId: string;
    companyId: string;
    scopes: string[];
    issuerBase: string;
  }) {
    const request = await getPendingRequest(input.requestId);
    if (!request) throw new OAuthError("invalid_request", "consent request is no longer pending");

    // The approving user must hold an active membership in the chosen company —
    // a grant is only ever as strong as that membership.
    const membership = await db
      .select({ companyId: companyMemberships.companyId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.userId),
          eq(companyMemberships.companyId, input.companyId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) throw new OAuthError("invalid_request", "not an active member of that company", 403);

    const client = await db
      .select()
      .from(assistantOauthClients)
      .where(eq(assistantOauthClients.id, request.clientRowId))
      .then((rows) => rows[0] ?? null);
    if (!client) throw new OAuthError("invalid_request", "client no longer exists");

    const requested = new Set(request.scope.split(/\s+/).filter(Boolean));
    const scopes = input.scopes.filter((s): s is AssistantScope => isAssistantScope(s) && requested.has(s));
    // An approval with nothing granted must fail, not quietly mint a read
    // grant the consent screen never showed. Deny is the path for "no".
    if (scopes.length === 0) {
      throw new OAuthError("invalid_request", "grant at least one scope or deny the request");
    }

    const redirectHost = new URL(request.redirectUri).host;
    const existingGrant = await db
      .select()
      .from(assistantGrants)
      .where(
        and(
          eq(assistantGrants.userId, input.userId),
          eq(assistantGrants.clientId, client.clientId),
          eq(assistantGrants.companyId, input.companyId),
          isNull(assistantGrants.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);

    const grant = existingGrant
      ? (
          await db
            .update(assistantGrants)
            .set({ scopes, clientName: client.clientName, redirectHost, updatedAt: new Date() })
            .where(eq(assistantGrants.id, existingGrant.id))
            .returning()
        )[0]!
      : (
          await db
            .insert(assistantGrants)
            .values({
              companyId: input.companyId,
              userId: input.userId,
              clientId: client.clientId,
              clientName: client.clientName,
              redirectHost,
              scopes,
            })
            .returning()
        )[0]!;

    const code = opaqueToken(CODE_PREFIX);
    const [approved] = await db
      .update(assistantAuthRequests)
      .set({
        status: "approved",
        userId: input.userId,
        companyId: input.companyId,
        grantId: grant.id,
        codeHash: hashSecret(code),
        updatedAt: new Date(),
      })
      .where(and(eq(assistantAuthRequests.id, request.id), eq(assistantAuthRequests.status, "pending")))
      .returning();
    if (!approved) throw new OAuthError("invalid_request", "consent request is no longer pending");

    // RFC 9207 `iss` — lets the client bind the response to this issuer.
    const redirect = buildRedirect(request, {
      code,
      iss: input.issuerBase,
      ...(request.state ? { state: request.state } : {}),
    });
    return { redirect, grant };
  }

  async function denyConsent(input: { requestId: string }) {
    const request = await getPendingRequest(input.requestId);
    if (!request) throw new OAuthError("invalid_request", "consent request is no longer pending");
    await db
      .update(assistantAuthRequests)
      .set({ status: "denied", updatedAt: new Date() })
      .where(and(eq(assistantAuthRequests.id, request.id), eq(assistantAuthRequests.status, "pending")));
    return {
      redirect: buildRedirect(request, {
        error: "access_denied",
        ...(request.state ? { state: request.state } : {}),
      }),
    };
  }

  async function mintTokenPair(grant: {
    id: string;
    scopes: string[];
    resource: string;
    familyId?: string;
  }) {
    const familyId = grant.familyId ?? randomUUID();
    const accessToken = opaqueToken(ASSISTANT_ACCESS_TOKEN_PREFIX);
    const refreshToken = opaqueToken(ASSISTANT_REFRESH_TOKEN_PREFIX);
    const accessExpires = nowPlus(ASSISTANT_ACCESS_TOKEN_TTL_MS);
    const refreshExpires = nowPlus(ASSISTANT_REFRESH_TOKEN_TTL_MS);
    await db.insert(assistantAccessTokens).values({
      tokenHash: hashSecret(accessToken),
      grantId: grant.id,
      familyId,
      resource: grant.resource,
      scopes: grant.scopes,
      expiresAt: accessExpires,
    });
    await db.insert(assistantRefreshTokens).values({
      tokenHash: hashSecret(refreshToken),
      grantId: grant.id,
      familyId,
      expiresAt: refreshExpires,
    });
    return { accessToken, refreshToken, accessExpires, familyId };
  }

  /**
   * authorization_code exchange. The conditional UPDATE is the replay guard:
   * whichever concurrent exchange flips `approved → consumed` wins; every
   * other attempt, and every re-use of a consumed code, is invalid_grant.
   */
  async function exchangeCode(params: {
    code: string;
    clientId: string;
    redirectUri: string | undefined;
    codeVerifier: string | undefined;
    resource: string | undefined;
  }) {
    const codeHash = hashSecret(params.code);
    const request = await db
      .select()
      .from(assistantAuthRequests)
      .where(eq(assistantAuthRequests.codeHash, codeHash))
      .then((rows) => rows[0] ?? null);
    if (!request || request.status !== "approved") {
      throw new OAuthError("invalid_grant", "authorization code is invalid or already used");
    }
    if (request.expiresAt.getTime() <= Date.now()) {
      throw new OAuthError("invalid_grant", "authorization code has expired");
    }
    const client = await db
      .select()
      .from(assistantOauthClients)
      .where(eq(assistantOauthClients.id, request.clientRowId))
      .then((rows) => rows[0] ?? null);
    if (!client || client.clientId !== params.clientId) {
      throw new OAuthError("invalid_grant", "client_id does not match the authorization request");
    }
    if (params.redirectUri !== undefined && params.redirectUri !== request.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!params.codeVerifier) {
      throw new OAuthError("invalid_grant", "code_verifier is required");
    }
    const expected = createHash("sha256").update(params.codeVerifier).digest("base64url");
    if (expected !== request.codeChallenge) {
      throw new OAuthError("invalid_grant", "code_verifier does not match");
    }
    if (params.resource !== request.resource) {
      throw new OAuthError("invalid_target", "resource must match the authorization request");
    }
    if (!request.grantId) {
      throw new OAuthError("invalid_grant", "authorization request has no grant");
    }
    const [consumed] = await db
      .update(assistantAuthRequests)
      .set({ status: "consumed", updatedAt: new Date() })
      .where(and(eq(assistantAuthRequests.id, request.id), eq(assistantAuthRequests.status, "approved")))
      .returning();
    if (!consumed) {
      throw new OAuthError("invalid_grant", "authorization code is invalid or already used");
    }
    const grant = await db
      .select()
      .from(assistantGrants)
      .where(eq(assistantGrants.id, request.grantId))
      .then((rows) => rows[0] ?? null);
    if (!grant || grant.revokedAt) {
      throw new OAuthError("invalid_grant", "grant has been revoked");
    }
    const pair = await mintTokenPair({
      id: grant.id,
      scopes: grant.scopes,
      resource: request.resource,
    });
    return {
      access_token: pair.accessToken,
      token_type: "Bearer" as const,
      expires_in: Math.floor(ASSISTANT_ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: pair.refreshToken,
      scope: grant.scopes.join(" "),
    };
  }

  async function revokeFamily(familyId: string) {
    const now = new Date();
    await Promise.all([
      db
        .update(assistantRefreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(assistantRefreshTokens.familyId, familyId), isNull(assistantRefreshTokens.revokedAt))),
      db
        .update(assistantAccessTokens)
        .set({ revokedAt: now })
        .where(and(eq(assistantAccessTokens.familyId, familyId), isNull(assistantAccessTokens.revokedAt))),
    ]);
  }

  /**
   * Refresh-token rotation. The conditional UPDATE again serializes the flip:
   * only the first presentation of a live token rotates it. A second
   * presentation of a rotated (or revoked) token is reuse — the whole family,
   * including live access tokens, is revoked on the spot.
   */
  async function refreshAccessToken(params: {
    refreshToken: string;
    clientId: string;
    canonicalResource: string;
  }) {
    const row = await db
      .select()
      .from(assistantRefreshTokens)
      .where(eq(assistantRefreshTokens.tokenHash, hashSecret(params.refreshToken)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw new OAuthError("invalid_grant", "refresh token is invalid");
    const grant = await db
      .select()
      .from(assistantGrants)
      .where(eq(assistantGrants.id, row.grantId))
      .then((rows) => rows[0] ?? null);
    if (!grant) throw new OAuthError("invalid_grant", "refresh token is invalid");
    if (grant.clientId !== params.clientId) {
      throw new OAuthError("invalid_grant", "client_id does not match the refresh token");
    }
    if (grant.revokedAt || row.expiresAt.getTime() <= Date.now()) {
      throw new OAuthError("invalid_grant", "refresh token is invalid");
    }
    const [rotated] = await db
      .update(assistantRefreshTokens)
      .set({ rotatedAt: new Date() })
      .where(
        and(
          eq(assistantRefreshTokens.id, row.id),
          isNull(assistantRefreshTokens.rotatedAt),
          isNull(assistantRefreshTokens.revokedAt),
        ),
      )
      .returning();
    if (!rotated) {
      // Reuse: somebody presented a token that was already spent or revoked.
      // The family is compromised — kill every token minted in it.
      await revokeFamily(row.familyId);
      throw new OAuthError("invalid_grant", "refresh token reuse detected — the token family has been revoked");
    }
    const pair = await mintTokenPair({
      id: grant.id,
      scopes: grant.scopes,
      resource: params.canonicalResource,
      familyId: row.familyId,
    });
    return {
      access_token: pair.accessToken,
      token_type: "Bearer" as const,
      expires_in: Math.floor(ASSISTANT_ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: pair.refreshToken,
      scope: grant.scopes.join(" "),
    };
  }

  /** RFC 7009 revocation — immediate, and a refresh revocation takes its family. */
  async function revokeToken(token: string) {
    const hash = hashSecret(token);
    const refresh = await db
      .select()
      .from(assistantRefreshTokens)
      .where(eq(assistantRefreshTokens.tokenHash, hash))
      .then((rows) => rows[0] ?? null);
    if (refresh) {
      await revokeFamily(refresh.familyId);
      return;
    }
    await db
      .update(assistantAccessTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(assistantAccessTokens.tokenHash, hash), isNull(assistantAccessTokens.revokedAt)));
  }

  /**
   * Resolve a `pcpa_…` bearer into actor fields for the middleware. Returns
   * null for anything unusable — expired, revoked, orphaned, or bound to a
   * user who no longer holds an active membership in the grant's company.
   * That last check is what makes "the person left the company" revoke
   * effectively without a token sweep.
   */
  async function resolveAccessToken(token: string, expectedResource?: string) {
    const hash = hashSecret(token);
    const row = await db
      .select()
      .from(assistantAccessTokens)
      .where(eq(assistantAccessTokens.tokenHash, hash))
      .then((rows) => rows[0] ?? null);
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
    // RFC 8707: a token minted for a different audience is invalid here —
    // indistinguishable from an unknown token, on purpose.
    if (expectedResource !== undefined && row.resource !== expectedResource) return null;
    const grant = await db
      .select()
      .from(assistantGrants)
      .where(eq(assistantGrants.id, row.grantId))
      .then((rows) => rows[0] ?? null);
    if (!grant || grant.revokedAt) return null;
    const membership = await db
      .select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, grant.userId),
          eq(companyMemberships.companyId, grant.companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership || membership.status !== "active") return null;

    // Touch bookkeeping without blocking the request path.
    const now = new Date();
    void Promise.all([
      db.update(assistantAccessTokens).set({ lastUsedAt: now }).where(eq(assistantAccessTokens.id, row.id)),
      db.update(assistantGrants).set({ lastUsedAt: now }).where(eq(assistantGrants.id, grant.id)),
    ]).catch(() => {});

    return {
      userId: grant.userId,
      companyId: grant.companyId,
      grantId: grant.id,
      scopes: row.scopes,
      membershipRole: membership.membershipRole,
    };
  }

  /** Connections card: the person's live grants in one company. */
  async function listGrantsForUser(companyId: string, userId: string) {
    return db
      .select()
      .from(assistantGrants)
      .where(
        and(
          eq(assistantGrants.companyId, companyId),
          eq(assistantGrants.userId, userId),
          isNull(assistantGrants.revokedAt),
        ),
      )
      .orderBy(sql`${assistantGrants.createdAt} desc`);
  }

  /** Connections card: revoke — kills the grant and every token under it. */
  async function revokeGrant(grantId: string, userId: string, companyId: string) {
    const grant = await db
      .select()
      .from(assistantGrants)
      .where(
        and(
          eq(assistantGrants.id, grantId),
          eq(assistantGrants.userId, userId),
          eq(assistantGrants.companyId, companyId),
          isNull(assistantGrants.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!grant) return null;
    const now = new Date();
    await Promise.all([
      db
        .update(assistantGrants)
        .set({ revokedAt: now, revokedByUserId: userId, updatedAt: now })
        .where(eq(assistantGrants.id, grant.id)),
      db
        .update(assistantAccessTokens)
        .set({ revokedAt: now })
        .where(and(eq(assistantAccessTokens.grantId, grant.id), isNull(assistantAccessTokens.revokedAt))),
      db
        .update(assistantRefreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(assistantRefreshTokens.grantId, grant.id), isNull(assistantRefreshTokens.revokedAt))),
    ]);
    return grant;
  }

  return {
    registerClient,
    resolveClient,
    beginAuthorize,
    consentView,
    approveConsent,
    denyConsent,
    exchangeCode,
    refreshAccessToken,
    revokeToken,
    resolveAccessToken,
    listGrantsForUser,
    revokeGrant,
    findClientRow,
  };
}

export type AssistantOAuthService = ReturnType<typeof assistantOAuthService>;
