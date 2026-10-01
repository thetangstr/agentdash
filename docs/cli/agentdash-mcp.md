---
title: agentdash-mcp
summary: The MCP server binary for stdio — how to build it, its environment variables, and how it picks a toolset.
---

`agentdash-mcp` runs the AgentDash MCP server over stdio. It is the `bin` of `packages/mcp-server` (`./dist/stdio.js`, `packages/mcp-server/package.json`). The package is not published to npm: build it from a checkout. To connect a harness to an instance over HTTP instead, nothing has to run locally; use [agentdash-connect](/cli/agentdash-connect).

```sh
pnpm --filter @agentdash/mcp-server build
PAPERCLIP_API_URL=https://your-instance PAPERCLIP_API_KEY=<key> node packages/mcp-server/dist/stdio.js
```

The process speaks MCP on stdin and stdout. It writes one line to stderr at startup — the version, the API URL and the toolset — and exits `1` if it cannot start (`packages/mcp-server/src/stdio.ts`, `runServer` in `src/index.ts`).

## Environment

Read by `readConfigFromEnv` in `packages/mcp-server/src/config.ts`, plus `AGENTDASH_TOOLSET` in `runServer`. Where a variable has an alias, the `PAPERCLIP_*` name is checked first and the first non-empty value wins.

| Variable | Alias | Required | What it does |
|---|---|---|---|
| `PAPERCLIP_API_URL` | `AGENTDASH_API_URL` | yes | The instance URL; `/api` is appended if missing. |
| `PAPERCLIP_API_KEY` | `AGENTDASH_API_KEY` | no | The bearer credential. Its prefix decides the surface (below). |
| `PAPERCLIP_COMPANY_ID` | `AGENTDASH_COMPANY_ID` | no | The default company for tools that take a `companyId`. |
| `PAPERCLIP_AGENT_ID` | — | no | Scopes the connection to one agent; tools default to it and it selects the agent playbook. |
| `PAPERCLIP_RUN_ID` | — | no | Sent as `X-Paperclip-Run-Id` on every write (`src/client.ts`). |
| `AGENTDASH_TOOLSET` | — | no | `setup`, `agent` (default), `assistant` or `human`. |

## Toolset selection

| Key | `AGENTDASH_TOOLSET` | Tools served |
|---|---|---|
| empty, or `pcp_…` | unset or `agent` | [agent](/mcp/tools/agent) |
| empty, or `pcp_…` | `setup` | [setup](/mcp/tools/setup) |
| `pcp_…` or `pcpa_…` | `assistant` | [assistant](/mcp/tools/assistant), unfiltered: stdio has no OAuth grant |
| `pcp_board_…` | `human` | [human](/mcp/tools/human); any other key, or a set `PAPERCLIP_AGENT_ID` or `PAPERCLIP_RUN_ID`, stops startup |
| anything else (a bridge endpoint token) | anything but `human` | [bridge](/mcp/tools/bridge) |

The rules, and why a bridge token and a control-plane key never share a surface, are on [Toolsets](/mcp/toolsets) (`buildToolSurface` in `src/index.ts`, `isControlPlaneCredential` in `src/config.ts`). An empty key is allowed so a fresh install can sign up through `agentdash_sign_up`, which mints a board key and upgrades the session in place.

## Development

```sh
pnpm --filter @agentdash/mcp-server test        # vitest, mocked fetch, no server needed
pnpm --filter @agentdash/mcp-server typecheck
pnpm docs:mcp-reference                         # regenerate docs/mcp/** after changing a tool
```
