# AgentDash Self-Learning Loop (AGE-105)

_Plan owner: TBD · 2026-05-01_

## Why this exists

AgentDash today **captures** what agents do (skill usage events, heartbeat runs, trace bundles, feedback votes, autoresearch evaluations) but does **not feed any of that signal back** into the same instance to make the next run smarter. The "self-learning" narrative the marketing copy implies is, today, aspirational: data flows out (to a central feedback hub) but nothing flows back in.

The closest external reference is **Hermes Agent** (Nous Research, MIT-licensed, ~64K stars), which is the only agent framework with a documented closed loop:

> Observe → Plan → Act → **Learn**

Hermes' specifics, mapped to what we already have:

| Hermes capability | AgentDash status today |
|---|---|
| Procedural memory (autonomously synthesized skill docs) | We have `company_skills` + `skill_versions` + approval workflow. **Missing**: any agent that writes new skills from completed runs. |
| Episodic memory (past experiences retrieved at run start) | We have `heartbeat_runs`, `issues`, trace bundles. **Missing**: any retrieval at run start. |
| Short-term memory (cache-aware system prompt) | Adapter sessions handle context. **Missing**: an explicit cache boundary so learning context doesn't grow token bills. |
| Skill auto-selection at run start | `skillSelectionService.selectForRun` is a stub returning `[]`. |
| Pluggable memory backends (Honcho, Mem0, Vectorize) | We have one PG backend. **Missing**: provider interface. |
| Closed loop (votes / evaluations → behavior) | Votes captured, evaluations recorded — neither read back into selection or prompt building. |

This plan describes how AgentDash closes that loop in five layers, ordered by ROI per week of effort. It deliberately stays inside the existing schema where possible (we already persist all the right signals; we just don't read them).

## Non-goals

- Replacing Hermes as an adapter — we keep the `hermes_local` adapter as one of many runtimes.
- Inventing new training infrastructure — no fine-tuning, no RLHF on the running instance. This is **prompt-time learning**, not weight updates.
- Closing the loop across companies — every company's learning stays scoped to its own data; no cross-tenant leakage.
- Fully autonomous agent decisions without human gate — every new procedural memory routes through the existing `skill_versions` approval workflow.

## Architecture overview

```
                        ┌─────────────────────────────────────┐
                        │          Run starts (a)             │
                        ├─────────────────────────────────────┤
   Procedural memory ─→ │  • Skill auto-selection             │  ← Layer 1
                        │      (selectForRun)                 │
   Episodic memory  ─→  │  • Lessons from similar past runs   │  ← Layer 2
                        │      (retrieveEpisodicContext)      │
                        ├─────────────────────────────────────┤
                        │          Agent executes (b)         │
                        ├─────────────────────────────────────┤
   On run end       ─→  │  • Trace + outcome persisted        │  (today ✅)
                        │  • If ≥5 tool calls & success:      │
                        │      synthesize candidate skill ────┼─→ skill_versions
                        │      (Layer 3)                      │      (status: pending_review)
                        │  • Vote signal:                     │
                        │      ↓ → demote skill version       │
                        │      ↑ → boost                      │  ← Layer 4
                        ├─────────────────────────────────────┤
                        │     Autoresearch tick (Layer 5)     │
                        │  • Read evaluations                 │
                        │  • Branch / abort / spawn next      │
                        │      experiment                     │
                        └─────────────────────────────────────┘
```

All of (a) and the post-run hooks live behind a **cache-aware** prompt construction so procedural and episodic memory never grow the cached prefix; they're inserted at the per-run suffix boundary. This is what keeps Hermes' learning from costing $20/run.

## Layer 1 — Skill auto-selection at run start

**Status today:** [`server/src/services/skill-selection.ts:30`](server/src/services/skill-selection.ts:30) is a stub returning `[]`. We persist every skill use in `skill_usage_events` with the run/issue context and never read it back.

**Goal:** when an agent starts a run on issue X, return the top-N skills most likely to help, ranked by historical hit rate on similar contexts.

**Algorithm (v0, no embeddings):**
1. Build the candidate set: all `companySkills` for the company that aren't soft-deleted, joined with their latest approved `skillVersion`.
2. Compute relevance: keyword overlap between the issue title + description and each skill's `whenToUse` field (already a designed input — see `SkillDescriptor` type at [`server/src/services/skill-selection.ts:5`](server/src/services/skill-selection.ts:5)).
3. Compute success rate: per skill, count `skill_usage_events` in the last 90 days where the parent `issue.status` is `done`, divide by total uses. Skills with <3 uses default to 50% prior.
4. Score = `0.6 * relevance + 0.4 * successRate`.
5. Return top 5 with `selectionReason: "Used in <N> similar issues, <X>% success rate"`.

**Algorithm (v1, optional, behind feature flag):** swap step 2 for cosine similarity on embeddings of issue text vs `(whenToUse + name)`. Embeddings cached per skill version and refreshed on version change.

**Wiring:** the prompt builder ([`server/src/services/prompt-builder.ts`](server/src/services/prompt-builder.ts)) already has a hook for skills. After this lands, swap the empty `[]` for `selectForRun(...)` output. Ensure these are loaded **after** the cached system prompt, not in it.

**Telemetry:** track `was_selected = true|false` on every `skill_usage_events` row going forward. We can A/B by checking time-to-completion with vs without auto-selection.

**Effort:** 1 week one engineer. No new tables.

## Layer 2 — Episodic recall

**Goal:** at run start, retrieve up to 3 short summaries of similar past runs and inject them as a "Lessons from prior similar tasks" snippet, only if they exist and were successful.

**Algorithm:**
1. Build the search corpus from `heartbeat_runs` joined to `issues` for the same company over the last 60 days.
2. Filter to runs where issue outcome ended `done` (success) — a "negative example" mode is a stretch goal.
3. Score similarity (same v0/v1 split as Layer 1): keyword overlap on issue text → embeddings later.
4. Take top 3, format as a tight bullet list:
   - "On AGE-87 (Quinn, Apr 14): closing books required pulling Stripe export first, then bank rec — adapter timed out twice on retries, succeeded with cooldown=30s."
5. Cap the snippet at 600 tokens. If we'd exceed, truncate per-bullet rather than dropping bullets.

**Schema additions:** none. We may add a `heartbeat_run_summaries` table later if generating bullet text on the fly is too slow; v0 derives it from `heartbeat_run_events` + an LLM summarizer call cached per run.

**Wiring:** new method on `promptBuilder` — `buildEpisodicSnippet(companyId, agentId, issueId)` — called after the cache boundary, before the user message.

**Effort:** 1 week. One LLM summarization call per run that ends; cached.

## Layer 3 — Autonomous skill synthesis

**Goal:** when an agent completes a complex task successfully, it writes a reusable skill doc that future agents can load. Match Hermes' "synthesize after ≥5 tool calls" heuristic.

**Trigger:** at end of every `heartbeat_run` with all of:
- `tool_call_count >= 5`
- Linked `issue.status = "done"`
- No skill version was created in the last 24h for the same agent role + similar issue (debounce)

**Process:**
1. New service `skillSynthesisService.synthesizeFromRun(runId)`.
2. Loads the run trace + tool calls + final result + the issue.
3. Spawns a one-shot reflection prompt: "Write a procedural skill in the agentskills.io style that captures the workflow. Output: name, whenToUse, instructions, allowedTools."
4. Inserts a new `skill_versions` row with `status: "pending_review"`, `source: "auto-synthesized"`, `parent_run_id: <runId>`.
5. Routes to the existing approval workflow — the human (or Chief of Staff agent under Layer 5) approves before the skill becomes selectable.

**Schema additions:**
- `skill_versions.parent_run_id` (nullable uuid → heartbeat_runs)
- `skill_versions.source` enum gets `"auto-synthesized"` value (already a string column; just a new enum value)

**Cost control:** synthesis runs only on `done` issues with ≥5 tool calls; rate-limited to N synthesis calls per company per day (default 5); behind a per-company feature flag `auto_skill_synthesis`.

**Effort:** 2 weeks.

## Layer 4 — Vote-driven adjustment

**Goal:** the existing `feedback_votes` (👍/👎 on traces) become a real signal that changes future selection.

**Mechanism:**
1. `feedback_votes` already references `traceId`. Trace ↔ run is already joined.
2. Periodic job (or trigger): for each skill version used in a voted run, recompute a `quality_score`.
3. Layer 1's success-rate term gets blended with `quality_score`.
4. After **10 net-negative votes** on a single skill version, mark it `status: "demoted"`. It stops appearing in `selectForRun` results unless explicitly pinned.
5. Every demotion fires a Layer 3 re-synthesis trigger seeded from the most recent successful runs that used the skill — so the agent rewrites a new candidate version automatically.

**Schema additions:**
- `skill_versions.quality_score` (decimal, default 0.5)
- `skill_versions.status` gets `"demoted"` value
- `skill_versions.demoted_at` (timestamp)

**Effort:** 1 week.

## Layer 5 — AutoResearch agent

**Status today:** the autoresearch schema chain (`research_cycles → hypotheses → experiments → measurements → evaluations`) is fully built and CRUD'd. **Nothing reads evaluations to decide what to do next.** It's a structured database for an agent or human to drive — no agent yet.

**Goal:** turn autoresearch into a closed loop where a Chief of Staff agent owns each active cycle, reads recent evaluations, and decides:
- Branch (spawn child hypotheses)
- Continue (next experiment for the current hypothesis)
- Close cycle (rolled-up summary written to the goal)

**Mechanism:**
1. Scheduled job per active `research_cycle` (cron: every 4h or end-of-experiment trigger).
2. Reads the cycle's experiments, their measurements, and evaluations.
3. Builds a CoS prompt: "Here are the last 3 evaluations. Propose: continue, branch, or close. If branch, draft 2 child hypotheses and their experiments."
4. Output is gated by the existing approval workflow when budget breaches an `experiments.budgetCapCents`.
5. Spawned experiments use the existing heartbeat run mechanism — no new execution surface.

**Effort:** 3 weeks (this is the biggest item; lots of integration with existing approval/budget/heartbeat code).

## Cross-cutting: cache-aware prompt construction

Critical to **not** turn this into a token bill spiral. Hermes' explicit promise — "learning doesn't grow token costs" — is a real architectural win we need to mirror.

Implementation:
- `promptBuilder` returns a structured prompt with explicit cache boundaries:
  - **Cached prefix** (system prompt, agent description, tool schemas, base behavior rules)
  - **Cache breakpoint** — `cache_control: { type: "ephemeral" }` here
  - **Per-run suffix** (selected skills from Layer 1, episodic snippet from Layer 2, the user's actual message)
- Adapter implementations honor the breakpoint and pass it through to the underlying provider's prompt-cache API (Anthropic ✅ supports; OpenAI's caching is implicit; track which adapters can and skip the optimization for those that can't).
- Selected skills are **loaded by reference, not by inlining the entire skill content** when possible — the procedural memory is the existence of the skill in scope, not pasting all instructions into every prompt.

Telemetry:
- Track `cached_input_tokens` vs `non_cached_input_tokens` per run.
- Goal: ≥80% of input tokens served from cache after Layer 1+2 ship.

## Cross-cutting: pluggable memory backend

Match Hermes' approach so we don't lock ourselves into PG-only.

Implementation:
- New interface in `packages/shared/src/memory.ts`:
  ```ts
  export interface MemoryProvider {
    procedural: { list, get, recordUse, ... }
    episodic:   { search, summarize, store, ... }
  }
  ```
- v0 built-in implementation backed by current `company_skills` + `heartbeat_runs` + `feedback_votes`.
- v1 (optional, post-Layer-4): Mem0 / Vectorize Hindsight / Honcho providers as plugins.
- Per-company config selects the active provider.

**Effort:** 1 week (interface + v0 PG impl) inside Layer 1's week.

## Telemetry — proving it works

The marketing claim ("agents get smarter the longer they run") needs a measurable benchmark before we make it. Hermes claims 40% faster on tasks-with-skills vs fresh instances. Our equivalent:

- Bucket every heartbeat run by `selected_skills_count`.
- Measure `time_to_completion` (`completed_at - started_at`) for each.
- Weekly digest per company: "Tasks completed with auto-selected skills were Xs faster than tasks without."
- Surface this in the marketing site's hero (real numbers from the user's own instance > synthetic copy).

If the number is < 10% improvement after Layer 1+2 ship, **we don't claim self-learning publicly** until Layer 3 lands.

## Sequencing & milestones

| Week | Layer | Deliverable | Public claim unlocked |
|---|---|---|---|
| 1 | L1 | `selectForRun` real impl + telemetry | "Skills auto-load based on past success" |
| 2 | L2 | Episodic recall snippet | "Agents recall lessons from prior runs" |
| 3-4 | L3 | Autonomous skill synthesis (gated by approval) | "Agents write new skills from successful work" |
| 5 | L4 | Vote-driven adjustment + demotion | "Bad runs teach the system to stop using bad skills" |
| 6-8 | L5 | AutoResearch agent | "AgentDash runs experiments and adapts on its own" |
| Cross-cutting | Cache-aware boundary, MemoryProvider interface | (woven into L1-L2) | "Learning that doesn't grow your bill" |

**Total: ~8 engineer-weeks.** Layer 1 alone is shippable in week 1 and immediately differentiates the product story.

## Open questions

1. **Cross-tenant skill sharing.** A high-quality auto-synthesized skill in company A could obviously help company B. Do we expose this opt-in? Likely a v2 question — too risky for v1 (data leak, license).
2. **Demotion vs deletion.** If a skill version reaches the demoted threshold, do we keep it for forensic value or delete? Plan defaults to keep + soft-hide.
3. **AutoResearch agent identity.** Does the cycle owner agent run autoresearch, or do we spawn a dedicated `autoresearcher` role? Lean toward existing CoS taking it on so we reuse approvals.
4. **Procedural memory at the issue level.** Hermes also synthesizes per-task memory snippets (not just reusable skills). Do we add a per-issue scratchpad on top of skills? Defer to v2.

## Why this is the right move now

- We've already built the data schema for every layer (cycles, hypotheses, skill_versions, skill_usage_events, feedback_votes, heartbeat_runs). The implementation is **read-back logic**, not new infrastructure.
- Hermes shows that the closed loop is the headline product feature buyers respond to. AgentDash today is "control plane for AI work"; with this loop it becomes "control plane for AI work that actually gets better".
- Layer 1 alone is a 1-week ship that produces a measurable speedup we can put on the marketing site.

## Linear breakdown (proposed)

If filed: one epic + 5 sub-issues + 1 cross-cutting issue.

- **AGE-105** (epic): Closed Learning Loop — Observe→Plan→Act→Learn
  - **AGE-105-1** Skill auto-selection (Layer 1) — _S, 1w_
  - **AGE-105-2** Episodic recall (Layer 2) — _S, 1w_
  - **AGE-105-3** Autonomous skill synthesis (Layer 3) — _M, 2w_
  - **AGE-105-4** Vote-driven adjustment + demotion (Layer 4) — _S, 1w_
  - **AGE-105-5** AutoResearch agent (Layer 5) — _L, 3w_
  - **AGE-105-X** Cache-aware prompt boundary + MemoryProvider interface — _M (cross-cutting, woven into L1+L2)_

Acceptance criterion for the epic: a published marketing-site benchmark showing ≥20% speedup on time-to-completion for runs with auto-selected skills vs runs without, computed against a real customer's data, on a real production deploy.
