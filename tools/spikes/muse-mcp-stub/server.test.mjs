// Self-test for muse-mcp-stub: drives the full OAuth + MCP flow against a
// locally spawned server on an ephemeral port. Run: node --test server.test.mjs
//
// Covers the exact behaviours the spike needs to record for real clients:
//   - /mcp without a token -> 401 + WWW-Authenticate resource_metadata
//   - Protected Resource Metadata + Authorization Server metadata docs
//   - DCR (/register) -> authorize (consent GET + approve POST) -> /token
//     with PKCE S256 -> authenticated MCP initialize/tools-list/tools-call
//   - whoami reports the OAuth subject
//   - static-bearer fallback mode
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 18741 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const STATIC_TOKEN = "test-static-bearer-token";
const logFile = path.join(mkdtempSync(path.join(tmpdir(), "muse-stub-")), "requests.log");

let child;
let accessToken;
let dcrClientId;
const REDIRECT_URI = "http://127.0.0.1:9999/oauth/callback";
const CODE_VERIFIER = randomBytes(48).toString("base64url");
const CODE_CHALLENGE = createHash("sha256").update(CODE_VERIFIER).digest("base64url");

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("stub did not start");
}

before(async () => {
  child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE,
      LOG_FILE: logFile,
      STUB_STATIC_BEARER: STATIC_TOKEN,
    },
    stdio: "inherit",
  });
  await waitForServer();
});

after(() => child?.kill("SIGTERM"));

test("unauthenticated /mcp returns 401 with WWW-Authenticate resource_metadata", async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(res.status, 401);
  const www = res.headers.get("www-authenticate");
  assert.ok(www?.includes("resource_metadata="), `WWW-Authenticate: ${www}`);
  assert.ok(www.includes("/.well-known/oauth-protected-resource/mcp"));
});

test("PRM and AS metadata docs are served", async () => {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  assert.deepEqual(prm.authorization_servers, [BASE]);

  const asMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asMeta.issuer, BASE);
  assert.deepEqual(asMeta.code_challenge_methods_supported, ["S256"]);
  assert.equal(asMeta.registration_endpoint, `${BASE}/register`);
  assert.equal(asMeta.client_id_metadata_document_supported, true);
});

test("DCR registers a public client", async () => {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "stub-test-client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.client_id.startsWith("dcr_"));
  assert.deepEqual(body.redirect_uris, [REDIRECT_URI]);
  dcrClientId = body.client_id;
});

test("authorize GET renders consent; approve POST redirects with a code; token verifies PKCE", async () => {
  const authorizeUrl = new URL(`${BASE}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", dcrClientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", CODE_CHALLENGE);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "mcp:read mcp:write");
  authorizeUrl.searchParams.set("state", "state-123");
  authorizeUrl.searchParams.set("resource", `${BASE}/mcp`);

  const consent = await fetch(authorizeUrl);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.ok(html.includes("stub-test-client"));

  const form = new URLSearchParams({
    client_id: dcrClientId,
    redirect_uri: REDIRECT_URI,
    scope: "mcp:read mcp:write",
    state: "state-123",
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
    decision: "approve",
  });
  const approve = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
  assert.equal(approve.status, 302);
  const location = new URL(approve.headers.get("location"));
  assert.equal(location.origin + location.pathname, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), "state-123");
  const code = location.searchParams.get("code");
  assert.ok(code);

  const badToken = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: dcrClientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: "wrong-verifier",
      resource: `${BASE}/mcp`,
    }),
  });
  assert.equal(badToken.status, 400);

  // Re-run authorize for a fresh code (the bad attempt consumed the first).
  const approve2 = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
  const code2 = new URL(approve2.headers.get("location")).searchParams.get("code");

  const token = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code2,
      client_id: dcrClientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: CODE_VERIFIER,
      resource: `${BASE}/mcp`,
    }),
  });
  assert.equal(token.status, 200);
  const tokenBody = await token.json();
  assert.equal(tokenBody.token_type, "Bearer");
  assert.ok(tokenBody.access_token.startsWith("stub_at_"));
  accessToken = tokenBody.access_token;
});

async function mcpCall(method, params, id = 1, token = accessToken) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    return { status: res.status, body: JSON.parse(dataLine.slice(5)) };
  }
  return { status: res.status, body: await res.json() };
}

test("OAuth token drives initialize + tools/list + tools/call; whoami reports the subject", async () => {
  const init = await mcpCall("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "stub-test", version: "0" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "muse-mcp-stub");

  const list = await mcpCall("tools/list", {}, 2);
  const toolNames = list.body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, ["echo", "whoami"]);

  const echo = await mcpCall("tools/call", { name: "echo", arguments: { text: "hello muse" } }, 3);
  assert.equal(echo.body.result.content[0].text, "hello muse");

  const who = await mcpCall("tools/call", { name: "whoami", arguments: {} }, 4);
  const whoData = JSON.parse(who.body.result.content[0].text);
  assert.equal(whoData.auth_via, "oauth");
  assert.equal(whoData.client_id, dcrClientId);
  assert.equal(whoData.resource, `${BASE}/mcp`);
});

test("static bearer mode answers whoami as the static subject", async () => {
  const who = await mcpCall("tools/call", { name: "whoami", arguments: {} }, 5, STATIC_TOKEN);
  const whoData = JSON.parse(who.body.result.content[0].text);
  assert.equal(whoData.auth_via, "static_bearer");
});

test("request log captured the traffic with secrets redacted", async () => {
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
  const paths = lines.map((l) => l.url).filter(Boolean);
  assert.ok(paths.some((p) => p.startsWith("/register")));
  assert.ok(paths.some((p) => p.startsWith("/authorize")));
  assert.ok(paths.some((p) => p.startsWith("/token")));
  assert.ok(paths.some((p) => p.startsWith("/mcp")));
  // Secrets are redacted in the log.
  const raw = readFileSync(logFile, "utf8");
  assert.ok(!raw.includes(CODE_VERIFIER));
  assert.ok(raw.includes("<redacted>"));
});
