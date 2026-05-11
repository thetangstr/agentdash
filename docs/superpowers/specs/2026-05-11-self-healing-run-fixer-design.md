# Self-Healing Run Fixer — Design Spec

## Overview

A proactive safety-net service that monitors agent runs for adapter-related failures, diagnoses issues using an LLM, and applies automatic fixes within bounded limits.

**Why:** Adapter failures (auth issues, rate limits, model outages, credential expiry) cause silent failures or unhelpful error messages. Currently, runs that fail with `adapter_failed` or `transient_upstream` errors require manual intervention to diagnose and fix.

**Goals:**
1. Proactively scan for runs in problematic states
2. Use an LLM (Claude via existing `claude_api` adapter) to diagnose root cause
3. Apply targeted fixes within strict safety bounds
4. Log all healing actions for auditability

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  RunHealerService                                          │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────┐ │
│  │ Scanner      │───▶│ Diagnoser    │───▶│ Fixer       │ │
│  │ (proactive)  │    │ (LLM-based)  │    │ (bounded)   │ │
│  └──────────────┘    └──────────────┘    └─────────────┘ │
│         │                   │                   │          │
│         ▼                   ▼                   ▼          │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  RunHealerStore (DB)                                │  │
│  │  - heal_attempts (per run, capped at MAX_HEALS)     │  │
│  │  - heal_events (audit log)                          │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Scanner

**Trigger:** Runs every `HEALER_SCAN_INTERVAL_MS` (5 minutes) via the routine scheduler.

**Scan targets:**
1. **Recent failures** — runs that entered `failed` status in the last `HEALER_LOOKBACK_MS` (1 hour)
2. **Stuck runs** — runs in `running` state past `ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS` (60 min)
3. **Transient retries exhausted** — runs that exhausted bounded retries and are `failed`
4. **Adapter-auth failures** — runs with errorCode matching `*_auth`, `*_token`, `*_key`, `unauthorized`, `forbidden`

**Exclusions:**
- Runs that already have `MAX_HEALS_PER_RUN` healing attempts
- Runs that are `succeeded` or `cancelled`
- Runs created in the last `HEALER_MIN_AGE_MS` (5 minutes) — give runs time to stabilize

## Diagnoser (LLM-powered)

**Input:** Run context object containing:
```typescript
{
  runId: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  errorCode: string | null;
  errorMessage: string | null;
  status: HeartbeatRunStatus;
  createdAt: Date;
  outputTail: string; // Last 4KB of run log
  adapterConfig: Record<string, unknown>; // Adapter-specific config (redacted)
  recentHealAttempts: HealAttempt[];
}
```

**Prompt to LLM:**
```
You are diagnosing why an agent run failed. Given the run context and error details,
identify the root cause category and recommend a fix.

Root cause categories:
- AUTH_EXPIRED: API key / token / credentials expired
- AUTH_MISSING: Required credentials not configured
- RATE_LIMIT: Upstream rate limiting
- MODEL_UNAVAILABLE: Model down or not responding
- ADAPTER_CONFIG: Adapter misconfigured (wrong params, missing env)
- PROCESS_CRASHED: Local adapter process crashed
- NETWORK_UNREACHABLE: Cannot reach upstream API
- UNKNOWN: Cannot determine from available data

Respond with JSON:
{
  "category": "AUTH_EXPIRED" | "MODEL_UNAVAILABLE" | etc,
  "confidence": "high" | "medium" | "low",
  "diagnosis": "Brief explanation of what went wrong",
  "suggestedFix": "Specific action to take (e.g., 'Run: opencode --auth refresh', 'Set ANTHROPIC_API_KEY env var', 'Switch to claude_api from claude_local')",
  "fixType": "retry" | "config_update" | "adapter_switch" | "manual_required"
}
```

**Confidence gating:** Only proceed if `confidence !== "low"`.

## Fixer (Bounded)

**Safety limits:**
- `MAX_HEALS_PER_RUN` = 3 (max healing attempts per run)
- `MAX_HEALS_PER_DAY` = 100 (global daily cap)
- `MAX_HEAL_COST_PER_DAY` = $5.00 (max LLM diagnosis cost per day)
- Only fix `high` confidence diagnoses
- Only fix certain `fixType` categories

**Fix types and actions:**

| fixType | Action |
|---------|--------|
| `retry` | Re-enqueue the run with same params |
| `adapter_switch` | Update agent's adapter to a fallback adapter |
| `config_update` | Update runtime config (e.g., clear session) |
| `manual_required` | Log warning, no automatic action |

**Adapter fallback chain:**
```
claude_local → claude_api → opencode_local → hermes_local
codex_local → opencode_local
gemini_local → claude_api
```

**For AUTH_EXPIRED:**
- `claude_local` → attempt `claude login --restore` or prompt for re-auth
- `opencode_local` → attempt `opencode auth refresh`
- Other adapters → log and mark as `manual_required`

**For MODEL_UNAVAILABLE / RATE_LIMIT:**
- Switch to fallback adapter in the chain
- Increment `adapterSwitchCount` on the run

## Database Schema

**New table:** `heal_attempts`
```typescript
// packages/db/src/schema/heal-attempts.ts
export const healAttempts = pgTable("heal_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  diagnosis: jsonb("diagnosis").notNull(),  // LLM response
  fixType: text("fix_type").notNull(),
  actionTaken: text("action_taken"),
  succeeded: boolean("succeeded"),
  costUsd: real("cost_usd"),
  createdAt: timestamp("created_at").defaultNow(),
});
```

**New table:** `heal_events` (audit log)
```typescript
export const healEvents = pgTable("heal_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: text("event_type").notNull(), // "scan" | "diagnose" | "fix" | "skip"
  runId: uuid("run_id").references(() => heartbeatRuns.id),
  details: jsonb("details"),
  createdAt: timestamp("created_at").defaultNow(),
});
```

## Routine Integration

**Schedule:** `HEALER_SCAN_INTERVAL_MS = 5 * 60 * 1000` (every 5 minutes)

**Registration:**
```typescript
// In server startup, register with routineService
routineService.register({
  id: "run-healer",
  schedule: "interval",
  intervalMs: HEALER_SCAN_INTERVAL_MS,
  handler: () => runHealerService.scan(),
});
```

## Configuration

```typescript
// In server config
RUN_HEALER_ENABLED: boolean = true
RUN_HEALER_SCAN_INTERVAL_MS: number = 5 * 60 * 1000
RUN_HEALER_MAX_HEALS_PER_RUN: number = 3
RUN_HEALER_MAX_HEALS_PER_DAY: number = 100
RUN_HEALER_MAX_COST_PER_DAY: number = 5.00
RUN_HEALER_MIN_AGE_MS: number = 5 * 60 * 1000
RUN_HEALER_LOOKBACK_MS: number = 60 * 60 * 1000
```

## Events / Observability

**Emitted events:**
- `run_healer.scan` — scan completed, how many issues found
- `run_healer.diagnosis` — LLM diagnosis completed
- `run_healer.fix_applied` — fix was applied successfully
- `run_healer.fix_failed` — fix was applied but didn't resolve issue
- `run_healer.skipped` — run skipped due to limits or confidence

**Metrics to track:**
- `healer_runs_scanned_total`
- `healer_diagnoses_total` (by category, confidence)
- `healer_fixes_applied_total` (by fixType)
- `healer_fixes_succeeded_total`
- `healer_llm_cost_total`
- `healer_llm_latency_ms`

## Error Handling

- If LLM call fails → log error, skip fix, don't retry within same scan
- If fix action fails → increment `attemptCount`, log failure, let next scan pick up
- If DB write fails → log error, continue with next run (don't block scan)
- If rate limit hit on LLM → back off for 1 minute, retry once

## Out of Scope

- Healing runs that are `pending` (not started yet)
- Healing issues (the issue-graph level, not run level)
- Automatic credential rotation (requires separate service)
- Cost prediction before fix

## Test Plan

1. **Unit tests** for scanner filter logic
2. **Unit tests** for fix-type routing
3. **Integration tests** with mock LLM responses
4. **E2E test** — trigger failure, verify healer diagnoses and applies fix
5. **Safety tests** — verify limits are respected (max heals, max cost)
