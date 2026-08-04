# Human–Agent Workforce Context Snapshot

## Task statement

Clarify an execution-ready product model for one-to-one human–agent relationships inside AgentDash, including multi-user access, human approvals, agent-to-agent collaboration, optional instant-messaging access beginning with Telegram and later Microsoft Teams, and cooperation with a local Codex/Claude-style agent running on each human's computer.

## Desired outcome

Each human company member has a dedicated AgentDash agent whose mandate is governed by that human. Agents can collaborate across the company org chart, request information or work from other agents, and return consolidated deliverables to the requesting executive. Humans can review and approve governed actions in AgentDash Inbox, with IM approval surfaces added later.

## Stated solution

- Give every company participant access to AgentDash.
- Associate one AgentDash agent with each human.
- Let the associated human control that agent's mandate/MD instructions.
- Support human approval of agent actions in AgentDash Inbox first.
- Add Telegram as the first IM surface and Microsoft Teams afterward.
- Allow AgentDash agents to work with a local Codex/Claude-style agent on the corresponding human's computer so the local agent can reach systems already available there.
- Fall back to asking the human for information when neither agent has direct access.

## Probable intent hypothesis

Create an AI-native company operating model where every human has an accountable digital counterpart, collaboration follows the human org structure, and access to sensitive external systems remains governed by existing human/local-machine boundaries instead of requiring AgentDash to build every SaaS integration.

## Known facts and evidence

- The repository already contains human company membership roles, permission grants, invites, and join approvals.
- It contains company inbox and approval UI/API surfaces.
- It contains persistent conversations, mention parsing, conversation dispatch, and agent summoning.
- It contains connector autonomy controls and encrypted connection storage.
- Slack/Gmail connector foundations exist, but Slack inbound dispatch and connection UI are incomplete.
- The Paperclip plugin SDK exposes inbound webhooks, outbound HTTP, events, state, secrets, UI slots, agent sessions, and issue/comment APIs.
- The repository has recent MCP-native onboarding and local-agent access work.

## Constraints

- Preserve company isolation and governed approval behavior.
- Avoid requiring first-party integrations for every external system.
- Humans must retain control of their associated agent's mandate.
- Agent-to-agent delegation must remain attributable and auditable.
- Telegram is the first IM provider; Microsoft Teams follows as a separate implementation phase.
- Deep-interview is requirements-only and must not implement code.

## Unknowns and open questions

- Whether the human–agent association is exclusive one-to-one or merely a primary stewardship relationship.
- Which agent fields/instructions the steward may edit without administrator approval.
- Whether agent-to-agent requests create issues, conversation messages, delegated runs, or a new work-request primitive.
- How local computer agents authenticate, advertise capabilities, and receive work.
- Whether local agents act as tools of the AgentDash agent or as peer agents with separate identity and audit history.
- What a human may approve: only actions from their own agent, or delegated requests involving their systems/data.
- How deliverables and citations/provenance flow back through a delegation chain.
- Initial non-goals and decisions the implementation team may make autonomously.

## Decision-boundary unknowns

- Ownership versus stewardship semantics for agents.
- Data-access authority and credential boundaries.
- Human approval responsibility across delegation chains.
- Product scope for the first independently deliverable phase.
- Whether Telegram belongs in the first foundation phase or follows after web-only ownership and approvals.

## Likely codebase touchpoints

- `packages/db/src/schema/agents.ts`
- `packages/db/src/schema/company_memberships.ts`
- `packages/db/src/schema/principal_permission_grants.ts`
- `server/src/services/access.ts`
- `server/src/routes/access.ts`
- `server/src/services/conversations.ts`
- `server/src/services/conversation-dispatch.ts`
- `server/src/services/agent-summoner.ts`
- `server/src/services/approvals.ts`
- `ui/src/pages/CompanyAccess.tsx`
- `ui/src/pages/CompanyInbox.tsx`
- `ui/src/pages/Inbox.tsx`
- connector and plugin webhook/session surfaces
- recent MCP onboarding and workspace runtime services

## Prompt-safe initial-context summary status

`not_needed` — the supplied context is lengthy but safe to retain as a condensed requirements narrative above; no external oversized source document was embedded.
