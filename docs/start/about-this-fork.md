---
title: About this fork
summary: The open-source project AgentDash is forked from, and why some names in the code still carry its name
---

AgentDash is a fork of an open-source control plane for AI agents, released under the MIT license. This page names that project and explains the names it left behind in the code.

## The upstream project

The upstream project is [Paperclip](https://github.com/paperclipai/paperclip). AgentDash keeps its agent harness — heartbeats, adapters, the plugin SDK — and builds its own product on top: the Chief of Staff and its onboarding, stewardship and the steward inbox, `agentdash-connect`, AgentDash Cloud, and a redesigned web app. Changes from upstream are picked one at a time, not merged in bulk.

This is the only page in these docs that names the upstream project. Everywhere else, the product is AgentDash.

## Names that still carry the upstream name

Some identifiers were kept so that existing installs, scripts and agents keep working. They are real, and the docs write them exactly as the code does:

| Kind | Examples |
| --- | --- |
| Environment variables | `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_HOME` |
| HTTP header | `X-Paperclip-Run-Id` |
| The operator CLI | `paperclipai`, run from a checkout as `pnpm paperclipai` |
| Workspace packages | `@paperclipai/server`, `@paperclipai/shared`, `@paperclipai/db` |

Where AgentDash also accepts an `AGENTDASH_*` spelling, the page that documents the variable says so. The MCP server, for example, reads `AGENTDASH_API_URL` and `AGENTDASH_API_KEY` as well (`packages/mcp-server/src/config.ts`).

The npm package named `paperclipai` is upstream's, not AgentDash's. To run the operator CLI against AgentDash, use a clone of [github.com/thetangstr/agentdash](https://github.com/thetangstr/agentdash). The only package AgentDash publishes is [`agentdash-connect`](/cli/agentdash-connect).

## Source and license

- AgentDash: [github.com/thetangstr/agentdash](https://github.com/thetangstr/agentdash) — MIT, the same license as upstream.
- Upstream: [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip).
