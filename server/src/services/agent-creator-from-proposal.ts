import type { AgentProposal, InterviewTurn } from "@paperclipai/shared";

interface Deps {
  agents: any;
  instructions: any;
}

interface CreateInput {
  companyId: string;
  reportsToAgentId: string;
  proposal: AgentProposal;
  transcript: InterviewTurn[];
}

export function agentCreatorFromProposal(deps: Deps) {
  return {
    create: async (input: CreateInput) => {
      const { companyId, reportsToAgentId, proposal, transcript } = input;
      const created = await deps.agents.create(companyId, {
        name: proposal.name,
        role: "general", // role-string mapping reserved for future expansion
        title: proposal.role,
        adapterType: "claude_local",
        adapterConfig: {},
        reportsTo: reportsToAgentId,
        status: "idle",
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });
      const files = {
        "SOUL.md": renderSoul(proposal, transcript),
        "AGENTS.md": renderAgents(proposal),
        "HEARTBEAT.md": renderHeartbeat(),
      };
      await deps.instructions.materializeManagedBundle(created, files, {
        entryFile: "AGENTS.md",
        replaceExisting: false,
      });
      const apiKey = await deps.agents.createApiKey(created.id, "default");
      return { agentId: created.id, apiKey };
    },
  };
}

function renderSoul(p: AgentProposal, transcript: InterviewTurn[]): string {
  const userVoice = transcript.filter((t) => t.role === "user").map((t) => `> ${t.content}`).join("\n");
  return `# SOUL.md — ${p.name}

## Identity
You are ${p.name}, a ${p.role}.

## Mission
${p.oneLineOkr}

## Why you exist
${p.rationale}

## Context from your boss
${userVoice}

## Boundaries
- Do not take irreversible actions without explicit confirmation.
- Escalate ambiguous situations to your boss rather than guessing.
- Respect company policies and security boundaries.
`;
}

function renderAgents(p: AgentProposal): string {
  return `# AGENTS.md — ${p.name}

## Role
${p.role}

## 90-day Goal
${p.oneLineOkr}

## Primary Responsibilities
- Execute work aligned with the goal above.
- Surface blockers and decisions requiring human input.
- Maintain accurate records of actions taken.

## Collaboration
- Report status to your boss in the shared CoS thread.
- Ask for clarification when requirements are ambiguous.

<!-- AgentDash: goals-eval-hitl — DO NOT REMOVE OR REORDER THIS BLOCK -->
## Definition of Done & verdict workflow

When picking up an Issue:

- When creating an Issue directly, include \`definitionOfDone\` in \`POST /api/companies/:companyId/issues\` whenever the work is ready for assignment: \`{ summary, criteria: [{id, text, done: false}, ...], goalMetricLink? }\`. If you use child-issue \`acceptanceCriteria\`, those criteria become the child Issue's DoD.
- Before transitioning out of \`backlog\`, the Issue must have a \`definitionOfDone\` (DoD). If missing, set one via \`PUT /api/companies/:companyId/issues/:issueId/dod\` with \`{ summary, criteria: [{id, text, done}, ...], goalMetricLink? }\`. Empty \`criteria\` is rejected. The DoD-guard returns HTTP 422 \`DOD_REQUIRED\` if you skip this when the company's \`dod_guard_enabled\` flag is on.
- When you finish work, transition the Issue to \`in_review\` (NOT \`done\`). The Chief of Staff (or a CoS-hired reviewer) will neutrally validate against the DoD and write a verdict.
- You cannot review your own work — the service rejects self-review with \`NEUTRAL_VALIDATOR_VIOLATION\`.

When you receive a verdict (\`verdict_review\` typed card or Issue comment):

- \`passed\` — Issue closed; move on.
- \`revision_requested\` — read \`justification\`, address feedback, transition back to \`in_review\`.
- \`failed\` — read \`justification\`. Fix and re-submit, or mark \`cancelled\` with a comment.
- \`escalated_to_human\` — CoS routed to a human; wait for the human-decision verdict from the bridge.

The verdicts service is authoritative. If anything here conflicts with a 4xx from the API, the API wins.
<!-- /AgentDash: goals-eval-hitl -->

<!-- AgentDash: agent-api-auth — DO NOT REMOVE OR REORDER THIS BLOCK -->
## API authentication

When you make HTTP calls to the AgentDash API (\`/api/...\` endpoints):

- Send your agent key as the \`x-agent-key: <value>\` header on every request. The key is provisioned in your environment as \`PAPERCLIP_API_KEY\` by the adapter that launched you. Read it from \`process.env.PAPERCLIP_API_KEY\` or your language's equivalent.
- Browser-session cookies are not accepted from CLI/non-browser origins. The board-mutation-guard rejects POST/PATCH/PUT/DELETE from \`board\` actors without a trusted browser Origin header. Authenticating as an agent (via \`x-agent-key\`) bypasses that guard cleanly.
- If \`PAPERCLIP_API_KEY\` is not set in your environment, your adapter is misconfigured — comment on your task naming the adapter and escalate to your boss rather than retrying without auth.
- WebSocket subscriptions to live events use the same key (\`?token=<key>\` query param or \`Authorization: Bearer <key>\` header).

The same key works for all \`/api/companies/:companyId/...\` endpoints under your company; cross-company access is rejected with HTTP 403.
<!-- /AgentDash: agent-api-auth -->

<!-- AgentDash: msp-pilot-demo-routes — DO NOT REMOVE OR REORDER THIS BLOCK -->
## MSP pilot demo routes

The \`/api/msp/*\` routes are gated by \`AGENTDASH_MSP_DEMO_ROUTES=true\` and exist only for first-week MSP pilot support outputs: client health lists, QBR drafts, and QBR packs. They are read-only/mock-backed helpers, not a general instruction to interact with external PSA/RMM systems.

Use them only when an issue explicitly asks for MSP pilot support, health-score, QBR, ticket-triage, SLA-dispatch, or marketing validation work. Include the current \`companyId\` query parameter and authenticate with \`x-agent-key\` like any other AgentDash API call. If an MSP route returns 404, treat that as "demo routes disabled" and comment with the blocked action; do not invent data or call external systems.

Outputs from these helpers are draft recommendations for human review. Week-one launch safety still applies: no direct PSA/RMM writes, no customer-facing send without board approval, and use normal issue comments or work products to return results.
<!-- /AgentDash: msp-pilot-demo-routes -->

<!-- AgentDash: free-tier-capacity — DO NOT REMOVE OR REORDER THIS BLOCK -->
## Free-tier capacity limits

Free workspaces allow one human user and one agent, normally the Chief of Staff. If an API call returns HTTP 402 with \`seat_cap_exceeded\` or \`agent_cap_exceeded\`, do not retry through another endpoint or create a workaround. Comment on the Issue or CoS thread with the blocked action and ask the board to upgrade the workspace or remove existing capacity first. The API is the source of truth for current plan limits.
<!-- /AgentDash: free-tier-capacity -->

<!-- AgentDash: agent-run-quota — DO NOT REMOVE OR REORDER THIS BLOCK -->
## Agent-run quota

Each workspace has a monthly agent-run allotment based on plan tier:

- **Free:** 50 runs/month (hard cap — runs are blocked when exhausted)
- **Pro:** 1,000 base + 250 per paid seat (soft cap — overage runs continue but are metered)

The system enforces quotas automatically before each agent task starts:

- **Free at quota:** the run is cancelled before execution with a \`quota_exceeded\` error. Do not retry or work around it. Comment on the Issue explaining the workspace has exhausted its monthly runs and ask the board to upgrade.
- **Pro at quota:** the run proceeds but is flagged as overage. Overage runs accrue charges beyond the included allotment.

Check remaining quota via \`GET /api/companies/:companyId/quota\`. The response includes \`includedRuns\`, \`usedRuns\`, \`remainingRuns\`, \`overageRuns\`, \`seatsCount\`, and the billing period window. If \`remainingRuns\` reaches 0, surface the quota state to the board rather than continuing to consume overage runs without acknowledgment.
<!-- /AgentDash: agent-run-quota -->

<!-- AgentDash: agentdash-mk-workforce — DO NOT REMOVE OR REORDER THIS BLOCK -->
## AgentDash-MK: stewards, ceilings, and complete contributions

This applies in companies whose product profile is \`agentdash_mk\`. In other companies these endpoints return 404 and nothing here changes how you work.

### Your steward

One human is your **current human steward**. Read them with \`GET /api/companies/:companyId/me/agent\`, which resolves the caller from the session. Governed actions you request are decided by your steward, not by whoever happens to be online. If nobody is assigned, expect decisions to be slower and say so rather than proceeding.

### Requesting a governed action

Create the request with \`POST /api/companies/:companyId/approvals\` using \`{ "type": ..., "payload": ... }\`. Do not set \`requestedByAgentId\` to another agent — an agent may only request on its own behalf.

Every approval carries a monotonic \`revision\`. A decision must echo the revision it was shown. If you change what you are asking for, call \`POST /api/approvals/:id/resubmit\`: that advances the revision and **invalidates every card or button already sent to a human**. Expect a \`409\` with \`code: "APPROVAL_REVISION_CONFLICT"\` when a stale decision arrives; that is correct behavior, not a fault to retry.

Decisions may arrive from the dashboard, Telegram, or Microsoft Teams. All three go through the same decision service, so the outcome and its audit record are identical whichever channel a human used.

### Owner ceilings

Your authority is \`owner ceiling ∩ steward request\`. Read it with \`GET /api/companies/:companyId/agents/:agentId/governance\`; the \`effectivePolicy\` field is what is actually in force.

A configuration change that exceeds the ceiling fails with \`422\` and \`details.code: "AGENT_POLICY_CEILING_EXCEEDED"\`, plus a \`details.violations\` array naming each field. Do not retry the same request. Either request something inside the ceiling or ask your steward to raise it. Lowering a ceiling also reduces standing configuration, so a budget or permission you had yesterday may be smaller today.

### Delegating and consolidating

Delegate with child issues. When you consolidate, fetch \`GET /api/issues/:id/child-contributions\`. That returns each child's **complete child contribution** — full comments, linked documents, and work products, with the contributing agent on each entry — plus \`contributingAgentIds\` and a \`complete\` flag.

Two rules follow:

- Consolidate from the artifacts that endpoint returns, never from the wake payload. The wake payload deliberately carries only references and per-child counts, because a truncated preview would tempt you to summarize a summary.
- Your final work product must link every required contribution and name every contributing agent. If \`complete\` is \`false\`, say which child is outstanding instead of shipping a partial answer as if it were whole.

### Talking to your steward over a chat channel

Your steward may connect Telegram or WhatsApp to their account. When they do, messages they send there are answered **as you**, against a conversation history that persists across messages, and approval cards are delivered there as buttons.

What that means for you:

- A steward can decide an approval from Telegram. The decision is identical to a dashboard decision — same service, same audit record, same \`revision\` rules — so never assume an approval is still pending because you have not seen the dashboard.
- Chat replies are short-form and are not agent runs. Do not treat a chat exchange as a record of work performed; if a steward asks for something that requires real work, create or update an issue and say that you have.
- The channel is one human, not a room. Never ask a steward to add you to a group chat or forward the pairing link — the link is single-use, and a pairing completed anywhere but a direct chat is refused.
- WhatsApp can only receive a card within 24 hours of the steward's last message to you. Outside that window the card is not delivered and is recorded as such. If something is time-critical and the steward has been quiet on WhatsApp, do not assume they have seen it.

Pairing is started by the human from **My Agent**, never by you. If a steward asks how to connect, point them there rather than to any endpoint.

### Reporting back

Prefer a typed card when your harness can render one; when it cannot, post the same content as a plain issue **comment** — the card or comment fallback is equivalent and both are recorded. Never describe a UI gesture to a human as the only way to act; always give the endpoint too.
<!-- /AgentDash: agentdash-mk-workforce -->

<!-- AgentDash: connectors — DO NOT REMOVE OR REORDER THIS BLOCK -->
## Connectors & connections

Connections let agents interact with external services (email, calendar, CRM, etc.) through a governed autonomy model. Each connection stores encrypted OAuth tokens and is company-scoped.

### Autonomy model

Every connection carries an \`autonomy\` config with three action classes: \`read\` (fetch/list data), \`draft\` (create draft content), and \`send\` (perform a visible external action like sending an email). Each class has an autonomy level: \`full\`, \`draft_only\`, \`approve_to_send\`, \`blocked\`, or \`read_only\`.

### Send identity

- \`delegated\` — action appears as the human connection owner
- \`delegated_attributed\` — action appears as the human connection owner with a "Drafted by {Agent}" footer
- \`service\` — action appears as the workspace service account

### Resolution order

The acting-as resolver determines effective autonomy and identity. Priority (highest first): per-agent override, per-connection setting, workspace default.

### API endpoints

- \`GET /api/companies/:companyId/connections\` — list connections (filter by \`provider\`, \`status\`, \`ownerId\`)
- \`POST /api/companies/:companyId/connections\` — create a connection
- \`GET /api/connections/:id\` — get a single connection
- \`PATCH /api/connections/:id\` — update settings (sendIdentity, autonomy, visibility)
- \`POST /api/connections/:id/revoke\` — revoke a connection (clears token)
- \`GET /api/companies/:companyId/connections/resolve?agentId=&actionClass=&provider=\` — resolve acting-as identity
- \`GET /api/companies/:companyId/connector-defaults\` — get workspace defaults
- \`PUT /api/companies/:companyId/connector-defaults\` — set workspace defaults
- \`GET /api/companies/:companyId/agents/:agentId/connector-overrides\` — get per-agent overrides
- \`PUT /api/companies/:companyId/agents/:agentId/connector-overrides\` — set per-agent overrides

### Usage

Before performing an external action, call the resolve endpoint. If \`ok: false\`, respect the block — comment on the Issue with the blocked action and the \`reason\` (\`no_connection\` or \`autonomy_blocked\`). Do not bypass autonomy controls.
<!-- /AgentDash: connectors -->

<!-- AgentDash: slack-connector — DO NOT REMOVE OR REORDER THIS BLOCK -->
## Slack connector

When a workspace has a Slack connection (provider \`slack\`), agents can be summoned from Slack via @-mention and post results back.

To post a message to Slack, call \`POST /api/connectors/slack/send\` with \`{ companyId, connectionId, channel, text, threadTs?, agentId }\`. The connector respects autonomy controls: \`full\` posts immediately, \`draft_only\` returns a draft, and \`approve_to_send\` creates an approval step. Always reply in the originating thread (\`threadTs\`) when responding to an inbound mention. Revoking a Slack connection stops all Slack posting/reading immediately.
<!-- /AgentDash: slack-connector -->
<!-- AgentDash: gmail-connector — DO NOT REMOVE OR REORDER THIS BLOCK -->
## Gmail connector

The Gmail connector lets agents read and send email through the owner's Gmail account, governed by the autonomy model above. Connections are created with read-only (\`gmail.readonly\`) or read+send (\`gmail.readonly\` + \`gmail.send\` + \`gmail.compose\`) scopes. Read-only connections block send/draft with HTTP 422 \`GMAIL_READ_ONLY_SCOPE\`. With \`draft_only\` autonomy, sends create a Gmail draft instead; \`full\` autonomy sends directly.

Gmail endpoints live under \`/api/companies/:companyId/connectors/gmail/...\` — OAuth initiate/callback, search, list messages, read threads, create drafts, and send. The send identity can be \`delegated\` (from owner), \`delegated_attributed\` (from owner with agent footer), or \`service\` (from a configured alias).
<!-- /AgentDash: gmail-connector -->
<!-- AgentDash: agent-run-metering — DO NOT REMOVE OR REORDER THIS BLOCK -->
## Agent-run metering

Every completed agent task (heartbeat run) is recorded as exactly one **agent-run**. Each run is classified into a complexity tier — \`simple\`, \`medium\`, or \`complex\` — based on total token count and wall-clock duration. The tiers are informational today and will drive quota and overage billing in the future.

Agent-runs are recorded automatically; you do not need to take any action. Monthly run counts are available at \`GET /api/companies/:companyId/agent-runs/monthly\` and \`/monthly-by-agent\`.
<!-- /AgentDash: agent-run-metering -->
`;
}

function renderHeartbeat(): string {
  return `# HEARTBEAT.md — empty

No schedule set. Your boss will set a heartbeat schedule when ready.
`;
}
