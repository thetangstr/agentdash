# AgentDash (IGT) Full Architecture Plan

## Context

AgentDash is a fork of Paperclip (AI agent orchestration control plane) extended with 7 major new systems to make it enterprise-grade: Agent Factory, Task Dependencies, AutoResearch, Integrations, Security/Policy Engine, Budget improvements, Skills Registry, and Onboarding. The goal is a deployable orchestration layer for baremetal/cloud that plugs into existing company infrastructure. We also incorporate design patterns from ClawTeam (auto-injected coordination prompts, task dependency DAG, team templates).

**Key architectural principle**: New features are built as additive layers — new tables, new services, new packages — minimizing changes to existing Paperclip code for upstream merge compatibility.

---

## System Overview

```
                    ┌─────────────────────────────────┐
                    │         AgentDash Dashboard         │
                    │     (React 19 + Vite + TW4)     │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │       AgentDash Control Plane       │
                    │     (Express 5 + WebSocket)      │
                    │                                  │
                    │  ┌───────────────────────────┐   │
                    │  │ Core (inherited Paperclip) │   │
                    │  │ Agents, Issues, Goals,     │   │
                    │  │ Heartbeats, Approvals,     │   │
                    │  │ Plugins, Skills, Budgets   │   │
                    │  └───────────────────────────┘   │
                    │                                  │
                    │  ┌───────────────────────────┐   │
                    │  │ AgentDash Extensions          │   │
                    │  │ Agent Factory, Task DAG,   │   │
                    │  │ AutoResearch, Policy Engine│   │
                    │  │ Onboarding, Skills Registry│   │
                    │  │ Prompt Builder, Capacity   │   │
                    │  └───────────────────────────┘   │
                    │                                  │
                    │  ┌───────────────────────────┐   │
                    │  │ Integration Plugins        │   │
                    │  │ Slack, GitHub, Linear,     │   │
                    │  │ Metrics adapters (PostHog) │   │
                    │  └───────────────────────────┘   │
                    └──────────────┬──────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                     ▼
     ┌─────────────┐    ┌─────────────┐       ┌─────────────┐
     │ Claude Code  │    │   Codex     │       │  OpenClaw   │
     │  (container) │    │ (container) │       │  (gateway)  │
     └─────────────┘    └─────────────┘       └─────────────┘
```

---

## New Database Tables (20 tables across 7 systems)

### Agent Factory (5 tables)

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `agent_templates` | Role-based agent blueprints | slug, role, adapterType, adapterConfig, skillKeys, okrs[], kpis[], authorityLevel (leader/executor/specialist), taskClassification (deterministic/stochastic), estimatedCostPerTaskCents |
| `spawn_requests` | Approval-gated batch agent creation | templateId, quantity, reason, projectId, approvalId FK, status (pending→fulfilled), spawnedAgentIds[] |
| `agent_okrs` | Agent-level objectives | agentId, goalId, objective, status, period, periodStart/End |
| `agent_key_results` | Measurable key results per OKR | okrId, metric, targetValue, currentValue, unit, weight |
| `issue_dependencies` | Task dependency DAG | issueId (blocked), blockedByIssueId (blocker), dependencyType (blocks/relates_to) — with unique constraint and cycle detection |

### AutoResearch (6 tables)

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `research_cycles` | Goal-tied investigation loops | goalId, projectId, ownerAgentId, status, maxIterations, currentIteration |
| `hypotheses` | Testable claims | cycleId, parentHypothesisId, title, rationale, source (human/ai/derived), status (proposed→approved→testing→validated/invalidated) |
| `experiments` | Operationalized hypotheses | hypothesisId, issueId (root work item), successCriteria[], budgetCapCents, timeLimitHours, rollbackTrigger[], approvalId |
| `metric_definitions` | What can be measured | key, displayName, unit, dataSourceType (posthog/sql/ci_cd/custom_api/manual), dataSourceConfig, aggregation, collectionMethod (poll/webhook/manual), pluginId |
| `measurements` | Metric snapshots | metricDefinitionId, experimentId, value, rawData, sampleSize, confidenceInterval, collectedAt |
| `evaluations` | Experiment analysis/verdicts | experimentId, verdict (validated/invalidated/inconclusive), analysis[], costTotalCents, nextAction (continue/pivot/stop/new_hypothesis) |

### Security & Policy Engine (4 tables)

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `security_policies` | Declarative security rules | policyType (resource_access/action_limit/data_boundary/rate_limit/blast_radius), targetType (agent/role/project/company), targetId, rules JSONB, effect (allow/deny), priority |
| `policy_evaluations` | Append-only audit log | agentId, runId, action, resource, matchedPolicyIds, decision (allowed/denied/escalated), denialReason |
| `agent_sandboxes` | Runtime isolation configs | agentId (unique), isolationLevel (process/container/vm), networkPolicy, filesystemPolicy, resourceLimits, secretAccess |
| `kill_switch_events` | Halt/resume audit trail | scope (company/agent), scopeId, action (halt/resume), reason, triggeredByUserId |

### Budget System (4 tables)

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `departments` | Organizational units for budget hierarchy | name, parentId (self-referential), leadUserId |
| `budget_allocations` | Parent-child budget relationships | parentPolicyId, childPolicyId, allocatedAmount, isFlexible (auto-draw from parent) |
| `budget_forecasts` | Burn rate and cost projections | policyId, forecastType (burn_rate/deadline_projection/task_estimate), projectedAmount, confidence, inputs |
| `resource_usage_events` | Non-LLM resource tracking | agentId, resourceType (compute_hours/saas_api_call/storage_gb), quantity, unit, costCents |

### Skills Registry (3 tables)

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `skill_versions` | Version history with review workflow | skillId, versionNumber (sequential), markdown, status (draft→in_review→approved→published→deprecated), diffFromPrevious, changeSummary |
| `skill_dependencies` | Skill composition graph | skillId, dependsOnSkillId, versionConstraint, isRequired |
| `skill_usage_events` | Analytics: what skills are used | skillId, versionId, agentId, runId, issueId, usedAt |

### Onboarding (3 tables)

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `onboarding_sessions` | Guided setup wizard state | companyId, currentStep (discovery/scope/goals/access/bootstrap), context JSONB |
| `onboarding_sources` | Ingested company documents | sessionId, sourceType (url/file/github/notion), rawContent, extractedSummary, extractedEntities |
| `company_context` | Structured company knowledge | contextType (domain/terminology/process/tech_stack), key, value, confidence, verifiedByUserId |

### Schema changes to existing tables

- `projects`: Add `departmentId uuid FK → departments`
- `agents`: Add `departmentId uuid FK → departments`
- `company_skills`: Add `publishedVersionId uuid FK → skill_versions`, `latestVersionNumber integer`
- `budget_policies.scopeType`: Add `'department'` value
- Constants: New approval types (`spawn_agents`, `hypothesis_approve`, `experiment_approve`, `skill_review`, `policy_override`), new event types, new permission keys

---

## New Services (14 services)

| Service | File | Key Methods |
|---------|------|-------------|
| **AgentFactory** | `agent-factory.ts` | `requestSpawn()`, `fulfillSpawnRequest()`, `instantiateFromTemplate()`, `evaluateAgent()`, `retireAgent()`, `setAgentOkrs()` |
| **TaskDependency** | `task-dependencies.ts` | `addDependency()`, `removeDependency()`, `detectCycle()`, `processCompletionUnblock()`, `getCriticalPath()`, `getReadyToStart()` |
| **CapacityPlanning** | `capacity-planning.ts` | `getWorkforceSnapshot()`, `estimateProjectCapacity()`, `recommendSpawns()`, `getAgentThroughput()` |
| **PromptBuilder** | `prompt-builder.ts` | `buildCoordinationPrompt()` → multi-section: identity + org + task + protocol + skills + dependencies |
| **ResearchCycles** | `research-cycles.ts` | CRUD, iteration management, status transitions |
| **Experiments** | `experiments.ts` | Full lifecycle: design → approval → running → measuring → evaluating |
| **Measurements** | `measurements.ts` | Recording, time-series queries, baseline calculation |
| **Evaluations** | `evaluations.ts` | Statistical analysis, verdict, next-action generation |
| **PolicyEngine** | `policy-engine.ts` | `evaluateAction()` (hot path), `createPolicy()`, `activateKillSwitch()` |
| **BudgetForecasts** | `budget-forecasts.ts` | `computeBurnRate()`, `projectDeadlineCost()`, `computeROI()` |
| **SkillsRegistry** | `skills-registry.ts` | `createVersion()`, `submitForReview()`, `publish()`, `resolveDependencies()` |
| **SkillAnalytics** | `skill-analytics.ts` | `usageBySkill()`, `outcomeCorrelation()`, `unusedSkills()` |
| **Onboarding** | `onboarding.ts` | `ingestSource()`, `extractContext()`, `suggestTeam()`, `applyTeam()` |
| **ResearchGuardrails** | `research-guardrails.ts` | Budget cap enforcement, time limits, rollback trigger evaluation |

---

## Integration Points with Existing Paperclip Code

These are the **only modifications** to existing Paperclip files:

| File | Change | Purpose |
|------|--------|---------|
| `server/src/services/issues.ts` | Add hook in `applyStatusSideEffects()` when status → `done`/`cancelled` | Call `taskDependencyService.processCompletionUnblock()` for auto-unblocking |
| `server/src/services/approvals.ts` | Add case in `approve()` for `spawn_agents` type | Trigger `agentFactory.fulfillSpawnRequest()` |
| `server/src/services/heartbeat.ts` | Add prompt builder call in `claimAndExecuteRun()` | Inject `paperclipCoordinationPrompt` into context |
| `packages/shared/src/constants.ts` | Add new approval types, event types, permission keys, budget scopes | Constants for all new features |
| `packages/db/src/schema/index.ts` | Export new schema tables | Make tables available to Drizzle |

Everything else is **new files only**.

---

## Integration Plugins (built on existing plugin system)

Integrations are **connector plugins** using Paperclip's mature plugin infrastructure (JSON-RPC workers, event bus, webhooks, job scheduler, entity store).

| Plugin | Purpose | Key Capabilities |
|--------|---------|-----------------|
| `igt.integration-slack` | Agent presence in channels, escalation, approval buttons | Webhook handler, event subscriber, agent invocation |
| `igt.integration-github` | PR sync, CI status, code review, issue sync | Webhook handler, work product sync, tool registration |
| `igt.integration-linear` | Bidirectional issue sync with Linear | Webhook handler, scheduled full sync, entity mapping |
| `igt.metrics-posthog` | Metric collection for AutoResearch | Scheduled collection, webhook receiver, agent tool |
| `igt.metrics-custom-api` | Generic HTTP metric fetching | Configurable endpoint polling |

**Plugin SDK extension needed**: Add `sync.registerMapping`, `sync.getMapping`, `sync.getMappingByPaperclipId` RPC methods to `WorkerToHostMethods` (thin wrappers over `plugin_entities`).

---

## Key Flows

### Agent Factory: "We need 3 more engineers"

1. Human/CEO agent → `POST /spawn-requests` (templateSlug, quantity, projectId)
2. AgentFactory resolves template, creates agents in `pending_approval` status
3. Creates `spawn_agents` approval → board reviews in existing UI
4. Board approves → existing `approvalService.approve()` triggers `fulfillSpawnRequest()`
5. Agents transition to `idle`, OKRs set from template, skills synced
6. First heartbeat fires → prompt builder injects coordination context → agents start working

### Task Dependencies: Auto-unblocking

1. Agent/human adds dependency: `POST /issues/:id/dependencies` (blockedByIssueId)
2. Cycle detection (DFS) prevents circular deps
3. When blocker issue → `done`, `processCompletionUnblock()` fires
4. Checks all dependents — if fully unblocked, transitions to `todo`
5. Wakes assigned agent via heartbeat with reason `dependency_resolved`

### AutoResearch: Hypothesis → Experiment → Evaluate loop

1. Research cycle created linked to a goal
2. Research lead agent generates hypotheses (LLM-powered)
3. Human approves hypothesis → experiment designed with success criteria + budget cap
4. Human approves experiment → agent team executes (normal issue workflow)
5. Measurement window: metrics collected via plugin adapters
6. Evaluation: statistical analysis, verdict, next-action recommendation
7. Loop continues until goal met, budget exhausted, or max iterations reached

### Kill Switch

1. `POST /companies/:id/kill-switch` → sets in-memory flag + pauses all agents
2. Cancels all active heartbeat runs
3. Records event for audit
4. Resume: clears flag, sets agents to `idle`

---

## Implementation Phases

### Phase 1: Foundation (Task Dependencies + Agent Templates)
- New schema: `issue_dependencies`, `agent_templates`
- Services: `taskDependencyService`, template CRUD in `agentFactoryService`
- Routes: dependency endpoints, template endpoints
- Constants/validators for new types
- **No changes to existing Paperclip code yet**

### Phase 2: Agent Factory + OKRs
- New schema: `spawn_requests`, `agent_okrs`, `agent_key_results`
- Services: spawn request flow, OKR management
- Routes: spawn request, OKR endpoints
- **Integration**: Hook `approvalService.approve()` for `spawn_agents`
- **Integration**: Add auto-unblock hook in `issueService.update()`

### Phase 3: Prompt Builder + Coordination Protocol
- Service: `promptBuilderService` with 6 section builders
- **Integration**: Hook into `heartbeat.claimAndExecuteRun()` context assembly
- Adapter reads `paperclipCoordinationPrompt` from context

### Phase 4: Security & Policy Engine
- New schema: `security_policies`, `policy_evaluations`, `agent_sandboxes`, `kill_switch_events`
- Services: `policyEngineService` with evaluation, kill switch
- Routes: policy CRUD, sandbox config, kill switch
- **Integration**: Pre-heartbeat policy gate

### Phase 5: Budget Improvements
- New schema: `departments`, `budget_allocations`, `budget_forecasts`, `resource_usage_events`
- Services: hierarchical budgets, forecasting, ROI, capacity planning
- Routes: department CRUD, forecast, ROI, capacity endpoints
- Schema changes: `departmentId` on projects + agents

### Phase 6: Skills Registry
- New schema: `skill_versions`, `skill_dependencies`, `skill_usage_events`
- Services: versioning, review workflow, dependency resolution, analytics
- Schema changes: `publishedVersionId` + `latestVersionNumber` on `company_skills`
- Routes: version CRUD, review, publish, analytics

### Phase 7: AutoResearch Engine
- New schema: `research_cycles`, `hypotheses`, `experiments`, `metric_definitions`, `measurements`, `evaluations`
- Services: full research lifecycle, guardrails, measurement collection
- Routes: research cycle CRUD, hypothesis, experiment, metrics, measurement, evaluation
- Plugin SDK: `measurements.record` RPC

### Phase 8: Integration Plugins
- Plugin SDK extension: sync mapping RPCs
- Slack plugin: agent presence, escalation, approvals
- GitHub plugin: PR sync, CI status, issue sync
- Linear plugin: bidirectional issue sync
- Metrics plugins: PostHog, custom API

### Phase 9: Onboarding Engine
- New schema: `onboarding_sessions`, `onboarding_sources`, `company_context`
- Services: document ingestion, LLM extraction, team suggestion, bootstrap
- Routes: onboarding wizard endpoints
- UI: guided onboarding flow

---

## Verification Plan

After each phase:
1. `pnpm -r typecheck` — all packages compile
2. `pnpm test:run` — existing tests pass
3. `pnpm db:generate` — migration generates cleanly
4. `pnpm build` — full build succeeds
5. Manual test: start dev server (`pnpm dev`), verify new endpoints return expected responses
6. For integration hooks (phases 2-4): verify existing flows still work (create agent, complete issue, run heartbeat)

---

## Critical Files Reference

| File | Why It Matters |
|------|---------------|
| `packages/db/src/schema/index.ts` | All new tables must be exported here |
| `packages/shared/src/constants.ts` | All new enum-like constants (approval types, events, permissions) |
| `server/src/services/approvals.ts` | Hook point for `spawn_agents` fulfillment (~line 102) |
| `server/src/services/issues.ts` | Hook point for auto-unblock in `applyStatusSideEffects` |
| `server/src/services/heartbeat.ts` | Hook point for prompt builder in `claimAndExecuteRun` (~line 1969) |
| `server/src/services/budgets.ts` | Extend for hierarchical budgets, new scope types |
| `server/src/services/company-skills.ts` | Extend for versioning and dependency resolution |
| `packages/plugins/sdk/src/protocol.ts` | Add sync mapping + measurement RPCs to `WorkerToHostMethods` |
| `server/src/services/plugin-host-services.ts` | Implement new worker-to-host RPC handlers |
