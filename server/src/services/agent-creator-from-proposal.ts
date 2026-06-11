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

- **Free:** 50 runs/month
- **Pro:** 1,000 base + 250 per paid seat (adjusts in real-time when seats change)

Check remaining quota via \`GET /api/companies/:companyId/quota\`. The response includes \`includedRuns\`, \`usedRuns\`, \`remainingRuns\`, \`overageRuns\`, \`seatsCount\`, and the billing period window. If \`remainingRuns\` reaches 0, surface the quota state to the board rather than continuing to consume overage runs without acknowledgment.
<!-- /AgentDash: agent-run-quota -->

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
