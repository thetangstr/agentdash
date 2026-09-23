# muse-mcp-stub

Throwaway public MCP server for the **Meta Muse registration spike** (GH #674,
spec §6.6). It holds **no AgentDash data or secrets** — its only job is to
stand on a public HTTPS URL and record exactly what a real client (Meta Muse,
Grok, Claude.ai, MCP Inspector) sends, so the findings doc is evidence rather
than recollection.

## What it implements

MCP spec revision **2025-11-25**, "authorization":

- Streamable HTTP MCP endpoint at `POST /mcp` (stateless; `GET`/`DELETE`
  pass through to the transport)
- Tools: `echo` (connectivity check) and `whoami` (reports the authenticated
  subject, client registration path, scopes, and `resource` the token was
  issued for — so the findings doc proves which auth path the client used)
- `401` + `WWW-Authenticate: Bearer resource_metadata="…"` on `/mcp`
- Protected Resource Metadata (RFC 9728):
  `GET /.well-known/oauth-protected-resource/mcp`
- Authorization Server metadata (RFC 8414):
  `GET /.well-known/oauth-authorization-server` (and the `/mcp`-suffixed
  variant), advertising `code_challenge_methods_supported: ["S256"]`
- Dynamic Client Registration (RFC 7591): `POST /register`
- **CIMD**: an `https://` `client_id` is fetched as a Client ID Metadata
  Document and its declared `redirect_uris` are honoured
- PKCE (S256 only), the `resource` parameter (RFC 8707) on `/authorize`
  and `/token`
- A trivial consent page (`GET`/`POST /authorize`) — one screen, approve/deny
- Optional **static-bearer fallback**: set `STUB_STATIC_BEARER` and that one
  token is accepted on `/mcp` (for clients that can only send a fixed header)

Every inbound request (method, path, headers **minus secrets**, body) is
appended as JSONL to `requests.log`. OAuth lifecycle events (CIMD fetches,
registrations, approvals, token issues) are logged as events too.

## Run it

```sh
cd tools/spikes/muse-mcp-stub
npm install
node server.mjs            # listens on :8741
```

Environment:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8741` | Listen port |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Advertised issuer/base URL — **must be the public https URL when deployed** |
| `LOG_FILE` | `./requests.log` | JSONL request log |
| `STUB_STATIC_BEARER` | unset | If set, this token is accepted on `/mcp` without OAuth |

## Expose it publicly

The OAuth metadata, consent page, and redirect URIs all derive from
`PUBLIC_BASE_URL`, so set it to the public URL whatever the exposure path.

**Zero-account option (cloudflared quick tunnel):**

```sh
PUBLIC_BASE_URL=http://localhost:8741 node server.mjs &
cloudflared tunnel --url http://localhost:8741
# prints https://<random>.trycloudflare.com — restart the server with:
PUBLIC_BASE_URL=https://<random>.trycloudflare.com node server.mjs
```

**Stable-URL options:** deploy `server.mjs` + `package.json` to any Node
host you control (Render, Railway, Fly.io, a VM + Caddy/nginx). It has no
persistence and no secrets — any throwaway host works.

## Verify

```sh
node --test server.test.mjs        # 7 tests: full DCR→consent→PKCE→MCP flow
node server.mjs                    # starts locally
npx @modelcontextprotocol/inspector   # connect, complete OAuth, list & call tools
curl -si https://<stub-host>/mcp -X POST   # expect 401 with WWW-Authenticate resource_metadata
curl -s https://<stub-host>/.well-known/oauth-protected-resource/mcp
curl -s https://<stub-host>/.well-known/oauth-authorization-server
```

## Safety notes

- In-memory state only; a restart wipes registrations, codes, and tokens —
  the client just re-registers and re-consents.
- `authorization`, `cookie`, `x-api-key` headers and `code_verifier`,
  `client_secret`, token body fields are redacted in `requests.log`.
- Do not put any real credential in this process. It exists to be probed by
  strangers' clients on the open internet; treat everything it receives as
  public.
