# Smart Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route mechanical agent tasks (2-3 tool calls, deterministic output) to small models (Haiku/GPT-4o-mini/Gemini Flash) while keeping all thinking tasks on the agent's default large model.

**Architecture:** Add `modelTier` to skill versions and pipeline stage definitions. A thin routing function between the heartbeat and `adapter.execute()` checks skill/stage tier and overrides `config.model` for that dispatch only. Verification runs post-execution for small-model skills.

**Tech Stack:** TypeScript, Drizzle ORM, Zod, Vitest, PostgreSQL

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `packages/shared/src/constants.ts` | Add `SMALL_MODELS` constant and `MODEL_TIERS` |
| Create | `packages/shared/src/types/model-routing.ts` | `SkillVerification` type |
| Modify | `packages/shared/src/types/pipeline.ts` | Add `modelTier` to `PipelineStageDefinition` |
| Modify | `packages/shared/src/validators/pipeline.ts` | Add `modelTier` to stage schema |
| Modify | `packages/db/src/schema/skill_versions.ts` | Add 3 columns: `model_tier`, `max_tool_calls`, `verification` |
| Create | migration SQL | Migration for new columns |
| Create | `server/src/services/model-router.ts` | `resolveModelTier()` function |
| Create | `server/src/__tests__/model-router.test.ts` | Unit tests for routing logic |
| Modify | `server/src/services/heartbeat.ts` | Call model router before `adapter.execute()`, run verification after |
| Create | `server/src/__tests__/model-router-integration.test.ts` | Verification execution tests |

---

### Task 1: Add shared constants and types

**Files:**
- Modify: `packages/shared/src/constants.ts:728-729`
- Create: `packages/shared/src/types/model-routing.ts`
- Modify: `packages/shared/src/types/index.ts` (re-export)

- [ ] **Step 1: Add MODEL_TIERS and SMALL_MODELS constants**

In `packages/shared/src/constants.ts`, add after line 729 (after `TASK_CLASSIFICATIONS`):

```typescript
// Smart Model Routing — Model Tiers
export const MODEL_TIERS = ["small", "default"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

// Smart Model Routing — Small model per adapter type
export const SMALL_MODELS: Record<string, string> = {
  claude_local: "haiku",
  claude_api: "haiku",
  codex_local: "codex-mini",
  gemini_local: "gemini-flash",
  opencode_local: "haiku",
  pi_local: "haiku",
};
```

- [ ] **Step 2: Create SkillVerification type**

Create `packages/shared/src/types/model-routing.ts`:

```typescript
// AgentDash: Smart model routing types

export type SkillVerificationType = "schema" | "effect" | "none";

export interface SkillVerificationSchema {
  type: "schema";
  zodSchema: string;
}

export interface SkillVerificationEffect {
  type: "effect";
  command: string;
}

export interface SkillVerificationNone {
  type: "none";
}

export type SkillVerification =
  | SkillVerificationSchema
  | SkillVerificationEffect
  | SkillVerificationNone;
```

- [ ] **Step 3: Re-export from types index**

In `packages/shared/src/types/index.ts`, add:

```typescript
export type { SkillVerification, SkillVerificationType, SkillVerificationSchema, SkillVerificationEffect, SkillVerificationNone } from "./model-routing.js";
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS — no consumers of new types yet

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/types/model-routing.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add MODEL_TIERS, SMALL_MODELS constants and SkillVerification type"
```

---

### Task 2: Add modelTier to PipelineStageDefinition

**Files:**
- Modify: `packages/shared/src/types/pipeline.ts:3-16`
- Modify: `packages/shared/src/validators/pipeline.ts:4-17`

- [ ] **Step 1: Add modelTier to the type**

In `packages/shared/src/types/pipeline.ts`, add `modelTier` to `PipelineStageDefinition` (after `hitlTimeoutHours`, line 15):

```typescript
  modelTier?: "small" | null;
```

- [ ] **Step 2: Add modelTier to the Zod validator**

In `packages/shared/src/validators/pipeline.ts`, add to `pipelineStageSchema` (after `hitlTimeoutHours` line 16):

```typescript
  modelTier: z.enum(["small"]).nullable().optional(),
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS — existing stage objects without `modelTier` still valid (field is optional)

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/pipeline.ts packages/shared/src/validators/pipeline.ts
git commit -m "feat(shared): add optional modelTier to PipelineStageDefinition"
```

---

### Task 3: Add columns to skill_versions table

**Files:**
- Modify: `packages/db/src/schema/skill_versions.ts:6-40`
- Create: migration via `pnpm db:generate`

- [ ] **Step 1: Add 3 new columns to skill_versions schema**

In `packages/db/src/schema/skill_versions.ts`, add after the `status` column (line 27):

```typescript
    modelTier: text("model_tier"),
    maxToolCalls: integer("max_tool_calls"),
    verification: jsonb("verification").$type<{ type: string; zodSchema?: string; command?: string }>(),
```

- [ ] **Step 2: Generate migration**

Run: `pnpm db:generate`
Expected: New migration file created in `packages/db/src/migrations/` (number 0069)

- [ ] **Step 3: Verify migration SQL**

Read the generated migration file. It should contain:

```sql
ALTER TABLE "skill_versions" ADD COLUMN "model_tier" text;
ALTER TABLE "skill_versions" ADD COLUMN "max_tool_calls" integer;
ALTER TABLE "skill_versions" ADD COLUMN "verification" jsonb;
```

All columns nullable — no default needed, `null` means "use agent default / no limit / no verification".

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/skill_versions.ts packages/db/src/migrations/
git commit -m "feat(db): add model_tier, max_tool_calls, verification to skill_versions"
```

---

### Task 4: Write model router tests (TDD)

**Files:**
- Create: `server/src/__tests__/model-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/__tests__/model-router.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveModelTier } from "../services/model-router.js";

describe("resolveModelTier", () => {
  const baseAgent = {
    adapterType: "claude_local",
    adapterConfig: { model: "opus" },
  };

  it("returns agent default when no skill and no pipeline stage", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: null,
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "opus", tier: "default" });
  });

  it("returns agent default when skill has no modelTier", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: { modelTier: null, maxToolCalls: null, verification: null },
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "opus", tier: "default" });
  });

  it("returns small model when skill has modelTier small", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: { modelTier: "small", maxToolCalls: 3, verification: null },
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "haiku", tier: "small" });
  });

  it("pipeline stage modelTier overrides skill modelTier", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: { modelTier: null, maxToolCalls: null, verification: null },
      pipelineStage: { modelTier: "small" },
    });
    expect(result).toEqual({ model: "haiku", tier: "small" });
  });

  it("pipeline stage null does not override skill small", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: { modelTier: "small", maxToolCalls: 2, verification: null },
      pipelineStage: { modelTier: null },
    });
    expect(result).toEqual({ model: "haiku", tier: "small" });
  });

  it("maps small model per adapter type", () => {
    const geminiAgent = {
      adapterType: "gemini_local",
      adapterConfig: { model: "gemini-pro" },
    };
    const result = resolveModelTier({
      agent: geminiAgent,
      skill: { modelTier: "small", maxToolCalls: 1, verification: null },
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "gemini-flash", tier: "small" });
  });

  it("falls back to agent default if adapter type has no small model mapping", () => {
    const unknownAgent = {
      adapterType: "custom_adapter",
      adapterConfig: { model: "custom-model" },
    };
    const result = resolveModelTier({
      agent: unknownAgent,
      skill: { modelTier: "small", maxToolCalls: 1, verification: null },
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "custom-model", tier: "default" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run server/src/__tests__/model-router.test.ts`
Expected: FAIL — `model-router.js` does not exist yet

- [ ] **Step 3: Commit failing tests**

```bash
git add server/src/__tests__/model-router.test.ts
git commit -m "test: add failing tests for model router"
```

---

### Task 5: Implement model router

**Files:**
- Create: `server/src/services/model-router.ts`

- [ ] **Step 1: Write the model router**

Create `server/src/services/model-router.ts`:

```typescript
// AgentDash: Smart model routing — resolves model tier for heartbeat dispatch

import { SMALL_MODELS } from "@agentdash/shared";
import type { SkillVerification } from "@agentdash/shared";

export interface ModelRoutingSkillInput {
  modelTier: string | null;
  maxToolCalls: number | null;
  verification: SkillVerification | null;
}

export interface ModelRoutingStageInput {
  modelTier: string | null;
}

export interface ModelRoutingAgentInput {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface ModelRoutingResult {
  model: string;
  tier: "small" | "default";
}

/**
 * Resolve which model to use for a heartbeat dispatch.
 *
 * Priority: pipeline stage modelTier > skill modelTier > agent default.
 * Only "small" overrides the agent default. Unknown adapter types fall back to default.
 */
export function resolveModelTier(params: {
  agent: ModelRoutingAgentInput;
  skill: ModelRoutingSkillInput | null;
  pipelineStage: ModelRoutingStageInput | null;
}): ModelRoutingResult {
  const { agent, skill, pipelineStage } = params;
  const agentModel = (agent.adapterConfig.model as string) ?? "";

  // Priority: pipeline stage > skill > default
  const tier = pipelineStage?.modelTier ?? skill?.modelTier ?? null;

  if (tier === "small") {
    const smallModel = SMALL_MODELS[agent.adapterType];
    if (smallModel) {
      return { model: smallModel, tier: "small" };
    }
    // Unknown adapter type — can't route to small, fall back to default
  }

  return { model: agentModel, tier: "default" };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run server/src/__tests__/model-router.test.ts`
Expected: ALL PASS (7 tests)

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/services/model-router.ts
git commit -m "feat: implement resolveModelTier routing function"
```

---

### Task 6: Write verification execution tests (TDD)

**Files:**
- Create: `server/src/__tests__/model-router-integration.test.ts`

- [ ] **Step 1: Write failing tests for verification and maxToolCalls**

Create `server/src/__tests__/model-router-integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { checkVerification, checkMaxToolCalls } from "../services/model-router.js";

describe("checkVerification", () => {
  it("returns pass for type none", () => {
    const result = checkVerification({ type: "none" }, { summary: "done" });
    expect(result).toEqual({ passed: true });
  });

  it("returns pass when verification is null", () => {
    const result = checkVerification(null, { summary: "done" });
    expect(result).toEqual({ passed: true });
  });

  it("returns pass for schema verification when output matches", () => {
    const result = checkVerification(
      { type: "schema", zodSchema: '{ "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] }' },
      { label: "bug" },
    );
    expect(result).toEqual({ passed: true });
  });

  it("returns fail for schema verification when output does not match", () => {
    const result = checkVerification(
      { type: "schema", zodSchema: '{ "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] }' },
      { count: 42 },
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("verification_failed");
  });
});

describe("checkMaxToolCalls", () => {
  it("returns pass when maxToolCalls is null", () => {
    expect(checkMaxToolCalls(null, 50)).toEqual({ passed: true });
  });

  it("returns pass when tool calls within limit", () => {
    expect(checkMaxToolCalls(3, 2)).toEqual({ passed: true });
  });

  it("returns pass when tool calls equal to limit", () => {
    expect(checkMaxToolCalls(3, 3)).toEqual({ passed: true });
  });

  it("returns fail when tool calls exceed limit", () => {
    const result = checkMaxToolCalls(3, 5);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("exceeded_max_tool_calls");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run server/src/__tests__/model-router-integration.test.ts`
Expected: FAIL — `checkVerification` and `checkMaxToolCalls` do not exist yet

- [ ] **Step 3: Commit failing tests**

```bash
git add server/src/__tests__/model-router-integration.test.ts
git commit -m "test: add failing tests for verification and maxToolCalls checks"
```

---

### Task 7: Implement verification and maxToolCalls checks

**Files:**
- Modify: `server/src/services/model-router.ts`

- [ ] **Step 1: Add checkVerification and checkMaxToolCalls to model-router.ts**

Append to `server/src/services/model-router.ts`:

```typescript
export interface VerificationResult {
  passed: boolean;
  reason?: string;
}

/**
 * Run post-execution verification for a small-model skill.
 * Schema verification does a JSON structure check (property presence).
 * Effect verification is handled externally (shell command) — not implemented in v1.
 */
export function checkVerification(
  verification: SkillVerification | null,
  resultJson: Record<string, unknown> | null,
): VerificationResult {
  if (!verification || verification.type === "none") {
    return { passed: true };
  }

  if (verification.type === "schema") {
    try {
      const schema = JSON.parse(verification.zodSchema);
      const requiredKeys: string[] = schema.required ?? [];
      if (!resultJson) {
        return { passed: false, reason: "verification_failed: no output" };
      }
      for (const key of requiredKeys) {
        if (!(key in resultJson)) {
          return { passed: false, reason: `verification_failed: missing key "${key}"` };
        }
      }
      return { passed: true };
    } catch {
      return { passed: false, reason: "verification_failed: invalid schema" };
    }
  }

  if (verification.type === "effect") {
    // Effect verification (shell command) deferred to v2
    return { passed: true };
  }

  return { passed: true };
}

/**
 * Check if a small-model run exceeded the allowed tool call count.
 */
export function checkMaxToolCalls(
  maxToolCalls: number | null,
  actualToolCalls: number,
): VerificationResult {
  if (maxToolCalls === null || maxToolCalls <= 0) {
    return { passed: true };
  }
  if (actualToolCalls > maxToolCalls) {
    return { passed: false, reason: "exceeded_max_tool_calls" };
  }
  return { passed: true };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run server/src/__tests__/model-router-integration.test.ts`
Expected: ALL PASS (7 tests)

- [ ] **Step 3: Run all model router tests**

Run: `pnpm vitest run server/src/__tests__/model-router`
Expected: ALL PASS (14 tests across both files)

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/model-router.ts
git commit -m "feat: implement checkVerification and checkMaxToolCalls"
```

---

### Task 8: Wire model router into heartbeat

**Files:**
- Modify: `server/src/services/heartbeat.ts:2438-2457` (issueContext query)
- Modify: `server/src/services/heartbeat.ts:2589-2599` (runtimeConfig assembly)
- Modify: `server/src/services/heartbeat.ts:3099-3111` (adapter execute)
- Modify: `server/src/services/heartbeat.ts:3176-3186` (result processing)

This is the core integration. Four surgical changes to the heartbeat.

- [ ] **Step 1: Add import at top of heartbeat.ts**

Add near other service imports at the top of `server/src/services/heartbeat.ts`:

```typescript
import { resolveModelTier, checkVerification, checkMaxToolCalls } from "./model-router.js";
```

- [ ] **Step 2: Add originKind and originId to issueContext query**

In `server/src/services/heartbeat.ts`, modify the `issueContext` select query (around line 2440). Add two fields to the `.select({})` block:

```typescript
            originKind: issues.originKind,
            originId: issues.originId,
```

Add these after the `executionWorkspaceSettings` field (line 2452).

- [ ] **Step 3: Add pipeline stage lookup and model routing before runtimeConfig**

After the `selectedSkills` selection (around line 2522) and before the `runtimeConfig` assembly (around line 2596), add the pipeline stage lookup and model routing call. Insert after the skill selection block:

```typescript
    // AgentDash: Smart model routing — resolve model tier from skill/stage
    let pipelineStageForRouting: { modelTier: string | null } | null = null;
    if (issueContext?.originKind === "pipeline_stage" && issueContext.originId) {
      const stageExec = await db
        .select({ stageId: pipelineStageExecutions.stageId, pipelineRunId: pipelineStageExecutions.pipelineRunId })
        .from(pipelineStageExecutions)
        .where(eq(pipelineStageExecutions.id, issueContext.originId))
        .then((rows) => rows[0] ?? null);
      if (stageExec) {
        const pipeline = await db
          .select({ stages: agentPipelines.stages })
          .from(agentPipelines)
          .innerJoin(pipelineRuns, eq(pipelineRuns.pipelineId, agentPipelines.id))
          .where(eq(pipelineRuns.id, stageExec.pipelineRunId))
          .then((rows) => rows[0] ?? null);
        if (pipeline) {
          const stages = pipeline.stages as Array<{ id: string; modelTier?: string | null }>;
          const matchedStage = stages.find((s) => s.id === stageExec.stageId);
          pipelineStageForRouting = matchedStage ? { modelTier: matchedStage.modelTier ?? null } : null;
        }
      }
    }

    // Resolve matched skill routing info from the first selected skill with modelTier
    const skillForRouting = selectedSkills.length > 0
      ? await db
          .select({ modelTier: skillVersions.modelTier, maxToolCalls: skillVersions.maxToolCalls, verification: skillVersions.verification })
          .from(skillVersions)
          .innerJoin(companySkills, eq(companySkills.id, skillVersions.skillId))
          .where(
            and(
              eq(companySkills.companyId, agent.companyId),
              eq(companySkills.key, selectedSkills[0].skill.key),
              eq(skillVersions.status, "published"),
            ),
          )
          .orderBy(skillVersions.versionNumber)
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;

    const routingResult = resolveModelTier({
      agent: { adapterType: agent.adapterType, adapterConfig: config },
      skill: skillForRouting,
      pipelineStage: pipelineStageForRouting,
    });
```

Add the necessary imports at the top of the file (near other schema imports):

```typescript
import { skillVersions, pipelineStageExecutions, pipelineRuns, agentPipelines, companySkills } from "@agentdash/db";
```

Check which of these are already imported and only add the missing ones.

- [ ] **Step 4: Override config.model with routing result**

In the `runtimeConfig` assembly block (around line 2596), after `const runtimeConfig = { ...resolvedConfig, paperclipRuntimeSkills: runtimeSkillEntries };`, add:

```typescript
    // AgentDash: Apply model routing override
    if (routingResult.tier === "small") {
      runtimeConfig.model = routingResult.model;
    }
```

- [ ] **Step 5: Add verification after adapter result processing**

After the outcome determination block (around line 3186, after the `outcome` variable is set), add verification logic:

```typescript
    // AgentDash: Run verification for small-model skills
    if (routingResult.tier === "small" && outcome === "succeeded" && skillForRouting) {
      const toolCallCount = (adapterResult.usage?.outputTokens ?? 0) > 0
        ? Math.ceil((adapterResult.usage?.outputTokens ?? 0) / 500)  // heuristic: ~500 tokens per tool call
        : 0;

      const maxToolCallsCheck = checkMaxToolCalls(skillForRouting.maxToolCalls, toolCallCount);
      if (!maxToolCallsCheck.passed) {
        outcome = "failed";
        adapterResult.errorMessage = maxToolCallsCheck.reason ?? "exceeded_max_tool_calls";
      }

      if (outcome === "succeeded" && skillForRouting.verification) {
        const verificationCheck = checkVerification(
          skillForRouting.verification as import("@agentdash/shared").SkillVerification,
          adapterResult.resultJson ?? null,
        );
        if (!verificationCheck.passed) {
          outcome = "failed";
          adapterResult.errorMessage = verificationCheck.reason ?? "verification_failed";
        }
      }
    }
```

Note: The tool call count heuristic (tokens/500) is a rough estimate. In v2 this should be replaced by parsing the actual tool call count from the adapter's streamed output. For v1 this is acceptable since `maxToolCalls` is a safety guard, not a precise meter.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `pnpm test:run`
Expected: ALL PASS (775+ tests)

- [ ] **Step 8: Commit**

```bash
git add server/src/services/heartbeat.ts
git commit -m "feat: wire model router into heartbeat dispatch and verification"
```

---

### Task 9: Full verification

**Files:** None — verification only

- [ ] **Step 1: Typecheck all packages**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `pnpm test:run`
Expected: ALL PASS

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 4: Run CUJ tests (if dev server available)**

Run: `bash scripts/test-cujs.sh`
Expected: 60 tests PASS (existing CUJs unaffected — routing is dormant until skills have `modelTier` set)

- [ ] **Step 5: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address verification issues from full test suite"
```

---

### Follow-up: Seed built-in small-model skills

Not part of this plan — requires a running DB and company context. Add to `scripts/seed-test-scenarios.sh` or the onboarding wizard's bootstrap step:

- `commit-message` — modelTier: "small", maxToolCalls: 1, verification: { type: "schema", zodSchema: '{"required":["message"]}' }
- `event-classifier` — modelTier: "small", maxToolCalls: 1, verification: { type: "schema", zodSchema: '{"required":["category"]}' }
- `template-render` — modelTier: "small", maxToolCalls: 1, verification: { type: "schema", zodSchema: '{"required":["rendered"]}' }
- `format-transform` — modelTier: "small", maxToolCalls: 2, verification: { type: "schema", zodSchema: '{"required":["output"]}' }

---

## Summary

| Task | What | Files Changed | Tests |
|------|------|--------------|-------|
| 1 | Shared constants + types | 3 files | typecheck only |
| 2 | Pipeline stage modelTier | 2 files | typecheck only |
| 3 | DB migration (3 columns) | 2 files | typecheck only |
| 4 | Router tests (TDD red) | 1 file | 7 failing tests |
| 5 | Router implementation (TDD green) | 1 file | 7 passing tests |
| 6 | Verification tests (TDD red) | 1 file | 7 failing tests |
| 7 | Verification implementation (TDD green) | 1 file | 14 passing tests |
| 8 | Heartbeat integration | 1 file | full suite |
| 9 | Full verification | 0 files | typecheck + test + build + CUJ |

**Total new files:** 3 (`model-router.ts`, 2 test files)
**Total modified files:** 5 (`constants.ts`, `pipeline.ts`, `pipeline validator`, `skill_versions.ts`, `heartbeat.ts`)
**Total new lines:** ~200
