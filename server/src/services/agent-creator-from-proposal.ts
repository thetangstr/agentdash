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
`;
}

function renderHeartbeat(): string {
  return `# HEARTBEAT.md — empty

No schedule set. Your boss will set a heartbeat schedule when ready.
`;
}
