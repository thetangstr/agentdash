---
title: MCP overview
summary: The AgentDash MCP server, its transports and toolsets, and where each reference page comes from.
---

AgentDash serves the Model Context Protocol from one server, `packages/mcp-server`. A harness reaches it over stdio (the `agentdash-mcp` binary, `packages/mcp-server/src/stdio.ts`) or over streamable HTTP on the instance itself: `POST /api/mcp` with an agent key, and `POST /api/mcp/assistant` with an OAuth access token (`server/src/routes/mcp.ts`). What a connection is offered is decided by its credential and, on stdio, by `AGENTDASH_TOOLSET`: one of four toolsets — `setup`, `agent`, `assistant`, `human` — or, for a bridge endpoint token, the bridge tools only (`buildToolSurface` in `packages/mcp-server/src/index.ts`). Each connection is also sent a playbook, the operating contract for its kind of caller, as the MCP `instructions` string.

- [Connecting](/mcp/connecting) — stdio, `POST /api/mcp`, `POST /api/mcp/assistant` and OAuth discovery, and what `npx agentdash-connect` writes for Claude Code and Codex.
- [Toolsets](/mcp/toolsets) — what each toolset is for, who gets it, and how it is selected.
- Tool reference, one page per surface: [agent](/mcp/tools/agent), [setup](/mcp/tools/setup), [assistant](/mcp/tools/assistant), [human](/mcp/tools/human), [bridge](/mcp/tools/bridge).
- [Resources](/mcp/resources) — the `agentdash://` resources and templates.
- [Playbooks](/mcp/playbooks) — the four playbooks, verbatim.

The tool reference, the resources page and the playbooks page are generated from the server's own `tools/list`, resource listings and `instructions` by `scripts/docs/generate-mcp-reference.mjs`. Each states the commit it was generated at, and `scripts/ci/check-mcp-reference-drift.mjs` fails a pull request whose committed pages differ from what the server produces. The other pages on this tab are written by hand and cite the files they describe.
