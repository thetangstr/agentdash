# AgentDash-MK Claude Code Handoff

**Prepared:** 2026-07-28

**Status:** Paused after Tasks 1–2; Task 3 has not started

**Branch:** `codex/agentdash-mk`

**HEAD:** `01a4748c5233be67dde26fa4e92748d4be7a772d`

**Working tree:** Clean

## 1. Start here

Continue in this worktree:

```sh
cd /Users/Kailor/.config/superpowers/worktrees/agentdash/agentdash-mk
git status --short
git branch --show-current
```

Expected:

- branch: `codex/agentdash-mk`
- no uncommitted files
- HEAD: `01a4748c`

Do not implement this work in the primary checkout at
`/Volumes/home/Projects_Hosted/agentdash`. The primary checkout remains on
`main`. The internal-disk worktree is intentional: dependency linking and test
execution were prohibitively slow in a project-local worktree on the hosted
volume.

Read, in order:

1. `/Volumes/home/Projects_Hosted/agentdash/AGENTS.md`
2. `doc/GOAL.md`
3. `doc/PRODUCT.md`
4. `doc/SPEC-implementation.md`
5. `doc/DEVELOPING.md`
6. `doc/DATABASE.md`
7. `docs/superpowers/specs/2026-07-28-agentdash-mk-design.md`
8. `doc/plans/2026-07-28-agentdash-mk-implementation.md`
9. This handoff

The approved design is authoritative for product intent. The implementation
plan is authoritative for sequencing and test shape. This handoff is
authoritative for current branch state and completed-work evidence.

## 2. Product goal

AgentDash-MK is an additive company profile inside AgentDash. It creates a
one-to-one relationship between an active company human and a company-owned
agent.

The assigned human is the agent's **steward**:

- the steward controls the agent's mandate and requested configuration;
- the company owner/admin sets maximum permission, spending,
  destructive-action, data-access, provider, and minimum-approval ceilings;
- the steward controls everything inside those ceilings;
- normal governed-action approval belongs to the current steward;
- owner/admin emergency override is separate, explicit, reasoned, and audited;
- the agent, its history, work, and configuration remain with the company when
  the steward changes or leaves.

The target collaboration flow is:

1. A human asks their assigned agent to produce work.
2. That agent delegates contributions to other company agents through durable
   AgentDash issues.
3. Each contributing agent retrieves available company information or asks its
   steward for missing information.
4. Contributions return to the parent issue with provenance.
5. The requesting agent assembles the final work product for its steward.

## 3. Approved scope and priorities

### P0

- explicit `agentdash_mk` company profile;
- one active steward per agent and one active agent per human;
- historical, atomic stewardship transfer;
- owner governance ceilings and steward-scoped configuration;
- steward-scoped approvals plus owner/admin emergency override;
- My Agent web experience;
- authenticated, server-backed personal Inbox;
- stewardship and policy administration UI;
- shared human-channel binding, revocation, idempotency, and delivery audit;
- Telegram bidirectional chat and native approve/reject actions;
- Microsoft Teams bidirectional chat and native approve/reject actions;
- complete child-agent contribution/provenance handling;
- all required prompt and product documentation updates;
- end-to-end acceptance coverage.

Telegram must be complete before Teams is presented as complete. Teams remains
P0.

### P2

- only the local Codex/Claude computer-agent bridge.

The future bridge is a scoped execution tool: the AgentDash agent owns the task
and asks the local computer agent to retrieve or perform specific work. Do not
implement it during P0.

### Explicitly out of scope

- new first-party Salesforce integrations;
- new HubSpot integrations;
- new Jira integrations;
- new SharePoint integrations;
- new Google Drive integrations;
- WhatsApp;
- a separate AgentDash fork or separate release line.

Existing integrations and human-provided information may still be used. Do not
add new P0 integration projects for the systems above.

## 4. Key architecture decisions

- `agentdash_mk` is a company product profile, not a fork.
- Existing companies default to the `default` profile.
- Server authorization is authoritative; UI hiding is presentation only.
- Profile-only routes must return the same 404-style response as unavailable
  routes when the company is not `agentdash_mk`.
- User references in stewardship history are durable text principals, matching
  `company_memberships.principal_id`. They intentionally do not FK to
  `auth_users`, because principals and historical attribution must survive auth
  identity lifecycle changes.
- Owner ceilings, steward requests, and effective policies are separate,
  typed, versioned records.
- The effective policy is the intersection of owner ceiling and steward
  request.
- The approval service is the only decision boundary. Telegram and Teams
  adapters must never update approval rows directly.
- Human/channel pairing is separate from shared bot/app credentials.
- Agent-to-agent work is anchored to issues, comments, documents, and work
  products—not ephemeral chat alone.
- Telegram webhook authentication must use
  `X-Telegram-Bot-Api-Secret-Token`; `update_id` is the replay/deduplication
  anchor; callback data must stay within Telegram's 64-byte limit; callback
  queries must be answered.
- Teams implementation must use the current TypeScript SDK
  `@microsoft/teams.apps` and Adaptive Card `Action.Execute`. Do not introduce
  the archived Bot Framework SDK or build new cards around legacy
  `Action.Submit`.

## 5. Completed work

### Task 1 — Product-profile contract

Completed and independently specification/quality reviewed.

Implemented:

- shared `COMPANY_PRODUCT_PROFILES = ["default", "agentdash_mk"]`;
- shared `CompanyProductProfile`;
- required `Company.productProfile`;
- strict create/update contract support;
- `companies.product_profile text NOT NULL DEFAULT 'default'`;
- generated migration `0096_company_product_profile.sql`;
- `requireProductProfile()` with 404-style mismatch behavior;
- explicit creation of `agentdash_mk` companies;
- owner/admin-only product-profile migration through the company PATCH route;
- updated UI and CLI typed fixtures.

Profile mutation authorization:

- allowed for local implicit board;
- allowed for instance admin;
- allowed for active company `owner` or `admin`;
- denied to ordinary operators;
- unrelated company updates retain their existing authorization.

Primary tests:

- `server/src/__tests__/agentdash-mk-profile.test.ts`
- `server/src/__tests__/companies-service.test.ts`
- `server/src/__tests__/companies-email-domain-route.test.ts`
- `ui/src/context/CompanyContext.test.tsx`
- `cli/src/__tests__/company-delete.test.ts`

Task 1 commits:

```text
ce0e689c Preserve product-specific company contracts
ccc978e9 Keep migration snapshots on the committed chain
ab9e593f Restrict profile migration to company administrators
```

### Task 2 — Stewardship history and atomic transfer

Completed and independently specification/quality reviewed.

Implemented:

- `agent_stewardships` historical relation;
- company and agent FKs;
- durable text principal IDs for steward and actors;
- partial unique indexes enforcing:
  - one active stewardship per company/user;
  - one active stewardship per company/agent;
- strict shared assign/transfer validators;
- company-scoped service reads and mutations;
- stable conflict handling for uniqueness/races;
- transaction-scoped membership and agent eligibility checks;
- row locking for assignment, transfer, and archival;
- atomic transfer that ends the old row and inserts the new row;
- exactly one in-transaction `agent.stewardship_transferred` activity;
- self-only current-agent lookup;
- owner/admin assignment and transfer authorization;
- member archival and instance-admin access removal end stewardship while
  preserving agent/history;
- correct audit attribution to the acting administrator;
- concurrency regressions for assignment versus offboarding.

Mounted routes:

```text
GET  /api/companies/:companyId/me/agent
POST /api/companies/:companyId/agent-stewardships
POST /api/companies/:companyId/agents/:agentId/stewardship/transfer
```

Additional company-scoped active/history read routes are implemented in
`server/src/routes/agent-stewardships.ts`.

Mutation authorization:

- board actors only;
- local implicit board and instance admin retain their existing conventions;
- other users require `accessService.canUser(companyId, userId, "agents:create")`;
- agent callers cannot assign or transfer stewardship.

Primary tests:

- `server/src/__tests__/agent-stewardships.test.ts`
- `server/src/__tests__/access-service.test.ts`

Task 2 commits:

```text
4d19cf2f Preserve human-agent stewardship history
ab39cc44 Close stewardship validation race gaps
efc5326b Close stewardship offboarding attribution gaps
5c463f35 Serialize member archival with stewardship assignment
01a4748c Lock member archival before stewardship cleanup
```

## 6. Current verification state

Before feature work, the full baseline `pnpm test` passed from this worktree.

After Task 2, the following fresh checks passed:

```sh
pnpm exec vitest run \
  server/src/__tests__/agent-stewardships.test.ts \
  server/src/__tests__/access-service.test.ts

pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/db typecheck
pnpm --filter @paperclipai/server typecheck
pnpm --filter paperclipai typecheck
pnpm -r typecheck
pnpm --filter @paperclipai/db run check:migrations
git diff --check
```

The stewardship/access suite reported 17 passing tests at the final review.

Full post-feature `pnpm test:run`, `pnpm build`, and browser acceptance tests have
not yet been run. Those are required in Task 12.

## 7. Migration warning

This repository has a sparse committed Drizzle snapshot history.

Current chain:

- `0079_snapshot.json` was the last pre-feature committed snapshot;
- `0096_snapshot.json.prevId` points to the committed `0079` snapshot ID;
- `0097_snapshot.json.prevId` points to `0096`;
- the journal includes migrations `0096` and `0097`.

The next schema task should generate migration `0098` and verify that its
snapshot points to `0097`.

`pnpm db:generate` may show a rename prompt because migrations after `0079`
previously existed without snapshots. Do not invent snapshot IDs or accept an
unrelated rename. Use generator-backed output, inspect the SQL, and verify:

```sh
pnpm --filter @paperclipai/db run check:migrations
```

Do not commit `pnpm-lock.yaml`; repository CI owns lockfile updates for this
work.

## 8. Exact continuation point

Resume at **Task 3: Owner ceilings and steward configuration** in:

`doc/plans/2026-07-28-agentdash-mk-implementation.md`

No Task 3 production or test files were left behind. The Task 3 implementer was
stopped before it changed the worktree.

Task 3 must deliver:

- typed, versioned owner ceiling;
- typed, versioned steward request;
- computed effective policy;
- deterministic pure policy intersection;
- stable ceiling violation codes;
- accepted and rejected mutation audit;
- owner/admin ceiling authorization;
- current-steward requested-configuration authorization;
- optimistic revision conflict behavior;
- 404 profile gating for non-`agentdash_mk` companies;
- steward-or-admin authority on existing agent configuration mutations;
- effective-policy enforcement at service boundaries, not only in UI.

Pay special attention to rejected-attempt audit durability: logging inside a
transaction that is later rolled back does not persist. Design the service so a
rejected attempt is recorded without accidentally committing the rejected
policy.

Use strict TDD:

1. add failing governance tests;
2. demonstrate RED;
3. implement the smallest complete slice;
4. run focused tests and typechecks;
5. self-review authorization and transaction boundaries;
6. commit using the Lore protocol;
7. obtain specification review;
8. fix gaps;
9. obtain code-quality review;
10. proceed only when both pass.

## 9. Remaining implementation sequence

Complete the plan in order:

1. ~~Task 1: Product-profile contract~~
2. ~~Task 2: Stewardship history and atomic transfer~~
3. Task 3: Owner ceilings and steward configuration
4. Task 4: Steward-scoped approvals and emergency override
5. Task 5: My Agent and server-backed personal Inbox
6. Task 6: Stewardship and policy administration UI
7. Task 7: Shared human-channel bindings and event deduplication
8. Task 8: Telegram chat and native approvals
9. Task 9: Microsoft Teams chat and Adaptive Card approvals
10. Task 10: Complete child contributions and provenance
11. Task 11: Prompt and documentation synchronization
12. Task 12: End-to-end acceptance and full verification

Do not present Teams as complete before Telegram satisfies its complete P0
contract.

## 10. Mandatory prompt synchronization

Before the branch is complete, every agent-facing behavior change must update
all four surfaces in the same branch/PR:

1. `server/src/onboarding-assets/default/AGENTS.md`
2. `server/src/onboarding-assets/ceo/AGENTS.md`
3. `server/src/onboarding-assets/chief_of_staff/AGENTS.md`
4. `server/src/services/agent-creator-from-proposal.ts`

Use AgentDash named blocks as required by the repository instructions. Content
must be adapter-neutral:

- HTTP endpoints rather than adapter-specific tool names;
- JSON field names rather than UI-only descriptions;
- card **or comment** fallbacks where rendering capabilities differ.

Do not use the CI bypass for this feature.

## 11. Repository rules that matter most

- Every new domain object and route must be company-scoped.
- Enforce company boundaries in service and route layers.
- Keep DB, shared types/validators, server, UI, and docs synchronized.
- Preserve single-assignee task semantics.
- Preserve atomic checkout behavior.
- Preserve approval gates and budget hard stops.
- Log all mutations.
- Use consistent `400/401/403/404/409/422/500` errors.
- Keep default-profile behavior unchanged.
- Use `apply_patch` for manual file edits.
- Prefer existing utilities and patterns; do not add abstractions or
  dependencies without need.
- Generate migrations rather than hand-authoring the intended schema delta.
- Do not commit `pnpm-lock.yaml`.
- Commits must use the Lore commit format from `AGENTS.md`.
- Do not push or open a PR unless explicitly requested.

## 12. Definition of done

Do not call AgentDash-MK complete until all are true:

- all 12 plan tasks are implemented;
- Telegram and Teams both support native approve/reject in conversation;
- stale/replayed provider callbacks fail closed or return the original
  idempotent terminal result;
- web and IM decisions share the approval service;
- owner ceilings and steward authority are enforced server-side;
- offboarding and transfer preserve company agent/history;
- child-agent contributions are complete and traceable;
- all four prompt surfaces are synchronized;
- product/developer/operator docs are updated;
- `pnpm -r typecheck` passes;
- `pnpm test:run` passes;
- `pnpm build` passes;
- relevant Playwright acceptance tests pass;
- migration checks pass;
- working tree is clean;
- final requirements audit has no unimplemented P0 item.

## 13. Suggested Claude Code kickoff prompt

```text
Continue the AgentDash-MK implementation in:
/Users/Kailor/.config/superpowers/worktrees/agentdash/agentdash-mk

Read AGENTS.md, the approved design, the implementation plan, and
doc/plans/2026-07-28-agentdash-mk-claude-code-handoff.md in full.

The branch is codex/agentdash-mk at 01a4748c. Tasks 1 and 2 are complete,
reviewed, and verified. Resume at Task 3 only. Use strict TDD, preserve the
default profile, keep every route/service company-scoped, generate coherent
Drizzle migration metadata, do not commit pnpm-lock.yaml, and use Lore commit
messages. After implementation, run focused verification, then perform separate
specification and code-quality reviews before starting Task 4.

Do not implement the local Codex/Claude bridge; it is P2. Do not add new
Salesforce, HubSpot, Jira, SharePoint, Google Drive, or WhatsApp integrations.
Telegram must be complete before Teams is presented as complete.
```
