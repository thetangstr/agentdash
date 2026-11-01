---
title: Toolsets
summary: What each MCP toolset is for, who gets it, and how a connection's toolset is chosen.
---

The server has five toolsets — `setup`, `agent`, `assistant`, `human`, `cloud` (`AGENTDASH_TOOLSETS` in `packages/mcp-server/src/index.ts`) — plus a bridge set that a bridge endpoint token gets instead of any of them. One function, `buildToolSurface` in the same file, decides what a connection is offered. Tool counts are on the generated pages, measured from `tools/list`; they are not repeated here, where they would go stale.

| Toolset | For | Who gets it | Reference |
|---|---|---|---|
| `agent` | An agent's own harness: the control plane (issues, comments, documents, agents, approvals, workspaces) plus the setup tools and the steward's directive and ceiling tools | Every `POST /api/mcp` connection; stdio by default | [agent](/mcp/tools/agent) |
| `setup` | Standing up a fresh instance: install checklist, onboarding interview, plan, provisioning, approval gates | stdio with `AGENTDASH_TOOLSET=setup` | [setup](/mcp/tools/setup) |
| `assistant` | A cloud assistant relaying to a person: read tools, work tools and gated tools, filtered by OAuth scope | Every `POST /api/mcp/assistant` connection; stdio with `AGENTDASH_TOOLSET=assistant` | [assistant](/mcp/tools/assistant) |
| `human` | The signed-in person acting through their own board key, with an explicit prepare-then-confirm step for every change | stdio with `AGENTDASH_TOOLSET=human` and a board key | [human](/mcp/tools/human) |
| `cloud` | Getting a person an AgentDash cloud workspace and then onto it: name check, signup, status, and the person's approval on the box | stdio with `AGENTDASH_TOOLSET=cloud`; every `POST /api/cloud/mcp` connection on the AgentDash cloud | [cloud](/mcp/tools/cloud) |
| bridge | The local end of the agent bridge (pull a task, submit a result) and the steward's inbox | Any connection whose key is a bridge endpoint token, except `human` | [bridge](/mcp/tools/bridge) |

## How the toolset is chosen

`buildToolSurface(client, config, toolset)` applies three rules in order (`packages/mcp-server/src/index.ts`):

1. **`human` and `cloud` first.** The human toolset is returned whatever the key looks like, and its own check refuses anything that is not a board key (`pcp_board_…`), any connection that also sets `PAPERCLIP_AGENT_ID` or `PAPERCLIP_RUN_ID`, and an API URL carrying credentials, a query or a fragment (`assertHumanConfig` in `src/human.ts`). On stdio the connection is also verified against the instance before the server starts, and again on every `tools/list`. The cloud toolset is returned whatever the key: its tools call the AgentDash cloud (`src/cloud.ts`), not an instance, and until `agentdash_cloud_connect` there is no instance.
2. **A bridge token gets the bridge tools and nothing else.** `isControlPlaneCredential` in `src/config.ts` treats a key as control-plane when it is empty or starts with `pcp_` (agent, board and the other API keys), `pcpa_` (an assistant access token) or `pcin_` (the assistant endpoint's internal loopback credential). Any other key is taken to be a bridge endpoint token, which is unprefixed, and gets the bridge tools only — `AGENTDASH_TOOLSET=setup`, `agent` or `assistant` makes no difference. The reverse also holds: a control-plane key never gets the bridge tools, because every `/bridge/*` route needs a bridge endpoint and the inbox belongs to the steward, not the agent (the comment in `buildToolSurface`; `src/bridge.ts`).
3. **Otherwise, the requested toolset.** `setup` is the journey tools (`src/journey.ts`). `assistant` is the assistant tools (`src/assistant/index.ts`). `agent` is the control-plane tools (`src/tools.ts`), then the journey tools, then the harness tools (`src/harness.ts`).

Which toolset is requested depends on the transport:

- **stdio:** `AGENTDASH_TOOLSET` (`parseToolset` in `src/index.ts`). Unset or empty means `agent`; an unknown value stops the server at startup.
- **`POST /api/mcp`:** always `agent` (`server/src/routes/mcp.ts`).
- **`POST /api/mcp/assistant`:** always `assistant`, with the grant's scopes (`server/src/routes/mcp.ts`).
- **`POST /api/cloud/mcp`** on the AgentDash cloud: always `cloud` (`cloud/src/routes/agent.ts`).

An empty key counts as control-plane on purpose: a fresh install has no key yet, and `agentdash_sign_up` mints one and upgrades the running session in place (`src/config.ts`, `setApiKey` in `src/client.ts`).

## The cloud toolset

The four `agentdash_cloud_*` tools run the self-serve signup at agentdash.cloud for a person: `agentdash_cloud_start` signs them up (they get the verification email) and returns a handle, `agentdash_cloud_status` follows that signup to a claimed workspace, and `agentdash_cloud_connect` asks the person, on their workspace, to approve the agent. The agent never sees the verification link, the claim link, a password or a browser session. The design and security model are in `doc/plans/2026-10-31-cloud-mcp-toolset.md`.

The same tool definitions serve both transports. Over stdio they call `POST <AGENTDASH_CLOUD_URL>/api/cloud/agent/<op>`; over `POST /api/cloud/mcp` cloud-control runs them in process. The one difference is what happens after the person approves:

- **stdio:** the session upgrades in place, the `agentdash_sign_up` pattern one step further. `setApiUrl` and `setApiKey` (`src/client.ts`) point it at the workspace with the delivered board key, the setup tools are added after the cloud tools, and the server sends `notifications/tools/list_changed`. The agent continues with `agentdash_setup_status`.
- **`POST /api/cloud/mcp`:** stateless, so nothing upgrades. The key is in the tool result, once; the client stores it, or adds the workspace's own `/api/mcp/assistant` as an OAuth connector instead.

## Assistant scopes

Over `POST /api/mcp/assistant` the grant's OAuth scopes filter the assistant toolset (`createAssistantToolDefinitions` in `src/assistant/index.ts`):

- The read tools are always served.
- The work tools are served only when the grant has `agentdash:work`.
- The gated tools are served only when the grant has `agentdash:decide`, which a person opts into at consent and is never granted by default (`packages/shared/src/assistant-oauth.ts`).

A tool the grant cannot use is not listed at all, rather than listed and refused. Over stdio there is no grant and every assistant tool is served. The [assistant reference](/mcp/tools/assistant) groups the tools by the scope that unlocks them, measured by listing the toolset with each scope.

## The harness tools in the agent toolset

Four tools in the agent toolset — `agentdashPushAgentDirectives`, `agentdashGetAgentDirectives`, `agentdashNarrowAgentCeilings`, `agentdashGetAgentPolicy` — let a steward's local harness direct the agent it stewards (`src/harness.ts`). Two rules bound them, both enforced by the server: ceilings can only be narrowed below the owner's ceiling, never widened, and directives shape how the agent works but grant it nothing. They take the caller's own board credential and work only when the caller is the agent's active steward — anyone else, an administrator included, gets `403` — and only on companies with the product profile these routes belong to; elsewhere the routes answer `404`.

## Resources and playbooks by toolset

The `assistant`, `human` and `cloud` toolsets list only the `agentdash://playbook` resource and no resource templates, and refuse a read of any other resource (`src/index.ts`). The other surfaces list every resource. See [Resources](/mcp/resources).

Every connection is sent one of five playbooks as its `instructions`: `ASSISTANT_PLAYBOOK` for `assistant`, `HUMAN_PLAYBOOK` for `human`, `CLOUD_PLAYBOOK` for `cloud` (`src/cloud.ts`), and for everything else `STEWARD_PLAYBOOK` when the connection is scoped to an agent (`PAPERCLIP_AGENT_ID`, or any `POST /api/mcp` connection) and `PLAYBOOK` when it is not (`selectPlaybook` in `src/playbook.ts`). See [Playbooks](/mcp/playbooks).

## The inbox server in agentdash-connect

`npx agentdash-connect mcp` is a separate, dependency-free MCP server for the person's own inbox, defined in `packages/connect/src/inbox-mcp.mjs`. It serves inbox tools on the same bridge endpoint token as the bridge set, but its tool definitions are its own and are not covered by the generated reference. It is what the `agentdash-inbox` entry written by connect launches; see [Connecting](/mcp/connecting).
