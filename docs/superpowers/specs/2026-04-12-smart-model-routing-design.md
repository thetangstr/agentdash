# Smart Model Routing — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**PRD Reference:** CUJ-14

---

## Problem

AgentDash agents run every task on the same model (set per-agent at creation time via `adapterConfig.model`). Mechanical tasks that complete in 1-3 tool calls — commit message generation, event classification, template rendering — burn the same tokens as complex reasoning tasks. There's no runtime model selection.

## Design Principle

**Does this task require thinking, or just executing?**

- **Thinking** = reasoning, judgment, interpretation, ambiguity resolution → agent's default (large) model
- **Executing** = following a known pattern, 2-3 tool calls, deterministic output → small model (Haiku / GPT-4o-mini / Gemini Flash)

No middle tier. No classifier. No auto-escalation. The skill declaration is the routing decision.

## Architecture

### Two-Tier Model System

| Tier | When | Models |
|------|------|--------|
| `default` | Everything — planning, coding, research, any ambiguity | Agent's configured model (Opus, Sonnet, etc.) |
| `small` | Skill-matched, 2-3 tool calls, deterministic, no thinking | Haiku, GPT-4o-mini, Gemini Flash |

### Small Model Mapping

```typescript
// packages/shared/src/constants.ts
export const SMALL_MODELS: Record<string, string> = {
  claude_local: "haiku",
  codex_local: "codex-mini",
  gemini_local: "gemini-flash",
  opencode_local: "haiku",
  pi_local: "haiku",
};
```

Company-level overrides are out of scope for v1 — the constant is the source of truth. Override support can be added later via company settings.

### Routing Function

```typescript
// server/src/services/model-router.ts
function resolveModelTier(params: {
  agent: Agent;
  skill: SkillVersion | null;
  pipelineStage: PipelineStageDefinition | null;
}): { model: string; tier: "small" | "default" } {

  // Priority: pipeline stage > skill > agent default
  const tier = params.pipelineStage?.modelTier
    ?? params.skill?.modelTier
    ?? "default";

  if (tier === "small") {
    const adapterType = params.agent.adapterType;
    return { model: SMALL_MODELS[adapterType], tier: "small" };
  }

  return { model: params.agent.adapterConfig.model, tier: "default" };
}
```

**Priority order:** Pipeline stage `modelTier` > Skill `modelTier` > Agent default

### Heartbeat Integration

~20 lines changed in `server/src/services/heartbeat.ts`:

1. After skill selection (existing logic), before `adapter.execute(ctx)`
2. Call `resolveModelTier({ agent, skill, pipelineStage })`
3. If tier is `"small"`, override `adapterConfig.model` for this dispatch only
4. Agent's persisted config is never modified
5. After execution, if skill has `verification`, run it
6. If skill has `maxToolCalls` and run exceeded it, mark as failed with reason `"exceeded_max_tool_calls"`

## Schema Changes

### `skill_versions` table — 3 new columns

```sql
ALTER TABLE skill_versions ADD COLUMN model_tier text;          -- "small" | null (null = use agent default)
ALTER TABLE skill_versions ADD COLUMN max_tool_calls integer;   -- enforced ceiling, null = unlimited
ALTER TABLE skill_versions ADD COLUMN verification jsonb;       -- verification config, null = none
```

### Verification Types

```typescript
type SkillVerification =
  | { type: "schema"; zodSchema: string }   // output must parse against this schema
  | { type: "effect"; command: string }      // run this command, exit 0 = pass
  | { type: "none" }                         // no verification (default)
```

### `PipelineStageDefinition` — 1 new field

```typescript
interface PipelineStageDefinition {
  // ... existing fields
  modelTier?: "small" | null;  // null = use skill or agent default
}
```

No new tables. No new services.

## Built-in Small-Model Skills

Shipped with AgentDash as `published` skill versions with `modelTier: "small"`:

| Skill | Tool Calls | Verification | What it does |
|-------|-----------|--------------|-------------|
| `commit-message` | 1 | schema (string output) | Generate commit message from diff |
| `event-classifier` | 1 | schema (known category enum) | Classify webhook/event payload |
| `template-render` | 1 | schema (rendered string) | Fill notification/email template from structured data |
| `format-transform` | 1-2 | schema (target format) | Convert between structured formats (JSON/CSV/etc.) |

### Authoring Custom Small-Model Skills

Companies can create their own through the existing Skills Registry pipeline:

1. Create skill version with `modelTier: "small"`, `maxToolCalls: 2-3`, and a `verification` block
2. Submit for review (existing draft → in_review → approved → published flow)
3. Once published, the heartbeat automatically routes matching tasks to the small model

## What Does NOT Qualify for Small Model

Anything that requires thinking:

- CRM field extraction (may need interpretation, context lookup)
- Issue triage (requires reading codebase, judgment)
- Data validation + fixing (validation alone is cheap, but fixing requires reasoning)
- Status summarization (needs multi-source synthesis)
- Git ops beyond commit messages (branch strategy, conflict resolution)
- Any task with ambiguous input or multiple possible correct outputs

**The test:** Can you write the expected output format before the task runs, and will it complete in 2-3 tool calls? If not, it stays on the default model.

## Failure Handling

**No auto-escalation.** If a small-model task fails verification or exceeds `maxToolCalls`, it fails. The heartbeat marks the run as failed with:

- `failureReason: "verification_failed"` — output didn't match schema or effect check returned non-zero
- `failureReason: "exceeded_max_tool_calls"` — small model went off the rails

These are deterministic tasks. Failure means the input or skill definition is wrong, not the model size. Failed runs surface in the dashboard "Needs Attention" widget (CUJ-2).

## Cost Impact

Small models are 10-50x cheaper per token than large models. The savings come from volume — mechanical tasks (notifications, classifications, formatting) happen frequently across many agents. Conservative estimate: 20-40% cost reduction for companies with high volumes of structured, repetitive work.

## What This Design Does NOT Include

- No "medium" tier — if it needs any thinking, it gets the default model
- No runtime classifier — the skill declaration is the classifier
- No context handoff — small-model tasks are independent, single-shot
- No conversation history — each small-model dispatch rebuilds context from DB (existing behavior)
- No company-level `modelTierOverrides` in v1 beyond the `SMALL_MODELS` constant (can add later)
