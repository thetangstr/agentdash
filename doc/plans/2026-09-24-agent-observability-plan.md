# Right-sized agent observability

Date: 2026-09-24. Status: proposal, awaiting founder approval. No issues filed yet.

The goal is that agents are effective and responsive, and that we can see it when they are not. The cheapest path is to record the facts we mostly already have, add a few aggregations, and show them where a founder or steward already looks. This is not a tracing platform.

**Constraint:** nothing here blocks the 2026-10-28 assistant MCP launch (#674 to #681). One small slice (section 6, M1) should land before launch because `whats_new` and `explain_blocker` get better with it. Everything else can come later.

---

## 1. The questions the product must answer

Each question comes from a real incident in the last month (section 3).

| # | Question | Who asks | Today |
|---|---|---|---|
| Q1 | Which agent is burning tokens on nothing? | founder, steward | Cannot answer. Hermes runs record 0 tokens (section 2.4). |
| Q2 | Is this run stuck, or just quiet? | steward, on-call | Wrong for Hermes. Silence past 1h opens a manager-review ticket. |
| Q3 | Which model actually served this run? | anyone debugging | Answered for the *next* run (AGE-1, #631). Per run only when the ledger read works. |
| Q4 | Did this run produce anything? | steward | The data exists (`liveness_state`), but nothing aggregates or shows it. |
| Q5 | Why did this wake happen? | steward | Stored (`invocation_source`, `trigger_detail`, context snapshot). Not summarized. |
| Q6 | What does a shipped task cost us? | founder | Cannot answer: tokens are missing, and there is no join from runs to done issues. |

---

## 2. What exists today

All paths are relative to the repo root on `origin/main` (0f2e19214).

### 2.1 Run records and logs
- `packages/db/src/schema/heartbeat_runs.ts:6-81` is the run row. It has `invocation_source` and `trigger_detail` (:12-13); status, exit code, signal, error and error code; `usage_json` and `result_json` as jsonb (:21-22); `session_id_before` and `session_id_after`; log pointers `log_store`, `log_ref`, `log_bytes` and `log_sha256`; liveness columns `liveness_state`, `liveness_reason`, `last_useful_action_at` and `next_action` (:51-55); and process liveness `process_pid`, `last_output_at`, `last_output_seq` and `last_output_bytes` (:34-40).
  - It has **no first-class columns** for model, tokens, turns, tool calls or time to first output. Those live, when present, inside `usage_json` and `result_json`. `server/src/services/heartbeat.ts:1307-1385` parses them.
- `heartbeat_run_events` (`packages/db/src/schema/heartbeat_run_events.ts`) is the per-run event stream: seq, type, stream, level, message and payload.
- `heartbeat_run_watchdog_decisions` records snoozes and other decisions against stale-run evaluations.
- `server/src/services/heartbeat.ts` (8.6k lines) owns dispatch, wake coalescing and stop metadata.

### 2.2 Bounded, redacted read surface (#654)
- `GET /api/issues/:id/runs` (`server/src/routes/activity.ts:76-101`) takes a strict-integer `limit` (default 100, cap 500, `server/src/services/activity.ts:34-46`) and an `offset`.
- Context snapshots are redacted with `summarizeHeartbeatRunContextSnapshot` (`heartbeat.ts:1106`).
- `heartbeatRunSafeResultJsonColumn` (`heartbeat.ts:693-751`) truncates summaries and stdout, and replaces oversized result JSON with `{truncated: true}`.
- The assistant MCP spec builds `get_work_item` and `explain_blocker` on this surface.

### 2.3 Activity log
- `server/src/services/activity-log.ts` is the redacted write path, fanned out to the plugin event bus.
- `server/src/services/activity.ts` is the read path. It computes run liveness via `classifyRunLiveness` and pulls retry-exhaustion reasons from run events.

### 2.4 Cost and usage metering, and the gap
- `packages/db/src/schema/cost_events.ts` records provider, biller, model, input, cached and output tokens, and cents, per run, issue, project and goal.
- `server/src/adapters/hermes-usage.ts` (#486, #559) was the fix for "Hermes reports no tokens". It reads Hermes' own `session_model_usage` ledger after each run and folds cumulative session totals into the result. `server/src/adapters/registry.ts:711-729` wraps every `hermes_local` execute this way, and the heartbeat bills deltas per session via `deriveNormalizedUsageDelta`.
- **The fix does not fire on the live instance.** `resolveHermesStateDbPath` (`hermes-usage.ts:71-77`) reads `~/.hermes/state.db`, or `HERMES_HOME`/`AGENTDASH_HERMES_STATE_DB` taken from the *server's* environment. Managed-profile agents write to `~/.hermes/profiles/<profile>/state.db`. Measured on execos-local on 2026-09-24:
  - `~/.hermes/state.db` was last written 2026-09-11.
  - `~/.hermes/profiles/agentdash/state.db` is 334 MB and current. Its ledger shows 9 to 19M input tokens per day from 09-09 to 09-19.
  - In `heartbeat_runs` for the last 10 days: **467 runs, 2 with any `usage_json`, 0 with a non-zero input token count, 1 `cost_events` row.** Q1 and Q6 are blind for exactly this reason.
  - The read failure is silent by design ("metering can never fail a run"). That is right for the run, but it means nothing reports that metering is off.
- `maxRawInputTokens` (`packages/adapter-utils/src/session-compaction.ts`) is a **session-rotation threshold**, enforced at `heartbeat.ts:2559-2566`. It is not a spend cap. It reads raw input tokens, so with zero tokens it never trips.
- Dollar budgets with hard stops exist (`server/src/services/budgets.ts`, checked in `enqueueWakeup` at `heartbeat.ts:7361`). They are denominated in cents, and Hermes rows carry `costUsd 0` (Z.AI and MiniMax report no price), so they cannot stop token burn either.

### 2.5 Liveness, healing and recovery
- **Stale-active-run evaluator:** `server/src/services/recovery/service.ts`.
  - `scanSilentActiveRuns` (:1058) judges liveness only by `coalesce(last_output_at, process_started_at, started_at)`, with thresholds of 1h (suspicious) and 4h (critical) at :50-51.
  - Past the 1h threshold it opens a `stale_active_run_evaluation` issue and wakes the owner for manager review.
  - `hermes_local` runs with `-Q` and streams nothing until it exits, so every Hermes run over 1h raises a false alarm (AGE-169, defect AGE-170).
- **Run liveness classifier:** `server/src/services/run-liveness.ts:292-347` classifies a *finished* run as `advanced`, `completed`, `blocked`, `empty_response`, `plan_only`, `needs_followup` or `failed`, from evidence counts (comments, document revisions, work products) plus text rules. **This is already the "did it produce anything" signal.** It is stored per run and never aggregated.
- **Run healer:** `server/src/services/run-healer/service.ts`. LLM diagnosis of failed or silent runs, capped at 3 per run, 100 per day and $5 per day.
- **Stop reasons:** `server/src/services/heartbeat-stop-metadata.ts` covers `timeout`, `budget_paused`, `process_lost` and `adapter_failed`. Per-adapter `timeoutMs` is the only time budget. The two-track review (2026-09-05) found zero-turn hangs firing that budget 5.8x late (around `heartbeat.ts:3139`).

### 2.6 Wakes and concurrency
- `agent_wakeup_requests.coalesced_count` counts merges. `enqueueWakeup` (`heartbeat.ts:7292`) folds a new wake into a running or deferred execution when it targets the same issue.
- Per-agent `maxConcurrentRuns` defaults to 20 (`packages/shared/src/constants.ts:111`).
- **There is no company-wide or per-provider wake rate limit.** Six wakes on six different issues start six processes against one provider quota.

### 2.7 Model resolution (AGE-1)
- `server/src/services/agent-runtime-model.ts` (#631) resolves the *next* run's model with provenance, returned as `resolvedRuntime` on `GET /api/agents/:id` and shown on `ui/src/pages/AgentDetail.tsx`.
- The *served* model per run comes from the Hermes ledger. It is therefore missing whenever the ledger read misses (section 2.4).

### 2.8 Evaluation, preflight and fallback
- **Company Evaluator:** `docs/superpowers/specs/2026-09-05-company-evaluator-design.md`, `server/src/services/evaluation/`. Read-only shadow-mode scoring of milestones from an append-only ledger. It judges *outcomes* per milestone; it does not measure run efficiency. The M0.1 baseline already recorded "usage_json on 13/142 runs, 2 cost_events rows: metering effectively absent".
- **Harness preflight:** `server/src/services/agent-harness-preflight-readiness.ts`.
- **Adapter fallback:** `server/src/services/dispatch-llm.ts:444-660` (env `AGENTDASH_FALLBACK_CHAIN`). A fallback hop changes `adapter_type`, which orphans the task session, and nothing records that it happened.

### 2.9 Tracing
- **No OpenTelemetry anywhere.** No package depends on it.
- `server/src/observability/` (error-sink, alerter, signals, health-checks, pre-run-checks) is homegrown and Postgres-backed. `error-sink.ts:1-16` notes that it replaced a Sentry transport that dropped every event.

### 2.10 UI
- `ui/src/pages/AgentDetail.tsx` shows the agent and the "Model (next run)" row.
- `ui/src/components/IssueRunLedger.tsx` is the per-issue run list, with liveness and retry states.
- `ui/src/components/transcript/RunTranscriptView.tsx` is the transcript.
- `ui/src/pages/Costs.tsx` has Overview, Budgets, Providers, Billers and Finance tabs, all in dollars.
- No view anywhere ranks agents by waste.

---

## 3. Incidents observability should have caught

| Incident | What happened | Signal that would have caught it | Q |
|---|---|---|---|
| Heartbeat session runaway (09-15 to 09-21) | Priya's 30-min timer resumed one Hermes session (`__heartbeat__`) about 40 times, re-sending a 49 KB mandate each time: about 10M input tokens a day on no-op wakes, about 50M over five days. The Z.AI weekly quota ran out on 09-21 and every run failed for a day. Nobody saw it until runs failed. Measured today: Priya's timer runs over 10 days were **248 `needs_followup` (avg 52 s), 100 `failed`, 9 `advanced`**. | Per-agent no-op wake rate, and tokens per wake, from ledger-backed metering. A token hard stop per agent per day. | Q1, Q4 |
| Acknowledgement-only comment wakes | A comment like "thanks" woke the assignee, which resumed its session and spent about 100K tokens to reply "noted". | Wake reason plus outcome plus tokens on the same row: "comment wake, no work product, 100K tokens". | Q1, Q5 |
| 6 simultaneous wakes | Six wakes started together and hit the provider's burst limit (429), so they all failed. | Failed runs grouped by `errorCode` and provider within a minute. A per-provider concurrency ceiling. | Q2 |
| Zero-turn hangs | Runs that made no model call sat until the time budget fired, 5.8x late. | Time to first output and turn count per run, plus a "no first output in N min" check separate from the overall timeout. | Q2 |
| Runtime model misreported (AGE-1) | Three different answers for the serving model in one day, none authoritative. | Served model per run, from the ledger, next to the configured model. A mismatch is a flag. | Q3 |
| False stale-run tickets (AGE-169/170) | Healthy 74-min Hermes runs opened manager-review tickets because `-Q` streams nothing. | A liveness probe that does not rely on stdout (process alive, ledger or session file growing). | Q2 |

Sources: memory notes for the runaway (09-22 quota incident), zero-turn hangs (2026-09-05 Track A review), AGE-1 (#631) and AGE-169/170. The acknowledgement-wake and six-wake burst incidents come from the founder's brief; no run ids are recorded for them, so M1's backfill should find and link them.

---

## 4. Paperclip upstream

Fork point `685ee84e4` (2026-05-01). Upstream has 2,199 commits since then, up to `e006c18f2` (2026-09-24), fetched from the `upstream` remote.

Upstream built a full observability stack in that time:
- opt-in OTel tracing
- opt-in Sentry
- a product-telemetry event contract with an `agent.task_run` event
- durable run-log storage
- a recovery-rate report
- cost-accuracy fixes

Most of it collides with heartbeat and recovery files we have rewritten. It is reference material, not merge material.

### Verdicts under `doc/UPSTREAM-POLICY.md`

| SHA | What | Verdict |
|---|---|---|
| `1e8ede4e1` (07-10) | `runChildProcess` escalates to SIGKILL on real process liveness (`exitCode`/`signalCode`), not `child.killed`. 6-line core change in adapter-utils. | **Cherry-pick.** Inherited adapter core, specific, bounded, and relevant to zombie or hung runs. Only a test-file conflict. |
| `362c30ccd` + `b01f423cd` (06-12, 07-31) | Opt-in OTel auto-instrumentation: new `server/src/instrumentation.ts` using dynamic imports, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The second commit fixes manual span export. | **Cherry-pick candidate for M5.** Mostly new files; conflicts are wiring only (`index.ts`, README). Gives us the SDK bootstrap for free. HTTP and PG spans only, no GenAI semantics. |
| `85e36aaef` (07-04) | Heartbeat progress shown in the run log on AgentDetail. UI only, applies cleanly. | **Optional cherry-pick**, low value on its own. |
| `b4e7ba514` + `187a90b7b` (07-15, 07-30) | Durable run-log store with an object-storage mirror, plus flush on shutdown. | **Only if** we see run logs lost on restart on the Minis. Not needed for this plan. |
| `ee851fc36` (08-01), `300a89ec1` (08-30) | Cache-adjusted cost; detection of the unqualified Claude usage-limit message. | Hand-port if needed. The second is a regex worth taking into `claude-local/parse.ts`. |
| `184b014c2` (09-04), `3124dd0f1` (07-16), `d1573244b` (08-24) | `agent.task_run` event at terminal transitions; recovery-rate report plus alert; "telemetry vs observability" docs split. | **Design reference only.** The `agent.task_run` field set is a good model for our run record (section 6, M1). The conflicts are redesign-level (13 files for `184b014c2`). |
| Sentry series (`8f1e3cfe2` and others) | Opt-in Sentry for server and browser. | Skip. Our `error-sink` replaced Sentry deliberately. |

---

## 5. What the good tools measure (2026)

Kept to what changes our design.

- **OTel GenAI semantic conventions are still "Development"**. In June 2026 they moved to their own repo, [semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai). On 2026-09-22 a breaking change replaced `gen_ai.client.token.usage` with per-direction metrics (`gen_ai.client.inference.usage.input_tokens` and others).
  - Relevant shapes: `invoke_agent` and `execute_tool` spans; `gen_ai.agent.id`, `gen_ai.conversation.id` and `gen_ai.conversation.compacted`.
  - `gen_ai.request.model` vs `gen_ai.response.model` is exactly our configured-vs-served distinction (Q3).
  - `gen_ai.usage.input_tokens` counts cached tokens, with `cache_read`/`cache_write` sub-counts.
  - New agent metrics: `gen_ai.invoke_agent.inference_calls` and `.tool_calls`. Client-side TTFT is `gen_ai.client.operation.time_to_first_chunk`.
  - Because the names are unstable, any export must keep attribute names in **one mapping module**.
- **Backends that accept OTLP GenAI directly:**
  - [Langfuse](https://langfuse.com/integrations/native/opentelemetry) (HTTP only; agent graphs show loops as cycle edges)
  - [LangSmith](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
  - [Braintrust](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry)
- **Backends that don't fit:**
  - [Arize Phoenix](https://arize.com/docs/phoenix/tracing/concepts-tracing/translating-conventions) needs an OpenInference translation step.
  - [Helicone](https://www.helicone.ai/blog/joining-mintlify) is in maintenance mode after the Mintlify acquisition, so it is not a target.
  - AgentOps offers session replay and per-session cost; its OTel export is only partly verified.
- **What they measure for agents:**
  - trajectory (step count against a budget, unnecessary tool calls, loops and retries)
  - tool-call success and recovery
  - task completion
  - cost and latency per run

  Deterministic checks run on every trace; an LLM judge runs only on the sampled subset that needs semantic judgment ([Langfuse on agent evaluation](https://langfuse.com/resources/engineering/ai-agent-evaluation); [LangSmith agent evals](https://www.langchain.com/resources/agent-evals)). Braintrust suggests online scoring on 1 to 10% of traffic ([docs](https://www.braintrust.dev/docs/guides/logs/score)).
- **Cost per successful task** is the outcome metric practitioners converge on. Abandoned, timed-out and escalated runs stay in the numerator ([example](https://tianpan.co/blog/2026-06-02-the-agent-budget-that-approved-cost-per-call-and-never-measured-cost-per-resolved-task)).
- **Runaway guards:** per-agent token budgets, cost circuit breakers, and cost-per-iteration trend as a non-convergence signal ([example](https://www.getreadyforagents.com/blog/agent-cost-runaway-detection-token-enforcement-production/); its $47k anecdote is unverified).
- **The CLIs our agents run already emit telemetry.**
  - [Claude Code](https://code.claude.com/docs/en/monitoring-usage) (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) exports `claude_code.token.usage`, `claude_code.cost.usage`, and `api_request`, `tool_decision` and `tool_result` events keyed by `session.id`. Beta traces are available. It uses `claude_code.*` names, not `gen_ai.*`.
  - Codex CLI has an `[otel]` config block ([docs](https://learn.chatgpt.com/docs/config-file/config-advanced)).
  - Hermes has its ledger.
  - So the per-adapter source of truth for tokens and turns already exists. Our job is to read it, not to re-instrument model calls.

**Takeaway for us:** the industry's core is a run record carrying served model, tokens, turns and tool calls; an outcome label; cost per successful outcome; and cheap deterministic loop and budget checks. We have the outcome label already (`liveness_state`). We lack trustworthy tokens and a place that adds it up. Tracing UIs, judge pipelines and trajectory viewers are what those vendors sell, and customers who want them can export to them.

---

## 6. The plan

### Principles
1. **Record once, on the run row.** Every question is a query over `heartbeat_runs`, not a new pipeline.
2. **Missing is not zero.** A run whose metering failed says `unmetered`, and an instance with unmetered runs raises a signal. The silent zero is the root of Q1 and Q6.
3. **Adapter ledgers are the source of truth** for tokens, turns and served model. Hermes has its ledger; Claude and Codex report usage in their output or telemetry.
4. **Surfaces the founder already uses:** agent page, steward inbox, assistant MCP. No new observability app.
5. **Export seam, not a tracing UI.**

### Milestones, ordered by value

#### M1: Honest per-run record (pre-launch, size S to M)
Fixes Q1, Q3, Q4 and Q5 at the source.

- **Hermes ledger path.** `resolveHermesStateDbPath` takes the run's profile. When the agent runs a managed profile, read `~/.hermes/profiles/<profile>/state.db` (the same `HERMES_PROFILES_DIR` resolution `hermes-profile.ts:48` uses), then fall back to the root DB.
- **Metering status.** `usage_json.meteringStatus` is one of `metered`, `unmetered_no_ledger`, `unmetered_no_session` or `adapter_reported`. A run whose ledger read fails logs one `heartbeat_run_events` warning.
- **Run facts.** Write a small normalized `runFacts` object into `result_json` (no migration). If later milestones need to index these values, promote them to columns in M2.
  - `servedModel` and `servedProvider` (from the ledger or adapter), and `configuredModel` (from `resolvedRuntime`)
  - `inputTokens`, `cachedInputTokens` and `outputTokens` as the **per-run delta**
  - `turns` (ledger `api_call_count` delta, or adapter `num_turns`) and `toolCalls` where the adapter reports them
  - `wallMs` and `firstOutputMs` (time to first stdout byte or first ledger row)
  - `outcome`: the existing `liveness_state` mapped to `produced` (advanced or completed with evidence), `no_op` (needs_followup, empty_response or plan_only with no evidence), `blocked` or `failed`
  - `wakeReason`: one normalized label from `invocation_source`, `trigger_detail` and the context snapshot's `wakeReason` (`timer`, `assignment`, `comment`, `mention`, `approval`, `automation`, `retry`, `manual`)
- **Backfill** `runFacts` for the last 30 days of runs from the ledger (read-only). This makes the founder's first view show the real 09-15 to 09-21 burn.
- **Acceptance:**
  - On execos-local, a new Priya or Jules run shows non-zero tokens and `servedModel = glm-5.3-flash`.
  - The backfill reproduces the ledger's daily totals within 1%.
  - A run with the ledger moved away shows `unmetered_no_ledger`, not 0.
  - `maxRawInputTokens` rotation fires in a test that uses real ledger numbers.
- **Verification:**
  - Unit tests on the path resolution and the delta.
  - A ledger fixture test with a profile-path DB.
  - A live check on :3199 with `select count(*) filter (where result_json->'runFacts'->>'meteringStatus'='metered')` over the last day, which should be above 90% of Hermes runs.
  - Full `pnpm -r typecheck && pnpm test:run && pnpm build`.

#### M2: Agent health signals and a hard stop (pre-launch if it fits, else the week after; size M)
Q1, Q2 and the runaway incident.

- **`agentHealthService.summary(companyId, agentId, window)`**, one SQL aggregate over `runFacts`, with no new table: runs, no-op rate, tokens total, tokens on no-op runs, median wall time, failures grouped by `errorCode`, and tokens per produced run.
- **Daily token ceiling per agent** (`runtimeConfig.heartbeat.maxDailyInputTokens`), checked in `enqueueWakeup` next to the budget check (`heartbeat.ts:7361`).
  - When exceeded, the agent pauses timer and comment wakes only; assignments and manual wakes still run.
  - One steward inbox item: "Priya paused: 10.2M input tokens today, 94% on no-op timer wakes."
  - Default = off for existing agents and 5M for new hires. This number is a founder decision.
- **Loop and runaway detection, deterministic only:**
  - N consecutive `no_op` runs on the same task key (default 5) raises the same inbox item and suggests a session reset. That is what fixed the incident by hand.
  - Tokens per run rising across a resumed session with no produced outcome is shown as "context growing, no progress".
- **Provider burst guard.** A per-provider concurrent-run ceiling (instance config, default 3 for `zai`), enforced where `availableSlots` is computed (`heartbeat.ts:5393`). Excess wakes defer, as they already do for per-agent slots.
- **Acceptance:**
  - A replay of the 09-15 to 09-21 run history in a test trips the ceiling on day 1.
  - Five consecutive no-op runs raise exactly one inbox item (deduped).
  - Six simultaneous `zai` wakes run three at a time.
- **Verification:** service unit tests with fixtures shaped like the live data in section 2.5, an inbox dedup test, and the full suite.

#### M3: Stuck vs quiet that works for non-streaming adapters (size S)
Q2, AGE-169/170, zero-turn hangs.

- **A `livenessProbe` per adapter.**
  - For `hermes_local`: process alive (pid, group), plus ledger `session_model_usage.last_seen` or message count advancing for the run's session.
  - For streaming adapters: `last_output_at` as today.
  - `scanSilentActiveRuns` (`recovery/service.ts:1058`) asks the probe before opening an evaluation.
- **First-output deadline.** A run with no first output (and no ledger row) after `firstOutputDeadlineMs` (default 10 min) stops with a new stop reason `no_first_output`. This addresses the 5.8x-late zero-turn hang without shortening real long runs.
- **Acceptance:**
  - A 74-minute Hermes run whose ledger advances opens no stale-run issue.
  - A Hermes run whose process is alive but whose ledger has not moved for 1h still does.
  - A zero-turn run stops at the deadline with `no_first_output`.
- **Verification:** unit tests on the probe with a ledger fixture, a recovery-service test for both cases, and a manual long run on :3199.

#### M4: Where it shows (partly pre-launch; size M)
- **Assistant MCP (pre-launch, inside M1 of #676, no new tools).**
  - `whats_new` gains a short `attention[]` entry when an agent's no-op tokens or ceiling pause crossed a threshold in the window: "Jules spent 2.1M tokens on 31 runs that produced nothing today."
  - `explain_blocker` adds the run's stop reason (`no_first_output`, `token_ceiling`, provider 429) as evidence.
  - Both read `agentHealthService`.
  - Token counts are **not** in the spec's redaction list. Budgets and ceilings are, so the ceiling *value* stays out and only the fact "paused by the daily token ceiling" is shown. Needs a line in the spec's §5 redaction section.
- **Agent page.** A "Last 7 days" strip: runs, produced vs no-op, tokens (with an `unmetered` badge when applicable), median time, and the served model with a mismatch flag against `resolvedRuntime`.
- **"Why is this expensive or slow" view.** A tab on the agent page, not a new app. Tokens by wake reason, and the top 10 costliest runs, each with outcome, turns, first-output time and a link to the transcript.
- **Costs page.** One card: tokens per shipped item per agent (Q6) = tokens across all runs on issues that reached `done` in the window, plus tokens on runs not tied to a done issue, divided by the count of done issues. Abandoned runs stay in the numerator.
- **Steward inbox.** Ceiling pause, loop suspicion, and "metering off on this instance" (from M1's `unmetered` rate). Reuses the existing inbox item kinds.
- **Acceptance:**
  - `whats_new` on a fixture company names the wasteful agent in one sentence under 280 characters.
  - The agent page shows the strip.
  - The Costs card matches a hand-computed value on fixtures.
  - Redaction wire-bytes test updated.
- **Verification:** MCP tool tests (per the #676 envelope), UI component tests, a Playwright check of the agent page strip, and the full suite.

#### M5: OpenTelemetry GenAI export seam (post-launch; size S to M)
- Cherry-pick `362c30ccd` and `b01f423cd` for the SDK bootstrap (off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set).
- At run finalization, emit one `invoke_agent` span per run, built from `runFacts`:
  - `gen_ai.agent.id` and `gen_ai.agent.name`
  - `gen_ai.conversation.id` = task session id
  - `gen_ai.request.model` = configured model, `gen_ai.response.model` = served model
  - usage attributes
  - `agentdash.outcome` and `agentdash.wake_reason`
- Emit child `execute_tool` spans only where the adapter reports tool calls.
- **No content capture.** Attribute names live in one `otel-genai-map.ts` because the spec is unstable (renamed metrics on 2026-09-22).
- A doc on pointing it at Langfuse, plus a note that Claude Code and Codex can export their own OTel to the same collector.
- **Acceptance:** with a local OTLP collector, one run produces one span with the attributes above. With no endpoint set, there are zero new dependencies loaded at runtime.
- **Verification:** a unit test on the mapper, an in-memory exporter test, a manual Langfuse Docker check, and the full suite. Log the cherry-pick in `doc/UPSTREAM-POLICY.md`.

Take `1e8ede4e1` (SIGKILL on real liveness) with M3. It is the same problem area and a 6-line change.

### Pre-launch slice
- M1 (the honest record) and the MCP part of M4 (`attention[]` in `whats_new`, stop reasons in `explain_blocker`).
- M2's token ceiling if it fits. It is the only item that would have *prevented* the quota outage rather than explained it.
- Together that is about one engineer-week. It touches `hermes-usage.ts`, `heartbeat.ts` finalization, one new service, and the #676 tool code.
- If #676 slips, drop the MCP part first. The launch acceptance script (spec §8) does not depend on it.

---

## 7. What not to build

- **A tracing UI, span waterfall or trajectory viewer.** The transcript view exists; Langfuse and others exist for customers who want more.
- **LLM-as-judge or online eval pipelines.** The Company Evaluator scores outcomes per milestone, and `liveness_state` labels run outcomes deterministically. Revisit only if `produced`/`no_op` turns out to be wrong more than occasionally.
- **Our own model-call instrumentation or a proxy gateway.** Adapters run CLIs that already meter; we read their ledgers and output.
- **Dollar pricing tables for Z.AI or MiniMax.** MKThink metering is tokens without dollars by decision. Tokens are the unit for ceilings.
- **A metrics time-series store** (Prometheus, ClickHouse). Postgres aggregates over `heartbeat_runs` are enough at our run volume (about 50 runs per day per instance).
- **New tables in M1.** Promote fields out of `result_json` only when a query needs an index.
- **Sentry** (deliberately replaced by `error-sink`) and upstream's `agent.task_run` product telemetry (a redesign-level merge).
- **New assistant MCP tools.** Observability rides on `whats_new` and `explain_blocker`.

---

## 8. Open decisions for the founder

1. **Default daily token ceiling** for new agents (proposed 5M input tokens), and whether it applies to existing agents at rollout or stays opt-in.
2. **Whether the ceiling pauses only timer and comment wakes** (proposed) or all wakes.
3. **Per-provider concurrency default** (proposed 3 for `zai`; unset elsewhere).
4. **Whether M2 lands before 2026-10-28**, or only M1 plus the MCP slice.
5. **Whether "tokens" may appear in assistant MCP output.** This plan proposes yes, while ceiling values stay redacted as the spec requires.
