# Pipeline Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a DAG-based pipeline orchestrator that chains agents into multi-step workflows with structured state passing, conditional branching, parallel fan-out/fan-in, HITL checkpoints, intelligent self-healing, and dual execution modes (sync fast-path + async heartbeat-driven).

**Architecture:** Pipelines are defined as DAGs (stages + edges with optional conditions). The pipeline runner walks the DAG, executing each stage via the existing heartbeat engine (preserving cost tracking, logging, quotas). State passes between stages as a slim JSON envelope with scoped per-stage instructions. HITL gates create approvals via the existing approval system. Self-healing uses LLM diagnosis on failure.

**Tech Stack:** Drizzle ORM, Express 5, Zod, React 19, TanStack Query, Tailwind 4, Vitest

**Spec:** `docs/superpowers/specs/2026-04-08-pipeline-orchestrator-design.md`

---

## File Map

### Create
| File | Responsibility |
|------|---------------|
| `packages/db/src/schema/pipeline_stage_executions.ts` | Per-stage execution tracking table |
| `packages/shared/src/types/pipeline.ts` | Shared TypeScript types for pipeline domain |
| `server/src/services/pipeline-condition-evaluator.ts` | Safe expression evaluator for edge conditions |
| `server/src/services/pipeline-runner.ts` | Core DAG execution engine |
| `server/src/services/pipeline-self-heal.ts` | LLM-powered diagnose-fix-rerun loop |
| `server/src/services/__tests__/pipeline-condition-evaluator.test.ts` | Condition evaluator unit tests |
| `server/src/services/__tests__/pipeline-runner.test.ts` | DAG walker unit tests |
| `server/src/services/__tests__/pipeline-orchestrator.test.ts` | Pipeline CRUD + run management tests |
| `ui/src/api/pipelines.ts` | API client for pipeline endpoints |
| `ui/src/components/DagPreview.tsx` | Read-only DAG visualization (SVG) |
| `ui/src/pages/PipelineDetail.tsx` | Pipeline detail with run history |
| `ui/src/pages/PipelineWizard.tsx` | Form-based pipeline creation wizard |
| `ui/src/pages/PipelineRunDetail.tsx` | Run detail with stage-by-stage status |

### Modify
| File | Change |
|------|--------|
| `packages/db/src/schema/agent_pipelines.ts` | Add edges, executionMode, defaults columns; extend pipelineRuns |
| `packages/db/src/schema/index.ts` | Export pipelineStageExecutions |
| `packages/shared/src/constants.ts` | Add pipeline execution modes, stage types, stage execution statuses |
| `packages/shared/src/validators/pipeline.ts` | Rewrite for DAG model (stages, edges, conditions) |
| `packages/shared/src/index.ts` | Export new pipeline types and validators |
| `server/src/services/pipeline-orchestrator.ts` | Full rewrite: CRUD + run management |
| `server/src/services/index.ts` | Export new pipeline services |
| `server/src/routes/pipelines.ts` | Full rewrite: REST endpoints for pipelines + runs |
| `ui/src/lib/queryKeys.ts` | Add pipelines query key group |
| `ui/src/pages/Pipelines.tsx` | Rewrite: pipeline list with status, stage count, run history |
| `ui/src/App.tsx` | Add PipelineDetail, PipelineWizard, PipelineRunDetail routes |

---

### Task 1: Database Schema & Migration

**Files:**
- Modify: `packages/db/src/schema/agent_pipelines.ts`
- Create: `packages/db/src/schema/pipeline_stage_executions.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Read existing schema files**

Read `packages/db/src/schema/agent_pipelines.ts` and `packages/db/src/schema/index.ts` to understand current column definitions and exports.

- [ ] **Step 2: Extend `agentPipelines` table**

In `packages/db/src/schema/agent_pipelines.ts`, add new columns to `agentPipelines`:

```typescript
import { pgTable, uuid, text, timestamp, integer, jsonb, index, numeric } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import type { PipelineStageDefinition, PipelineEdgeDefinition, PipelineDefaults } from "@agentdash/shared";

// AgentDash: Pipeline orchestration
export const agentPipelines = pgTable(
  "agent_pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    stages: jsonb("stages").notNull().$type<PipelineStageDefinition[]>().default([]),
    // AgentDash: DAG edges connecting stages
    edges: jsonb("edges").notNull().$type<PipelineEdgeDefinition[]>().default([]),
    // AgentDash: sync (direct execute) or async (heartbeat-driven)
    executionMode: text("execution_mode").notNull().default("sync"),
    // AgentDash: pipeline-level timeout/budget/retry defaults
    defaults: jsonb("defaults").$type<PipelineDefaults>(),
    status: text("status").notNull().default("draft"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_pipelines_company_idx").on(table.companyId),
  ],
);
```

- [ ] **Step 3: Extend `pipelineRuns` table**

In the same file, replace `pipelineRuns` definition:

```typescript
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id").notNull().references(() => agentPipelines.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    status: text("status").notNull().default("pending"),
    // AgentDash: sync or async execution mode for this run
    executionMode: text("execution_mode").notNull().default("sync"),
    // AgentDash: tracks multiple active stages for parallel fan-out
    activeStageIds: jsonb("active_stage_ids").$type<string[]>().default([]),
    currentStage: integer("current_stage").notNull().default(0),
    inputData: jsonb("input_data").$type<Record<string, unknown>>(),
    outputData: jsonb("output_data").$type<Record<string, unknown>>(),
    // AgentDash: cost tracking
    totalCostUsd: numeric("total_cost_usd").default("0"),
    triggeredBy: uuid("triggered_by"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pipeline_runs_pipeline_idx").on(table.pipelineId),
    index("pipeline_runs_company_idx").on(table.companyId),
  ],
);
```

- [ ] **Step 4: Create `pipeline_stage_executions` table**

Create `packages/db/src/schema/pipeline_stage_executions.ts`:

```typescript
import { pgTable, uuid, text, timestamp, jsonb, integer, numeric, index } from "drizzle-orm/pg-core";
import { pipelineRuns } from "./agent_pipelines.js";
import type { StateEnvelope, SelfHealEntry } from "@agentdash/shared";

// AgentDash: Per-stage execution tracking for pipeline runs
export const pipelineStageExecutions = pgTable(
  "pipeline_stage_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineRunId: uuid("pipeline_run_id").notNull().references(() => pipelineRuns.id),
    stageId: text("stage_id").notNull(),
    status: text("status").notNull().default("pending"),
    heartbeatRunId: uuid("heartbeat_run_id"),
    inputState: jsonb("input_state").$type<StateEnvelope>(),
    outputState: jsonb("output_state").$type<Record<string, unknown>>(),
    costUsd: numeric("cost_usd").default("0"),
    selfHealAttempts: integer("self_heal_attempts").notNull().default(0),
    selfHealLog: jsonb("self_heal_log").$type<SelfHealEntry[]>().default([]),
    approvalId: uuid("approval_id"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pipeline_stage_exec_run_idx").on(table.pipelineRunId),
    index("pipeline_stage_exec_stage_idx").on(table.pipelineRunId, table.stageId),
  ],
);
```

- [ ] **Step 5: Export from schema index**

In `packages/db/src/schema/index.ts`, add:

```typescript
export { pipelineStageExecutions } from "./pipeline_stage_executions.js";
```

- [ ] **Step 6: Generate migration**

Run: `pnpm db:generate`

Expected: New migration file `packages/db/src/migrations/0066_*.sql` with ALTER TABLE statements for `agent_pipelines`, `pipeline_runs`, and CREATE TABLE for `pipeline_stage_executions`.

- [ ] **Step 7: Verify migration chain**

Run: `pnpm -r typecheck`

Expected: PASS. If migration prevId collision occurs (like the 0061 issue), fix the `prevId` in the new migration's snapshot to point to the actual previous migration ID.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/agent_pipelines.ts packages/db/src/schema/pipeline_stage_executions.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): extend pipeline schema for DAG orchestration"
```

---

### Task 2: Shared Constants, Types & Validators

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/types/pipeline.ts`
- Modify: `packages/shared/src/validators/pipeline.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Read existing constants and validators**

Read `packages/shared/src/constants.ts` (the PIPELINE section), `packages/shared/src/validators/pipeline.ts`, and `packages/shared/src/index.ts`.

- [ ] **Step 2: Add new pipeline constants**

In `packages/shared/src/constants.ts`, add after the existing `PIPELINE_RUN_STATUSES`:

```typescript
// AgentDash: Pipeline orchestrator constants
export const PIPELINE_EXECUTION_MODES = ["sync", "async"] as const;
export type PipelineExecutionMode = (typeof PIPELINE_EXECUTION_MODES)[number];

export const PIPELINE_STAGE_TYPES = ["agent", "hitl_gate", "merge"] as const;
export type PipelineStageType = (typeof PIPELINE_STAGE_TYPES)[number];

export const STAGE_EXECUTION_STATUSES = [
  "pending", "running", "completed", "failed", "skipped", "waiting_hitl",
] as const;
export type StageExecutionStatus = (typeof STAGE_EXECUTION_STATUSES)[number];
```

Also update `PIPELINE_RUN_STATUSES` to include `"pending"` and `"paused"`:

```typescript
export const PIPELINE_RUN_STATUSES = [
  "pending", "running", "paused", "completed", "failed", "cancelled",
] as const;
```

- [ ] **Step 3: Create shared pipeline types**

Create `packages/shared/src/types/pipeline.ts`:

```typescript
// AgentDash: Pipeline orchestrator types

export interface PipelineStageDefinition {
  id: string;
  name: string;
  type: "agent" | "hitl_gate" | "merge";
  agentId?: string;
  scopedInstruction: string;
  stateMapping?: Record<string, string>;
  timeoutMinutes?: number;
  maxRetries?: number;
  mergeStrategy?: "all" | "any";
  mergeTimeout?: number;
  hitlInstructions?: string;
  hitlTimeoutHours?: number;
}

export interface PipelineEdgeDefinition {
  id: string;
  fromStageId: string;
  toStageId: string;
  condition?: string;
}

export interface PipelineDefaults {
  stageTimeoutMinutes: number;
  hitlTimeoutHours: number;
  maxSelfHealRetries: number;
  budgetCapUsd?: number;
}

export interface StateEnvelope {
  pipelineRunId: string;
  sourceStageId: string | null;
  data: Record<string, unknown>;
  metadata: {
    pipelineId: string;
    stageIndex: number;
    totalStages: number;
    executionMode: "sync" | "async";
    accumulatedCostUsd: number;
  };
}

export interface SelfHealEntry {
  attempt: number;
  diagnosis: string;
  adjustedInstruction: string;
  outcome: "retried" | "failed";
  timestamp: string;
}

export interface PipelineWithCounts {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  stages: PipelineStageDefinition[];
  edges: PipelineEdgeDefinition[];
  executionMode: string;
  defaults: PipelineDefaults | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  runCount?: number;
  lastRunStatus?: string;
}
```

- [ ] **Step 4: Rewrite pipeline validators**

Replace `packages/shared/src/validators/pipeline.ts`:

```typescript
import { z } from "zod";

// AgentDash: Pipeline stage definition
export const pipelineStageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["agent", "hitl_gate", "merge"]),
  agentId: z.string().uuid().optional(),
  scopedInstruction: z.string().min(1),
  stateMapping: z.record(z.string()).optional(),
  timeoutMinutes: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonneg().max(10).optional(),
  mergeStrategy: z.enum(["all", "any"]).optional(),
  mergeTimeout: z.number().int().positive().optional(),
  hitlInstructions: z.string().optional(),
  hitlTimeoutHours: z.number().positive().optional(),
});

// AgentDash: Pipeline edge definition
export const pipelineEdgeSchema = z.object({
  id: z.string().min(1),
  fromStageId: z.string().min(1),
  toStageId: z.string().min(1),
  condition: z.string().optional(),
});

// AgentDash: Pipeline defaults
export const pipelineDefaultsSchema = z.object({
  stageTimeoutMinutes: z.number().int().positive().default(30),
  hitlTimeoutHours: z.number().positive().default(72),
  maxSelfHealRetries: z.number().int().nonneg().max(10).default(3),
  budgetCapUsd: z.number().positive().optional(),
});

export const createPipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  stages: z.array(pipelineStageSchema).min(1),
  edges: z.array(pipelineEdgeSchema).default([]),
  executionMode: z.enum(["sync", "async"]).default("sync"),
  defaults: pipelineDefaultsSchema.optional(),
});

export const updatePipelineSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  stages: z.array(pipelineStageSchema).min(1).optional(),
  edges: z.array(pipelineEdgeSchema).optional(),
  executionMode: z.enum(["sync", "async"]).optional(),
  defaults: pipelineDefaultsSchema.optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
});

export const startPipelineRunSchema = z.object({
  inputData: z.record(z.unknown()).optional(),
  executionMode: z.enum(["sync", "async"]).optional(),
});

export type CreatePipeline = z.infer<typeof createPipelineSchema>;
export type UpdatePipeline = z.infer<typeof updatePipelineSchema>;
export type StartPipelineRun = z.infer<typeof startPipelineRunSchema>;
```

- [ ] **Step 5: Export new types from barrel**

In `packages/shared/src/index.ts`, add exports for the new pipeline types and updated constants. Check which pipeline items are already exported and add the new ones:

```typescript
export type {
  PipelineStageDefinition,
  PipelineEdgeDefinition,
  PipelineDefaults,
  StateEnvelope,
  SelfHealEntry,
  PipelineWithCounts,
} from "./types/pipeline.js";
```

Also ensure the new constants (`PIPELINE_EXECUTION_MODES`, `PIPELINE_STAGE_TYPES`, `STAGE_EXECUTION_STATUSES`) are exported from constants.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/
git commit -m "feat(shared): add pipeline orchestrator types, validators, and constants"
```

---

### Task 3: Condition Evaluator

**Files:**
- Create: `server/src/services/pipeline-condition-evaluator.ts`
- Create: `server/src/services/__tests__/pipeline-condition-evaluator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/services/__tests__/pipeline-condition-evaluator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../pipeline-condition-evaluator.js";

describe("evaluateCondition", () => {
  const sampleData = {
    score: 0.85,
    status: "approved",
    count: 3,
    nested: { value: 42 },
    label: "high",
  };

  it("returns true for simple numeric comparison", () => {
    expect(evaluateCondition("data.score > 0.7", sampleData)).toBe(true);
  });

  it("returns false when numeric comparison fails", () => {
    expect(evaluateCondition("data.score > 0.9", sampleData)).toBe(false);
  });

  it("evaluates string equality", () => {
    expect(evaluateCondition('data.status === "approved"', sampleData)).toBe(true);
  });

  it("evaluates string inequality", () => {
    expect(evaluateCondition('data.status !== "rejected"', sampleData)).toBe(true);
  });

  it("evaluates nested property access", () => {
    expect(evaluateCondition("data.nested.value >= 42", sampleData)).toBe(true);
  });

  it("returns true for null/undefined condition (unconditional edge)", () => {
    expect(evaluateCondition(undefined, sampleData)).toBe(true);
    expect(evaluateCondition(null as unknown as string, sampleData)).toBe(true);
    expect(evaluateCondition("", sampleData)).toBe(true);
  });

  it("returns false for missing property", () => {
    expect(evaluateCondition("data.nonexistent > 0", sampleData)).toBe(false);
  });

  it("rejects dangerous expressions", () => {
    expect(() => evaluateCondition("process.exit(1)", sampleData)).toThrow();
    expect(() => evaluateCondition("require('fs')", sampleData)).toThrow();
    expect(() => evaluateCondition("eval('1+1')", sampleData)).toThrow();
    expect(() => evaluateCondition("data.__proto__", sampleData)).toThrow();
  });

  it("supports boolean operators", () => {
    expect(evaluateCondition("data.score > 0.5 && data.count > 2", sampleData)).toBe(true);
    expect(evaluateCondition("data.score < 0.5 || data.count > 2", sampleData)).toBe(true);
  });

  it("supports equality with numbers", () => {
    expect(evaluateCondition("data.count === 3", sampleData)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run server/src/services/__tests__/pipeline-condition-evaluator.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement condition evaluator**

Create `server/src/services/pipeline-condition-evaluator.ts`:

```typescript
// AgentDash: Safe expression evaluator for pipeline edge conditions
// Evaluates simple conditions against a state envelope's data field.
// Only allows property access, comparison operators, and boolean logic.
// Does NOT use eval() — uses manual parsing for safety.

const FORBIDDEN_PATTERNS = [
  /\b(eval|Function|require|import|process|global|window|document)\b/,
  /\b(constructor|__proto__|prototype)\b/,
  /[;{}[\]]/,
  /\.\s*\(/,
];

type ComparisonOp = "===" | "!==" | ">" | ">=" | "<" | "<=";
const COMPARISON_OPS: ComparisonOp[] = ["===", "!==", ">=", "<=", ">", "<"];

function resolveProperty(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseLiteral(token: string): unknown {
  const trimmed = token.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed === "undefined") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const strMatch = trimmed.match(/^["'](.*)["']$/);
  if (strMatch) return strMatch[1];
  return undefined;
}

function resolveValue(token: string, data: Record<string, unknown>): unknown {
  const trimmed = token.trim();
  if (trimmed.startsWith("data.")) {
    return resolveProperty({ data }, trimmed);
  }
  return parseLiteral(trimmed);
}

function evaluateComparison(
  expr: string,
  data: Record<string, unknown>,
): boolean {
  for (const op of COMPARISON_OPS) {
    const idx = expr.indexOf(op);
    if (idx === -1) continue;
    const left = resolveValue(expr.slice(0, idx), data);
    const right = resolveValue(expr.slice(idx + op.length), data);
    switch (op) {
      case "===": return left === right;
      case "!==": return left !== right;
      case ">":   return (left as number) > (right as number);
      case ">=":  return (left as number) >= (right as number);
      case "<":   return (left as number) < (right as number);
      case "<=":  return (left as number) <= (right as number);
    }
  }
  // No operator found — treat as truthy check on data property
  const val = resolveValue(expr, data);
  return Boolean(val);
}

function evaluateBooleanExpr(
  expr: string,
  data: Record<string, unknown>,
): boolean {
  // Split on || first (lower precedence)
  const orParts = expr.split("||");
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateBooleanExpr(part.trim(), data));
  }
  // Then split on &&
  const andParts = expr.split("&&");
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateComparison(part.trim(), data));
  }
  return evaluateComparison(expr.trim(), data);
}

export function evaluateCondition(
  condition: string | undefined | null,
  data: Record<string, unknown>,
): boolean {
  if (!condition || condition.trim() === "") return true;

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(condition)) {
      throw new Error(`Unsafe condition expression: ${condition}`);
    }
  }

  try {
    return evaluateBooleanExpr(condition, data);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run server/src/services/__tests__/pipeline-condition-evaluator.test.ts`

Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-condition-evaluator.ts server/src/services/__tests__/pipeline-condition-evaluator.test.ts
git commit -m "feat: add safe condition evaluator for pipeline edges"
```

---

### Task 4: Pipeline CRUD Service

**Files:**
- Modify: `server/src/services/pipeline-orchestrator.ts` (full rewrite)
- Create: `server/src/services/__tests__/pipeline-orchestrator.test.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Read existing service stub and service patterns**

Read `server/src/services/pipeline-orchestrator.ts`, `server/src/services/connectors.ts` (for service factory pattern reference), and `server/src/services/index.ts`.

- [ ] **Step 2: Write failing tests**

Create `server/src/services/__tests__/pipeline-orchestrator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validatePipelineDag } from "../pipeline-orchestrator.js";

describe("validatePipelineDag", () => {
  it("accepts a valid linear pipeline", () => {
    const stages = [
      { id: "s1", name: "A", type: "agent" as const, scopedInstruction: "do A" },
      { id: "s2", name: "B", type: "agent" as const, scopedInstruction: "do B" },
    ];
    const edges = [{ id: "e1", fromStageId: "s1", toStageId: "s2" }];
    expect(() => validatePipelineDag(stages, edges)).not.toThrow();
  });

  it("rejects edges referencing non-existent stages", () => {
    const stages = [
      { id: "s1", name: "A", type: "agent" as const, scopedInstruction: "do A" },
    ];
    const edges = [{ id: "e1", fromStageId: "s1", toStageId: "s999" }];
    expect(() => validatePipelineDag(stages, edges)).toThrow(/unknown stage/i);
  });

  it("rejects cycles in the DAG", () => {
    const stages = [
      { id: "s1", name: "A", type: "agent" as const, scopedInstruction: "do A" },
      { id: "s2", name: "B", type: "agent" as const, scopedInstruction: "do B" },
    ];
    const edges = [
      { id: "e1", fromStageId: "s1", toStageId: "s2" },
      { id: "e2", fromStageId: "s2", toStageId: "s1" },
    ];
    expect(() => validatePipelineDag(stages, edges)).toThrow(/cycle/i);
  });

  it("accepts fan-out with merge", () => {
    const stages = [
      { id: "s1", name: "Start", type: "agent" as const, scopedInstruction: "start" },
      { id: "s2a", name: "Branch A", type: "agent" as const, scopedInstruction: "branch a" },
      { id: "s2b", name: "Branch B", type: "agent" as const, scopedInstruction: "branch b" },
      { id: "s3", name: "Merge", type: "merge" as const, scopedInstruction: "merge", mergeStrategy: "all" as const },
    ];
    const edges = [
      { id: "e1", fromStageId: "s1", toStageId: "s2a" },
      { id: "e2", fromStageId: "s1", toStageId: "s2b" },
      { id: "e3", fromStageId: "s2a", toStageId: "s3" },
      { id: "e4", fromStageId: "s2b", toStageId: "s3" },
    ];
    expect(() => validatePipelineDag(stages, edges)).not.toThrow();
  });

  it("rejects duplicate stage IDs", () => {
    const stages = [
      { id: "s1", name: "A", type: "agent" as const, scopedInstruction: "do A" },
      { id: "s1", name: "B", type: "agent" as const, scopedInstruction: "do B" },
    ];
    expect(() => validatePipelineDag(stages, [])).toThrow(/duplicate/i);
  });
});

describe("pipelineOrchestratorService module", () => {
  it("exports pipelineOrchestratorService function", async () => {
    const mod = await import("../pipeline-orchestrator.js");
    expect(typeof mod.pipelineOrchestratorService).toBe("function");
  });

  it("exports validatePipelineDag function", async () => {
    const mod = await import("../pipeline-orchestrator.js");
    expect(typeof mod.validatePipelineDag).toBe("function");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run server/src/services/__tests__/pipeline-orchestrator.test.ts`

Expected: FAIL — functions not exported.

- [ ] **Step 4: Implement pipeline CRUD service**

Rewrite `server/src/services/pipeline-orchestrator.ts`:

```typescript
import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agentPipelines, pipelineRuns, pipelineStageExecutions } from "@agentdash/db/schema";
import type {
  PipelineStageDefinition,
  PipelineEdgeDefinition,
  CreatePipeline,
  UpdatePipeline,
  StartPipelineRun,
} from "@agentdash/shared";

// AgentDash: DAG validation — exported for testing
export function validatePipelineDag(
  stages: PipelineStageDefinition[],
  edges: PipelineEdgeDefinition[],
): void {
  // Check duplicate stage IDs
  const stageIds = new Set<string>();
  for (const s of stages) {
    if (stageIds.has(s.id)) throw new Error(`Duplicate stage ID: ${s.id}`);
    stageIds.add(s.id);
  }

  // Check edges reference valid stages
  for (const e of edges) {
    if (!stageIds.has(e.fromStageId))
      throw new Error(`Edge ${e.id} references unknown stage: ${e.fromStageId}`);
    if (!stageIds.has(e.toStageId))
      throw new Error(`Edge ${e.id} references unknown stage: ${e.toStageId}`);
  }

  // BFS cycle detection (topological sort)
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const s of stages) {
    inDegree.set(s.id, 0);
    adjacency.set(s.id, []);
  }
  for (const e of edges) {
    adjacency.get(e.fromStageId)!.push(e.toStageId);
    inDegree.set(e.toStageId, (inDegree.get(e.toStageId) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited !== stages.length) {
    throw new Error("Pipeline DAG contains a cycle");
  }
}

// AgentDash: Pipeline orchestrator service
export function pipelineOrchestratorService(db: Db) {
  return {
    // --- Pipeline CRUD ---
    async list(companyId: string) {
      return db
        .select()
        .from(agentPipelines)
        .where(
          and(
            eq(agentPipelines.companyId, companyId),
            eq(agentPipelines.status, "active"),
          ),
        )
        .orderBy(desc(agentPipelines.updatedAt));
    },

    async listAll(companyId: string) {
      return db
        .select()
        .from(agentPipelines)
        .where(eq(agentPipelines.companyId, companyId))
        .orderBy(desc(agentPipelines.updatedAt));
    },

    async get(companyId: string, pipelineId: string) {
      const [row] = await db
        .select()
        .from(agentPipelines)
        .where(
          and(
            eq(agentPipelines.id, pipelineId),
            eq(agentPipelines.companyId, companyId),
          ),
        );
      return row ?? null;
    },

    async create(companyId: string, data: CreatePipeline, createdBy?: string) {
      validatePipelineDag(data.stages, data.edges ?? []);
      const [row] = await db
        .insert(agentPipelines)
        .values({
          companyId,
          name: data.name,
          description: data.description,
          stages: data.stages,
          edges: data.edges ?? [],
          executionMode: data.executionMode ?? "sync",
          defaults: data.defaults,
          status: "draft",
          createdBy,
        })
        .returning();
      return row;
    },

    async update(companyId: string, pipelineId: string, data: UpdatePipeline) {
      if (data.stages && data.edges) {
        validatePipelineDag(data.stages, data.edges);
      }
      const [row] = await db
        .update(agentPipelines)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentPipelines.id, pipelineId),
            eq(agentPipelines.companyId, companyId),
          ),
        )
        .returning();
      return row ?? null;
    },

    async delete(companyId: string, pipelineId: string) {
      const [row] = await db
        .update(agentPipelines)
        .set({ status: "archived", archivedAt: new Date() })
        .where(
          and(
            eq(agentPipelines.id, pipelineId),
            eq(agentPipelines.companyId, companyId),
          ),
        )
        .returning();
      return row ?? null;
    },

    // --- Pipeline Run CRUD ---
    async createRun(companyId: string, pipelineId: string, data: StartPipelineRun, triggeredBy?: string) {
      const pipeline = await this.get(companyId, pipelineId);
      if (!pipeline) throw new Error("Pipeline not found");
      if (pipeline.status !== "active")
        throw new Error("Pipeline must be active to start a run");

      const [run] = await db
        .insert(pipelineRuns)
        .values({
          pipelineId,
          companyId,
          executionMode: data.executionMode ?? pipeline.executionMode,
          inputData: data.inputData,
          triggeredBy,
          status: "pending",
        })
        .returning();
      return run;
    },

    async getRun(companyId: string, runId: string) {
      const [row] = await db
        .select()
        .from(pipelineRuns)
        .where(
          and(
            eq(pipelineRuns.id, runId),
            eq(pipelineRuns.companyId, companyId),
          ),
        );
      return row ?? null;
    },

    async listRuns(companyId: string, pipelineId: string) {
      return db
        .select()
        .from(pipelineRuns)
        .where(
          and(
            eq(pipelineRuns.pipelineId, pipelineId),
            eq(pipelineRuns.companyId, companyId),
          ),
        )
        .orderBy(desc(pipelineRuns.createdAt));
    },

    async cancelRun(companyId: string, runId: string) {
      const [row] = await db
        .update(pipelineRuns)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(pipelineRuns.id, runId),
            eq(pipelineRuns.companyId, companyId),
          ),
        )
        .returning();
      return row ?? null;
    },

    // --- Stage Execution Tracking ---
    async createStageExecution(pipelineRunId: string, stageId: string, inputState: unknown) {
      const [row] = await db
        .insert(pipelineStageExecutions)
        .values({
          pipelineRunId,
          stageId,
          inputState: inputState as any,
          status: "pending",
        })
        .returning();
      return row;
    },

    async getStageExecutions(pipelineRunId: string) {
      return db
        .select()
        .from(pipelineStageExecutions)
        .where(eq(pipelineStageExecutions.pipelineRunId, pipelineRunId));
    },

    async updateStageExecution(id: string, updates: Record<string, unknown>) {
      const [row] = await db
        .update(pipelineStageExecutions)
        .set(updates as any)
        .where(eq(pipelineStageExecutions.id, id))
        .returning();
      return row ?? null;
    },
  };
}
```

- [ ] **Step 5: Export from services index**

In `server/src/services/index.ts`, add:

```typescript
export { pipelineOrchestratorService, validatePipelineDag } from "./pipeline-orchestrator.js";
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run server/src/services/__tests__/pipeline-orchestrator.test.ts`

Expected: All 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/pipeline-orchestrator.ts server/src/services/__tests__/pipeline-orchestrator.test.ts server/src/services/index.ts
git commit -m "feat: add pipeline CRUD service with DAG validation"
```

---

### Task 5: Pipeline Runner — Core DAG Walker

**Files:**
- Create: `server/src/services/pipeline-runner.ts`
- Create: `server/src/services/__tests__/pipeline-runner.test.ts`

- [ ] **Step 1: Write failing tests for DAG walking**

Create `server/src/services/__tests__/pipeline-runner.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  findEntryStages,
  findNextStages,
  buildStateEnvelope,
  applyStateMapping,
} from "../pipeline-runner.js";
import type { PipelineStageDefinition, PipelineEdgeDefinition } from "@agentdash/shared";

const linearStages: PipelineStageDefinition[] = [
  { id: "s1", name: "Scrape", type: "agent", scopedInstruction: "scrape" },
  { id: "s2", name: "Enrich", type: "agent", scopedInstruction: "enrich" },
  { id: "s3", name: "Score", type: "agent", scopedInstruction: "score" },
];

const linearEdges: PipelineEdgeDefinition[] = [
  { id: "e1", fromStageId: "s1", toStageId: "s2" },
  { id: "e2", fromStageId: "s2", toStageId: "s3" },
];

describe("findEntryStages", () => {
  it("finds stages with no incoming edges", () => {
    const result = findEntryStages(linearStages, linearEdges);
    expect(result).toEqual(["s1"]);
  });

  it("finds multiple entry stages for fan-out", () => {
    const stages: PipelineStageDefinition[] = [
      { id: "a", name: "A", type: "agent", scopedInstruction: "a" },
      { id: "b", name: "B", type: "agent", scopedInstruction: "b" },
    ];
    const result = findEntryStages(stages, []);
    expect(result).toHaveLength(2);
    expect(result).toContain("a");
    expect(result).toContain("b");
  });
});

describe("findNextStages", () => {
  it("finds the next stage in a linear pipeline", () => {
    const data = { result: "scraped data" };
    const result = findNextStages("s1", linearEdges, data);
    expect(result).toEqual(["s2"]);
  });

  it("returns empty for the last stage", () => {
    const result = findNextStages("s3", linearEdges, {});
    expect(result).toEqual([]);
  });

  it("evaluates conditional edges", () => {
    const edges: PipelineEdgeDefinition[] = [
      { id: "e1", fromStageId: "s1", toStageId: "s2", condition: "data.score > 0.7" },
      { id: "e2", fromStageId: "s1", toStageId: "s3", condition: "data.score <= 0.7" },
    ];
    const highScore = findNextStages("s1", edges, { score: 0.9 });
    expect(highScore).toEqual(["s2"]);

    const lowScore = findNextStages("s1", edges, { score: 0.3 });
    expect(lowScore).toEqual(["s3"]);
  });

  it("follows unconditional edges alongside conditional", () => {
    const edges: PipelineEdgeDefinition[] = [
      { id: "e1", fromStageId: "s1", toStageId: "s2" },
      { id: "e2", fromStageId: "s1", toStageId: "s3", condition: "data.flag === true" },
    ];
    const result = findNextStages("s1", edges, { flag: true });
    expect(result).toEqual(["s2", "s3"]);
  });
});

describe("buildStateEnvelope", () => {
  it("wraps output data with metadata", () => {
    const env = buildStateEnvelope({
      pipelineRunId: "run-1",
      pipelineId: "pipe-1",
      sourceStageId: "s1",
      data: { leads: [1, 2, 3] },
      stageIndex: 1,
      totalStages: 3,
      executionMode: "sync",
      accumulatedCostUsd: 0.5,
    });
    expect(env.pipelineRunId).toBe("run-1");
    expect(env.sourceStageId).toBe("s1");
    expect(env.data.leads).toEqual([1, 2, 3]);
    expect(env.metadata.stageIndex).toBe(1);
    expect(env.metadata.executionMode).toBe("sync");
  });
});

describe("applyStateMapping", () => {
  it("maps fields from source to target keys", () => {
    const source = { score: 0.85, name: "Acme", extra: "ignored" };
    const mapping = { rating: "score", company: "name" };
    const result = applyStateMapping(source, mapping);
    expect(result).toEqual({ rating: 0.85, company: "Acme" });
  });

  it("passes through all data when no mapping defined", () => {
    const source = { a: 1, b: 2 };
    const result = applyStateMapping(source, undefined);
    expect(result).toEqual({ a: 1, b: 2 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run server/src/services/__tests__/pipeline-runner.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement pipeline runner core**

Create `server/src/services/pipeline-runner.ts`:

```typescript
import type { Db } from "@agentdash/db";
import type {
  PipelineStageDefinition,
  PipelineEdgeDefinition,
  PipelineDefaults,
  StateEnvelope,
} from "@agentdash/shared";
import { evaluateCondition } from "./pipeline-condition-evaluator.js";

// AgentDash: Pipeline runner — core DAG execution engine

export function findEntryStages(
  stages: PipelineStageDefinition[],
  edges: PipelineEdgeDefinition[],
): string[] {
  const hasIncoming = new Set(edges.map((e) => e.toStageId));
  return stages.filter((s) => !hasIncoming.has(s.id)).map((s) => s.id);
}

export function findNextStages(
  completedStageId: string,
  edges: PipelineEdgeDefinition[],
  outputData: Record<string, unknown>,
): string[] {
  return edges
    .filter((e) => e.fromStageId === completedStageId)
    .filter((e) => evaluateCondition(e.condition, outputData))
    .map((e) => e.toStageId);
}

export function buildStateEnvelope(params: {
  pipelineRunId: string;
  pipelineId: string;
  sourceStageId: string | null;
  data: Record<string, unknown>;
  stageIndex: number;
  totalStages: number;
  executionMode: "sync" | "async";
  accumulatedCostUsd: number;
}): StateEnvelope {
  return {
    pipelineRunId: params.pipelineRunId,
    sourceStageId: params.sourceStageId,
    data: params.data,
    metadata: {
      pipelineId: params.pipelineId,
      stageIndex: params.stageIndex,
      totalStages: params.totalStages,
      executionMode: params.executionMode,
      accumulatedCostUsd: params.accumulatedCostUsd,
    },
  };
}

export function applyStateMapping(
  source: Record<string, unknown>,
  mapping: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!mapping) return { ...source };
  const result: Record<string, unknown> = {};
  for (const [targetKey, sourceKey] of Object.entries(mapping)) {
    result[targetKey] = source[sourceKey];
  }
  return result;
}

export function getStageById(
  stages: PipelineStageDefinition[],
  stageId: string,
): PipelineStageDefinition | undefined {
  return stages.find((s) => s.id === stageId);
}

export function getIncomingEdges(
  stageId: string,
  edges: PipelineEdgeDefinition[],
): PipelineEdgeDefinition[] {
  return edges.filter((e) => e.toStageId === stageId);
}

export function isMergeReady(
  mergeStageId: string,
  edges: PipelineEdgeDefinition[],
  completedStageIds: Set<string>,
  strategy: "all" | "any",
): boolean {
  const incoming = getIncomingEdges(mergeStageId, edges);
  if (incoming.length === 0) return true;
  if (strategy === "any") {
    return incoming.some((e) => completedStageIds.has(e.fromStageId));
  }
  return incoming.every((e) => completedStageIds.has(e.fromStageId));
}

export function getEffectiveTimeout(
  stage: PipelineStageDefinition,
  defaults: PipelineDefaults | null,
): number {
  if (stage.type === "hitl_gate") {
    return (stage.hitlTimeoutHours ?? defaults?.hitlTimeoutHours ?? 72) * 60;
  }
  return stage.timeoutMinutes ?? defaults?.stageTimeoutMinutes ?? 30;
}

export function getEffectiveMaxRetries(
  stage: PipelineStageDefinition,
  defaults: PipelineDefaults | null,
): number {
  return stage.maxRetries ?? defaults?.maxSelfHealRetries ?? 3;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run server/src/services/__tests__/pipeline-runner.test.ts`

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-runner.ts server/src/services/__tests__/pipeline-runner.test.ts
git commit -m "feat: add pipeline runner core with DAG walker and state passing"
```

---

### Task 6: Pipeline Runner — Execution Integration

**Files:**
- Modify: `server/src/services/pipeline-runner.ts` (add `pipelineRunnerService`)
- Modify: `server/src/services/index.ts`

This task adds the `pipelineRunnerService(db)` factory that integrates with the heartbeat engine, approval system, and budget tracking. It is the orchestration heart that advances pipeline runs.

- [ ] **Step 1: Read heartbeat service integration points**

Read `server/src/services/heartbeat.ts` to find the exact method signatures for:
- Creating a heartbeat run (INSERT into `heartbeatRuns`)
- Executing a run directly (for sync mode)
- The `wakeup()` method for HITL resume

Also read `server/src/services/approvals.ts` to find how to create an approval.

- [ ] **Step 2: Add pipelineRunnerService to pipeline-runner.ts**

Append to `server/src/services/pipeline-runner.ts`:

```typescript
import { eq, and } from "drizzle-orm";
import { agentPipelines, pipelineRuns, pipelineStageExecutions } from "@agentdash/db/schema";

// AgentDash: Pipeline runner service — advances pipeline runs through DAG stages
export function pipelineRunnerService(db: Db) {
  const svc = {
    // Start a pipeline run by launching entry stages
    async startRun(runId: string) {
      const [run] = await db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.id, runId));
      if (!run) throw new Error("Run not found");

      const [pipeline] = await db
        .select()
        .from(agentPipelines)
        .where(eq(agentPipelines.id, run.pipelineId));
      if (!pipeline) throw new Error("Pipeline not found");

      const stages = pipeline.stages as PipelineStageDefinition[];
      const edges = (pipeline.edges ?? []) as PipelineEdgeDefinition[];
      const entryStageIds = findEntryStages(stages, edges);

      if (entryStageIds.length === 0) {
        throw new Error("Pipeline has no entry stages");
      }

      // Mark run as running
      await db
        .update(pipelineRuns)
        .set({
          status: "running",
          activeStageIds: entryStageIds,
          startedAt: new Date(),
        })
        .where(eq(pipelineRuns.id, runId));

      // Create stage executions for entry stages
      const initialEnvelope = buildStateEnvelope({
        pipelineRunId: runId,
        pipelineId: pipeline.id,
        sourceStageId: null,
        data: (run.inputData as Record<string, unknown>) ?? {},
        stageIndex: 0,
        totalStages: stages.length,
        executionMode: run.executionMode as "sync" | "async",
        accumulatedCostUsd: 0,
      });

      for (const stageId of entryStageIds) {
        const stage = getStageById(stages, stageId);
        if (!stage) continue;

        const mapped = applyStateMapping(initialEnvelope.data, stage.stateMapping);
        const stageEnvelope = { ...initialEnvelope, data: mapped };

        await db.insert(pipelineStageExecutions).values({
          pipelineRunId: runId,
          stageId,
          inputState: stageEnvelope as any,
          status: "pending",
        });
      }

      return { runId, entryStageIds };
    },

    // Called when a stage completes — advances the DAG
    async onStageCompleted(
      runId: string,
      stageId: string,
      outputData: Record<string, unknown>,
      costUsd: number,
    ) {
      const [run] = await db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.id, runId));
      if (!run || run.status !== "running") return;

      const [pipeline] = await db
        .select()
        .from(agentPipelines)
        .where(eq(agentPipelines.id, run.pipelineId));
      if (!pipeline) return;

      const stages = pipeline.stages as PipelineStageDefinition[];
      const edges = (pipeline.edges ?? []) as PipelineEdgeDefinition[];
      const defaults = pipeline.defaults as PipelineDefaults | null;

      // Update stage execution as completed
      const stageExecs = await db
        .select()
        .from(pipelineStageExecutions)
        .where(
          and(
            eq(pipelineStageExecutions.pipelineRunId, runId),
            eq(pipelineStageExecutions.stageId, stageId),
          ),
        );
      const stageExec = stageExecs[0];
      if (stageExec) {
        await db
          .update(pipelineStageExecutions)
          .set({
            status: "completed",
            outputState: outputData,
            costUsd: String(costUsd),
            completedAt: new Date(),
          })
          .where(eq(pipelineStageExecutions.id, stageExec.id));
      }

      // Accumulate cost
      const newTotalCost = Number(run.totalCostUsd ?? 0) + costUsd;

      // Budget check
      if (defaults?.budgetCapUsd && newTotalCost > defaults.budgetCapUsd) {
        await db
          .update(pipelineRuns)
          .set({ status: "paused", totalCostUsd: String(newTotalCost) })
          .where(eq(pipelineRuns.id, runId));
        return { action: "paused", reason: "budget_exceeded" };
      }

      // Find next stages via DAG edges + conditions
      const nextStageIds = findNextStages(stageId, edges, outputData);

      // Get all completed stages for merge-readiness checks
      const allExecs = await db
        .select()
        .from(pipelineStageExecutions)
        .where(eq(pipelineStageExecutions.pipelineRunId, runId));
      const completedIds = new Set(
        allExecs.filter((e) => e.status === "completed").map((e) => e.stageId),
      );
      completedIds.add(stageId);

      // Filter next stages — check merge readiness
      const readyStageIds: string[] = [];
      for (const nextId of nextStageIds) {
        const nextStage = getStageById(stages, nextId);
        if (!nextStage) continue;

        if (nextStage.type === "merge") {
          const strategy = nextStage.mergeStrategy ?? "all";
          if (!isMergeReady(nextId, edges, completedIds, strategy)) {
            continue; // wait for other branches
          }
        }
        readyStageIds.push(nextId);
      }

      // Remove completed stage from active, add new ready stages
      const currentActive = (run.activeStageIds as string[]) ?? [];
      const newActive = [
        ...currentActive.filter((id) => id !== stageId),
        ...readyStageIds,
      ];

      // If no active stages and no ready stages, pipeline is complete
      if (newActive.length === 0) {
        await db
          .update(pipelineRuns)
          .set({
            status: "completed",
            activeStageIds: [],
            outputData,
            totalCostUsd: String(newTotalCost),
            completedAt: new Date(),
          })
          .where(eq(pipelineRuns.id, runId));
        return { action: "completed", outputData };
      }

      // Update run with new active stages and cost
      await db
        .update(pipelineRuns)
        .set({
          activeStageIds: newActive,
          totalCostUsd: String(newTotalCost),
        })
        .where(eq(pipelineRuns.id, runId));

      // Create stage executions for newly ready stages
      const stageIndex = stages.findIndex((s) => s.id === stageId);
      for (const nextId of readyStageIds) {
        const nextStage = getStageById(stages, nextId);
        if (!nextStage) continue;

        const mapped = applyStateMapping(outputData, nextStage.stateMapping);
        const envelope = buildStateEnvelope({
          pipelineRunId: runId,
          pipelineId: pipeline.id,
          sourceStageId: stageId,
          data: mapped,
          stageIndex: stageIndex + 1,
          totalStages: stages.length,
          executionMode: run.executionMode as "sync" | "async",
          accumulatedCostUsd: newTotalCost,
        });

        await db.insert(pipelineStageExecutions).values({
          pipelineRunId: runId,
          stageId: nextId,
          inputState: envelope as any,
          status: nextStage.type === "hitl_gate" ? "waiting_hitl" : "pending",
        });
      }

      return { action: "advanced", readyStageIds };
    },

    // Handle HITL gate approval
    async onHitlDecision(
      runId: string,
      stageId: string,
      decision: "approved" | "rejected",
      notes?: string,
    ) {
      if (decision === "rejected") {
        await db
          .update(pipelineRuns)
          .set({ status: "cancelled", errorMessage: notes ?? "HITL rejected" })
          .where(eq(pipelineRuns.id, runId));
        return { action: "cancelled" };
      }

      // Approved — mark stage as completed and advance
      return svc.onStageCompleted(runId, stageId, { hitl_decision: "approved", notes }, 0);
    },

    // Handle stage failure
    async onStageFailed(runId: string, stageId: string, error: string) {
      const stageExecs = await db
        .select()
        .from(pipelineStageExecutions)
        .where(
          and(
            eq(pipelineStageExecutions.pipelineRunId, runId),
            eq(pipelineStageExecutions.stageId, stageId),
          ),
        );
      const stageExec = stageExecs[0];
      if (stageExec) {
        await db
          .update(pipelineStageExecutions)
          .set({
            status: "failed",
            errorMessage: error,
            completedAt: new Date(),
          })
          .where(eq(pipelineStageExecutions.id, stageExec.id));
      }

      // Mark run as failed
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          errorMessage: `Stage ${stageId} failed: ${error}`,
          failedAt: new Date(),
        })
        .where(eq(pipelineRuns.id, runId));

      return { action: "failed", stageId, error };
    },
  };

  return svc;
}
```

- [ ] **Step 3: Export from services index**

In `server/src/services/index.ts`, add:

```typescript
export { pipelineRunnerService } from "./pipeline-runner.js";
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS. Fix any import issues (the `@agentdash/db/schema` import may need adjustment based on how the DB package exports).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-runner.ts server/src/services/index.ts
git commit -m "feat: add pipeline runner execution engine with DAG advancement"
```

---

### Task 7: Self-Heal Service

**Files:**
- Create: `server/src/services/pipeline-self-heal.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Create self-heal service**

Create `server/src/services/pipeline-self-heal.ts`:

```typescript
import type { Db } from "@agentdash/db";
import { eq, and } from "drizzle-orm";
import { pipelineStageExecutions } from "@agentdash/db/schema";
import type { SelfHealEntry, StateEnvelope } from "@agentdash/shared";

// AgentDash: Self-healing loop for pipeline stage failures
// Uses LLM diagnosis to adjust instruction and retry, rather than blind retry.

interface DiagnoseResult {
  diagnosis: string;
  adjustedInstruction: string;
  shouldRetry: boolean;
}

// Placeholder LLM call — will use the same callLlm from wizard service
// when Anthropic API key is available. Falls back to structured retry guidance.
async function diagnoseStageFailure(
  originalInstruction: string,
  inputData: Record<string, unknown>,
  error: string,
  previousAttempts: SelfHealEntry[],
): Promise<DiagnoseResult> {
  // Build diagnosis prompt
  const attemptHistory = previousAttempts
    .map((a) => `Attempt ${a.attempt}: ${a.diagnosis} → ${a.outcome}`)
    .join("\n");

  // Without an LLM call, provide structured guidance
  const diagnosis = [
    `Stage failed with error: ${error}`,
    `Original instruction: ${originalInstruction}`,
    previousAttempts.length > 0
      ? `Previous ${previousAttempts.length} attempt(s):\n${attemptHistory}`
      : "First failure — no prior attempts.",
    `Input data keys: ${Object.keys(inputData).join(", ")}`,
  ].join("\n");

  // Adjust instruction to be more explicit about error handling
  const adjustedInstruction = [
    originalInstruction,
    "",
    "IMPORTANT: A previous attempt failed with this error:",
    error,
    "Please approach this task more carefully, validating inputs before proceeding.",
    previousAttempts.length > 0
      ? `This is retry attempt ${previousAttempts.length + 1}. Previous adjustments did not resolve the issue.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    diagnosis,
    adjustedInstruction,
    shouldRetry: previousAttempts.length < 3,
  };
}

export function pipelineSelfHealService(db: Db) {
  return {
    async attemptHeal(
      stageExecutionId: string,
      originalInstruction: string,
      inputData: Record<string, unknown>,
      error: string,
      maxRetries: number,
    ): Promise<{ shouldRetry: boolean; adjustedInstruction: string }> {
      // Get current stage execution with its heal log
      const [stageExec] = await db
        .select()
        .from(pipelineStageExecutions)
        .where(eq(pipelineStageExecutions.id, stageExecutionId));

      if (!stageExec) throw new Error("Stage execution not found");

      const currentAttempts = stageExec.selfHealAttempts ?? 0;
      const healLog = (stageExec.selfHealLog ?? []) as SelfHealEntry[];

      if (currentAttempts >= maxRetries) {
        return { shouldRetry: false, adjustedInstruction: originalInstruction };
      }

      const result = await diagnoseStageFailure(
        originalInstruction,
        inputData,
        error,
        healLog,
      );

      // Log the heal attempt
      const newEntry: SelfHealEntry = {
        attempt: currentAttempts + 1,
        diagnosis: result.diagnosis,
        adjustedInstruction: result.adjustedInstruction,
        outcome: result.shouldRetry ? "retried" : "failed",
        timestamp: new Date().toISOString(),
      };

      await db
        .update(pipelineStageExecutions)
        .set({
          selfHealAttempts: currentAttempts + 1,
          selfHealLog: [...healLog, newEntry],
          status: result.shouldRetry ? "pending" : "failed",
        })
        .where(eq(pipelineStageExecutions.id, stageExecutionId));

      return {
        shouldRetry: result.shouldRetry,
        adjustedInstruction: result.adjustedInstruction,
      };
    },
  };
}
```

- [ ] **Step 2: Export from services index**

In `server/src/services/index.ts`, add:

```typescript
export { pipelineSelfHealService } from "./pipeline-self-heal.js";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/services/pipeline-self-heal.ts server/src/services/index.ts
git commit -m "feat: add pipeline self-heal service with LLM diagnosis loop"
```

---

### Task 8: Pipeline Routes

**Files:**
- Modify: `server/src/routes/pipelines.ts` (full rewrite)

- [ ] **Step 1: Read existing route patterns**

Read `server/src/routes/connectors.ts` and `server/src/routes/inbox.ts` for the route pattern reference (assertCompanyAccess, validate middleware, service calls).

- [ ] **Step 2: Rewrite pipeline routes**

Replace `server/src/routes/pipelines.ts`:

```typescript
import { Router } from "express";
import type { Db } from "@agentdash/db";
import { pipelineOrchestratorService } from "../services/pipeline-orchestrator.js";
import { pipelineRunnerService } from "../services/pipeline-runner.js";
import { assertCompanyAccess } from "../services/access.js";
import { validate } from "../middleware/validate.js";
import {
  createPipelineSchema,
  updatePipelineSchema,
  startPipelineRunSchema,
} from "@agentdash/shared";

// AgentDash: Pipeline orchestrator routes
export function pipelineRoutes(db: Db) {
  const router = Router();
  const orchestrator = pipelineOrchestratorService(db);
  const runner = pipelineRunnerService(db);

  // --- Pipeline CRUD ---

  // List pipelines for a company
  router.get("/companies/:companyId/pipelines", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const includeArchived = req.query.includeArchived === "true";
    const pipelines = includeArchived
      ? await orchestrator.listAll(companyId)
      : await orchestrator.list(companyId);
    res.json(pipelines);
  });

  // Get a single pipeline
  router.get("/companies/:companyId/pipelines/:pipelineId", async (req, res) => {
    const { companyId, pipelineId } = req.params;
    assertCompanyAccess(req, companyId);
    const pipeline = await orchestrator.get(companyId, pipelineId);
    if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
    res.json(pipeline);
  });

  // Create a pipeline
  router.post(
    "/companies/:companyId/pipelines",
    validate(createPipelineSchema),
    async (req, res) => {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const pipeline = await orchestrator.create(companyId, req.body);
      res.status(201).json(pipeline);
    },
  );

  // Update a pipeline
  router.patch(
    "/companies/:companyId/pipelines/:pipelineId",
    validate(updatePipelineSchema),
    async (req, res) => {
      const { companyId, pipelineId } = req.params;
      assertCompanyAccess(req, companyId);
      const pipeline = await orchestrator.update(companyId, pipelineId, req.body);
      if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
      res.json(pipeline);
    },
  );

  // Delete (archive) a pipeline
  router.delete("/companies/:companyId/pipelines/:pipelineId", async (req, res) => {
    const { companyId, pipelineId } = req.params;
    assertCompanyAccess(req, companyId);
    const pipeline = await orchestrator.delete(companyId, pipelineId);
    if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });
    res.json(pipeline);
  });

  // --- Pipeline Run Management ---

  // List runs for a pipeline
  router.get("/companies/:companyId/pipelines/:pipelineId/runs", async (req, res) => {
    const { companyId, pipelineId } = req.params;
    assertCompanyAccess(req, companyId);
    const runs = await orchestrator.listRuns(companyId, pipelineId);
    res.json(runs);
  });

  // Start a pipeline run
  router.post(
    "/companies/:companyId/pipelines/:pipelineId/runs",
    validate(startPipelineRunSchema),
    async (req, res) => {
      const { companyId, pipelineId } = req.params;
      assertCompanyAccess(req, companyId);
      const run = await orchestrator.createRun(companyId, pipelineId, req.body);
      // Start execution
      const result = await runner.startRun(run.id);
      res.status(201).json({ ...run, ...result });
    },
  );

  // Get a specific run
  router.get("/companies/:companyId/pipeline-runs/:runId", async (req, res) => {
    const { companyId, runId } = req.params;
    assertCompanyAccess(req, companyId);
    const run = await orchestrator.getRun(companyId, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const stages = await orchestrator.getStageExecutions(run.id);
    res.json({ ...run, stages });
  });

  // Cancel a run
  router.post("/companies/:companyId/pipeline-runs/:runId/cancel", async (req, res) => {
    const { companyId, runId } = req.params;
    assertCompanyAccess(req, companyId);
    const run = await orchestrator.cancelRun(companyId, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    res.json(run);
  });

  // HITL decision on a run's stage
  router.post("/companies/:companyId/pipeline-runs/:runId/stages/:stageId/decide", async (req, res) => {
    const { companyId, runId, stageId } = req.params;
    assertCompanyAccess(req, companyId);
    const { decision, notes } = req.body;
    const result = await runner.onHitlDecision(runId, stageId, decision, notes);
    res.json(result);
  });

  return router;
}
```

- [ ] **Step 3: Verify the routes mount in app.ts**

Read `server/src/app.ts` to confirm `api.use(pipelineRoutes(db))` is already present. It should be — the stub was already wired. If not, add it.

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS. If `validate` middleware import path differs, adjust to match existing route patterns.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pipelines.ts
git commit -m "feat: add pipeline REST routes for CRUD and run management"
```

---

### Task 9: UI API Client & Query Keys

**Files:**
- Create: `ui/src/api/pipelines.ts`
- Modify: `ui/src/lib/queryKeys.ts`

- [ ] **Step 1: Read existing API client patterns**

Read `ui/src/api/connectors.ts` and `ui/src/api/inbox.ts` for the API client pattern.

- [ ] **Step 2: Create pipeline API client**

Create `ui/src/api/pipelines.ts`:

```typescript
import { apiClient } from "./client";
import type {
  PipelineStageDefinition,
  PipelineEdgeDefinition,
  PipelineDefaults,
} from "@agentdash/shared";

// AgentDash: Pipeline API client

export interface Pipeline {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  stages: PipelineStageDefinition[];
  edges: PipelineEdgeDefinition[];
  executionMode: string;
  defaults: PipelineDefaults | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  companyId: string;
  status: string;
  executionMode: string;
  activeStageIds: string[];
  inputData: Record<string, unknown> | null;
  outputData: Record<string, unknown> | null;
  totalCostUsd: string;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface StageExecution {
  id: string;
  pipelineRunId: string;
  stageId: string;
  status: string;
  inputState: unknown;
  outputState: Record<string, unknown> | null;
  costUsd: string;
  selfHealAttempts: number;
  selfHealLog: unknown[];
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PipelineRunWithStages extends PipelineRun {
  stages: StageExecution[];
}

export const pipelinesApi = {
  list: (companyId: string) =>
    apiClient.get<Pipeline[]>(`/companies/${companyId}/pipelines`),

  get: (companyId: string, pipelineId: string) =>
    apiClient.get<Pipeline>(`/companies/${companyId}/pipelines/${pipelineId}`),

  create: (companyId: string, data: {
    name: string;
    description?: string;
    stages: PipelineStageDefinition[];
    edges?: PipelineEdgeDefinition[];
    executionMode?: string;
    defaults?: PipelineDefaults;
  }) => apiClient.post<Pipeline>(`/companies/${companyId}/pipelines`, data),

  update: (companyId: string, pipelineId: string, data: Partial<Pipeline>) =>
    apiClient.patch<Pipeline>(`/companies/${companyId}/pipelines/${pipelineId}`, data),

  delete: (companyId: string, pipelineId: string) =>
    apiClient.delete<Pipeline>(`/companies/${companyId}/pipelines/${pipelineId}`),

  listRuns: (companyId: string, pipelineId: string) =>
    apiClient.get<PipelineRun[]>(`/companies/${companyId}/pipelines/${pipelineId}/runs`),

  startRun: (companyId: string, pipelineId: string, data?: {
    inputData?: Record<string, unknown>;
    executionMode?: string;
  }) => apiClient.post<PipelineRun>(`/companies/${companyId}/pipelines/${pipelineId}/runs`, data ?? {}),

  getRun: (companyId: string, runId: string) =>
    apiClient.get<PipelineRunWithStages>(`/companies/${companyId}/pipeline-runs/${runId}`),

  cancelRun: (companyId: string, runId: string) =>
    apiClient.post<PipelineRun>(`/companies/${companyId}/pipeline-runs/${runId}/cancel`, {}),

  hitlDecide: (companyId: string, runId: string, stageId: string, decision: "approved" | "rejected", notes?: string) =>
    apiClient.post(`/companies/${companyId}/pipeline-runs/${runId}/stages/${stageId}/decide`, { decision, notes }),
};
```

- [ ] **Step 3: Add pipeline query keys**

In `ui/src/lib/queryKeys.ts`, add inside the `queryKeys` object after the `agentResearch` block:

```typescript
  pipelines: {
    list: (companyId: string) => ["pipelines", companyId] as const,
    detail: (companyId: string, pipelineId: string) =>
      ["pipelines", companyId, pipelineId] as const,
    runs: (companyId: string, pipelineId: string) =>
      ["pipelines", companyId, pipelineId, "runs"] as const,
    runDetail: (companyId: string, runId: string) =>
      ["pipelines", "run", companyId, runId] as const,
  },
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS. The `apiClient` import must match the pattern in existing API files — check `ui/src/api/client.ts` for the exact export name.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/pipelines.ts ui/src/lib/queryKeys.ts
git commit -m "feat(ui): add pipeline API client and query keys"
```

---

### Task 10: DAG Preview Component

**Files:**
- Create: `ui/src/components/DagPreview.tsx`

- [ ] **Step 1: Read existing component patterns**

Read a representative UI component (e.g., `ui/src/components/EmptyState.tsx` or a simple card component) for styling/Tailwind patterns.

- [ ] **Step 2: Create DAG preview**

Create `ui/src/components/DagPreview.tsx`. This is a read-only SVG visualization that renders pipeline stages as nodes and edges as arrows. Uses a simple left-to-right layered layout computed from the DAG topology.

```tsx
import { useMemo } from "react";
import type { PipelineStageDefinition, PipelineEdgeDefinition } from "@agentdash/shared";

// AgentDash: Read-only DAG visualization for pipeline stages

interface DagPreviewProps {
  stages: PipelineStageDefinition[];
  edges: PipelineEdgeDefinition[];
  activeStageIds?: string[];
  completedStageIds?: string[];
  failedStageIds?: string[];
  className?: string;
}

const NODE_W = 160;
const NODE_H = 48;
const GAP_X = 80;
const GAP_Y = 24;
const PADDING = 24;

function computeLayers(
  stages: PipelineStageDefinition[],
  edges: PipelineEdgeDefinition[],
): Map<string, number> {
  const layers = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const s of stages) {
    inDegree.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const e of edges) {
    adj.get(e.fromStageId)?.push(e.toStageId);
    inDegree.set(e.toStageId, (inDegree.get(e.toStageId) ?? 0) + 1);
  }

  // BFS topological layering
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      layers.set(id, 0);
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    const layer = layers.get(node) ?? 0;
    for (const next of adj.get(node) ?? []) {
      const nextLayer = Math.max(layers.get(next) ?? 0, layer + 1);
      layers.set(next, nextLayer);
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  return layers;
}

function stageColor(
  stageId: string,
  type: string,
  active?: string[],
  completed?: string[],
  failed?: string[],
): string {
  if (failed?.includes(stageId)) return "#ef4444";
  if (active?.includes(stageId)) return "#3b82f6";
  if (completed?.includes(stageId)) return "#22c55e";
  if (type === "hitl_gate") return "#f59e0b";
  if (type === "merge") return "#8b5cf6";
  return "#6b7280";
}

function stageLabel(type: string): string {
  if (type === "hitl_gate") return "HITL";
  if (type === "merge") return "Merge";
  return "";
}

export function DagPreview({
  stages,
  edges,
  activeStageIds,
  completedStageIds,
  failedStageIds,
  className,
}: DagPreviewProps) {
  const layout = useMemo(() => {
    const layers = computeLayers(stages, edges);
    const layerGroups = new Map<number, string[]>();

    for (const [id, layer] of layers) {
      if (!layerGroups.has(layer)) layerGroups.set(layer, []);
      layerGroups.get(layer)!.push(id);
    }

    const positions = new Map<string, { x: number; y: number }>();
    for (const [layer, ids] of layerGroups) {
      ids.forEach((id, i) => {
        positions.set(id, {
          x: PADDING + layer * (NODE_W + GAP_X),
          y: PADDING + i * (NODE_H + GAP_Y),
        });
      });
    }

    const maxLayer = Math.max(0, ...layers.values());
    const maxPerLayer = Math.max(1, ...Array.from(layerGroups.values()).map((g) => g.length));
    const svgW = PADDING * 2 + (maxLayer + 1) * NODE_W + maxLayer * GAP_X;
    const svgH = PADDING * 2 + maxPerLayer * NODE_H + (maxPerLayer - 1) * GAP_Y;

    return { positions, svgW, svgH };
  }, [stages, edges]);

  if (stages.length === 0) {
    return <div className={className}>No stages defined</div>;
  }

  return (
    <svg
      width={layout.svgW}
      height={layout.svgH}
      className={className}
      viewBox={`0 0 ${layout.svgW} ${layout.svgH}`}
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5"
          markerWidth="8" markerHeight="8" orient="auto-start-auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((edge) => {
        const from = layout.positions.get(edge.fromStageId);
        const to = layout.positions.get(edge.toStageId);
        if (!from || !to) return null;
        return (
          <g key={edge.id}>
            <line
              x1={from.x + NODE_W}
              y1={from.y + NODE_H / 2}
              x2={to.x}
              y2={to.y + NODE_H / 2}
              stroke="#9ca3af"
              strokeWidth={1.5}
              markerEnd="url(#arrow)"
            />
            {edge.condition && (
              <text
                x={(from.x + NODE_W + to.x) / 2}
                y={(from.y + to.y) / 2 + NODE_H / 2 - 4}
                fontSize={10}
                fill="#6b7280"
                textAnchor="middle"
              >
                {edge.condition.length > 30
                  ? edge.condition.slice(0, 27) + "..."
                  : edge.condition}
              </text>
            )}
          </g>
        );
      })}

      {/* Nodes */}
      {stages.map((stage) => {
        const pos = layout.positions.get(stage.id);
        if (!pos) return null;
        const color = stageColor(
          stage.id, stage.type, activeStageIds, completedStageIds, failedStageIds,
        );
        const badge = stageLabel(stage.type);
        return (
          <g key={stage.id}>
            <rect
              x={pos.x} y={pos.y}
              width={NODE_W} height={NODE_H}
              rx={8} ry={8}
              fill="white"
              stroke={color}
              strokeWidth={2}
            />
            <text
              x={pos.x + NODE_W / 2}
              y={pos.y + NODE_H / 2 + (badge ? -2 : 4)}
              fontSize={12}
              fontWeight={500}
              fill="#1f2937"
              textAnchor="middle"
            >
              {stage.name.length > 18 ? stage.name.slice(0, 15) + "..." : stage.name}
            </text>
            {badge && (
              <text
                x={pos.x + NODE_W / 2}
                y={pos.y + NODE_H / 2 + 14}
                fontSize={9}
                fill={color}
                textAnchor="middle"
              >
                {badge}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/DagPreview.tsx
git commit -m "feat(ui): add read-only DAG preview component for pipelines"
```

---

### Task 11: Pipeline List & Detail Pages

**Files:**
- Modify: `ui/src/pages/Pipelines.tsx` (rewrite)
- Create: `ui/src/pages/PipelineDetail.tsx`

- [ ] **Step 1: Read existing page patterns**

Read `ui/src/pages/Connectors.tsx` for the list page pattern and `ui/src/pages/AgentDetail.tsx` for the detail page pattern. Also check existing `ui/src/pages/Pipelines.tsx` to see what's there.

- [ ] **Step 2: Rewrite Pipelines list page**

Replace `ui/src/pages/Pipelines.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useCompany } from "../hooks/useCompany";
import { pipelinesApi, type Pipeline } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { DagPreview } from "../components/DagPreview";
import { GitBranch, Plus, Play, Archive } from "lucide-react";

// AgentDash: Pipeline list page

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  active: "bg-green-100 text-green-700",
  paused: "bg-yellow-100 text-yellow-700",
  archived: "bg-red-100 text-red-700",
};

export default function Pipelines() {
  const { company } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: pipelines = [], isLoading } = useQuery({
    queryKey: queryKeys.pipelines.list(company.id),
    queryFn: () => pipelinesApi.list(company.id),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => pipelinesApi.delete(company.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(company.id) }),
  });

  if (isLoading) return <div className="p-6">Loading...</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <GitBranch className="w-6 h-6 text-teal-600" />
          <h1 className="text-2xl font-bold">Pipelines</h1>
        </div>
        <Link
          to="/pipelines/new"
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700"
        >
          <Plus className="w-4 h-4" />
          New Pipeline
        </Link>
      </div>

      {pipelines.length === 0 ? (
        <EmptyState message="No pipelines yet. Create one to chain agents into multi-step workflows." />
      ) : (
        <div className="space-y-4">
          {pipelines.map((pipeline: Pipeline) => (
            <div
              key={pipeline.id}
              className="border rounded-lg p-4 hover:border-teal-300 cursor-pointer"
              onClick={() => navigate(`/pipelines/${pipeline.id}`)}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold text-lg">{pipeline.name}</h3>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[pipeline.status] ?? STATUS_COLORS.draft}`}>
                    {pipeline.status}
                  </span>
                  <span className="text-sm text-gray-500">
                    {pipeline.stages.length} stages · {pipeline.executionMode}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {pipeline.status === "active" && (
                    <button
                      className="p-1.5 rounded hover:bg-gray-100"
                      title="Start run"
                      onClick={(e) => {
                        e.stopPropagation();
                        pipelinesApi.startRun(company.id, pipeline.id).then(() =>
                          queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(company.id) }),
                        );
                      }}
                    >
                      <Play className="w-4 h-4 text-teal-600" />
                    </button>
                  )}
                  <button
                    className="p-1.5 rounded hover:bg-gray-100"
                    title="Archive"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate(pipeline.id);
                    }}
                  >
                    <Archive className="w-4 h-4 text-gray-400" />
                  </button>
                </div>
              </div>
              {pipeline.description && (
                <p className="text-sm text-gray-600 mb-3">{pipeline.description}</p>
              )}
              {pipeline.stages.length > 0 && (
                <div className="overflow-x-auto">
                  <DagPreview stages={pipeline.stages} edges={pipeline.edges} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create Pipeline Detail page**

Create `ui/src/pages/PipelineDetail.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useCompany } from "../hooks/useCompany";
import { pipelinesApi } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { DagPreview } from "../components/DagPreview";
import { Play, Settings, ArrowLeft } from "lucide-react";

// AgentDash: Pipeline detail page with run history

const RUN_STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  running: "bg-blue-100 text-blue-700",
  paused: "bg-yellow-100 text-yellow-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

export default function PipelineDetail() {
  const { company } = useCompany();
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: pipeline, isLoading } = useQuery({
    queryKey: queryKeys.pipelines.detail(company.id, pipelineId!),
    queryFn: () => pipelinesApi.get(company.id, pipelineId!),
    enabled: !!pipelineId,
  });

  const { data: runs = [] } = useQuery({
    queryKey: queryKeys.pipelines.runs(company.id, pipelineId!),
    queryFn: () => pipelinesApi.listRuns(company.id, pipelineId!),
    enabled: !!pipelineId,
  });

  const startRun = useMutation({
    mutationFn: () => pipelinesApi.startRun(company.id, pipelineId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.runs(company.id, pipelineId!) }),
  });

  const activateMutation = useMutation({
    mutationFn: () => pipelinesApi.update(company.id, pipelineId!, { status: "active" } as any),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(company.id, pipelineId!) }),
  });

  if (isLoading || !pipeline) return <div className="p-6">Loading...</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link to="/pipelines" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Pipelines
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{pipeline.name}</h1>
          {pipeline.description && <p className="text-gray-600 mt-1">{pipeline.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {pipeline.status === "draft" && (
            <button
              onClick={() => activateMutation.mutate()}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              Activate
            </button>
          )}
          {pipeline.status === "active" && (
            <button
              onClick={() => startRun.mutate()}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700"
            >
              <Play className="w-4 h-4" /> Start Run
            </button>
          )}
        </div>
      </div>

      {/* DAG Preview */}
      <div className="border rounded-lg p-4 mb-6 overflow-x-auto bg-gray-50">
        <h2 className="text-sm font-medium text-gray-500 mb-3">Pipeline DAG</h2>
        <DagPreview stages={pipeline.stages} edges={pipeline.edges} />
      </div>

      {/* Configuration */}
      <div className="border rounded-lg p-4 mb-6">
        <h2 className="text-sm font-medium text-gray-500 mb-3 flex items-center gap-2">
          <Settings className="w-4 h-4" /> Configuration
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Execution Mode</span>
            <p className="font-medium">{pipeline.executionMode}</p>
          </div>
          <div>
            <span className="text-gray-500">Stage Timeout</span>
            <p className="font-medium">{pipeline.defaults?.stageTimeoutMinutes ?? 30} min</p>
          </div>
          <div>
            <span className="text-gray-500">HITL Timeout</span>
            <p className="font-medium">{pipeline.defaults?.hitlTimeoutHours ?? 72} hrs</p>
          </div>
          <div>
            <span className="text-gray-500">Max Self-Heal Retries</span>
            <p className="font-medium">{pipeline.defaults?.maxSelfHealRetries ?? 3}</p>
          </div>
        </div>
      </div>

      {/* Run History */}
      <div>
        <h2 className="text-sm font-medium text-gray-500 mb-3">Run History</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-gray-400">No runs yet.</p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <div
                key={run.id}
                className="border rounded-lg p-3 hover:border-teal-300 cursor-pointer flex items-center justify-between"
                onClick={() => navigate(`/pipeline-runs/${run.id}`)}
              >
                <div className="flex items-center gap-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${RUN_STATUS_COLORS[run.status] ?? ""}`}>
                    {run.status}
                  </span>
                  <span className="text-sm text-gray-600">
                    {run.executionMode} · ${Number(run.totalCostUsd).toFixed(4)}
                  </span>
                </div>
                <span className="text-xs text-gray-400">
                  {new Date(run.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS. Adjust `useCompany` hook import path if needed.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/Pipelines.tsx ui/src/pages/PipelineDetail.tsx
git commit -m "feat(ui): add pipeline list and detail pages"
```

---

### Task 12: Pipeline Wizard Page

**Files:**
- Create: `ui/src/pages/PipelineWizard.tsx`

- [ ] **Step 1: Read existing wizard pattern**

Read `ui/src/pages/AgentWizard.tsx` for the multi-step wizard pattern (stepper, form state, submit).

- [ ] **Step 2: Create Pipeline Wizard**

Create `ui/src/pages/PipelineWizard.tsx`. This is a multi-step form:
1. **Basics** — name, description, execution mode
2. **Stages** — add/remove stages (agent, hitl_gate, merge) with scoped instructions
3. **Edges** — connect stages with optional conditions
4. **Defaults** — timeout, budget, retry settings
5. **Review** — DAG preview + summary, create button

```tsx
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useCompany } from "../hooks/useCompany";
import { pipelinesApi } from "../api/pipelines";
import { DagPreview } from "../components/DagPreview";
import type { PipelineStageDefinition, PipelineEdgeDefinition } from "@agentdash/shared";
import { ArrowLeft, ArrowRight, Plus, Trash2, GitBranch } from "lucide-react";

// AgentDash: Pipeline creation wizard

type WizardStep = "basics" | "stages" | "edges" | "defaults" | "review";
const STEPS: WizardStep[] = ["basics", "stages", "edges", "defaults", "review"];
const STEP_LABELS: Record<WizardStep, string> = {
  basics: "Basics",
  stages: "Stages",
  edges: "Connections",
  defaults: "Settings",
  review: "Review",
};

let stageCounter = 0;
function nextStageId(): string {
  stageCounter++;
  return `stage-${stageCounter}`;
}

let edgeCounter = 0;
function nextEdgeId(): string {
  edgeCounter++;
  return `edge-${edgeCounter}`;
}

export default function PipelineWizard() {
  const { company } = useCompany();
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>("basics");
  const stepIdx = STEPS.indexOf(step);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [executionMode, setExecutionMode] = useState<"sync" | "async">("sync");
  const [stages, setStages] = useState<PipelineStageDefinition[]>([]);
  const [edges, setEdges] = useState<PipelineEdgeDefinition[]>([]);
  const [stageTimeoutMinutes, setStageTimeoutMinutes] = useState(30);
  const [hitlTimeoutHours, setHitlTimeoutHours] = useState(72);
  const [maxSelfHealRetries, setMaxSelfHealRetries] = useState(3);

  const createMutation = useMutation({
    mutationFn: () =>
      pipelinesApi.create(company.id, {
        name,
        description: description || undefined,
        stages,
        edges,
        executionMode,
        defaults: { stageTimeoutMinutes, hitlTimeoutHours, maxSelfHealRetries },
      }),
    onSuccess: (data) => navigate(`/pipelines/${data.id}`),
  });

  function addStage(type: "agent" | "hitl_gate" | "merge") {
    const id = nextStageId();
    setStages([
      ...stages,
      {
        id,
        name: type === "hitl_gate" ? "Human Review" : type === "merge" ? "Merge" : `Stage ${stages.length + 1}`,
        type,
        scopedInstruction: "",
        ...(type === "merge" ? { mergeStrategy: "all" as const } : {}),
      },
    ]);
  }

  function removeStage(id: string) {
    setStages(stages.filter((s) => s.id !== id));
    setEdges(edges.filter((e) => e.fromStageId !== id && e.toStageId !== id));
  }

  function updateStage(id: string, updates: Partial<PipelineStageDefinition>) {
    setStages(stages.map((s) => (s.id === id ? { ...s, ...updates } : s)));
  }

  function addEdge() {
    if (stages.length < 2) return;
    setEdges([...edges, { id: nextEdgeId(), fromStageId: stages[0].id, toStageId: stages[1].id }]);
  }

  function removeEdge(id: string) {
    setEdges(edges.filter((e) => e.id !== id));
  }

  function updateEdge(id: string, updates: Partial<PipelineEdgeDefinition>) {
    setEdges(edges.map((e) => (e.id === id ? { ...e, ...updates } : e)));
  }

  const canAdvance =
    (step === "basics" && name.trim().length > 0) ||
    (step === "stages" && stages.length >= 1) ||
    step === "edges" ||
    step === "defaults" ||
    step === "review";

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <GitBranch className="w-6 h-6 text-teal-600" />
        <h1 className="text-2xl font-bold">New Pipeline</h1>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                i <= stepIdx ? "bg-teal-600 text-white" : "bg-gray-200 text-gray-500"
              }`}
            >
              {i + 1}
            </div>
            <span className={`text-sm ${i <= stepIdx ? "text-teal-700 font-medium" : "text-gray-400"}`}>
              {STEP_LABELS[s]}
            </span>
            {i < STEPS.length - 1 && <div className="w-8 h-px bg-gray-300" />}
          </div>
        ))}
      </div>

      {/* Step Content */}
      {step === "basics" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Pipeline Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
              placeholder="e.g., RFP Response Pipeline"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
              rows={3}
              placeholder="What does this pipeline do?"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Execution Mode</label>
            <div className="flex gap-3">
              {(["sync", "async"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setExecutionMode(mode)}
                  className={`px-4 py-2 rounded-lg border ${
                    executionMode === mode ? "border-teal-600 bg-teal-50 text-teal-700" : "border-gray-200"
                  }`}
                >
                  {mode === "sync" ? "Sync (fast-path)" : "Async (heartbeat-driven)"}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {step === "stages" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button onClick={() => addStage("agent")} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50">
              <Plus className="w-3 h-3 inline mr-1" /> Agent Stage
            </button>
            <button onClick={() => addStage("hitl_gate")} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50">
              <Plus className="w-3 h-3 inline mr-1" /> HITL Gate
            </button>
            <button onClick={() => addStage("merge")} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50">
              <Plus className="w-3 h-3 inline mr-1" /> Merge
            </button>
          </div>
          {stages.map((stage) => (
            <div key={stage.id} className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    stage.type === "hitl_gate" ? "bg-yellow-100 text-yellow-700" :
                    stage.type === "merge" ? "bg-purple-100 text-purple-700" :
                    "bg-blue-100 text-blue-700"
                  }`}>
                    {stage.type}
                  </span>
                  <input
                    value={stage.name}
                    onChange={(e) => updateStage(stage.id, { name: e.target.value })}
                    className="border-b border-transparent hover:border-gray-300 focus:border-teal-500 outline-none font-medium"
                  />
                </div>
                <button onClick={() => removeStage(stage.id)} className="text-gray-400 hover:text-red-500">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <textarea
                value={stage.scopedInstruction}
                onChange={(e) => updateStage(stage.id, { scopedInstruction: e.target.value })}
                className="w-full border rounded px-3 py-2 text-sm"
                rows={2}
                placeholder={
                  stage.type === "hitl_gate" ? "Instructions for the human reviewer..." :
                  stage.type === "merge" ? "Merge strategy description..." :
                  "Scoped instruction for this stage..."
                }
              />
              {stage.type === "merge" && (
                <div className="mt-2">
                  <label className="text-xs text-gray-500">Merge Strategy: </label>
                  <select
                    value={stage.mergeStrategy ?? "all"}
                    onChange={(e) => updateStage(stage.id, { mergeStrategy: e.target.value as "all" | "any" })}
                    className="text-sm border rounded px-2 py-1"
                  >
                    <option value="all">Wait for all branches</option>
                    <option value="any">Continue on first branch</option>
                  </select>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {step === "edges" && (
        <div className="space-y-4">
          <button onClick={addEdge} disabled={stages.length < 2} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">
            <Plus className="w-3 h-3 inline mr-1" /> Add Connection
          </button>
          {edges.map((edge) => (
            <div key={edge.id} className="border rounded-lg p-3 flex items-center gap-3">
              <select
                value={edge.fromStageId}
                onChange={(e) => updateEdge(edge.id, { fromStageId: e.target.value })}
                className="border rounded px-2 py-1 text-sm flex-1"
              >
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span className="text-gray-400">→</span>
              <select
                value={edge.toStageId}
                onChange={(e) => updateEdge(edge.id, { toStageId: e.target.value })}
                className="border rounded px-2 py-1 text-sm flex-1"
              >
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <input
                value={edge.condition ?? ""}
                onChange={(e) => updateEdge(edge.id, { condition: e.target.value || undefined })}
                className="border rounded px-2 py-1 text-sm flex-1"
                placeholder="Condition (optional)"
              />
              <button onClick={() => removeEdge(edge.id)} className="text-gray-400 hover:text-red-500">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {stages.length > 0 && (
            <div className="mt-4 overflow-x-auto border rounded-lg p-4 bg-gray-50">
              <DagPreview stages={stages} edges={edges} />
            </div>
          )}
        </div>
      )}

      {step === "defaults" && (
        <div className="space-y-4 max-w-md">
          <div>
            <label className="block text-sm font-medium mb-1">Stage Timeout (minutes)</label>
            <input type="number" value={stageTimeoutMinutes} onChange={(e) => setStageTimeoutMinutes(Number(e.target.value))} className="w-full border rounded-lg px-3 py-2" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">HITL Timeout (hours)</label>
            <input type="number" value={hitlTimeoutHours} onChange={(e) => setHitlTimeoutHours(Number(e.target.value))} className="w-full border rounded-lg px-3 py-2" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Max Self-Heal Retries</label>
            <input type="number" value={maxSelfHealRetries} onChange={(e) => setMaxSelfHealRetries(Number(e.target.value))} className="w-full border rounded-lg px-3 py-2" min={0} max={10} />
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-4">
          <div className="border rounded-lg p-4">
            <h3 className="font-semibold mb-2">{name}</h3>
            {description && <p className="text-sm text-gray-600 mb-3">{description}</p>}
            <div className="text-sm text-gray-500 mb-4">
              {stages.length} stages · {edges.length} connections · {executionMode} mode
            </div>
            <DagPreview stages={stages} edges={edges} />
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="border rounded p-3">
              <span className="text-gray-500">Stage Timeout</span>
              <p className="font-medium">{stageTimeoutMinutes} min</p>
            </div>
            <div className="border rounded p-3">
              <span className="text-gray-500">HITL Timeout</span>
              <p className="font-medium">{hitlTimeoutHours} hrs</p>
            </div>
            <div className="border rounded p-3">
              <span className="text-gray-500">Self-Heal Retries</span>
              <p className="font-medium">{maxSelfHealRetries}</p>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between mt-8 pt-4 border-t">
        <button
          onClick={() => stepIdx > 0 && setStep(STEPS[stepIdx - 1])}
          disabled={stepIdx === 0}
          className="flex items-center gap-1 px-4 py-2 border rounded-lg disabled:opacity-50"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        {step === "review" ? (
          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            className="px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
          >
            {createMutation.isPending ? "Creating..." : "Create Pipeline"}
          </button>
        ) : (
          <button
            onClick={() => canAdvance && setStep(STEPS[stepIdx + 1])}
            disabled={!canAdvance}
            className="flex items-center gap-1 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
          >
            Next <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/PipelineWizard.tsx
git commit -m "feat(ui): add pipeline creation wizard with form steps and DAG preview"
```

---

### Task 13: Pipeline Run Detail Page

**Files:**
- Create: `ui/src/pages/PipelineRunDetail.tsx`

- [ ] **Step 1: Create run detail page**

Create `ui/src/pages/PipelineRunDetail.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { useCompany } from "../hooks/useCompany";
import { pipelinesApi, type StageExecution } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { DagPreview } from "../components/DagPreview";
import { ArrowLeft, XCircle, CheckCircle, Clock, AlertTriangle } from "lucide-react";

// AgentDash: Pipeline run detail with stage-by-stage status

const STATUS_ICONS: Record<string, typeof Clock> = {
  pending: Clock,
  running: Clock,
  completed: CheckCircle,
  failed: XCircle,
  skipped: XCircle,
  waiting_hitl: AlertTriangle,
};

const STATUS_COLORS: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-blue-500",
  completed: "text-green-500",
  failed: "text-red-500",
  skipped: "text-gray-400",
  waiting_hitl: "text-yellow-500",
};

export default function PipelineRunDetail() {
  const { company } = useCompany();
  const { runId } = useParams<{ runId: string }>();
  const queryClient = useQueryClient();

  const { data: run, isLoading } = useQuery({
    queryKey: queryKeys.pipelines.runDetail(company.id, runId!),
    queryFn: () => pipelinesApi.getRun(company.id, runId!),
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "paused" ? 5000 : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => pipelinesApi.cancelRun(company.id, runId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.runDetail(company.id, runId!) }),
  });

  const hitlMutation = useMutation({
    mutationFn: ({ stageId, decision, notes }: { stageId: string; decision: "approved" | "rejected"; notes?: string }) =>
      pipelinesApi.hitlDecide(company.id, runId!, stageId, decision, notes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.runDetail(company.id, runId!) }),
  });

  if (isLoading || !run) return <div className="p-6">Loading...</div>;

  const stageExecs = (run.stages ?? []) as StageExecution[];
  const completedIds = stageExecs.filter((s) => s.status === "completed").map((s) => s.stageId);
  const activeIds = stageExecs.filter((s) => s.status === "running" || s.status === "waiting_hitl").map((s) => s.stageId);
  const failedIds = stageExecs.filter((s) => s.status === "failed").map((s) => s.stageId);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link to={`/pipelines/${run.pipelineId}`} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Pipeline
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Pipeline Run</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
              run.status === "completed" ? "bg-green-100 text-green-700" :
              run.status === "running" ? "bg-blue-100 text-blue-700" :
              run.status === "failed" ? "bg-red-100 text-red-700" :
              "bg-gray-100 text-gray-700"
            }`}>
              {run.status}
            </span>
            <span className="text-sm text-gray-500">
              Cost: ${Number(run.totalCostUsd).toFixed(4)} · {run.executionMode}
            </span>
          </div>
        </div>
        {(run.status === "running" || run.status === "paused") && (
          <button
            onClick={() => cancelMutation.mutate()}
            className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50"
          >
            Cancel Run
          </button>
        )}
      </div>

      {run.errorMessage && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {run.errorMessage}
        </div>
      )}

      {/* Stage Executions */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-gray-500">Stage Executions</h2>
        {stageExecs.length === 0 ? (
          <p className="text-sm text-gray-400">No stages executed yet.</p>
        ) : (
          stageExecs.map((exec) => {
            const Icon = STATUS_ICONS[exec.status] ?? Clock;
            const color = STATUS_COLORS[exec.status] ?? "text-gray-400";
            return (
              <div key={exec.id} className="border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className={`w-5 h-5 ${color}`} />
                    <span className="font-medium">{exec.stageId}</span>
                    <span className="text-xs text-gray-400">{exec.status}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {exec.costUsd && (
                      <span className="text-xs text-gray-500">${Number(exec.costUsd).toFixed(4)}</span>
                    )}
                    {exec.selfHealAttempts > 0 && (
                      <span className="text-xs text-yellow-600">{exec.selfHealAttempts} heal attempts</span>
                    )}
                  </div>
                </div>

                {exec.errorMessage && (
                  <div className="text-sm text-red-600 bg-red-50 rounded p-2 mb-2">{exec.errorMessage}</div>
                )}

                {exec.status === "waiting_hitl" && (
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => hitlMutation.mutate({ stageId: exec.stageId, decision: "approved" })}
                      className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => hitlMutation.mutate({ stageId: exec.stageId, decision: "rejected" })}
                      className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-sm hover:bg-red-50"
                    >
                      Reject
                    </button>
                  </div>
                )}

                {exec.outputState && (
                  <details className="mt-2">
                    <summary className="text-xs text-gray-500 cursor-pointer">Output data</summary>
                    <pre className="text-xs bg-gray-50 rounded p-2 mt-1 overflow-x-auto">
                      {JSON.stringify(exec.outputState, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -r typecheck`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/PipelineRunDetail.tsx
git commit -m "feat(ui): add pipeline run detail page with stage status and HITL actions"
```

---

### Task 14: Wire Into Router & Full Verification

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Read current App.tsx routes**

Read `ui/src/App.tsx` to find the exact location of existing pipeline route and import section.

- [ ] **Step 2: Add new routes and imports**

In `ui/src/App.tsx`, add lazy imports for the new pages:

```typescript
const PipelineDetail = lazy(() => import("./pages/PipelineDetail"));
const PipelineWizard = lazy(() => import("./pages/PipelineWizard"));
const PipelineRunDetail = lazy(() => import("./pages/PipelineRunDetail"));
```

Add routes near the existing `<Route path="pipelines" ...>`:

```tsx
<Route path="pipelines/:pipelineId" element={<PipelineDetail />} />
<Route path="pipelines/new" element={<PipelineWizard />} />
<Route path="pipeline-runs/:runId" element={<PipelineRunDetail />} />
```

Note: `pipelines/new` must come BEFORE `pipelines/:pipelineId` in route order, or use exact matching. Check how the existing router handles this.

- [ ] **Step 3: Verify Pipelines.tsx uses default export**

Ensure `ui/src/pages/Pipelines.tsx` uses `export default function Pipelines()` (not named export) to match the lazy import pattern.

- [ ] **Step 4: Run full verification**

Run: `pnpm -r typecheck && pnpm test:run && pnpm build`

Expected:
- Typecheck: PASS
- Tests: All existing tests pass + new pipeline tests pass
- Build: PASS

- [ ] **Step 5: Verify no new test failures**

Compare test count and failures against the baseline. Our changes should add ~15 new tests and introduce zero new failures.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx ui/src/pages/Pipelines.tsx
git commit -m "feat(ui): wire pipeline pages into router"
```

- [ ] **Step 7: Final integration smoke test**

Start the dev server: `pnpm dev`

Manual checks:
1. Navigate to `/pipelines` — should show empty state with "New Pipeline" button
2. Click "New Pipeline" — should open wizard with 5 steps
3. Fill out a basic 2-stage linear pipeline and create it
4. Pipeline detail page should show DAG preview and configuration
5. Check browser console for errors

---

## Summary

| Task | What | Files | Tests |
|------|------|-------|-------|
| 1 | Schema & migration | 3 files | migration chain |
| 2 | Constants, types, validators | 4 files | typecheck |
| 3 | Condition evaluator | 2 files | 10 unit tests |
| 4 | Pipeline CRUD service | 3 files | 7 unit tests |
| 5 | Pipeline runner core | 2 files | 9 unit tests |
| 6 | Runner execution integration | 2 files | typecheck |
| 7 | Self-heal service | 2 files | typecheck |
| 8 | Pipeline routes | 1 file | typecheck |
| 9 | UI API client + query keys | 2 files | typecheck |
| 10 | DAG preview component | 1 file | typecheck |
| 11 | List + detail pages | 2 files | typecheck |
| 12 | Pipeline wizard | 1 file | typecheck |
| 13 | Run detail page | 1 file | typecheck |
| 14 | Wire router + verify | 2 files | full suite |

**Total: ~30 files, ~26 new tests, 14 tasks**
