# AgentDash Adapter Strategy: SDK, Auth, and Enterprise Cost Control

> **Status:** Research complete, implementation not started
> **Date:** 2026-03-31
> **Audience:** Founding team, enterprise sales, future contributors
> **Related issues:** Paperclip #373 (idle burn), #1756 (token budgets), #128 (subscription auth), #248 (sandboxed execution)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [How Agent Execution Works Today](#how-agent-execution-works-today)
3. [Claude Agent SDK: Evaluation](#claude-agent-sdk-evaluation)
4. [Authentication Landscape](#authentication-landscape)
5. [Codex Comparison](#codex-comparison)
6. [Enterprise Cost Modeling](#enterprise-cost-modeling)
7. [The Idle Token Burn Problem](#the-idle-token-burn-problem)
8. [Token-Based Budgets for Enterprise](#token-based-budgets-for-enterprise)
9. [Enterprise Customer Communication Guide](#enterprise-customer-communication-guide)
10. [Adapter Strategy Roadmap](#adapter-strategy-roadmap)
11. [Appendix: Paperclip Community Issues](#appendix-paperclip-community-issues)

---

## Executive Summary

AgentDash inherits Paperclip's CLI-spawning architecture for agent execution. The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) offers programmatic hooks, streaming, and session management — but **does not support OAuth/subscription auth**, which is how many users (and enterprise customers with seat-based plans) access Claude today.

**Key decisions:**

- **Keep `claude_local` (CLI adapter) as the default.** It supports both subscription and API key auth, matches upstream Paperclip, and is battle-tested by the community.
- **Build `claude_sdk` as a second adapter** for enterprise customers who need mid-run policy enforcement, real-time streaming, and programmatic session management. API-key only.
- **Fix idle token burn (#373) before anything else.** This is the single highest-ROI change for enterprise readiness — a DB query before spawning can cut costs 60-80%.
- **Add token-based budgets (#1756).** Enterprise customers on seat-based plans don't think in dollars.

---

## How Agent Execution Works Today

### Architecture

Paperclip (and AgentDash) uses a **CLI-spawning model**. The server never calls the Anthropic API directly:

```
Heartbeat Service (server/src/services/heartbeat.ts)
    │
    ├── enqueueWakeup() — checks budget, policy, issue locks
    ├── startNextQueuedRunForAgent() — claims and executes
    │
    └── adapter.execute(ctx) — dispatches to registered adapter
            │
            ├── claude_local: spawns `claude --print - --output-format stream-json ...`
            ├── codex_local: spawns `codex --approval-mode full-auto ...`
            ├── gemini_local: spawns `gemini ...`
            └── (other adapters follow same pattern)
```

### Claude Local Adapter

**File:** `packages/adapters/claude-local/src/server/execute.ts`

1. Builds runtime config from agent's `adapterConfig` (model, effort, maxTurns, etc.)
2. Creates skill directory with symlinks to available skills
3. Renders system prompt from template with agent context
4. Spawns `claude` CLI process with prompt via stdin
5. Parses streamed JSON output (session ID, model, cost, usage, result)
6. Returns `AdapterExecutionResult` with metadata

**Key characteristics:**
- Fire-and-forget: no mid-run control (can only kill the OS process)
- Cost tracking is post-hoc (parse `costUsd` from CLI output after run completes)
- Session management delegated to Claude CLI (file-based)
- Skills discovered via filesystem symlinks

### No Direct Anthropic SDK Usage

There is **no dependency** on `@anthropic-ai/sdk` anywhere in the codebase. All LLM interaction goes through CLI child processes. This is consistent across all adapters — Claude, Codex, Gemini, etc.

---

## Claude Agent SDK: Evaluation

### What It Is

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, formerly "Claude Code SDK") gives you the same agent loop that powers Claude Code as a programmable library. Available in TypeScript and Python.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

### Capabilities

| Feature | Description |
|---|---|
| **Built-in tools** | Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch — no reimplementation needed |
| **Hooks** | `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart/End` — intercept agent behavior mid-run |
| **Subagents** | Native `AgentDefinition` for spawning specialized sub-agents |
| **MCP** | Connect to external systems (databases, browsers, APIs) as native agent tools |
| **Sessions** | Programmatic resume/fork with `session_id` |
| **Permissions** | Declarative `allowedTools` + permission modes (`acceptEdits`, `dontAsk`, `bypassPermissions`) |

### Authentication

**API key only.** The SDK supports:

1. `ANTHROPIC_API_KEY` (direct Anthropic API)
2. Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials)
3. Google Vertex AI (`CLAUDE_CODE_USE_VERTEX=1` + GCP credentials)
4. Microsoft Azure AI Foundry (`CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials)

**No OAuth. No subscription auth. No claude.ai login passthrough.**

From the official docs:
> *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."*

### SDK vs CLI: Trade-off Matrix

| Dimension | CLI Adapter (current) | Agent SDK |
|---|---|---|
| **Auth** | Subscription OAuth + API key | API key only |
| **Mid-run control** | Kill process only | Hook callbacks before/after each tool |
| **Cost enforcement** | Post-hoc (after tokens spent) | Pre-tool-call hooks (before tokens spent) |
| **Observability** | Parse stdout JSON | Streaming message iterator |
| **Session management** | File-based (CLI manages) | Programmatic resume/fork |
| **MCP integration** | CLI discovers MCP servers | Native MCP server connections |
| **Process model** | 1 OS process per agent run | Async iterator in-process |
| **Dependency risk** | CLI versioning (semver) | SDK versioning (semver, in-process) |
| **Upstream compat** | Matches Paperclip | Would diverge |

### Verdict

**Don't switch. Augment.**

The SDK becomes compelling when you need mid-run governance (approval gates, budget hard-stops, audit logging per tool call). That's a v2 feature — the policy engine's value prop. But the CLI adapter is working, battle-tested, and supports the broadest auth surface.

Build the SDK adapter as a second option alongside `claude_local`, registered in the adapter system as `claude_sdk`. The choice becomes a per-agent config decision.

---

## Authentication Landscape

### Two Separate Billing Planes

Claude has two completely independent authentication and billing systems:

| | Subscription (claude.ai) | API (platform.claude.com) |
|---|---|---|
| **Auth mechanism** | OAuth via claude.ai login | `ANTHROPIC_API_KEY` |
| **Billing model** | Per-seat/month (Team $25/seat, Enterprise custom) | Per-token (pay-as-you-go) |
| **Claude Code included?** | Yes — uses subscription quota | No — uses API credits |
| **Headless/server** | Fragile — OAuth tokens expire every ~8hrs, no refresh API | Stable — key doesn't expire |
| **Agent SDK** | Explicitly prohibited for 3rd-party apps | Supported |
| **CLI (`claude -p`)** | Works (CLI handles token refresh internally) | Works |
| **Enterprise admin controls** | SSO, SCIM, audit logs, seat management | Rate limits, usage tiers, spend caps |

### Enterprise Subscription vs API: Key Distinction

Enterprise customers paying for Claude Enterprise (seat-based) get:
- Claude.ai access for all seats
- Claude Code usage included in subscription
- SSO, SCIM, audit logs, access controls
- No per-token billing

But this does **not** automatically include API access. API keys are provisioned separately through the Anthropic Console. An enterprise customer could have:
- 500 seats on Claude Enterprise (subscription), AND
- A separate API account with per-token billing

**This matters for AgentDash** because:
- Running agents via CLI (`claude -p`) = subscription billing (included in seats)
- Running agents via Agent SDK = API billing (additional per-token cost)
- Running agents via CLI with `ANTHROPIC_API_KEY` set = API billing (overrides subscription)

### OAuth in Headless Deployments: Known Pain Points

From Paperclip community (issue #1613):
- OAuth tokens expire every ~8 hours on headless servers
- No programmatic token refresh API
- Workaround: `claude -p "ping"` before agent runs to trigger CLI's internal refresh
- Closed with: *"Anthropic officially recommends ANTHROPIC_API_KEY for headless/server deployments"*

From issue #2001:
- When both `ANTHROPIC_API_KEY` and subscription OAuth are present, they conflict
- API key takes precedence and overrides subscription auth
- If the API key has no credits, runs fail even though subscription is valid

**Recommendation for AgentDash enterprise deployments:**
Require API keys for headless/server deployments. Document the OAuth limitations clearly. For customers who want to use their Enterprise subscription, require a machine with an active Claude Code login session (e.g., a developer workstation, not a CI server).

---

## Codex Comparison

### Auth Model

OpenAI's Codex CLI supports broader auth than Claude's Agent SDK:

| | Claude CLI | Codex CLI | Claude Agent SDK |
|---|---|---|---|
| **Subscription auth** | OAuth (claude.ai login) | "Sign in with ChatGPT" — Plus/Pro/Team/Edu/Enterprise | Not allowed for 3rd-party |
| **API key auth** | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `ANTHROPIC_API_KEY` only |
| **Enterprise plan** | Claude Enterprise (seat-based) | ChatGPT Enterprise (seat-based) | API billing (per-token) |
| **Headless/server** | OAuth expires ~8hrs | Likely similar issues | Stable (API key) |

**Key advantage:** Codex explicitly supports Enterprise ChatGPT plan auth for all plan tiers.

### AgentDash Codex Adapter

**File:** `packages/adapters/codex-local/src/server/execute.ts`

The Codex adapter already handles both auth paths:
- Checks for `OPENAI_API_KEY` → API billing
- Falls back to local session auth from `~/.codex/auth.json` → subscription billing
- Detects billing type: `"openai"` (API key), `"chatgpt"` (subscription), `"openrouter"` (OpenRouter)
- Has quota checking via `packages/adapters/codex-local/src/server/quota.ts`

### Multi-Provider Strategy

AgentDash's adapter registry already supports multiple providers. Enterprise customers should be able to:
- Use Claude for reasoning-heavy work (policy engine, architecture decisions)
- Use Codex for code generation tasks (implementing tickets, writing tests)
- Use Haiku/smaller models for triage and routing
- See unified cost tracking across all providers

---

## Enterprise Cost Modeling

### Anthropic API Pricing (as of 2026-03-31)

| Model | Input | Output | Batch Input | Batch Output |
|---|---|---|---|---|
| **Opus 4.6** | $5/MTok | $25/MTok | $2.50/MTok | $12.50/MTok |
| **Sonnet 4.6** | $3/MTok | $15/MTok | $1.50/MTok | $7.50/MTok |
| **Haiku 4.5** | $1/MTok | $5/MTok | $0.50/MTok | $2.50/MTok |

Cache hits: 10% of input price. Cache writes: 1.25x (5min) or 2x (1hr) of input price.

### Projected Monthly Costs (API Billing)

| Scenario | Agents | Model Mix | Active Tokens/mo | Idle Burn/mo | Total Cost/mo |
|---|---|---|---|---|---|
| **Startup (current)** | 5 | Sonnet | ~25M | ~50M | $200-500 |
| **Mid-market (target)** | 20 | Mixed | ~200M | ~400M (unfixed) | $2,000-6,000 |
| **Mid-market (idle fix)** | 20 | Mixed | ~200M | ~20M | $800-2,500 |
| **Enterprise** | 50 | Mixed | ~500M | ~1B (unfixed) | $10,000-30,000 |
| **Enterprise (idle fix)** | 50 | Mixed | ~500M | ~50M | $3,000-8,000 |
| **Enterprise (optimized)** | 50 | Tiered + cache | ~500M | ~50M | $1,500-4,000 |

**The idle burn fix alone saves 60-80% for organizations with more agents than active tasks.**

### Cost Optimization Levers

1. **Fix idle burn (#373)** — Don't spawn CLI for agents with no work. Saves the most.
2. **Model tiering** — Haiku ($1/MTok) for triage/routing, Sonnet ($3/MTok) for implementation, Opus ($5/MTok) only for complex reasoning. A 50-agent org using all Opus pays 5x what a tiered org pays.
3. **Prompt caching** — Cache hits are 10% of input cost. Agent system prompts, skill definitions, and role context should be cached across runs.
4. **Batch API** — 50% discount for non-realtime work (scheduled reports, bulk processing).
5. **MaxTurns enforcement** — Currently passed to CLI but not enforced by the adapter. Add adapter-level turn limits as a safety net.
6. **Session reuse** — Don't re-bootstrap context on every heartbeat. Resume existing sessions where possible.

### Subscription vs API: Cost Comparison

For a 50-seat Enterprise customer:

| Billing Model | Monthly Cost | Per-Agent Effective | Predictable? |
|---|---|---|---|
| **Claude Enterprise subscription** | ~$150/seat × 50 = $7,500 | $150 | Yes (flat rate) |
| **API billing (optimized)** | $1,500-4,000 | $30-80 | No (usage-based) |
| **API billing (unoptimized)** | $10,000-30,000 | $200-600 | No |

Subscription is cheaper **if** the org has seats to spare. API is cheaper per-agent **if** optimized, but unpredictable. Enterprises generally prefer predictable costs.

---

## The Idle Token Burn Problem

### Current State (Paperclip #373 — OPEN, UNFIXED)

A user with 22 idle agents burned **hundreds of thousands of tokens overnight doing nothing**. The heartbeat service has no "skip if idle" logic:

```
Current heartbeat flow:
  1. Timer fires (every intervalSec)
  2. Check: agent paused/terminated? → skip
  3. Check: budget exceeded? → skip
  4. Spawn CLI process ← ALWAYS HAPPENS if above checks pass
  5. CLI bootstraps (loads system prompt, skills, context)
  6. Agent looks around, finds nothing to do
  7. Agent reports "no work" — tokens already burned
```

Each idle bootstrap costs approximately:
- System prompt: ~2,000 tokens
- Skill definitions: ~1,000-5,000 tokens
- Agent context/role: ~1,000-3,000 tokens
- "No work found" response: ~500-1,000 tokens
- **Total per idle heartbeat: ~5,000-10,000 tokens**

At 5-minute intervals, 50 agents, that's:
- 50 agents × 288 heartbeats/day × 7,500 avg tokens = **108M tokens/day idle**
- At Sonnet pricing ($3/MTok in + $15/MTok out): **~$500-1,500/day wasted**

### Proposed Fix

Add a pre-spawn work check in `heartbeat.ts`:

```typescript
// Before spawning CLI, check if agent has pending work
async function agentHasWork(db: Db, agentId: string, companyId: string): Promise<boolean> {
  const [hasTasks, hasComments, hasWakeups, hasApprovals, hasScheduled] = await Promise.all([
    // Open tasks assigned to this agent
    db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.assigneeAgentId, agentId), inArray(tasks.status, ['open', 'in_progress'])))
      .limit(1),
    // New comments since agent's last run
    db.select({ id: comments.id }).from(comments)
      .where(and(eq(comments.companyId, companyId), gt(comments.createdAt, agent.lastRunAt)))
      .limit(1),
    // Pending wakeup requests
    db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, 'queued')))
      .limit(1),
    // Pending approvals
    db.select({ id: approvals.id }).from(approvals)
      .where(and(eq(approvals.reviewerAgentId, agentId), eq(approvals.status, 'pending')))
      .limit(1),
    // Scheduled events due
    checkScheduledEvents(db, agentId),
  ]);

  return hasTasks.length > 0 || hasComments.length > 0 || hasWakeups.length > 0
    || hasApprovals.length > 0 || hasScheduled;
}
```

This is 5 indexed DB queries (~5ms total) vs spawning a Node.js process and burning 10K tokens (~30 seconds, ~$0.05-0.15).

**Important:** On-demand wakeups (explicit `wakeupAgent()` calls) should bypass this check — they're triggered because there IS work. Only timer-based heartbeats need the idle guard.

---

## Token-Based Budgets for Enterprise

### Problem (Paperclip #1756 — OPEN)

The current budget system uses `budgetMonthlyCents` / `spentMonthlyCents` — dollar-denominated limits. Enterprise customers on seat-based plans don't track dollar spend; they track **token usage**. The dollar model doesn't map to their billing reality.

Current workaround: set budgets to `0` (unlimited) and track externally via the Anthropic dashboard. This defeats AgentDash's built-in budget guardrails.

### Proposed Schema

```typescript
// Company-level budget config
export const companyBudgetConfig = pgTable("company_budget_config", {
  companyId: uuid("company_id").notNull().references(() => companies.id),
  budgetMode: text("budget_mode").notNull().default("dollars"), // "dollars" | "tokens" | "both"

  // Dollar-based (existing)
  budgetMonthlyCents: integer("budget_monthly_cents"),
  spentMonthlyCents: integer("spent_monthly_cents").default(0),

  // Token-based (new)
  budgetMonthlyInputTokens: bigint("budget_monthly_input_tokens", { mode: "number" }),
  budgetMonthlyOutputTokens: bigint("budget_monthly_output_tokens", { mode: "number" }),
  spentMonthlyInputTokens: bigint("spent_monthly_input_tokens", { mode: "number" }).default(0),
  spentMonthlyOutputTokens: bigint("spent_monthly_output_tokens", { mode: "number" }).default(0),

  // Shared
  alertThresholdPercent: integer("alert_threshold_percent").default(80),
  hardStopEnabled: boolean("hard_stop_enabled").default(true),
});

// Per-agent overrides
export const agentBudgetOverride = pgTable("agent_budget_override", {
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  maxMonthlyInputTokens: bigint("max_monthly_input_tokens", { mode: "number" }),
  maxMonthlyOutputTokens: bigint("max_monthly_output_tokens", { mode: "number" }),
  maxMonthlyTotalTokens: bigint("max_monthly_total_tokens", { mode: "number" }),
  preferredModel: text("preferred_model"), // enforce model tier
});
```

### Example Enterprise Configuration

```
Acme Corp (50 agents, Claude Enterprise subscription)
├── budgetMode: "tokens"
├── budgetMonthlyInputTokens: 500,000,000   (500M input tokens/mo)
├── budgetMonthlyOutputTokens: 100,000,000  (100M output tokens/mo)
├── alertThresholdPercent: 80
├── hardStopEnabled: true
│
├── CEO Agent:      maxTotal: 100M tokens,  model: opus-4.6
├── Dev Lead (x3):  maxTotal: 50M tokens,   model: sonnet-4.6
├── Developer (x20):maxTotal: 20M tokens,   model: sonnet-4.6
├── Triage (x10):   maxTotal: 10M tokens,   model: haiku-4.5
├── Docs (x5):      maxTotal: 5M tokens,    model: haiku-4.5
└── QA (x10):       maxTotal: 15M tokens,   model: sonnet-4.6
```

---

## Enterprise Customer Communication Guide

### By Customer Billing Profile

#### Scenario A: Customer has Claude Enterprise subscription (seat-based)

**Positioning:**
> "Your team already has Claude access through your Enterprise subscription. AgentDash agents can run under your licensed seats via Claude Code — agent usage is covered by your existing subscription with no additional per-token costs."

**Setup:** Each agent runs on a machine where a licensed user is logged into Claude Code. The CLI handles OAuth internally.

**Caveats to manage:**
- OAuth tokens expire every ~8 hours on headless servers
- Workaround: pre-run `claude -p "ping"` to trigger token refresh
- Recommend allocating dedicated seats for agent usage so human users aren't rate-limited
- Best for small-to-mid deployments (5-20 agents) where someone can maintain login sessions

**When to recommend switching to API keys:**
- Headless server deployment (no browser for OAuth refresh)
- More than 20 agents (managing login sessions becomes operational burden)
- Need for reliable, unattended operation (CI/CD, overnight processing)

#### Scenario B: Headless/production deployment (recommended for enterprise)

**Positioning:**
> "For production deployments, we recommend provisioning API keys through your Anthropic organization admin. This gives you stable, headless authentication with granular cost controls. AgentDash includes built-in budget guardrails — per-agent token limits, automatic pause at threshold, and real-time cost dashboards."

**Setup:** Set `ANTHROPIC_API_KEY` in the deployment environment. Each agent's `adapterConfig.env` can optionally override with a different key.

**Cost management talking points:**
- "We'll help you right-size model selection: Haiku for routine tasks ($1/MTok), Sonnet for complex work ($3/MTok), Opus only where needed ($5/MTok)"
- "Prompt caching reduces repeated context costs by 90%"
- "Built-in idle detection prevents agents from burning tokens when there's no work" (once #373 is fixed)
- "Token-based budgets let you set limits that map to your billing reality" (once #1756 is built)
- "For high-volume usage, Anthropic offers custom enterprise API pricing — contact their sales team"

#### Scenario C: Multi-provider deployment (Claude + Codex)

**Positioning:**
> "AgentDash is provider-agnostic. Assign different agents to different providers based on their strengths — Claude for reasoning-heavy work, Codex for code generation. Each provider uses its own auth and billing. Your cost dashboard shows spend across all providers in one view."

**Auth per provider:**
- Claude: `ANTHROPIC_API_KEY` or subscription OAuth
- Codex: `OPENAI_API_KEY` or ChatGPT subscription (Plus/Pro/Team/Enterprise)
- Gemini: Google Cloud credentials

### What Anthropic Tells Enterprise Customers

From Anthropic's enterprise and pricing pages:

- Enterprise plans are **custom-priced** — negotiated case-by-case
- Include: SSO, SCIM, audit logs, access controls, HIPAA-ready options
- API access is **separate** from subscription — requires API key from Console
- *"For high-volume agent applications, contact the enterprise sales team for custom pricing arrangements"*
- Volume discounts available for high-volume API users
- No public "enterprise API flat rate" — all negotiated

**Implication for AgentDash:** When selling to enterprises, recommend they negotiate API pricing with Anthropic directly for agent workloads. AgentDash provides the orchestration, cost tracking, and guardrails — but the customer's Anthropic contract determines per-token rates.

---

## Adapter Strategy Roadmap

### Priority 1: Fix Idle Token Burn (#373)

**Impact:** 60-80% cost reduction for orgs with more agents than tasks
**Effort:** Small — add `agentHasWork()` check in `heartbeat.ts` before `startNextQueuedRunForAgent()`
**Risk:** Low — only affects timer-triggered heartbeats, not on-demand wakeups
**Files:** `server/src/services/heartbeat.ts`

### Priority 2: Token-Based Budgets (#1756)

**Impact:** Enterprise customers can use AgentDash's budget system instead of tracking externally
**Effort:** Medium — new schema, budget service changes, UI updates
**Risk:** Low — additive, doesn't change existing dollar-based budgets
**Files:** `packages/db/src/schema/`, `server/src/services/budgets.ts`, `server/src/services/costs.ts`, UI budget components

### Priority 3: Model Tiering Per Agent

**Impact:** 3-5x cost reduction by matching model to task complexity
**Effort:** Small — already partially supported in `adapterConfig.model`, needs UI and recommendation engine
**Risk:** Low
**Files:** Agent configuration UI, onboarding flow

### Priority 4: Cost Dashboard Enhancements

**Impact:** Enterprise visibility — real-time spend by agent, provider, model
**Effort:** Medium — aggregation queries, new dashboard components
**Risk:** Low
**Files:** `server/src/services/costs.ts`, new UI dashboard page

### Priority 5: Claude Agent SDK Adapter (`claude_sdk`)

**Impact:** Mid-run governance hooks, real-time streaming, programmatic sessions
**Effort:** Large — new adapter implementation, hook integration with policy engine
**Risk:** Medium — API-key only auth, diverges from upstream Paperclip
**When:** After priorities 1-4 are solid, and when a customer needs mid-run policy enforcement
**Files:** New `packages/adapters/claude-sdk/`, `server/src/adapters/registry.ts`

### Priority 6: Sandbox Execution (Paperclip #248)

**Impact:** Security isolation for agents processing untrusted input
**Effort:** Large — new `SandboxProvider` interface, E2B/Docker integrations
**Risk:** Medium — new infrastructure dependency
**When:** When processing external input (GitHub issues, customer tickets)
**Files:** New `packages/adapter-utils/src/sandbox.ts`, provider implementations

---

## Appendix: Paperclip Community Issues

### Auth and Billing

| Issue | Status | Summary | Relevance |
|---|---|---|---|
| **#128** | Open | "Is subscription-based auth secure?" — Many users run on Claude Max, not API keys | Confirms CLI-based subscription auth is a major use case |
| **#139** | Closed | "Unclear how to resolve expired OAuth token" — No resolution posted | OAuth expiry is a known pain point |
| **#863** | Open | "Agents struggle with PAPERCLIP_API_KEY" — JWT secret and env var confusion | Auth wiring is fragile in Docker/headless deployments |
| **#1613** | Closed | "Pre-run hook for Claude subscription auth refresh" — Closed as "use API keys instead" | Anthropic's official stance: API keys for headless |
| **#1614** | Closed | "Auto-retry on claude_auth_required error" — Closed alongside #1613 | No official fix for OAuth expiry |
| **#1615** | Closed | "Headless deployment guide for Claude subscription auth" | Community wanted docs, got "use API keys" |
| **#2001** | Open | "API key passed via env block ignored" — API key overrides subscription, but key has no credits | Shows the two auth systems conflicting |

### Cost and Scale

| Issue | Status | Summary | Relevance |
|---|---|---|---|
| **#373** | Open | "Save billions of wasted tokens" — 22 idle agents burned tokens overnight | Highest-priority fix for enterprise readiness |
| **#1756** | Open | "Token-based budgets" — Enterprise users can't use dollar-based budgets | Must-have for seat-based enterprise customers |
| **#958** | Open | "Slow UI — memory leak from unpaginated heartbeat runs" | Scale issue — UI breaks with many agents |
| **#458** | Open | "Auto-restart agents on process_lost" | Reliability at scale |
| **#2188** | Open | "Anthropic subscription quota always shows 100% used" | Cost dashboard broken for subscription users |

### Architecture and Sandboxing

| Issue | Status | Summary | Relevance |
|---|---|---|---|
| **#248** | Open | "Sandboxed Agent Execution — provider-agnostic interface" | Security isolation for enterprise (E2B, Docker, Cloudflare) |
| **#2145** | Open | "Agents in environments where --dangerously-skip-permissions unavailable" | Permissions model needs work for restricted environments |
| **#1034** | Open | "Cryptographic agent identity and delegation" | Enterprise security feature |

---

*This document should be updated as Anthropic's pricing, SDK capabilities, and Paperclip's architecture evolve.*
