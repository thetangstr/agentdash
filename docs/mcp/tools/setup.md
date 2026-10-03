---
title: "Setup toolset"
summary: "The install and onboarding tools: what an agent standing up a fresh instance is given."
---

> Generated at commit `ddebd3f5c` by `scripts/docs/generate-mcp-reference.mjs`.
> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.

**17 tools** — measured: the length of the `tools/list` response. Source: `buildToolSurface(client, config, "setup")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/journey.ts`.

Each tool's description is its inline string, verbatim. The input table is rendered from the JSON schema the server advertises in `tools/list` (`toolInputSchema` in `packages/mcp-server/src/schema.ts`, converted from the tool's zod schema). Nested objects are flattened: `a.b` is property `b` of object `a`, and `a[].b` is property `b` of each item of array `a`.

Tools, in the order `tools/list` returns them: `agentdash_setup_status`, `agentdash_install_checklist`, `agentdash_sign_up`, `agentdash_setup_adapter`, `agentdash_start_interview`, `agentdash_interview_turn`, `agentdash_get_plan`, `agentdash_confirm_plan`, `agentdash_revise_plan`, `agentdash_request_approval`, `agentdash_check_approval`, `agentdash_list_agents`, `agentdash_list_tasks`, `agentdash_create_task`, `agentdash_get_dashboard`, `agentdash_pause_agent`, `agentdash_resume_agent`.

## `agentdash_setup_status`

THE SELF-DRIVING ANCHOR. Aggregates server health, agents, dashboard, and pending approvals into a machine-readable status with a deterministic nextAction. Call this first, do the nextAction, verify, and call it again — repeat until the workspace is provisioned and operating.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `agentdash_install_checklist`

Returns machine-readable install steps for AgentDash on a fresh Mac mini. This tool NEVER executes anything. The steps run in the calling agent's shell with the human's consent — run them one at a time and verify each before the next.

No input.

## `agentdash_sign_up`

Founding-user signup for a FRESH authenticated-mode install — works ONLY while the instance has zero users (bootstrapStatus "bootstrap_pending"). No password needed: collect the human's email and name in conversation (NEVER invent an email), and the server creates the founding user, returns a board API key, and this session continues authenticated immediately. Persist the key so future sessions stay signed in. The response also returns a one-time passwordSetupUrl — hand that link to the human so they can set a browser password and open the web UI (no email needed).

| Property | Type | Required | Description |
|---|---|---|---|
| `email` | string | yes |  |
| `name` | string | yes |  |
| `inviteCode` | string | no |  |

## `agentdash_setup_adapter`

Configure the model adapter your agents will run on — a required onboarding step before the interview can produce a real team plan. Offer the human the choices from the preset menu (Claude / OpenAI / Gemini — each needs an API key — or 'stub' for a no-key placeholder that produces canned plans). Ask the human which provider and collect the key in conversation (NEVER invent a key). After applying, re-check agentdash_setup_status to confirm adapterReady before continuing the interview.

| Property | Type | Required | Description |
|---|---|---|---|
| `preset` | `"claude"` \| `"openai"` \| `"gemini"` \| `"stub"` | yes | claude=ANTHROPIC_API_KEY; openai=OPENAI_COMPAT_API_KEY (api.openai.com); gemini=OPENAI_COMPAT_API_KEY (Gemini OpenAI-compat); stub=no key, canned plans. |
| `apiKey` | string | no |  |

## `agentdash_start_interview`

Bootstrap the AgentDash workspace: creates the company, the Chief of Staff agent, and the onboarding conversation, then enforces the boundary default that new agent hires require board approval. Returns {companyId, conversationId, cosAgentId, boundaries}. Follow with agentdash_interview_turn to run the intent-capture interview. Pass companyId when the user belongs to more than one company — the server refuses to guess (409) and lists the candidates.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no | Company to bootstrap in. Required when the user holds active memberships in more than one company; omit when they belong to exactly one or none. |

## `agentdash_interview_turn`

Submit one round of the onboarding interview: passes the user's answer to the Chief of Staff and returns the next question (or the completed state). Repeat until a team plan is proposed, then use agentdash_get_plan.

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |
| `userMessage` | string | yes |  |
| `cosAgentId` | string \| null | no |  |
| `companyId` | string \| null | no |  |

## `agentdash_get_plan`

Fetch the latest proposed agent-team plan (the newest agent_plan_proposal_v1 card in the onboarding conversation). Present the plan to the human before confirming.

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |

## `agentdash_confirm_plan`

Confirm and materialize the proposed agent team from the latest plan card. Creates one agent per plan entry. Only call this after the human has approved the plan. Hires beyond this confirmed plan are gated — use agentdash_request_approval for those.

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |

## `agentdash_revise_plan`

Request revisions to the proposed agent-team plan. Pass the human's feedback; the Chief of Staff rewrites the plan as a delta and posts a new plan card.

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |
| `revisionText` | string | yes |  |

## `agentdash_request_approval`

Request human approval for a gated action (hiring beyond the plan, deletions, budget changes, pausing/resuming the fleet, anything outside the confirmed goals). Creates a request_board_approval that the human decides at the approveUrl in the AgentDash UI. Returns {approvalId, status, approveUrl}. Poll agentdash_check_approval and do NOT proceed until it returns approved.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `summary` | string | yes |  |
| `proposedAction` | string | yes |  |
| `details` | string | no |  |
| `issueIds` | array of string | no |  |

## `agentdash_check_approval`

Check the status of an approval request. Poll this after agentdash_request_approval and DO NOT proceed with the gated action until status === "approved". If status is "rejected" or "revision_requested", read the comments (list_approval_comments) and either revise the request or drop the action. Never fabricate approval status.

| Property | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes |  |

## `agentdash_list_agents`

List all agents in the workspace with their current status (read-only, always allowed).

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `agentdash_list_tasks`

List tasks/issues in the workspace, optionally filtered by status (read-only, always allowed).

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `status` | `"backlog"` \| `"todo"` \| `"in_progress"` \| `"in_review"` \| `"done"` \| `"blocked"` \| `"cancelled"` | no |  |

## `agentdash_create_task`

Create a new task/issue in the workspace and optionally assign it to an agent. Creating tasks within the confirmed goals is always allowed — it is also the fallback when an approval stays pending: create a task for the human instead of proceeding.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `title` | string | yes |  |
| `description` | string | no |  |
| `priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | no | Default: `"medium"`. |
| `assigneeAgentId` | string \| null | no |  |

## `agentdash_get_dashboard`

Get the company dashboard summary: agent counts, task counts, spend, pending approvals (read-only, always allowed).

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `agentdash_pause_agent`

Pause one agent so it stops picking up new work. GATED when applied to ALL agents: pausing the whole fleet requires agentdash_request_approval first — wait for approved.

| Property | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes |  |

## `agentdash_resume_agent`

Resume a paused agent. GATED: resuming an agent a human paused, or resuming the whole fleet, requires agentdash_request_approval first — wait until agentdash_check_approval returns approved before calling this.

| Property | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes |  |
