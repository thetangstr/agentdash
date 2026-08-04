# Human–Agent Workforce P0 Specification

## Metadata

- Source: Deep Interview
- Profile: Standard
- Context type: Brownfield
- Interview rounds: 10
- Final ambiguity: 5%
- Threshold: 20%
- Context snapshot: `docs/superpowers/specs/2026-07-27-human-agent-workforce-context-snapshot.md`
- Transcript: `docs/superpowers/specs/2026-07-28-human-agent-workforce-deep-interview.md`
- Prompt-safe initial-context summary: not needed

## Clarity breakdown

| Dimension | Final clarity |
|---|---:|
| Intent | 96% |
| Desired outcome | 96% |
| Scope | 96% |
| Constraints | 94% |
| Success criteria | 93% |
| Brownfield context | 90% |

Weighted ambiguity is 5%, below the 20% Standard-profile threshold. Non-goals, decision boundaries, and the pressure-pass gate are resolved.

## Intent

AgentDash should support a company operating model in which every active human participant has a dedicated digital counterpart. The agent is retained by the company as institutional capacity and memory, while the assigned human steward governs its mandate and day-to-day operation.

This model must support real company work: an executive agent delegates bounded work to stakeholder agents, those agents return attributable inputs, and the executive agent consolidates a final deliverable. Humans remain in control through policy ceilings and approval gates without being required to sit continuously inside AgentDash.

## Desired outcome

An active company member can:

1. Access AgentDash under their own identity.
2. See the company agent assigned to them.
3. Edit that agent's mandate and operating configuration.
4. Control its connections, permissions, budget, and autonomy inside company-owner ceilings.
5. Review and decide that agent's governed actions in the web Inbox.
6. Chat with the agent and decide approval requests through Telegram.
7. Chat with the agent and decide approval requests through Microsoft Teams.

The agent remains with the company when the steward changes roles or leaves. A company owner or administrator can transfer stewardship and can perform an emergency approval override. Every sensitive change and override is audited.

## P0 scope

### 1. Human–agent stewardship

- Model an explicit company-scoped stewardship relation between one human user and one agent.
- One active human has at most one primary stewarded agent in a company.
- One stewarded agent has at most one active human steward.
- Company agents may remain unassigned when no human currently fills the corresponding role.
- The relation has lifecycle history: assigned, transferred, and ended.
- Offboarding a human never transfers the agent outside the company.
- Steward transfer preserves the agent's company history, work, configuration history, and audit history.

### 2. Steward authority

The current steward may manage their agent's:

- instruction and mandate files;
- connections;
- permissions;
- budget;
- autonomy settings;
- day-to-day goals and operating preferences.

Changes are applied directly without manager pre-approval. They must create durable actor attribution, version history where applicable, and rollback evidence.

### 3. Owner policy ceilings

Company owners define ceilings that no steward may exceed:

- maximum permissions and allowed action classes;
- spending and budget ceilings;
- destructive-action policy;
- data-access boundaries;
- allowed connection/provider boundaries;
- minimum approval requirements.

Effective authority is the intersection of owner policy and steward configuration. A steward may tighten an agent but may not broaden it beyond the company ceiling. Rejected configuration changes must identify the violated ceiling.

### 4. Approval authority

- The assigned steward is the normal human decider for their agent's governed actions.
- Company owners and administrators have an emergency override.
- Other company members cannot decide the request merely because they can see the company.
- A decision is bound to the current approval/request revision so stale buttons cannot approve changed work.
- Approve, reject, expiry, supersession, and override are idempotent and audited.
- Override records identify the overriding user, reason, original steward, channel, and request revision.

### 5. Web Inbox

- Each human sees approval work for their stewarded agent.
- Owners/admins can reach an explicit emergency-override view without making every approval look routinely actionable.
- Inbox state is server-backed per user rather than relying only on browser-local read state.
- Approval details show the requesting agent, task, requested action, relevant risk/authority, and source work item.
- Decide actions are available only to the steward or an authorized owner/admin override actor.

### 6. Telegram

Telegram is the first IM delivery lane inside P0.

- A human securely pairs a Telegram identity/chat with their AgentDash user and stewarded agent.
- Inbound messages route to the paired agent under the correct company.
- Replies preserve Telegram chat/thread/topic context.
- Governed actions render native approve/reject controls.
- Approval callbacks verify Telegram user identity, company, stewardship, request revision, and current decision state.
- Webhook authenticity, replay protection, update deduplication, bot-loop prevention, rate limiting, and revocation are required.
- Revoking the pairing immediately stops inbound routing and outbound delivery.
- All external and internal message identifiers needed for audit and idempotency are retained.

### 7. Microsoft Teams

Teams is the second delivery lane inside P0 and follows the Telegram implementation.

- Build a Teams app/bot integration, not a retired Office 365 connector.
- Pair Microsoft/Entra identity and Teams conversation context to the AgentDash user and stewarded agent.
- Support direct or appropriately scoped conversational messages.
- Preserve Teams conversation/thread context in replies.
- Render native approve/reject actions using supported interactive cards.
- Validate inbound bot activities and authorize the acting Teams user against the current stewardship relation.
- Support proactive approval/notification messages only where the Teams app is installed and authorized.
- Apply the same revision binding, idempotency, audit, revocation, company isolation, and override rules as Telegram.

### 8. Agent-to-agent collaboration

P0 uses the existing issue hierarchy as the durable delegation substrate.

- An executive agent creates child issues for stakeholder agents.
- Each child retains the parent goal/project/workspace context and requester provenance.
- Stakeholder agents can return complete outputs and source evidence without being blocked by peer-comment authorization gaps.
- Completion of required child work wakes the parent/executive agent.
- The parent agent can fetch complete child artifacts rather than relying only on truncated latest-comment summaries.
- The consolidated result links back to child work and its contributors.
- Company Chat is not the system of record for multi-agent delegation in P0.

## Canonical P0 acceptance scenario

1. A company owner invites a CEO, Head of Product, Head of Engineering, and Head of Marketing as separate human members.
2. Each human is assigned one company-owned agent as steward.
3. The owner configures non-overridable company ceilings.
4. Each steward edits their agent's mandate and operating settings inside those ceilings.
5. The CEO asks the CEO agent, through AgentDash or Telegram, to prepare a board-meeting deck.
6. The CEO agent creates three child work items for the Product, Engineering, and Marketing agents.
7. Each stakeholder agent prepares its contribution. If a governed action is required, only that agent's steward can decide it normally.
8. At least one approval is completed in web Inbox, one through Telegram, and one through Teams.
9. The CEO agent is awakened when the required child work completes, retrieves the full outputs, and produces a consolidated deck or deck-ready artifact with contributor provenance.
10. The audit history shows stewardship, configuration changes, delegations, approvals, overrides if any, and the final consolidation chain.
11. Reassigning or removing a steward leaves the company agent and its institutional history intact.

## P0 non-goals

- No bridge to an already-running Codex, Claude, Cursor, or other local human-computer agent.
- No first-party Salesforce integration.
- No first-party HubSpot integration.
- No first-party Jira integration.
- No first-party SharePoint integration.
- No first-party Google Drive integration.
- No replacement of durable issue delegation with recursive Company Chat mentions.
- No personal export or transfer of a company agent when a human leaves.
- No notification-only Telegram or Teams implementation presented as complete IM support.

## P2 direction

The local Codex/Claude bridge is a scoped execution-tool relationship:

- the AgentDash agent owns the task;
- it sends a bounded request to a paired human-owned local runtime;
- the local runtime operates only within explicitly granted scope;
- the result returns with evidence and audit provenance;
- the local runtime is not modeled as a peer company agent.

P2 requires a separate design for device pairing, presence, capability discovery, consent, task delivery, credential scope, and result attestation.

## Decision boundaries

The implementation team may decide without further product confirmation:

- table and API names;
- internal service decomposition;
- provider SDK selection when official APIs are used;
- Telegram message layout and Teams Adaptive Card layout;
- UI placement details that preserve the specified authority model;
- migration mechanics and index strategy;
- exact P0 delivery sequencing, provided Telegram is completed before Teams;
- retry/backoff parameters that remain within provider rules;
- test fixture and mock-server structure.

The implementation team must return for product confirmation before:

- allowing more than one active steward for an agent;
- allowing a steward to exceed owner ceilings;
- allowing ordinary non-stewards to approve an agent's request;
- weakening audit or approval-revision binding;
- adding direct SaaS integrations to P0;
- moving the local computer-agent bridge into P0;
- treating the local computer agent as a peer agent;
- replacing issue-based delegation with chat-only orchestration.

## Constraints

- All new data and operations are company-scoped.
- Steward identity is a human authenticated user, not an arbitrary string.
- Company access alone does not imply stewardship or approval authority.
- Effective policy must fail closed when stewardship, identity binding, or provider verification is missing.
- Provider callbacks must be authenticated using official platform mechanisms.
- External events and approval callbacks must be deduplicated.
- External identities and chats cannot be rebound across companies without explicit revocation/re-pairing.
- Tokens and secrets remain encrypted and are cleared on revocation.
- Mutations write activity records with user, agent, company, channel, and related work identifiers.
- Agent-facing behavior changes update all four mandatory AgentDash prompt surfaces.
- Existing company role and permission hierarchy remains enforceable.
- Free-tier human limits may remain a commercial policy, but P0 behavior must work for a multi-human entitled company.

## Testable acceptance criteria

1. Database constraints prevent two active primary agents for one human and two active stewards for one agent.
2. Steward transfer is atomic and retains agent history.
3. A steward can edit only their assigned agent unless separately authorized by an existing company role.
4. Owner ceilings reject over-broad permission, budget, destructive-action, data-access, and approval-policy changes.
5. Every accepted or rejected configuration change has actor and revision provenance.
6. Only the steward can decide an ordinary approval; owner/admin override requires an explicit override path and reason.
7. Web Inbox queries are user-scoped and server-backed.
8. Telegram inbound messages cannot cross company or pairing boundaries.
9. Telegram approval callbacks are signed/verified, user-bound, revision-bound, deduplicated, and idempotent.
10. Teams messages and interactive-card actions satisfy the same identity, company, revision, deduplication, and idempotency requirements.
11. Revoking either IM connection immediately prevents further sends and inbound dispatch.
12. Parent/child issue delegation completes the canonical CEO-to-three-stakeholders scenario using agent-authenticated execution.
13. Stakeholder agents can submit complete contributions and the parent can retrieve them without lossy summary dependence.
14. The final consolidated artifact links to all required child contributions.
15. Audit queries reconstruct the full human → agent → delegated agent → approval → final artifact chain.
16. No P0 route or UI claims support for the deferred local computer-agent bridge or excluded direct SaaS integrations.

## Verification expectations

- Unit tests for stewardship policy intersection, lifecycle rules, provider payload normalization, callback authorization, and idempotency.
- Database/service integration tests for company isolation, uniqueness, transfer, ceilings, approval authority, and audit history.
- Route tests for authenticated user roles, steward checks, emergency override, revocation, and cross-company denial.
- Telegram webhook contract tests with exact update IDs and callback-query replay cases.
- Teams bot activity/card-action contract tests with identity and conversation binding.
- Agent-authenticated delegation-chain tests, not board-only stand-ins.
- UI tests for My Agent, steward-scoped Inbox, ceiling errors, pairing/revocation, and override affordances.
- End-to-end coverage of the canonical board-deck scenario.

## Assumptions exposed and resolved

- **Personal versus institutional agent:** institutional; the company retains it.
- **Steward versus owner:** the human is steward; the company is owner.
- **Mandate-only control versus operational control:** comprehensive steward control.
- **Unlimited steward authority:** rejected; owner ceilings are non-overridable.
- **Local computer agent as peer:** rejected; future scoped execution tool.
- **Local bridge timing:** P2.
- **Messaging scope:** Telegram and Teams are both P0, delivered in that order.
- **IM approvals:** native approve/reject in both providers.
- **Approval authority:** assigned steward, with emergency owner/admin override.
- **Direct SaaS integrations:** excluded from P0.
- **Delegation substrate:** durable parent/child issues, not recursive Company Chat.

## Brownfield evidence

### Auto-confirmed facts

- Human membership and permission primitives exist in `packages/db/src/schema/company_memberships.ts`, `packages/db/src/schema/principal_permission_grants.ts`, and `server/src/services/access.ts`.
- Agents have no human steward field or relation in `packages/db/src/schema/agents.ts`.
- Agent instruction editing and revision/rollback surfaces exist in `server/src/services/agent-instructions.ts` and `server/src/routes/agents.ts`.
- Approval records exist in `packages/db/src/schema/approvals.ts`; current decision routes are board-scoped rather than steward-scoped.
- Web Inbox is composed in `ui/src/pages/Inbox.tsx`.
- Conversation mention dispatch exists in `server/src/services/conversation-dispatch.ts`, but production invocation is incomplete.
- Parent/child issue delegation and parent wakeups exist in `server/src/routes/issues.ts` and `server/src/services/issues.ts`.
- The MCP server uses local stdio-to-REST control and does not implement paired-device presence.

### Inferences requiring implementation validation

- Existing membership and agent instruction primitives can support stewardship without replacing the human access model.
- Existing issue hierarchy can support the canonical collaboration scenario after peer-contribution and full-artifact retrieval gaps are closed.
- Telegram and Teams should share a normalized IM binding/event/approval layer rather than duplicating provider-specific authorization logic.

## Pressure-pass result

The final model preserves a deliberate tension:

- company ownership provides continuity and hard safety boundaries;
- human stewardship provides direct operational control and accountability;
- approval authority follows the steward relationship;
- owners/admins retain an exceptional, visible override;
- IM increases accessibility without becoming the source of authority;
- durable company work remains issue-based and auditable.
