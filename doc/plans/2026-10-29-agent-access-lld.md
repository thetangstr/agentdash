# Agent access: what an agent can see, do and talk to — low-level design

Status: **Design for Yang's review, revision 2 (after Codex review round 1). Not authorized
for implementation, tests, migrations or rollout.**
Date: October 29, 2026. Base: `c625911` plus the uncommitted paired-harness slice on
`codex/acceptance-criteria-enforcement`.

Part of a three-document LLD:
- [overview and profile](2026-10-29-agent-performance-management-lld.md)
- [agent evaluation](2026-10-29-agent-evaluation-lld.md)
- this document.

Review record: [Codex round 1](2026-10-29-agent-pm-lld-review-codex-r1.md).

Evidence: read-only code inspection on October 29. File references say what this checkout
does, not what any tenant has configured.

## 1. Principle

Access is the most important thing a human defines for an agent (Yang, October 29).

1. **Humans define it.** A person with authority over the agent sets what it can see, do
   and talk to. An agent can ask for more; it never grants itself more. The performance
   manager proposes; a human decides.
2. **The server enforces it, at every path.** The control-plane agent MCP toolset includes
   a generic `api_request` tool (`packages/mcp-server/src/tools.ts:942-952`), so prompts
   and tool lists are not controls. A rule counts only where every route, service and
   runtime path that reaches the resource checks it. Section 4 lists those paths.
3. **People can see it.** For each item, the human sees what was requested, what is
   defined, whether it is enforced, whether it works, and whether it was used. Anything
   the server cannot enforce is labelled that way.
4. **Use is logged.** Allowed use, refusals and would-be refusals leave records. Those
   records feed the agent's evaluation.
5. **Narrow only.** The V2 policy can only take access away. It never switches on a
   behaviour, a credential fallback or an approval bypass that a company does not have today.

## 2. What exists today

The company is the only hard boundary. Inside it, an agent reads almost everything, writes
through route allowlists and a small permission-key table, and can reach anyone.

| Dimension | Mechanism today | Where | Limit |
| --- | --- | --- | --- |
| See | Company boundary for agent keys and run JWTs | `server/src/middleware/auth.ts:467-548`, `server/src/routes/authz.ts:195-205` | A hard boundary that works. |
| See | Restricted projects + `project_access` (principal type agent) | `server/src/routes/visibility.ts:53-119` | The only per-agent read scope, and it covers API reads only. |
| See | **Runtime context**: heartbeat loads the issue, wake comment and continuation documents by company and issue id | `server/src/services/heartbeat.ts:6608`, `:6638-6651`, `:6723-6732`, `:6793-6798` | No visibility check, so a queued run can carry content from a project the agent can no longer read. |
| See | **Company export**: CEO agents may export | `server/src/routes/companies.ts:186-196`, `server/src/services/company-portability.ts:3259-3277` | Export reads issues without the actor's visibility (Codex, inferred). |
| See | Agent memory: private to the agent, its steward and admins | `server/src/routes/agent-memory.ts:91-104` | Works. |
| See | Connector resolution | `server/src/services/connectors.ts:402-639` | Document providers resolve only to the current steward's private connection, on any profile (`:455-477`). Other providers resolve to the agent's own connections plus workspace-visible ones. Provider and data-scope ceilings run only on MK. |
| See | Agent visibility (`owner`/`company`) | `server/src/routes/visibility.ts:970-981` | Limits humans only. |
| Do | Permission keys (`principal_permission_grants`) | `packages/shared/src/constants.ts:658-679`, `server/src/services/access.ts:78-108` | `tasks:assign` is granted to every new agent. `tasks:assign_scope` and the grant's `scope` are never read. |
| Do | Governance: owner ceiling ∩ steward request | `packages/db/src/schema/agent_governance_policies.ts`, `packages/shared/src/types/agent-governance.ts` | Off MK, every check returns early (`server/src/services/agent-governance.ts:617`, `:697`). A non-null policy also *switches on* MK behaviours: the steward credential fallback (`connectors.ts:524`) and bridge approval selection (`bridge.ts:501-508`). |
| Do | Connector autonomy per action class `read`/`draft`/`send` | `connections.autonomy`, `connector_workspace_defaults`, `agent_connector_overrides` | No UI for generic settings or per-agent overrides. |
| Do | External writes | HubSpot only, via a mandatory `connector_send` approval (`server/src/routes/hubspot-connector.ts:176-215`) | Gmail and Slack send are board-only. |
| Do | **Runtime skills**: skills mentioned in issue text are added to the run | `heartbeat.ts:7026-7038` | Bypasses skill sync entirely. |
| Do | Skill sync: self, plus authorized peers | `server/src/routes/agents.ts:2413-2425` | Any company skill. |
| Do | Profile fields an agent may patch on itself or on peers | `agents.ts:1322-1327` (self), `:1343-1347` (peer) | Both lists include `capabilities`. |
| Do | Budgets, hard stop | `server/src/services/budgets.ts:733`, `heartbeat.ts:5402` | Works. |
| Do | Mandates (agent-to-agent delegation) | `server/src/services/mandated-action.ts:55-85` | Checked only when `POST /mandated-actions` is called. |
| Talk | Assigning work | `server/src/routes/issues.ts:472-490`, `:1262-1266` | `tasks:assign` reaches any agent. When the grant fails, CEO authority is the fallback. Company import creates assigned issues directly (`company-portability.ts:4849-4863`). |
| Talk | Wakes from comments and mentions | `server/src/services/issue-mutation-actions.ts:338`, `:402-422`, `server/src/services/issues.ts:4395-4414` | A plain comment wakes the assignee; a mention wakes the named agent. There is no allowlist for either. |
| Talk | Hand-offs | `server/src/services/agent-handoffs.ts:25`, `:67` | The three-round cap is behind a feature flag and documented as race-prone. There is no limit on *who*. |
| Talk | Questions to people | `server/src/services/human-control/authority.ts:135` | Workforce questions go to the accountable member; any other question can go to any active member. |
| Talk | Agent-authored bridge tasks to a person's machine | `server/src/services/bridge.ts:416-432`, `:467-508` | Checks the endpoint's declared capabilities; the scope between agent and endpoint is not defined. |

**Ways an agent widens its own reach today:**
- Self-add any skill, or get skills by naming them in issue text.
- Rewrite `capabilities` on itself or, with authority, on peers.
- Wake any agent with assignments, comments or mentions.
- Local adapters skip host permission prompts by default
  (`packages/adapters/claude-local/src/index.ts:58`; acpx approve-all), so the process can
  edit its host files, including its own instruction bundle.

**Told but not possible:** `server/src/onboarding-assets/default/AGENTS.md:421` tells agents
to read their policy with `GET .../governance`, which refuses agents
(`server/src/routes/agent-governance.ts:83-98`).

## 3. The access model

### 3.1 Shape

V2 extends the stored governance policy. The six V1 fields keep their meaning and
consumers. New dimensions are optional, and an omitted dimension means "not restricted by V2".

```ts
interface AgentAccessPolicy extends AgentGovernancePolicy {  // V1: permissions, monthlyBudgetCents,
  policyVersion: 2;                                          // destructiveActions, dataScopes, providers, minimumApproval
  see?: {
    projects?: ListScope;                    // projects, their issues, comments, documents, attachments
    connections?: Array<{ connectionId: string; dataScopes: string[] }>;
  };
  do?: {
    connections?: Array<{ connectionId: string; draft: Mode; send: Mode }>;
    skills?: ListScope;                      // company skills this agent may run with (all writers, §4)
  };
  talk?: {
    agents?: ContactScope & { via: Array<"assign" | "comment_wake" | "mention" | "handoff"> };
    people?: ContactScope;                   // questions, approval routing, bridge tasks
    external?: Array<{ connectionId: string; targets: { mode: "listed" | "domains" | "any"; values: string[] } }>;
    inbound?: ContactScope;                  // who may assign to, comment-wake or mention THIS agent
  };
}
type ListScope = { mode: "all" | "listed"; ids: string[] };     // listed + [] = nothing
type ContactScope = { mode: "any" | "listed" | "reports_chain" | "accountable_only";
                      agentIds?: string[]; userIds?: string[] };
type Mode = "never" | "approve" | "auto";   // auto = this policy adds no approval (§3.2); never relaxes another rule
```

Fixed rules, not policy fields:
- Agents may edit their own `name`, `title` and `icon`, as today.
- `capabilities` is profile-managed and leaves both the self and peer patch lists.
- Issue create and edit stay as they are. The V1 draft's `issueActions` and `selfEdit`
  booleans are dropped: they had no enforcement design.

### 3.2 How the effective decision is computed

**Separate evaluators.** `resolveAgentPolicy` keeps its MK meaning and its MK consumers:
credential fallback, bridge approval selection, ceilings. A new pure function,
`evaluateAccessV2(ceiling, request, target, context)`, used only by V2 checks, returns
`allow | refuse(reason)`. A V2 result can refuse something the legacy path allows. It
can never allow something the legacy path refuses, and it never switches on an MK-only
behaviour.

**Ceiling and request.** An admin sets the ceiling per agent (`AgentCeilingEditor`). The
person responsible for the agent sets the request: the steward for stewarded agents, the
accountable user for autonomous ones. An approved profile revision writes the request side.

**Combining them:**
- **List scopes:** the intersection of ids. `listed` with an empty list means nothing.
- **Contact scopes** are predicates, evaluated at check time. A target is allowed only if
  the ceiling allows it AND the request allows it. Per mode:
  - `any`: everyone;
  - `listed`: id in the list;
  - `reports_chain`: the target is in the agent's current `reportsTo` chain or among its
    direct reports, computed from live `agents.reportsTo` and never stored;
  - `accountable_only`: the agent's accountable user, steward or company admins.
- **`via`:** the set intersection.
- Effective V2 contact rules are never flattened into stored JSON, which avoids ranking
  modes that can't be ranked.

**Send precedence:** the most restrictive rule wins.

| Order | Rule | Source |
| --- | --- | --- |
| 1 | Provider-mandated approval (e.g., HubSpot always files `connector_send`) | Connector route |
| 2 | `destructiveActions` | V1 ceiling (MK today) |
| 3 | Connection autonomy (workspace default → connection → agent override) | `connectors.ts:587-616` |
| 4 | V2 `do.connections[].send` and `talk.external` targets | This design |

`auto` in V2 therefore never removes an approval required by rules 1–3. Removing one is a
separate, explicit owner decision outside this design.

**Clipping.** When a request exceeds the ceiling, the item is shown as clipped, with who
can raise the ceiling.

### 3.3 States per access item

| State | Meaning | Source |
| --- | --- | --- |
| Requested | The operating profile asks for it | Active profile revision |
| Defined | Ceiling ∧ request allow it | Stored policy |
| Enforced | The company's enforcement mode is `enforce` and every path in §4 checks it | Company setting + this matrix |
| Working | The setup exists and is healthy (connection connected, project exists, contact active) | Live check on read |
| Used | Used, refused or would-be refused in the window | Activity, connector records, `access.*` ledger events |

In `shadow` mode an item is **Defined, not enforced**, and the UI says so. "Granted" is not
used, because it would describe an unenforced rule as actual reach.

### 3.4 Writing the policy without losing history

- **Merging V1 writes.** Today's ceiling and request writers replace a whole side, and
  the normalizer rebuilds six V1 fields (`server/src/services/agent-governance.ts:238-241`,
  `:275-280`, `:553-575`). Under V2:
  - a V1-shaped write to a row that has V2 fields merges into it and keeps the V2 fields;
  - a write that *intends* to clear a V2 dimension must name it.
  - The shared parser tells a stored V1 row (upgrade on read) apart from an update that
    omits fields (merge).
- **Changes made outside the profile** are recorded as `access.policy_changed` with their
  source (admin ceiling edit, steward request edit, harness narrowing) and shown in the
  profile history as "changed outside the profile". Examples: an admin lowers a ceiling,
  a steward edits a request, a harness narrows something.
- **No silent restore.** Applying a profile refuses as stale when the governance
  revision changed after the proposal was frozen (overview LLD §4.2). An older approved
  profile cannot quietly bring back access someone removed since.

## 4. Enforcement matrix

Every V2 field has at least one row, and every path known to reach the resource is listed.
One helper, `checkAgentAccess(companyId, agentId, request)`, evaluates V2 and logs.

Per-company setting `agentAccessEnforcement`:
- `off`: no V2 check.
- `shadow`: log `access.would_refuse`, then allow.
- `enforce`: refuse.

MK V1 checks run unchanged in every mode.

| Field | Path(s) checked | Rule | On refusal (enforce) | Default (omitted) |
| --- | --- | --- | --- | --- |
| see.projects | API reads (`visibility.ts` project filter extended to listed scopes) | Project in scope | Filtered from lists; 404 on direct read | all |
| see.projects | Run claim and context hydration (`heartbeat.ts:6608` onward; wake comment; continuation documents) | Issue's project in scope at claim time, and again after a resume | Run not started; issue gets a blocker note "outside this agent's access"; owner notified | all |
| see.projects | Export preview and execution for agent actors (`company-portability.ts`) | Only in-scope projects included | Out-of-scope projects omitted and listed as withheld | all |
| see.connections | `resolveActingAs` (`connectors.ts:402-639`) via `evaluateAccessV2`, after the legacy decision | Connection id and data scope allowed | Not resolvable; reason logged | all |
| do.permissions (V1) | `hasPermission` (`access.ts:78-108`) + ceiling clamp | Existing | Existing 403 | V1 default |
| do.connections.draft / send; talk.external | `connector_send` creation (`hubspot-connector.ts:176-215`) and execution (`connector-send-execution.ts:283-340`) | Precedence table (§3.2); target in list | 403, or approval filed (never auto-executed by V2) | inherit |
| do.skills | Persistent writers: self and peer skill sync (`agents.ts:2413-2425`), hire, import. Runtime: run-scoped mentioned skills (`heartbeat.ts:7026-7038`) | Skill in scope, or in the platform's required-skill list | Writers: 403. Runtime: skill dropped from the run and logged | all |
| talk.agents + target's talk.inbound | **One wake-dispatch check** where wakeups are enqueued for assignment, comment wakes (`issue-mutation-actions.ts:338`), mentions (`:402-422`, `issues.ts:4395-4414`), hand-offs, reopen and person-to-agent routing | Source agent's outbound scope ∧ target's inbound scope ∧ `via` | Comment or record kept, wake withheld, refusal logged | any |
| talk.agents (assign) | `issues.ts:472-490`, `:1262-1266`; import (`company-portability.ts:4849-4863`) for agent actors | Same predicate. **V2 refusal overrides** the CEO and `reportsTo` fallbacks | 403 | any |
| talk.people | Question answer-owner, approval routing (`human-control/authority.ts:135`, `issue-thread-interactions.ts:458`), agent-authored bridge tasks (`bridge.ts:416-508`) | Person in scope. For bridge tasks, the endpoint must belong to the agent's steward or accountable user | 403 naming the allowed people | any (bridge: steward/accountable only, always) |

Invariants:
- **The escalation path is always open.** Accountable user, steward and company admins are
  always reachable for questions and approvals.
- **People with authority are unaffected.** Board actors with configuration authority over
  a target agent are never blocked by that agent's inbound scope.
- **A refusal is an attempt, not misconduct.** Repeating the same refused request after a
  refusal raises an exception (evaluation LLD §6.3).

**Refusal response:**
- HTTP 403, code `ACCESS_POLICY_REFUSED`.
- Body: `{ dimension, rule, requested, allowedSummary, howToRequest }`.
- Logged as `authz.refused` with `dimension` and `policyMode`.

## 5. Closing the self-widening gaps

| Gap | Change |
| --- | --- |
| Self or peer skill writes, and runtime skills from issue text | `do.skills` on every writer and on the runtime path (§4). Required platform skills are a separate, fixed list. |
| `capabilities` patched by self or peers | Removed from both lists; rendered from the profile. |
| Waking anyone through assignment, comment or mention | One wake-dispatch check (§4). The default stays `any` until a human narrows it. |
| CEO / `reportsTo` fallback after a failed grant | A V2 refusal overrides it. |
| `tasks:assign_scope` and grant `scope` never read | Retired in this design. Assignment scope is `talk.agents`, and keeping a key that looks like a control but isn't is not acceptable. |
| Agent can't read its own policy | `GET /api/agents/me/access`. |
| Instruction bundle editable on host | Detected, not prevented: at run start the server records the profile block hash actually on disk, and drift is logged. Refresh is best-effort, honours suppression and may skip external bundles (`heartbeat.ts:6585-6600`), so a refresh call is not treated as proof of delivery. |

## 6. The host boundary

This policy governs the control plane: routes, runtime context hydration, connectors,
approvals and spend. It does not govern what a local agent process does on its host.

The Access tab states the execution environment as a fact, for example:
- "Local machine, host permissions not restricted"; or
- "Managed environment `<name>`" when the agent's `defaultEnvironmentId` points at one.

Restricting the host is environment work and out of scope here.

## 7. Defaults and rollout

- **Existing agents.** Omitted V2 dimensions mean today's access. The Access tab says
  "Access not yet defined by a person". (Open item §13.1: whether to add a time limit.)
- **New agents.** They get the profile's requested access when the profile is applied.
  Before that they have their current defaults and no new grants.
- **Rollout per company: `off` → `shadow` → `enforce`.** In shadow, the owner sees what
  would have been refused (counts and a sample of cases) before anything is refused.
  Switching modes is an admin action recorded in the activity log.

## 8. What the human sees

- **Access tab:** See / Do / Talk / Spend with the five states (§3.3); "What it used" and
  "What was refused" for the window, linked to records; the execution environment; clipped
  items and who can raise them.
- **Editing** goes through a profile draft, then Request approval. Approving and applying
  stay separate records.
- **`POST /api/companies/:companyId/agents/:agentId/access/check`** answers "could this
  agent do X?" for the preview and for debugging a refusal. It reads; it never writes.
- **Company view:** agents × connections and agents × agents ("who can wake whom").

## 9. What the agent sees

`GET /api/agents/me/access` returns:
- the effective rules in plain fields;
- the escalation contacts that are always allowed;
- the current mode;
- how to request a change.

Both prompt surfaces tell agents:
- read it before touching a connection, another agent or a person outside the issue;
- on `ACCESS_POLICY_REFUSED`, don't route around it through another agent;
- record the blocker on the issue.

## 10. Link to evaluation and the profile

Access is the profile's `access` section. A change is a profile revision, or an
out-of-profile change recorded as in §3.4.

The agent card's bounds section separates:
- allowed use;
- refused attempts;
- repeated attempts after a refusal;
- would-be refusals (shadow);
- demonstrated unauthorized execution.

See the evaluation LLD §6.3. Requested-but-not-working access is a readiness gap.

## 11. Data and migrations (proposed)

1. `agent_governance_policies`: no new columns. The jsonb stores the V2 shape. The
   shared parser upgrades V1 on read and merges V1-shaped writes (§3.4).
2. `companies.agent_access_enforcement`, text, default `off`.
3. Activity actions: `access.would_refuse`, and `authz.refused` with `dimension` and
   `policyMode`. Ingested as ledger events.
4. Run start records `profileRevisionId` and the block hash read from disk in
   `heartbeat_runs.context_snapshot`. No column change.
5. Contract sync across `packages/db`, `packages/shared` (types, parser, `evaluateAccessV2`),
   `server` and `ui`. Both prompt surfaces.

## 12. Verification to write later (not run)

- **Pure functions:** `evaluateAccessV2` for every field, predicate contact scopes and
  `via`; precedence table; V1↔V2 parse and merge; clipping.
- **One test per matrix row** in off, shadow and enforce, including the paths found in
  review:
  - run claim and resume after narrowing;
  - export by a CEO agent;
  - comment wake without a mention;
  - import-assigned issues;
  - bridge tasks;
  - runtime-mentioned skills;
  - peer `capabilities` patch;
  - CEO fallback.
- **Legacy writers:** a V1-shaped write keeps V2 fields; a harness narrowing is recorded;
  a stale profile application is refused.
- **MK regression:** in all three modes, MK companies behave exactly as before, including
  the credential fallback and bridge approval selection.
- **Isolation:** `connections/resolve`, the events API and the access check stay
  company-scoped.

## 13. Open items for Yang

1. **Existing agents when a company turns on enforcement.** Recommended: keep today's
   access, labelled "not yet defined", shadow first. Optional addition: after N days
   undefined, the owner gets a review item (no hold). The alternative is locking until
   defined, which would stop running work.
2. **Who may approve access widening.** Recommended: within the admin ceiling, the
   accountable user or steward; beyond it, an admin.
