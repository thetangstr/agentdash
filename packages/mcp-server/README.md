# @agentdash/mcp-server

The AgentDash MCP server. One server, four toolsets plus a bridge set, two transports. Full reference: `docs/mcp/` (served at `/docs/mcp/overview`), generated from this package by `scripts/docs/generate-mcp-reference.mjs`.

## Toolsets

| Toolset | For | Defined in |
|---|---|---|
| `agent` (default) | An agent's own harness: control plane, setup tools, steward directive and ceiling tools | `src/tools.ts`, `src/journey.ts`, `src/harness.ts` |
| `setup` | Standing up a fresh instance: install, onboarding interview, provisioning, approval gates | `src/journey.ts` |
| `assistant` | A cloud assistant relaying to a person; filtered by OAuth scope over HTTP | `src/assistant/` |
| `human` | The signed-in person on their own board key, prepare then confirm | `src/human.ts` |
| bridge | What a bridge endpoint token gets instead: the agent bridge and the steward inbox | `src/bridge.ts` |

No `paperclip*` prefix: tool names are exactly as the reference lists them (`list_issues`, `agentdash_setup_status`, `agentdashGetMyMandate`, `inbox_sync`). `buildToolSurface` in `src/index.ts` picks the surface: `human` if asked; otherwise a key that is not a control-plane credential (`isControlPlaneCredential`, `src/config.ts`) gets the bridge set only; otherwise the requested toolset. Tool lists and input schemas: `docs/mcp/tools/*.md`.

Every connection is also sent a playbook as its MCP `instructions` and as the `agentdash://playbook` resource (`src/playbook.ts`, `src/human.ts`; verbatim in `docs/mcp/playbooks.md`).

## Transports

- **stdio** — `agentdash-mcp` (`dist/stdio.js`). Not published to npm; build it here.
- **Streamable HTTP** — mounted by the server (`server/src/routes/mcp.ts`): `POST /api/mcp` with an agent key as Bearer (always `agent`), and `POST /api/mcp/assistant` with an OAuth `pcpa_` access token (always `assistant`). Connection details: `docs/mcp/connecting.md`.

## stdio environment

| Variable | Alias | Required | Purpose |
|---|---|---|---|
| `PAPERCLIP_API_URL` | `AGENTDASH_API_URL` | yes | Instance URL; `/api` is appended if missing |
| `PAPERCLIP_API_KEY` | `AGENTDASH_API_KEY` | no | Bearer credential; its prefix picks the surface. Empty is allowed for sign-up |
| `PAPERCLIP_COMPANY_ID` | `AGENTDASH_COMPANY_ID` | no | Default company |
| `PAPERCLIP_AGENT_ID` | — | no | Scopes the connection to one agent |
| `PAPERCLIP_RUN_ID` | — | no | Sent as `X-Paperclip-Run-Id` on writes |
| `AGENTDASH_TOOLSET` | — | no | `setup`, `agent`, `assistant` or `human` |

`PAPERCLIP_*` is checked first; first non-empty value wins.

## Development

```sh
pnpm --filter @agentdash/mcp-server build
pnpm --filter @agentdash/mcp-server test
pnpm --filter @agentdash/mcp-server typecheck
pnpm docs:mcp-reference   # after changing a tool, schema, resource or playbook
```

CI fails when `docs/mcp/**` is stale (`scripts/ci/check-mcp-reference-drift.mjs`).
