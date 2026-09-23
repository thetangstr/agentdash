// muse-mcp-stub — throwaway public MCP server for the Meta Muse registration
// spike (GH #674). Holds NO AgentDash data or secrets. Purpose: stand on a
// public HTTPS URL and record exactly what a real client (Muse, Grok,
// Claude.ai, MCP Inspector) sends, so the findings doc is evidence, not
// recollection.
//
// Implements, per MCP spec revision 2025-11-25 "authorization":
//   - Streamable HTTP at POST /mcp (stateless; GET/DELETE pass through)
//   - Protected Resource Metadata (RFC 9728) at
//     /.well-known/oauth-protected-resource/mcp
//   - 401 + WWW-Authenticate with the resource_metadata parameter
//   - Authorization Server metadata (RFC 8414) at
//     /.well-known/oauth-authorization-server
//   - PKCE (S256 only), the `resource` parameter (RFC 8707)
//   - Dynamic Client Registration (RFC 7591) at POST /register
//   - CIMD: an https:// client_id is fetched as a Client ID Metadata
//     Document and its declared redirect_uris are honoured
//   - A trivial consent page (GET/POST /authorize)
//   - Optional static-bearer mode: STUB_STATIC_BEARER=<token> accepts that
//     one token on /mcp, for clients that can only send a fixed header
//
// Run:  npm install && node server.mjs
// Env:  PORT (default 8741), PUBLIC_BASE_URL (default http://localhost:PORT),
//       LOG_FILE (default ./requests.log), STUB_STATIC_BEARER (optional)

import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 8741);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const LOG_FILE = process.env.LOG_FILE ?? new URL("./requests.log", import.meta.url).pathname;
const STATIC_BEARER = (process.env.STUB_STATIC_BEARER ?? "").trim() || null;
const MCP_RESOURCE = `${PUBLIC_BASE_URL}/mcp`;
const SCOPES_SUPPORTED = ["mcp:read", "mcp:write"];
const TOKEN_TTL_SEC = 3600;
const CODE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-memory state (throwaway — process restart wipes it, which is fine for a
// spike; the client re-registers and re-consents).
// ---------------------------------------------------------------------------
/** DCR-registered clients: client_id -> { client_name, redirect_uris, client_uri? } */
const dcrClients = new Map();
/** CIMD documents fetched from client_id URLs: url -> fetched doc */
const cimdDocuments = new Map();
/** Pending auth codes: code -> { clientId, redirectUri, codeChallenge, scope, resource, subject, expiresAt } */
const authCodes = new Map();
/** Issued access tokens: token -> { subject, clientId, scope, resource, expiresAt } */
const accessTokens = new Map();

// ---------------------------------------------------------------------------
// Request logging — the whole point of the stub.
// ---------------------------------------------------------------------------
const REDACTED_HEADERS = new Set(["authorization", "cookie", "x-api-key", "proxy-authorization"]);
const REDACTED_BODY_KEYS = new Set(["code_verifier", "client_secret", "access_token", "refresh_token", "assertion"]);

function logRequest(req, parsedBody, extra = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? "<redacted>" : v;
  }
  let body = parsedBody;
  if (body && typeof body === "object") {
    body = { ...body };
    for (const k of Object.keys(body)) {
      if (REDACTED_BODY_KEYS.has(k)) body[k] = "<redacted>";
    }
  }
  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    url: req.url,
    remote: req.socket.remoteAddress,
    headers,
    body: body === undefined ? null : body,
    ...extra,
  };
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Logging must never take the stub down.
  }
}

function logEvent(event) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), event }) + "\n");
  } catch {}
}

// ---------------------------------------------------------------------------
// Small HTTP helpers (no framework on purpose — one file, no secrets).
// ---------------------------------------------------------------------------
function sendJson(res, status, obj, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders });
  res.end(buf);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function redirect(res, url) {
  res.writeHead(302, { location: url, "cache-control": "no-store" });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params) {
      if (obj[k] === undefined) obj[k] = v;
      else if (Array.isArray(obj[k])) obj[k].push(v);
      else obj[k] = [obj[k], v];
    }
    return obj;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw.slice(0, 4096) };
  }
}

// ---------------------------------------------------------------------------
// Client resolution — DCR map first, then CIMD fetch for https:// client_ids.
// ---------------------------------------------------------------------------
async function fetchCimdDocument(clientId) {
  if (cimdDocuments.has(clientId)) return cimdDocuments.get(clientId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(clientId, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`CIMD fetch HTTP ${res.status}`);
    const doc = await res.json();
    const parsed = {
      client_name: typeof doc.client_name === "string" ? doc.client_name : clientId,
      redirect_uris: Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [],
      logo_uri: typeof doc.logo_uri === "string" ? doc.logo_uri : null,
    };
    cimdDocuments.set(clientId, parsed);
    logEvent({ kind: "cimd_fetch", clientId, doc: parsed });
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns { client_name, redirect_uris, via: "dcr" | "cimd" } or throws. */
async function resolveClient(clientId) {
  if (dcrClients.has(clientId)) {
    return { ...dcrClients.get(clientId), via: "dcr" };
  }
  if (/^https:\/\/./.test(clientId)) {
    const doc = await fetchCimdDocument(clientId);
    return { ...doc, via: "cimd" };
  }
  throw new Error(`unknown client_id: ${clientId}`);
}

// ---------------------------------------------------------------------------
// OAuth endpoints
// ---------------------------------------------------------------------------
function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [PUBLIC_BASE_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES_SUPPORTED,
    resource_documentation: `${PUBLIC_BASE_URL}/`,
  };
}

function authorizationServerMetadata() {
  return {
    issuer: PUBLIC_BASE_URL,
    authorization_endpoint: `${PUBLIC_BASE_URL}/authorize`,
    token_endpoint: `${PUBLIC_BASE_URL}/token`,
    registration_endpoint: `${PUBLIC_BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: SCOPES_SUPPORTED,
    // RFC 8707 — we accept and record `resource` on /authorize and /token.
    resource_parameter_supported: true,
    // MCP 2025-11-25: clients MAY register by hosting a Client ID Metadata
    // Document and using its URL as client_id — supported, see resolveClient.
    client_id_metadata_document_supported: true,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function consentPage({ clientName, clientId, redirectUri, scope, state, codeChallenge, codeChallengeMethod, resource }) {
  return `<!doctype html>
<html><head><title>muse-mcp-stub — authorize</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}
.card{border:1px solid #ccc;border-radius:8px;padding:1.25rem 1.5rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem .75rem}dt{font-weight:600}
button{font-size:1rem;padding:.5rem 1.25rem;margin-right:.5rem;cursor:pointer}
.allow{background:#0a7f3f;color:#fff;border:0;border-radius:6px}
.deny{background:#fff;border:1px solid #999;border-radius:6px}
code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px;word-break:break-all}</style></head>
<body><h1>muse-mcp-stub</h1>
<div class="card">
<p><strong>${escapeHtml(clientName)}</strong> is asking to connect to this MCP server.</p>
<dl>
<dt>client_id</dt><dd><code>${escapeHtml(clientId)}</code></dd>
<dt>redirect_uri</dt><dd><code>${escapeHtml(redirectUri)}</code></dd>
<dt>scope</dt><dd><code>${escapeHtml(scope ?? "(none requested)")}</code></dd>
<dt>resource</dt><dd><code>${escapeHtml(resource ?? "(none)")}</code></dd>
</dl>
<form method="POST" action="/authorize">
<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="scope" value="${escapeHtml(scope ?? "")}">
<input type="hidden" name="state" value="${escapeHtml(state ?? "")}">
<input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
<input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod ?? "")}">
<input type="hidden" name="resource" value="${escapeHtml(resource ?? "")}">
<p>This is a throwaway test server. Approving mints an authorization code and redirects back to the client.</p>
<button class="allow" name="decision" value="approve" type="submit">Approve</button>
<button class="deny" name="decision" value="deny" type="submit">Deny</button>
</form></div></body></html>`;
}

function oauthErrorRedirect(res, redirectUri, state, error, description) {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  redirect(res, u.toString());
}

async function handleAuthorizeGet(req, res, query, body) {
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  const state = query.get("state") ?? "";
  const responseType = query.get("response_type");
  const codeChallenge = query.get("code_challenge") ?? "";
  const codeChallengeMethod = query.get("code_challenge_method") ?? "";
  const scope = query.get("scope") ?? "";
  const resource = query.get("resource") ?? "";

  if (responseType !== "code") {
    return sendJson(res, 400, { error: "unsupported_response_type", error_description: "only response_type=code" });
  }
  if (!clientId || !redirectUri) {
    return sendJson(res, 400, { error: "invalid_request", error_description: "client_id and redirect_uri required" });
  }

  let client;
  try {
    client = await resolveClient(clientId);
  } catch (err) {
    logEvent({ kind: "authorize_client_rejected", clientId, error: String(err) });
    return sendJson(res, 400, { error: "invalid_client", error_description: String(err) });
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    // Do NOT redirect errors to an unverified URI — render the error instead.
    logEvent({ kind: "authorize_redirect_mismatch", clientId, redirectUri, registered: client.redirect_uris });
    return sendJson(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri not registered for this client",
      registered_redirect_uris: client.redirect_uris,
    });
  }
  if (codeChallengeMethod && codeChallengeMethod !== "S256") {
    return oauthErrorRedirect(res, redirectUri, state, "invalid_request", "only S256 code_challenge_method supported");
  }
  if (!codeChallenge) {
    return oauthErrorRedirect(res, redirectUri, state, "invalid_request", "code_challenge required (PKCE S256)");
  }

  sendHtml(res, 200, consentPage({
    clientName: client.client_name,
    clientId, redirectUri, scope, state, codeChallenge, codeChallengeMethod, resource,
  }));
}

async function handleAuthorizePost(req, res, body) {
  const { client_id: clientId, redirect_uri: redirectUri, scope = "", state = "",
    code_challenge: codeChallenge = "", resource = "", decision } = body ?? {};

  // The form fields are attacker-controlled — re-validate the redirect target
  // before issuing a code, same as the GET did.
  let client;
  try {
    client = await resolveClient(clientId);
  } catch (err) {
    return sendJson(res, 400, { error: "invalid_client", error_description: String(err) });
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return sendJson(res, 400, { error: "invalid_request", error_description: "redirect_uri not registered for this client" });
  }

  if (decision !== "approve") {
    return oauthErrorRedirect(res, redirectUri, state, "access_denied", "user denied the request");
  }
  const code = randomBytes(24).toString("base64url");
  authCodes.set(code, {
    clientId, redirectUri, codeChallenge,
    scope: scope || SCOPES_SUPPORTED.join(" "),
    resource: resource || null,
    subject: `stub-user@${new URL(PUBLIC_BASE_URL).host}`,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  logEvent({ kind: "authorize_approved", clientId, redirectUri, scope, resource });
  redirect(res, u.toString());
}

function handleRegister(req, res, body) {
  // RFC 7591 Dynamic Client Registration — public clients only.
  const clientId = `dcr_${randomBytes(12).toString("base64url")}`;
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
  const record = {
    client_name: typeof body?.client_name === "string" ? body.client_name : clientId,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: body?.token_endpoint_auth_method ?? "none",
  };
  dcrClients.set(clientId, record);
  logEvent({ kind: "dcr_register", clientId, record });
  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: record.client_name,
    redirect_uris: redirectUris,
    grant_types: record.grant_types,
    token_endpoint_auth_method: record.token_endpoint_auth_method,
  });
}

function s256(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function issueToken({ subject, clientId, scope, resource }) {
  const token = `stub_at_${randomBytes(24).toString("base64url")}`;
  accessTokens.set(token, {
    subject, clientId, scope,
    resource: resource || null,
    expiresAt: Date.now() + TOKEN_TTL_SEC * 1000,
  });
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SEC,
    scope,
    ...(resource ? { resource } : {}),
  };
}

function handleToken(req, res, body) {
  const grantType = body?.grant_type;
  if (grantType === "refresh_token") {
    // We do not issue refresh tokens; answer honestly rather than 500.
    return sendJson(res, 400, { error: "invalid_grant", error_description: "refresh tokens are not issued by this stub" });
  }
  if (grantType !== "authorization_code") {
    return sendJson(res, 400, { error: "unsupported_grant_type" });
  }
  const code = authCodes.get(body?.code);
  if (!code) return sendJson(res, 400, { error: "invalid_grant", error_description: "unknown code" });
  authCodes.delete(body.code); // single use
  if (code.expiresAt < Date.now()) {
    return sendJson(res, 400, { error: "invalid_grant", error_description: "code expired" });
  }
  if (body?.client_id !== code.clientId) {
    return sendJson(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
  }
  if (body?.redirect_uri !== code.redirectUri) {
    return sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
  }
  if (!body?.code_verifier || s256(body.code_verifier) !== code.codeChallenge) {
    return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
  }
  // RFC 8707: a client that sends `resource` gets a token bound to it. We only
  // serve this one resource; record whatever was asked for in the log.
  const resource = body?.resource ?? code.resource;
  logEvent({ kind: "token_issued", clientId: code.clientId, scope: code.scope, resource, codeResource: code.resource });
  sendJson(res, 200, issueToken({ subject: code.subject, clientId: code.clientId, scope: code.scope, resource }));
}

// ---------------------------------------------------------------------------
// MCP endpoint — stateless Streamable HTTP. whoami reports the bearer subject
// so the findings doc can prove which auth path the client used.
// ---------------------------------------------------------------------------
function authenticate(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (STATIC_BEARER && token === STATIC_BEARER) {
    return { subject: "static-bearer", clientId: "static", scope: "static", resource: MCP_RESOURCE, via: "static_bearer" };
  }
  const record = accessTokens.get(token);
  if (!record || record.expiresAt < Date.now()) return null;
  return { ...record, via: "oauth" };
}

function wwwAuthenticateHeader() {
  const metadataUrl = `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer realm="muse-mcp-stub", resource_metadata="${metadataUrl}"`;
}

function buildMcpServer(authInfo) {
  const server = new McpServer({ name: "muse-mcp-stub", version: "0.1.0" });
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes the input text back. Connectivity check for the Muse MCP spike.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Returns the authenticated subject, client registration path, scopes, and resource the token was issued for.",
      inputSchema: {},
    },
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          subject: authInfo.subject,
          client_id: authInfo.clientId,
          scope: authInfo.scope,
          resource: authInfo.resource,
          auth_via: authInfo.via,
          server: PUBLIC_BASE_URL,
        }, null, 2),
      }],
    }),
  );
  return server;
}

async function handleMcp(req, res, parsedBody) {
  const auth = authenticate(req);
  if (!auth) {
    return sendJson(res, 401, { error: "invalid_token", error_description: "missing or invalid bearer token" }, {
      "www-authenticate": wwwAuthenticateHeader(),
    });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer(auth);
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", PUBLIC_BASE_URL);
  const parsedBody = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
  logRequest(req, parsedBody);

  try {
    if (url.pathname === "/mcp") return await handleMcp(req, res, parsedBody);
    if (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return sendJson(res, 200, protectedResourceMetadata());
    }
    if (url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/mcp") {
      return sendJson(res, 200, authorizationServerMetadata());
    }
    if (url.pathname === "/register" && req.method === "POST") return handleRegister(req, res, parsedBody);
    if (url.pathname === "/authorize" && req.method === "GET") return await handleAuthorizeGet(req, res, url.searchParams);
    if (url.pathname === "/authorize" && req.method === "POST") return await handleAuthorizePost(req, res, parsedBody);
    if (url.pathname === "/token" && req.method === "POST") return handleToken(req, res, parsedBody);
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/") {
      return sendJson(res, 200, {
        name: "muse-mcp-stub",
        purpose: "GH #674 — throwaway MCP server for the Meta Muse registration spike. No AgentDash data.",
        mcp_endpoint: MCP_RESOURCE,
        oauth: {
          protected_resource_metadata: `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp`,
          authorization_server_metadata: `${PUBLIC_BASE_URL}/.well-known/oauth-authorization-server`,
          registration_endpoint: `${PUBLIC_BASE_URL}/register`,
          authorization_endpoint: `${PUBLIC_BASE_URL}/authorize`,
          token_endpoint: `${PUBLIC_BASE_URL}/token`,
          cimd_supported: true,
          dcr_supported: true,
          static_bearer_enabled: Boolean(STATIC_BEARER),
        },
        log_file: LOG_FILE,
      });
    }
    sendJson(res, 404, { error: "not_found", path: url.pathname });
  } catch (err) {
    logEvent({ kind: "handler_error", path: url.pathname, error: String(err) });
    if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    else res.end();
  }
});

httpServer.listen(PORT, () => {
  console.log(`muse-mcp-stub listening on :${PORT}`);
  console.log(`  PUBLIC_BASE_URL = ${PUBLIC_BASE_URL}`);
  console.log(`  MCP endpoint    = ${MCP_RESOURCE}`);
  console.log(`  request log     = ${LOG_FILE}`);
  console.log(`  static bearer   = ${STATIC_BEARER ? "enabled" : "disabled"}`);
  logEvent({ kind: "startup", publicBaseUrl: PUBLIC_BASE_URL, staticBearer: Boolean(STATIC_BEARER) });
});
