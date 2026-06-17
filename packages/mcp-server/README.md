# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `PAPERCLIP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `PAPERCLIP_API_KEY` - bearer token used for `/api` requests
- `PAPERCLIP_COMPANY_ID` - optional default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` - optional default agent for checkout helpers
- `PAPERCLIP_RUN_ID` - optional run id forwarded on mutating requests
- `PAPERCLIP_PROVISION_KEY` - optional high-privilege key required only by
  `agentdashOnboardUser` (creates new users). Sent as `x-provision-key`; must
  match the server's `AGENTDASH_PROVISION_KEY`. Omit it and onboarding is simply
  unavailable from this client.

## How users & agents find this server

This is a published npm package (STDIO transport). There is no auto-discovery —
add it to your MCP client config (Claude Code, Cursor, etc.) pointed at your
AgentDash instance:

```jsonc
{
  "command": "npx",
  "args": ["-y", "@paperclipai/mcp-server"],
  "env": {
    "PAPERCLIP_API_URL": "https://your-agentdash.example",
    "PAPERCLIP_API_KEY": "<board api key>",
    "PAPERCLIP_PROVISION_KEY": "<only for agentdashOnboardUser>"
  }
}
```

The server runs locally as a subprocess and talks to your instance's REST API.
"Finding it" = the package name + your instance URL + a key.

## Usage

```sh
npx -y @paperclipai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @paperclipai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListIssueApprovals`
- `paperclipListDocuments`
- `paperclipGetDocument`
- `paperclipListDocumentRevisions`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipGetIssueWorkspaceRuntime`
- `paperclipWaitForIssueWorkspaceService`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`
- `paperclipGetApprovalIssues`
- `paperclipListApprovalComments`

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipUpsertIssueDocument`
- `paperclipRestoreIssueDocumentRevision`
- `paperclipControlIssueWorkspaceServices`
- `paperclipCreateApproval`
- `paperclipLinkIssueApproval`
- `paperclipUnlinkIssueApproval`
- `paperclipApprovalDecision`
- `paperclipAddApprovalComment`

AgentDash onboarding / provisioning tools:

These let an agent or human create and set up a workspace through the LLM-led
Chief of Staff, reducing onboarding friction. They use the `agentdash*` prefix
to stay distinct from the inherited `paperclip*` tools.

- `agentdashBootstrapWorkspace` — provision a workspace for the authenticated
  user (company + Chief of Staff agent + opening conversation). Lowest-friction
  start; takes no input.
- `agentdashListCompanies` — list accessible workspaces.
- `agentdashGetCompany` — get a workspace by id.
- `agentdashCreateCompany` — explicitly create a workspace (prefer
  `agentdashBootstrapWorkspace` for full onboarding).
- `agentdashCosChat` — send a message to a workspace's Chief of Staff (drives
  the onboarding interview). The reply is generated asynchronously — read it
  back with `agentdashReadConversation`.
- `agentdashReadConversation` — read recent messages in a conversation.
- `agentdashHireAgent` — hire an agent (e.g. one the Chief of Staff proposes).
- `agentdashOnboardUser` — **create a NEW user** + their company + a Chief of
  Staff in one call, and email them a set-password link. Requires
  `PAPERCLIP_PROVISION_KEY` (high-privilege; gated by `x-provision-key`). The
  new user then hires specialists via `agentdashCosChat`. Use this to onboard
  customers programmatically; the other `agentdash*` tools act for the
  already-authenticated actor.

A typical zero-to-working-workspace flow: `agentdashBootstrapWorkspace` →
`agentdashCosChat` (answer the CoS interview) → `agentdashReadConversation`
(read the proposed plan) → `agentdashHireAgent` for each proposed agent.

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
