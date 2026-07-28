# AgentDash-MK Design

**Status:** Approved design  
**Date:** 2026-07-28  
**Product profile:** `agentdash_mk`  
**Source:** `.omx/specs/deep-interview-human-agent-workforce.md`

## 1. Purpose

AgentDash-MK is a first-class company profile inside the AgentDash platform. It
implements a one-to-one relationship between a human company member and a
company-owned agent, with the human acting as that agent's steward.

The profile is additive. It does not fork AgentDash, replace the existing
company model, or change behavior for companies that do not enable
`agentdash_mk`. A starter company package may seed the canonical executive team,
but the enforceable behavior belongs to the shared platform.

## 2. Product outcome

For every active human in an AgentDash-MK company:

- the company may assign one primary company-owned agent;
- the human can edit and operate that agent within company-owner ceilings;
- governed actions are decided by the assigned steward;
- owners and administrators retain an explicit emergency override;
- approvals can be decided in AgentDash, Telegram, or Microsoft Teams;
- company work remains anchored to durable issues, comments, documents, and
  work products.

When a steward changes roles or leaves, the agent, configuration history, work,
and audit history remain with the company.

## 3. Approaches considered

### 3.1 First-class profile plus starter package — selected

The shared platform exposes an `agentdash_mk` profile. Profile-enabled companies
receive the workforce governance, My Agent, personal Inbox, and IM features.
An optional company package provides a useful executive-team starting point.

This preserves one release line and lets security, connector, and orchestration
fixes benefit every profile.

### 3.2 Starter package only — rejected

A package can create agents, mandates, projects, and starter tasks, but it cannot
enforce steward identity, approval authority, policy ceilings, webhook
authenticity, or revocation.

### 3.3 Separate fork — rejected

A fork would offer strong visual isolation but duplicate migrations, auth,
connectors, and governance code. It conflicts with AgentDash's existing strategy
of one horizontal platform with profiles and starter companies.

## 4. Scope and sequencing

AgentDash-MK P0 is delivered as four independently testable slices:

1. **Governance core:** product profile, stewardship, owner ceilings, steward
   configuration, approval authority, override audit, and issue contribution
   completeness.
2. **Web experience:** My Agent, steward-scoped Inbox, owner policy editor,
   stewardship assignment and transfer, and audit visibility.
3. **Telegram:** secure human pairing, bidirectional chat, native approvals,
   revocation, replay protection, and delivery audit.
4. **Microsoft Teams:** Entra-backed pairing, bot conversations, Adaptive Card
   approvals, revocation, replay protection, and delivery audit.

Telegram must reach the complete P0 contract before the Teams provider is
presented as complete. Teams remains part of P0.

The local Codex/Claude computer-agent bridge is P2. New first-party Salesforce,
HubSpot, Jira, SharePoint, and Google Drive integrations are not part of this
work.

## 5. Profile architecture

### 5.1 Company profile

Companies gain a stable product-profile value with exactly two initial keys:
`default` and `agentdash_mk`. Existing companies backfill to `default`.
`agentdash_mk` is selected during company creation, import, or an explicit
owner/admin migration.

Profile checks are centralized in a shared helper rather than scattered string
comparisons. Server authorization is authoritative; UI gating is presentation
only.

The profile controls availability of:

- stewardship assignment;
- owner policy ceilings;
- My Agent;
- the steward-scoped Inbox;
- human IM bindings;
- Telegram and Teams configuration;
- AgentDash-MK starter-company import.

Profile changes are audited. Disabling the profile does not delete workforce
records. It revokes active IM bindings and prevents new profile-only mutations
until re-enabled or explicitly migrated.

### 5.2 Branding

The global product remains AgentDash. Profile-enabled company surfaces show
“AgentDash-MK” as a company-profile label and use workforce-oriented navigation
and copy. CLI names, package scopes, storage keys, and public platform branding
do not fork.

## 6. Governance domain

### 6.1 Stewardship

`agent_stewardships` is a company-scoped historical relation with:

- company, agent, and human user identity;
- lifecycle state and effective timestamps;
- assignment, transfer, and ending actor attribution;
- transfer reason;
- created and updated timestamps.

Database constraints enforce:

- one active primary agent per human per company;
- one active steward per agent;
- referenced membership and agent belong to the same company.

Transfer is transactional: end the old active relation and create the new one in
one transaction. Ending a membership ends its active stewardship but never
deletes or exports the agent.

### 6.2 Owner ceilings and steward settings

Governance configuration is typed, versioned, and separated into:

- an owner-controlled ceiling;
- a steward-controlled requested configuration;
- a computed effective configuration.

The ceiling covers:

- allowed permissions and action classes;
- maximum monthly spend and subordinate budget;
- destructive-action requirements;
- allowed data scopes;
- allowed connector/provider boundaries;
- minimum approval requirements.

The effective configuration is computed as:

`owner ceiling ∩ steward request`

The intersection function is a pure shared-domain function with exhaustive unit
tests. It is reused by API mutations and runtime authorization. A rejected
request returns a stable semantic error that identifies the violated ceiling
without exposing secrets.

Owners/admins edit ceilings. The current steward edits the requested
configuration for their assigned agent. Existing role permissions continue to
authorize broader administrative actions; stewardship does not silently grant
company-wide agent administration.

Every accepted and rejected configuration mutation records:

- acting human;
- company and agent;
- old and requested revision;
- effective result or rejection code;
- channel;
- timestamp.

### 6.3 Mandates and connections

Mandate editing reuses the existing instruction-bundle revision and rollback
system. Steward authorization is added at the service boundary and is not
implemented as a UI-only exception.

Connections continue to use AgentDash's connector records and encrypted tokens.
The steward may select or configure only providers allowed by the owner ceiling.
Company-wide credentials remain owner/admin-controlled unless an existing
permission explicitly grants broader access.

## 7. Approval domain

The approval service becomes the single decision boundary for web and IM.
Provider routes never update approval rows directly.

Approvals gain:

- a monotonically increasing request revision;
- decision channel;
- idempotency key;
- decision actor and role;
- optional emergency-override reason;
- superseded and expiry metadata.

Normal approve/reject authority belongs to the current steward of the requesting
agent. Owners/admins use a distinct override action that requires a reason and
is visibly labeled as exceptional. Ordinary company membership is insufficient.

Every decision re-resolves current company membership, active stewardship,
approval revision, and approval status. Stale buttons fail closed. Repeated
delivery of the same valid callback returns the original terminal result without
duplicating side effects.

## 8. Web experience

### 8.1 My Agent

AgentDash-MK adds a My Agent route that shows:

- assigned agent identity, status, and current work;
- mandate editor and revision history;
- requested and effective permissions, autonomy, and budget;
- owner-ceiling explanations;
- connected communication channels;
- recent approval and activity history.

Unassigned users see an explicit “No agent assigned” state. Owners/admins receive
an assignment action; ordinary users do not self-claim agents.

### 8.2 Inbox

Inbox aggregation moves behind a server query scoped to the authenticated user.
It returns approvals and governed interactions for the user's active stewarded
agent, plus existing user-owned work.

Owners/admins can enter a separate emergency-override view. Override controls do
not appear as ordinary approval controls.

Read, archive, and decision state are server-backed per user. Approval detail
includes requesting agent, source issue, requested action, risk, effective
authority, revision, and decision history.

### 8.3 Administration

AgentDash-MK company settings include:

- product-profile status;
- agent/steward assignment and transfer;
- owner ceiling editor;
- Telegram bot configuration and human bindings;
- Teams app configuration and human bindings;
- revocation and audit history.

## 9. Shared IM architecture

The existing connector service remains the credential and outbound-autonomy
foundation. Human identity/channel pairing is modeled separately because one
company bot/app credential may serve many human conversations.

### 9.1 Human channel bindings

`human_channel_bindings` associates:

- company;
- authenticated AgentDash user;
- current stewarded agent;
- provider;
- external tenant/account/user identity;
- conversation/chat/thread coordinates;
- verified and revoked timestamps;
- provider metadata.

Active bindings are unique for the relevant provider identity and company.
Rebinding requires explicit revocation and a new verification ceremony.

### 9.2 External events

`external_channel_events` retains provider event identifiers, normalized event
type, binding, approval revision where applicable, processing state, timestamps,
and a payload digest. It is the deduplication and audit boundary; raw secrets and
unnecessary message content are not retained.

### 9.3 Provider interface

Telegram and Teams implement a normalized interface for:

- authenticate/verify inbound request;
- normalize event;
- resolve active human binding;
- route human message;
- render approval request;
- deliver agent response;
- acknowledge callback;
- revoke delivery.

Provider adapters may differ in payload shape but cannot bypass shared
authorization, approval, idempotency, or audit services.

## 10. Telegram

Telegram is the first provider.

- A company owner configures the bot token through encrypted secret storage.
- A signed, short-lived pairing challenge links an authenticated AgentDash user
  to a Telegram user and chat.
- Webhooks use Telegram's secret-token header and strict route configuration.
- Update IDs are deduplicated before dispatch.
- Messages route only through an active binding to the user's current stewarded
  agent.
- Agent replies preserve chat, topic, and reply coordinates where supported.
- Approval messages use inline keyboard approve/reject controls.
- Callback data contains an opaque, short-lived server token rather than raw
  authority data.
- Callback handling re-resolves identity, binding, stewardship, revision, and
  approval status.
- Revocation immediately blocks sends and inbound dispatch.

Bot loops, unsupported group contexts, unpaired identities, stale callbacks, and
cross-company references fail closed and generate safe audit events.

## 11. Microsoft Teams

Teams is implemented as a Microsoft Teams bot/app, not an Office 365 connector.

- Company/instance configuration uses the supported Microsoft identity and bot
  registration flow.
- Inbound Bot Framework activities are validated using official mechanisms.
- The Entra/Teams actor and conversation are paired to the AgentDash user.
- Agent replies preserve conversation references needed for proactive messages.
- Approval requests use Adaptive Cards with approve/reject actions.
- Card actions carry opaque server tokens and pass through the same shared
  decision service used by web and Telegram.
- Proactive delivery is attempted only when the app is installed and an active
  conversation reference is available.
- Tenant changes, app uninstall, identity mismatch, revocation, stale revisions,
  and duplicate activities fail closed.

## 12. Agent-to-agent collaboration

Parent/child issues remain the durable delegation substrate.

The implementation closes three current gaps:

1. stakeholder agents can post complete contributions to delegated child work
   without relying on an unauthorized peer-comment path;
2. the parent agent can retrieve complete child documents and work products,
   not only a truncated latest-comment summary;
3. consolidated output retains explicit links to every required child
   contribution and contributing agent.

Completing required child work wakes the parent agent once. The wakeup payload
contains references, not lossy embedded substitutes for the source artifacts.
Company Chat remains a convenience surface and is not the system of record.

## 13. Security and failure behavior

- Every new row and operation is company-scoped.
- Human identity comes from the authenticated session and verified provider
  binding, never request-supplied user IDs.
- Webhook verification occurs before parsing or dispatch with provider-specific
  semantics.
- Missing provider secrets, missing bindings, revoked connections, and ambiguous
  authority fail closed.
- Provider events and approval decisions are idempotent.
- Secrets use existing encrypted storage and are zeroed or made inaccessible on
  revocation.
- Activity records include company, acting user, agent, channel, approval/work
  identifiers, and override reason where applicable.
- Logs redact tokens, callback secrets, message authorization tokens, and
  provider credentials.
- Rate limits apply by provider, company, binding, and source address where
  meaningful.

## 14. Testing strategy

Development follows red-green-refactor.

### 14.1 Unit tests

- profile capability resolution;
- owner-ceiling intersection and stable rejection reasons;
- stewardship transition rules;
- approval actor resolution and revision binding;
- provider payload normalization;
- callback token expiry and idempotency.

### 14.2 Database and service tests

- partial uniqueness of active stewardships;
- atomic transfer and membership offboarding;
- company isolation;
- accepted/rejected governance revisions;
- ordinary decision versus emergency override;
- binding uniqueness, revocation, and event deduplication;
- full child-contribution retrieval and provenance.

### 14.3 Route tests

- role and steward authorization;
- cross-company denial;
- stale revision conflicts;
- webhook authenticity;
- callback replay;
- connector revocation;
- missing configuration fail-closed behavior.

### 14.4 UI tests

- My Agent assigned/unassigned states;
- ceiling explanations and rejected changes;
- steward-scoped Inbox;
- explicit override presentation;
- pairing, connected, revoked, and error states.

### 14.5 End-to-end acceptance

The final browser/API scenario creates CEO, Product, Engineering, and Marketing
humans and agents, assigns stewardship, configures ceilings, delegates three
child contributions, completes governed actions through web, Telegram, and
Teams, wakes the CEO agent, and verifies a consolidated artifact with complete
provenance.

Provider E2E uses deterministic local mock endpoints for CI plus documented
provider sandbox checks for live Telegram and Teams credentials.

## 15. Migration and compatibility

- Existing companies default to the current AgentDash profile.
- New nullable/backfilled fields and additive tables avoid destructive
  migration.
- Existing board approval behavior remains unchanged outside
  `agentdash_mk` until deliberately generalized.
- Existing connector rows remain valid.
- Existing agents may be assigned a steward after profile activation.
- Export/import preserves the profile, stewardship declarations without user
  secrets, owner policies, and starter-company structure. Human identities and
  IM bindings must be re-established at the destination.

## 16. Agent-facing prompt impact

The implementation changes how agents discover their steward, request governed
actions, create delegated work, return complete contributions, and handle quota
or authorization failures. Every slice must update all four mandatory prompt
surfaces:

- `server/src/onboarding-assets/default/AGENTS.md`;
- `server/src/onboarding-assets/ceo/AGENTS.md`;
- `server/src/onboarding-assets/chief_of_staff/AGENTS.md`;
- `server/src/services/agent-creator-from-proposal.ts`.

AgentDash-specific guidance is wrapped in named blocks and remains
adapter-neutral.

## 17. Acceptance criteria

AgentDash-MK is complete only when:

1. `agentdash_mk` can be enabled without changing non-profile company behavior.
2. Database constraints enforce one active primary stewardship in both
   directions.
3. Steward transfer is atomic and retains company agent history.
4. Stewards can manage only their assigned agents unless separately authorized.
5. Owner ceilings reject every specified class of over-broad configuration.
6. Accepted and rejected changes retain actor and revision provenance.
7. Ordinary approvals are steward-only and emergency overrides are explicit,
   reasoned, and audited.
8. The web Inbox is authenticated-user scoped and server-backed.
9. Telegram provides secure pairing, bidirectional agent conversation, native
   approvals, deduplication, and immediate revocation.
10. Teams provides equivalent behavior with a supported bot/app and Adaptive
    Cards.
11. Parent/child delegation completes the CEO-to-three-stakeholders scenario
    using agent-authenticated execution and complete artifacts.
12. The final result links every required contribution and reconstructs the full
    audit chain.
13. No P0 surface claims the deferred local computer-agent bridge or excluded
    direct SaaS integrations.
14. Targeted tests, repository typecheck, test suite, build, and relevant
    browser suites pass before handoff.
