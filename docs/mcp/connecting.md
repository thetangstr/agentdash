---
title: Connecting
summary: stdio, streamable HTTP with an agent key, and OAuth 2.1 for assistants — and what agentdash-connect writes.
---

There are three ways in. The credential you hold decides which one applies.

| Transport | Where | Credential | Toolset |
|---|---|---|---|
| Streamable HTTP | `POST /api/mcp` on the instance | an agent key, as `Authorization: Bearer` | `agent` |
| Streamable HTTP | `POST /api/mcp/assistant` on the instance | an OAuth access token (`pcpa_…`) | `assistant`, filtered by the grant's scopes |
| stdio | the `agentdash-mcp` binary, run locally | any; see [Toolsets](/mcp/toolsets) | chosen by `AGENTDASH_TOOLSET` and the key |

Sources: `server/src/routes/mcp.ts` (both HTTP endpoints), `server/src/routes/oauth.ts` (OAuth), `packages/mcp-server/src/index.ts` and `src/config.ts` (stdio).

## Streamable HTTP with an agent key

`POST https://your-instance/api/mcp` with `Authorization: Bearer <agent key>`. The key is the whole configuration: the auth middleware resolves it to its agent and company, and the server is started with that agent and company, so the harness is greeted with the agent's own playbook (`STEWARD_PLAYBOOK`; see [Playbooks](/mcp/playbooks)). Source: `server/src/routes/mcp.ts`.

- A bearer that does not resolve to an agent is answered `401` with a message asking for an agent key.
- The endpoint is stateless (`sessionIdGenerator: undefined`): every POST gets its own server, there is no session id, and `GET` and `DELETE` answer `405`.
- Responses are JSON (`enableJsonResponse: true`), not an event stream.
- Tool calls loop back to the same instance over `127.0.0.1` with the caller's own bearer. Each call carries exactly the key's authority, and the audit trail records the agent.
- The toolset is always `agent`. `AGENTDASH_TOOLSET` does not apply here.

## What `npx agentdash-connect` writes

`npx -y agentdash-connect@latest --url https://your-instance <code>` redeems a connect code for an agent key and writes each installed harness's native MCP config, pointing at `POST /api/mcp` (`mcpEndpointFor` in `packages/connect/src/harnesses.mjs`). The server name defaults to `agentdash` (`DEFAULT_SERVER_NAME` in `packages/connect/src/index.mjs`); `--name` changes it. The full command reference is on the [agentdash-connect](/cli/agentdash-connect) page.

**Claude Code**, `~/.claude.json` (`upsertClaudeConfig`):

```json
{
  "mcpServers": {
    "agentdash": {
      "type": "http",
      "url": "https://your-instance/api/mcp",
      "headers": { "Authorization": "Bearer <agent key>" }
    }
  }
}
```

Claude Code stores the key in this file in plaintext; connect sets the file mode to 600 (`packages/connect/README.md`, "Where the key goes").

**Codex**, `~/.codex/config.toml` (`upsertCodexToml`):

```toml
[mcp_servers.agentdash]
url = "https://your-instance/api/mcp"
bearer_token_env_var = "AGENTDASH_KEY_AGENTDASH"
```

The file names an environment variable and never holds the key. The variable name is `AGENTDASH_KEY_` plus the server name in upper case (`envVarNameFor`); connect stores the key in the OS keychain and adds one shell-profile line that reads it back.

**The inbox entry.** When the instance supports it, connect also writes a second Claude Code entry, `<name>-inbox` (`inboxServerNameFor`), that runs the person's own inbox tools over stdio (`inboxMcpLaunch`, `upsertClaudeStdioServer`):

```json
{
  "mcpServers": {
    "agentdash-inbox": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agentdash-connect@latest", "mcp", "--server", "https://your-instance"],
      "env": {}
    }
  }
}
```

On Windows the command is `cmd` with `/c npx …`, because `npx` is a `.cmd` shim Claude Code cannot spawn directly. This entry holds no secret: it reads the inbox credential from `~/.agentdash/bridge-token` on every call (`packages/connect/README.md`). Its tools are defined in `packages/connect/src/inbox-mcp.mjs`, not in the MCP server, and are not part of the generated reference.

Connect writes the files directly instead of running `claude mcp add` or `codex mcp add`, because those take the token as a command-line argument, which puts it in `ps` output and shell history (`packages/connect/src/harnesses.mjs`).

## Streamable HTTP for assistants (OAuth 2.1)

`POST https://your-instance/api/mcp/assistant` with `Authorization: Bearer <access token>`. The token is an OAuth access token minted against an assistant grant, prefixed `pcpa_` (`ASSISTANT_ACCESS_TOKEN_PREFIX` in `packages/shared/src/assistant-oauth.ts`). An agent key or a session cookie is refused. Source: `server/src/routes/mcp.ts`.

**Discovery.** A request without a valid token is answered `401` with:

```
WWW-Authenticate: Bearer resource_metadata="https://your-instance/.well-known/oauth-protected-resource/api/mcp/assistant", scope="agentdash:read"
```

The OAuth endpoints are mounted at the app root, not under `/api` (`server/src/app.ts`, `server/src/routes/oauth.ts`):

| Endpoint | What it is |
|---|---|
| `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/api/mcp/assistant` | Protected-resource metadata (RFC 9728): the resource, its authorization server, `scopes_supported`, `bearer_methods_supported: ["header"]` |
| `GET /.well-known/oauth-authorization-server` | Authorization-server metadata (RFC 8414) |
| `POST /oauth/register` | Dynamic client registration |
| `GET /oauth/authorize` | Validates the request, then redirects the person's browser to the consent screen in the web app |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | Token revocation (RFC 7009); always answers `200` |

The authorization-server metadata states: response type `code`; PKCE with `S256`; token endpoint auth method `none` (public clients); `client_id_metadata_document_supported: true`, so a `client_id` may be an https URL naming a client metadata document; and `resource_parameter_supported: true` (RFC 8707).

**Scopes** (`packages/shared/src/assistant-oauth.ts`):

| Scope | What it allows |
|---|---|
| `agentdash:read` | the read tools |
| `agentdash:work` | creating and moving work, and waking agents |
| `agentdash:decide` | resolving approvals and hiring; opt-in at consent, never granted by default |

A grant without `agentdash:work` is not shown the work tools at all, and one without `agentdash:decide` is not shown the gated tools (`packages/mcp-server/src/assistant/index.ts`). The [assistant reference](/mcp/tools/assistant) groups the tools by the scope that unlocks them.

**Origin.** A browser-originated request must send an `Origin` the instance recognizes — its own host or its configured public URL — or it is answered `403`. A client that sends no `Origin` is accepted.

**Loopback.** Tool calls loop back to the instance on an internal credential minted for that one request and revoked when the response closes (`server/src/services/assistant-loopback.ts`). The `pcpa_` token itself reaches no REST route. Like `/api/mcp`, the endpoint is stateless and answers `GET` and `DELETE` with `405`.

## stdio

The `agentdash-mcp` binary is `packages/mcp-server/dist/stdio.js` (`bin` in `packages/mcp-server/package.json`). The package is not published to npm; build it from a checkout:

```sh
pnpm --filter @agentdash/mcp-server build
```

It reads its configuration from the environment (`readConfigFromEnv` in `packages/mcp-server/src/config.ts`; `runServer` in `src/index.ts`). For each pair, the `PAPERCLIP_*` name is checked first and the first non-empty value wins.

| Variable | Alias | Required | What it does |
|---|---|---|---|
| `PAPERCLIP_API_URL` | `AGENTDASH_API_URL` | yes | The instance URL. `/api` is appended if missing. Startup fails without it. |
| `PAPERCLIP_API_KEY` | `AGENTDASH_API_KEY` | no | The bearer credential. Its prefix decides the surface; see [Toolsets](/mcp/toolsets). Empty is allowed: a fresh install has no key yet and gets one through `agentdash_sign_up`. |
| `PAPERCLIP_COMPANY_ID` | `AGENTDASH_COMPANY_ID` | no | The default company for tools that take a `companyId`. |
| `PAPERCLIP_AGENT_ID` | — | no | Scopes the connection to one agent: tools default to it, and it selects `STEWARD_PLAYBOOK`. |
| `PAPERCLIP_RUN_ID` | — | no | Sent as `X-Paperclip-Run-Id` on every write request (`src/client.ts`). |
| `AGENTDASH_TOOLSET` | — | no | `setup`, `agent` (default), `assistant` or `human`. Case and surrounding space are ignored; any other value stops the server at startup. |

A Claude Code entry for a local build, in the same `mcpServers` shape as above:

```json
{
  "mcpServers": {
    "agentdash": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-checkout>/packages/mcp-server/dist/stdio.js"],
      "env": {
        "PAPERCLIP_API_URL": "https://your-instance",
        "PAPERCLIP_API_KEY": "<key>"
      }
    }
  }
}
```

On startup the server writes one line to stderr naming the version, the API URL and the toolset. More on the binary: [agentdash-mcp](/cli/agentdash-mcp).
