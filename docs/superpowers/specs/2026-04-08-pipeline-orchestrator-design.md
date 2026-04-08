# Pipeline Orchestrator Design Spec

## Metadata
- Interview ID: pipe-orch-001
- Rounds: 9
- Final Ambiguity Score: 15%
- Type: brownfield
- Generated: 2026-04-08
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown

| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 0.35 | 0.32 |
| Constraint Clarity | 0.85 | 0.25 | 0.21 |
| Success Criteria | 0.75 | 0.25 | 0.19 |
| Context Clarity | 0.85 | 0.15 | 0.13 |
| **Total Clarity** | | | **0.85** |
| **Ambiguity** | | | **15%** |

## Goal

Build a DAG-based pipeline orchestrator for AgentDash that chains agents into multi-step workflows with structured state passing, conditional branching, parallel fan-out/fan-in, HITL checkpoints, and intelligent self-healing on failure. The orchestrator operates in two modes: **sync fast-path** (immediate sequential execution via direct `heartbeat.executeRun()` calls) and **async heartbeat-driven** (stages scheduled as prioritized heartbeatRuns). This becomes the **primary execution path** for structured work, with the existing heartbeat interval model relegated to background/autonomous tasks.

### Core Mechanism

Each pipeline stage receives a **slim state envelope** (structured JSON from the previous stage's output) and a **scoped instruction** (minimal per-stage prompt, ~200 tokens, instead of the agent's full SOUL.md/AGENTS.md). This reduces per-stage token usage from ~4-8K (full heartbeat context rebuild) to ~500-2K while improving completion rate through structured data handoff.

## Architecture

### Execution Flow

```
Pipeline Definition (DAG)
  │
  ├─ Sync Fast-Path
  │    Pipeline runner calls heartbeat.executeRun() directly in a loop
  │    Stage N completes → output captured → state envelope built → Stage N+1 invoked
  │    HITL gates pause the loop, create approval, resume on decision
  │
  └─ Async Heartbeat-Driven
       Pipeline runner creates heartbeatRuns with delegationKind: 'pipeline_stage'
       Priority flag ensures next-cycle execution (no interval wait)
       Heartbeat completion callback triggers pipeline advancement
```

### DAG Execution Model

```
                    ┌─[Stage B1]─┐
[Stage A] ─edge─> ┤              ├─merge─> [Stage D] ─edge─> HITL ─edge─> [Stage E]
                    └─[Stage B2]─┘
                         │
                    (condition: if score < 0.5)
                         │
                    [Stage C] ─edge─> [Stage D]
```

- **Edges** connect stages with optional condition expressions
- **Fan-out**: a stage with multiple outgoing edges spawns parallel executions
- **Fan-in (merge)**: a merge node waits for all/any incoming branches before continuing
- **HITL gates**: pause pipeline, create an approval request, resume on human decision
- **Conditional edges**: simple expression evaluator against the state envelope (e.g., `output.score > 0.7`)

### Integration with Existing Infrastructure

| Component | How Pipeline Uses It |
|-----------|---------------------|
| **Heartbeat engine** | Executes stages via `heartbeat.executeRun()` — all cost tracking, activity logging, quota management preserved |
| **HeartbeatRun** | Each stage = one heartbeatRun with `delegationKind: 'pipeline_stage'`, `contextSnapshot` = state envelope |
| **Approval system** | HITL gates create approvals via existing `approvalService`. Approval decision triggers pipeline resume via `heartbeat.wakeup()` |
| **Activity log** | All stage executions logged automatically through heartbeat |
| **Task dependencies** | NOT used for pipeline stages — the pipeline orchestrator manages its own DAG. Task deps remain for unstructured heartbeat work |
| **Agent adapters** | Stages invoke agents through their configured adapter. Sub-agent spawning within a stage is handled by the adapter internally |

### State Envelope

The structured data object passed between stages:

```typescript
interface StateEnvelope {
  pipelineRunId: string;
  sourceStageId: string | null;  // null for first stage
  data: Record<string, unknown>; // stage output → next stage input
  metadata: {
    pipelineId: string;
    stageIndex: number;
    totalStages: number;
    executionMode: 'sync' | 'async';
    accumulatedCostUsd: number;
  };
}
```

Each stage's `resultJson` is extracted and wrapped into a `StateEnvelope` for the next stage. The pipeline definition can specify a **state mapping** per edge — which fields from the output to pass forward, enabling data filtering between stages.

### Self-Healing Loop

On stage failure (adapter error, timeout, unexpected output):

1. **Diagnose**: invoke an LLM call with the error context + stage instruction + state envelope. Ask: "What went wrong and how should the stage be adjusted?"
2. **Fix**: LLM produces an adjusted instruction or identifies a data issue in the state envelope
3. **Re-run**: execute the stage again with the adjusted context
4. **Max retries**: 3 attempts per stage. After 3 failures, fail the stage and (if configured) escalate via HITL

This is NOT a blind retry — each attempt incorporates the diagnosis from the previous failure.

```
Stage fails → [Diagnose via LLM] → [Adjust instruction/state] → [Re-run stage]
                                                                       │
                                                              (max 3 retries)
                                                                       │
                                                              [Fail stage → escalate]
```

## Schema Changes

### Modified: `agent_pipelines` table

The existing table has `stages` as JSONB. Extend to support DAG:

```typescript
export const agentPipelines = pgTable("agent_pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  description: text("description"),
  // CHANGED: stages is now an array of stage definitions
  stages: jsonb("stages").notNull().$type<PipelineStageDefinition[]>(),
  // NEW: edges define the DAG connections
  edges: jsonb("edges").notNull().default([]).$type<PipelineEdgeDefinition[]>(),
  // NEW: execution mode preference
  executionMode: text("execution_mode").notNull().default("sync"),
  // NEW: pipeline-level defaults
  defaults: jsonb("defaults").$type<PipelineDefaults>(),
  status: text("status").notNull().default("draft"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

### New Types

```typescript
interface PipelineStageDefinition {
  id: string;                        // unique within pipeline
  name: string;
  type: 'agent' | 'hitl_gate' | 'merge';
  agentId?: string;                  // for type='agent'
  scopedInstruction: string;         // minimal prompt for this stage
  stateMapping?: Record<string, string>; // input field mapping from previous stage output
  timeoutMinutes?: number;           // override pipeline default
  maxRetries?: number;               // override pipeline default (for self-heal)
  mergeStrategy?: 'all' | 'any';    // for type='merge' — wait for all or any incoming
  mergeTimeout?: number;             // minutes to wait for fan-in
  hitlInstructions?: string;         // for type='hitl_gate' — what the human sees
  hitlTimeoutHours?: number;         // override pipeline default
}

interface PipelineEdgeDefinition {
  id: string;
  fromStageId: string;
  toStageId: string;
  condition?: string;                // expression evaluated against state envelope
                                     // e.g., "data.score > 0.7", "data.status === 'approved'"
                                     // null = unconditional (always follow)
}

interface PipelineDefaults {
  stageTimeoutMinutes: number;       // default: 30
  hitlTimeoutHours: number;          // default: 72
  maxSelfHealRetries: number;        // default: 3
  budgetCapUsd?: number;             // null = inherit from agent budget
}
```

### Modified: `pipeline_runs` table

```typescript
export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  pipelineId: uuid("pipeline_id").notNull().references(() => agentPipelines.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  status: text("status").notNull().default("running"),
  executionMode: text("execution_mode").notNull(), // 'sync' | 'async'
  // CHANGED: track multiple active stages (for parallel fan-out)
  activeStageIds: jsonb("active_stage_ids").default([]).$type<string[]>(),
  inputData: jsonb("input_data").$type<Record<string, unknown>>(),
  outputData: jsonb("output_data").$type<Record<string, unknown>>(),
  totalCostUsd: numeric("total_cost_usd").default("0"),
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  failedAt: timestamp("failed_at"),
  errorMessage: text("error_message"),
  triggeredBy: uuid("triggered_by"),  // user or agent that started the run
});
```

### New: `pipeline_stage_executions` table

```typescript
export const pipelineStageExecutions = pgTable("pipeline_stage_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  pipelineRunId: uuid("pipeline_run_id").notNull().references(() => pipelineRuns.id),
  stageId: text("stage_id").notNull(),           // references PipelineStageDefinition.id
  status: text("status").notNull().default("pending"),
  // 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_hitl'
  heartbeatRunId: uuid("heartbeat_run_id"),       // links to the actual execution
  inputState: jsonb("input_state").$type<StateEnvelope>(),
  outputState: jsonb("output_state").$type<Record<string, unknown>>(),
  costUsd: numeric("cost_usd").default("0"),
  selfHealAttempts: integer("self_heal_attempts").default(0),
  selfHealLog: jsonb("self_heal_log").default([]).$type<SelfHealEntry[]>(),
  approvalId: uuid("approval_id"),                // for HITL gates
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  errorMessage: text("error_message"),
});

interface SelfHealEntry {
  attempt: number;
  diagnosis: string;
  adjustedInstruction: string;
  outcome: 'retried' | 'failed';
  timestamp: string;
}
```

## Constraints

- **Stage timeout**: 30 minutes per agent stage (configurable per stage). Excludes HITL wait time.
- **HITL timeout**: 72 hours (configurable). Escalate to company admin on expiry.
- **Budget cap**: Inherits from agent budget allocation. Pipeline pauses and escalates if cumulative cost exceeds cap.
- **Max self-heal retries**: 3 per stage. After 3 failed diagnose-fix-rerun cycles, the stage fails.
- **Max concurrent fan-out**: limited by available agents. Each parallel branch requires an assigned agent.
- **Agents are not atomic**: a stage may spawn sub-agents internally via the adapter. The pipeline treats the top-level heartbeatRun completion as "stage done."
- **Long-running tails**: stages that monitor/track indefinitely (like "track RFP feedback") should be spawned as heartbeat tasks at pipeline completion, not kept as pipeline stages.

## Non-Goals

- **Visual drag-and-drop DAG editor** — v1 uses a form wizard with read-only DAG preview
- **Pipeline versioning** — editing a pipeline definition does not version it; runs use the definition at time of creation
- **Cross-company pipelines** — all stages execute within a single company scope
- **Pipeline marketplace/templates** — no sharing between companies in v1
- **Token usage optimization metrics** — architectural win comes free; no dedicated measurement dashboard in v1
- **Persistent LLM conversation across stages** — each stage is a fresh LLM call with scoped instruction + state envelope

## Acceptance Criteria

- [ ] **RFP Pipeline E2E**: A 7-stage pipeline (scrape → compare → rank → HITL → draft → HITL → track) runs to completion
- [ ] **State passing works**: each stage receives structured JSON from the previous stage's output, not free text
- [ ] **HITL gates work**: pipeline pauses at gate stages, creates approval in Inbox, resumes on human decision
- [ ] **Conditional branching works**: an edge with `condition: "data.score > 0.7"` routes to the correct next stage
- [ ] **Parallel fan-out/fan-in works**: two stages execute concurrently, merge node waits for both before continuing
- [ ] **Self-healing works**: a deliberately failing stage triggers LLM diagnosis, adjusts, and re-runs successfully
- [ ] **Sync mode works**: pipeline stages execute immediately via direct `heartbeat.executeRun()` calls
- [ ] **Async mode works**: pipeline stages execute via prioritized heartbeatRuns
- [ ] **Timeout enforcement**: a stage that exceeds its timeout triggers the self-heal loop
- [ ] **Budget enforcement**: pipeline pauses when cumulative cost exceeds the budget cap
- [ ] **Pipeline CRUD**: create, list, get, update, delete pipelines via API
- [ ] **Pipeline run management**: start, monitor, cancel pipeline runs via API
- [ ] **Form wizard UI**: step-by-step pipeline creation with stage definition, edge configuration, and read-only DAG preview
- [ ] **Pipeline run UI**: view active/completed runs with stage-by-stage status and state inspection
- [ ] **Company-scoped**: all pipelines and runs enforce company boundaries

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| Pipeline = visual layer on task deps | Round 1: what does orchestrator DO that task deps don't? | New execution engine — primary path for structured work, not just a UI layer |
| Persistent LLM conversation saves tokens | Round 2: how to reduce tokens? | Rejected — growing context is worse. Slim state + scoped instructions is better |
| Linear pipelines are enough for v1 | Round 3: linear vs DAG? | Full DAG from day one — it's a differentiator |
| Blind retry on failure | Round 4: what about sub-agents and retries? | Intelligent self-heal: LLM diagnoses → adjusts → re-runs. Agents spawn sub-agents internally |
| Need token/speed metrics for v1 | Round 6: what success criteria? | Functional correctness first (RFP E2E). Token/speed wins are architectural freebies |
| Direct adapter call is faster | Round 7: how to invoke stages? | Heartbeat with priority — preserves all infrastructure, adds immediate execution flag |
| Complex pipelines need complex UI | Round 9: how to create pipelines? | Form wizard + DAG preview — consistent with Agent Wizard pattern |

## Technical Context (Brownfield)

### Existing Infrastructure to Reuse

| Component | File | What We Use |
|-----------|------|-------------|
| Pipeline schema | `packages/db/src/schema/agent_pipelines.ts` | Extend existing tables (add edges, executionMode, defaults) |
| Pipeline runs schema | (same file) | Extend existing table (add activeStageIds, totalCostUsd) |
| Heartbeat engine | `server/src/services/heartbeat.ts` | `executeRun()` for sync, `createChildRunFromRun()` for async, `wakeup()` for HITL resume |
| HeartbeatRun schema | `packages/db/src/schema/heartbeat_runs.ts` | `contextSnapshot` = state envelope, `delegationKind: 'pipeline_stage'`, `resultJson` = stage output |
| Approval service | `server/src/services/approvals.ts` | HITL gates create approvals, pipeline resumes on decision |
| Activity log | `server/src/services/activity-log.ts` | All stage executions logged automatically via heartbeat |
| Pipeline orchestrator stub | `server/src/services/pipeline-orchestrator.ts` | Replace empty `onStageCompleted()` with full orchestration logic |
| Pipeline routes stub | `server/src/routes/pipelines.ts` | Replace empty router with full CRUD + run management endpoints |
| Pipeline validators | `packages/shared/src/validators/pipeline.ts` | Extend existing validators for new fields |
| Pipeline constants | `packages/shared/src/constants.ts` | `PIPELINE_STATUSES`, `PIPELINE_RUN_STATUSES` already exist |

### New Files to Create

| File | Purpose |
|------|---------|
| `packages/db/src/schema/pipeline_stage_executions.ts` | New table for per-stage execution tracking |
| `server/src/services/pipeline-runner.ts` | Core execution engine: DAG walker, state passing, fan-out/fan-in |
| `server/src/services/pipeline-condition-evaluator.ts` | Safe expression evaluator for edge conditions |
| `server/src/services/pipeline-self-heal.ts` | Diagnose-fix-rerun loop using LLM |
| `server/src/services/__tests__/pipeline-runner.test.ts` | Unit tests for DAG execution |
| `server/src/services/__tests__/pipeline-condition-evaluator.test.ts` | Unit tests for condition evaluation |
| `ui/src/pages/Pipelines.tsx` | Pipeline list page |
| `ui/src/pages/PipelineDetail.tsx` | Pipeline detail with run history |
| `ui/src/pages/PipelineWizard.tsx` | Form-based pipeline creation wizard |
| `ui/src/pages/PipelineRunDetail.tsx` | Run detail with stage-by-stage status |
| `ui/src/components/DagPreview.tsx` | Read-only DAG visualization component |
| `ui/src/api/pipelines.ts` | API client for pipeline CRUD and runs |
| `packages/shared/src/validators/pipeline-extended.ts` | New validators for DAG, edges, conditions |

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Pipeline | core domain | id, name, stages[], edges[], executionMode, defaults, status | has many PipelineRuns, belongs to Company |
| PipelineRun | core domain | id, status, executionMode, activeStageIds[], inputData, outputData, totalCostUsd | belongs to Pipeline, has many StageExecutions |
| StageExecution | core domain | id, stageId, status, heartbeatRunId, inputState, outputState, costUsd, selfHealAttempts | belongs to PipelineRun, links to HeartbeatRun |
| StateEnvelope | core domain | pipelineRunId, sourceStageId, data, metadata | passed between StageExecutions |
| Edge | core domain | fromStageId, toStageId, condition | connects Stages in DAG |
| MergeNode | core domain (stage type) | mergeStrategy (all/any), timeout | fan-in point for parallel branches |
| HITLGate | core domain (stage type) | hitlInstructions, hitlTimeoutHours, approvalId | pauses PipelineRun, creates Approval |
| SelfHealLoop | supporting | diagnosis, adjustedInstruction, attempt, outcome | triggered by failed StageExecution |
| Agent | existing entity | adapter, heartbeat config, budget | executes StageExecutions via adapter |
| HeartbeatRun | existing entity | contextSnapshot, resultJson, delegationKind | actual execution record for each stage |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 4 | 4 | - | - | N/A |
| 2 | 5 | 1 | 0 | 4 | 80% |
| 3 | 7 | 2 | 0 | 5 | 71% |
| 4 | 8 | 1 | 0 | 7 | 87% |
| 5 | 10 | 2 | 0 | 8 | 80% |
| 6 | 10 | 0 | 0 | 10 | 100% |
| 7 | 10 | 0 | 0 | 10 | 100% |
| 8 | 10 | 0 | 0 | 10 | 100% |

Ontology fully converged at round 6 and remained stable through 3 consecutive rounds.

## Demo Pipeline: RFP Response

The canonical test pipeline for MKthink:

```
[S1: Scrape RFPs]
    ↓ (unconditional)
[S2: Compare with proprietary context]
    ↓ (unconditional)
[S3: Rank & match RFPs]
    ↓ (unconditional)
[HITL Gate 1: Select which RFP to respond to]
    ↓ (human approves)
[S4: Research + draft proposal]  ← sub-agents spawned internally by adapter
    ↓ (unconditional)
[HITL Gate 2: Human reviews proposal]
    ↓ (human approves, or requests revision → loop back to S4)
[Spawn heartbeat task: Track feedback & next steps]  ← exits pipeline, becomes long-running monitoring
```

Stage details:
- **S1** scoped instruction: "Search public RFP sources for new postings matching company profile. Return structured list with title, deadline, requirements, budget."
- **S2** scoped instruction: "Compare each RFP against company's past projects and capabilities. Add match_score and relevant_experience fields."
- **S3** scoped instruction: "Rank RFPs by match_score and deadline urgency. Select top 3 candidates with rationale."
- **HITL 1**: Human sees ranked RFPs, selects which to pursue.
- **S4** scoped instruction: "Research winning proposals in this domain. Draft a response incorporating company strengths, past work, and competitive positioning."
- **HITL 2**: Human reviews draft, approves or sends back with notes.
- **Tail**: spawned as a separate heartbeat task to monitor for RFP response feedback.

## Interview Transcript

<details>
<summary>Full Q&A (9 rounds)</summary>

### Round 1
**Q:** The heartbeat engine already chains agents via task dependencies. What does the pipeline orchestrator DO that task deps don't?
**A:** Both — new execution engine with better completion rate, faster, reduced token usage. Heartbeat intervals will be extended; pipeline engine handles structured work.
**Ambiguity:** 67% (Goal: 0.55, Constraints: 0.15, Criteria: 0.10, Context: 0.45)

### Round 2
**Q:** How does the pipeline engine reduce token usage vs heartbeat?
**A:** User deferred to technical recommendation.
**Resolution:** Option 4 — slim state envelope + scoped per-stage instructions, fresh LLM call per stage. Each stage gets ~200-token instruction + structured JSON instead of full 4-8K agent context rebuild.
**Ambiguity:** 61% (Goal: 0.70, Constraints: 0.15, Criteria: 0.10, Context: 0.50)

### Round 3
**Q:** Linear only, full DAG, or linear v1 with DAG-ready schema?
**A:** Full DAG — conditional branching, parallel fan-out/fan-in from day one.
**Ambiguity:** 54% (Goal: 0.75, Constraints: 0.40, Criteria: 0.10, Context: 0.50)

### Round 4 (Contrarian mode)
**Q:** LangGraph runs in one process. AgentDash agents are external processes running minutes. What happens on failure?
**A:** Agents spawn sub-agents internally. On failure: LLM reviews, investigates, fixes, then re-runs. Not blind retry.
**Ambiguity:** 47% (Goal: 0.80, Constraints: 0.55, Criteria: 0.10, Context: 0.55)

### Round 5
**Q:** What's the canonical demo pipeline for MKthink?
**A:** RFP response pipeline: scrape → compare with proprietary context → rank → HITL select → research + draft → HITL review → track feedback. 7 stages, 2 HITL gates, sub-agent research.
**Ambiguity:** 35% (Goal: 0.85, Constraints: 0.55, Criteria: 0.50, Context: 0.60)

### Round 6 (Simplifier mode)
**Q:** For v1 success, which bar: functional correctness, token reduction, speed, or all three?
**A:** Functional correctness — RFP pipeline runs end-to-end.
**Ambiguity:** 30% (Goal: 0.85, Constraints: 0.55, Criteria: 0.70, Context: 0.60)

### Round 7
**Q:** How should pipeline stages invoke agents? Reuse heartbeat, direct adapter call, or heartbeat with priority?
**A:** User deferred to technical recommendation.
**Resolution:** Option 3 — heartbeat with priority. Sync fast-path calls `heartbeat.executeRun()` directly. Async creates prioritized heartbeatRuns. Both use heartbeat infrastructure.
**Ambiguity:** 24% (Goal: 0.90, Constraints: 0.60, Criteria: 0.70, Context: 0.75)

### Round 8
**Q:** Guardrails: 30min stage timeout, 72hr HITL timeout, inherited budget cap, 3 max self-heal retries. Agree?
**A:** These defaults are reasonable, ship it.
**Ambiguity:** 17% (Goal: 0.90, Constraints: 0.85, Criteria: 0.70, Context: 0.80)

### Round 9
**Q:** How should operators create pipelines? Code-only, visual builder, or form wizard + DAG preview?
**A:** Form wizard + read-only DAG preview — consistent with Agent Wizard pattern.
**Ambiguity:** 15% (Goal: 0.92, Constraints: 0.85, Criteria: 0.75, Context: 0.85)

</details>
