# Design: Managed Inference Gateway + `agentdash_native` Adapter

Date: 2026-06-24
Status: Design for approval
Depends on: `doc/plans/2026-06-24-launch-and-runtime-independence-plan.md` (Phases 1 & 3)
Grounded in: `packages/adapter-utils/src/types.ts` (`ServerAdapterModule`, `AdapterExecutionContext`, `AdapterExecutionResult`), `server/src/adapters/registry.ts`, `server/src/services/heartbeat.ts`, 2026-06-24 Hermes-usage audit.

Goal: a runtime AgentDash owns — no customer tokens, no external binary — that covers the launch agent archetypes (CoS / triage / analyst / support). Two pieces: a gateway (model access) and a native adapter (the loop).

---

## Part A — Managed Inference Gateway

### What it solves
- Kills the **token-setup dependency**: customers never configure provider keys (the #1 source of `adapter_failed` — expired Codex token, missing MiniMax key, agent key not resolving).
- **Provider-swappable**: change models/providers without touching agents (no cc-switch).
- **Metering hook** for the usage-based inference SKU and the future outcome-based pricing.

### Shape (pragmatic MVP, then harden)
The gateway is an **OpenAI/Anthropic-compatible endpoint + AgentDash-held credentials + per-run usage capture**. It must serve two consumers:
1. **In-process consumers** (the native adapter) → a server-side client factory returns a configured SDK client.
2. **External CLIs** (Hermes/Claude/Codex, kept as opt-in) → an HTTP base URL their provider config points at.

MVP can *be* an AgentDash account on **OpenRouter or Fireworks** (both are OpenAI-compatible, multi-provider) behind one internal base URL + key, plus a thin metering wrapper. A self-hosted proxy comes later only when per-company budgets / key isolation / provider fallback are needed.

### Server interface
```ts
// server/src/services/inference-gateway.ts (new)
export interface GatewayModelAccess {
  baseUrl: string;          // e.g. https://openrouter.ai/api/v1  (or self-hosted proxy)
  apiKey: string;           // AgentDash-held (cloud) or BYO (on-prem)
  model: string;            // canonical model id, mapped to provider model
  provider: string;         // for reporting/billing
  protocol: "openai" | "anthropic";
}

// Resolve per company + agent config. Cloud: platform key. On-prem: company BYO key.
export function resolveGatewayAccess(input: {
  companyId: string;
  requestedModel?: string;      // from agent.adapterConfig.model
  secretsSvc: RuntimeConfigSecretResolver;  // existing pattern (registry.ts:270-293)
}): Promise<GatewayModelAccess>;

// Capture usage → cost for billing (feeds the usage-based SKU).
export function recordGatewayUsage(input: {
  companyId: string; runId: string; provider: string; model: string;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}): Promise<{ costUsd: number }>;
```

### Config / env
- `AGENTDASH_GATEWAY_BASE_URL`, `AGENTDASH_GATEWAY_API_KEY` (cloud platform key).
- Per-company override (on-prem BYO): stored via the existing secrets service, same path adapters already use (`resolveExecutionRunAdapterConfig`, `registry.ts:270`).
- Model routing table: canonical id → provider model id + cost-per-1M tokens (drives `recordGatewayUsage`).

### Integration points (existing code)
- Adapters call `resolveGatewayAccess()` instead of reading customer provider config.
- `recordGatewayUsage()` runs from the usage returned in `AdapterExecutionResult.usage` (heartbeat already meters per run).
- For Hermes (opt-in): set its provider `base_url`/key from `GatewayModelAccess` so it routes through the gateway too — retires cc-switch.

### Phasing
- **MVP**: one provider account (OpenRouter/Fireworks), one base URL + key, per-run usage→cost capture, model routing table.
- **Harden**: thin self-hosted proxy for per-company budgets, key isolation, provider fallback, rate-limit handling.

### Exit criteria
Existing agents run with zero customer-managed tokens; cc-switch retired; per-run cost recorded for billing.

---

## Part B — `agentdash_native` Adapter

A first-party `ServerAdapterModule` running an in-process agent loop. No external binary, no venv, no shell, no fs — which also **eliminates the runaway-edit-live-source failure** by construction (no fs/shell tools exist to misuse).

### Conforms to `ServerAdapterModule` (types.ts:331)
```ts
// server/src/adapters/native/index.ts (new); register in registry.ts builtin list
export const agentDashNativeAdapter: ServerAdapterModule = {
  type: "agentdash_native",
  supportsLocalAgentJwt: true,        // consumes ctx.authToken (per-run JWT)
  supportsInstructionsBundle: true,   // reuse AGENTS.md instructions like other local adapters
  requiresMaterializedRuntimeSkills: false,
  models,                             // from the gateway model routing table
  modelProfiles: [{ key: "cheap", ... }],
  sessionCodec,                       // own conversation-state id (resume)
  async execute(ctx) { /* see below */ },
  async testEnvironment(ctx) { /* gateway reachable + key present */ },
};
```

### `execute(ctx: AdapterExecutionContext)` — the loop
Inputs already provided by heartbeat (no new plumbing):
- `ctx.context.paperclipIssue` / `paperclipWakeComment` / `paperclipTaskMarkdown` — the task, handed in-band (`heartbeat.ts:5095-5118`). The agent does not need to fetch its own task.
- `ctx.authToken` — per-run JWT minted at `heartbeat.ts:5771`; accepted by `middleware/auth.ts:126-149` as `x-agent-key`/Bearer.
- `ctx.runId`, `ctx.agent`, `ctx.config` (model, instructions), `ctx.onLog`, `ctx.onMeta`, `ctx.runtime` (prior `sessionParams` for resume).

Flow:
1. Resolve model access via `resolveGatewayAccess({ companyId: ctx.agent.companyId, requestedModel: ctx.config.model, secretsSvc })`.
2. Build the system prompt from the managed AGENTS.md (`supportsInstructionsBundle`) + the in-band task context. **Drop the curl-instructions prompt** (`registry.ts:265-321`) — tools replace it.
3. Run an agent loop on the **Claude Agent SDK** (Anthropic protocol) or **OpenAI Agents SDK** (OpenAI protocol), per `GatewayModelAccess.protocol`, with the native tool set below.
4. Stream assistant/tool events via `ctx.onLog("stdout", ...)` (same ndjson the UI/run-log already consumes).
5. Enforce reliability budgets: max turns, wall-clock timeout (well under the 1800s that caused the runaway timeouts), per-tool-call cap. Return cleanly on budget exhaustion (no EPIPE — there's no child process).
6. Return `AdapterExecutionResult`: `{ exitCode: 0, timedOut, usage: {inputTokens, outputTokens, cachedInputTokens}, costUsd (from recordGatewayUsage), provider, model, sessionParams (own resume id), sessionDisplayId, summary, resultJson }` — same shape Hermes returns so heartbeat metering/auto-comment is unchanged.

### Native tool set (replaces curl-in-terminal)
Each tool calls `http://127.0.0.1:<port>/api/...` with headers `x-agent-key: ctx.authToken`, `X-Paperclip-Run-Id: ctx.runId`. Minimum viable set for the launch archetypes (from the audit):

| Tool | Endpoint |
|---|---|
| `list_issues` | `GET /api/companies/:companyId/issues?assigneeAgentId=&status=` |
| `get_issue` | `GET /api/issues/:id` |
| `update_issue` | `PATCH /api/issues/:id` (status, assignee) |
| `create_issue` | `POST /api/companies/:companyId/issues` (with `definitionOfDone`) |
| `post_comment` | `POST /api/issues/:id/comments` |
| `read_comment` | `GET /api/issues/:id/comments/:commentId` |
| `set_dod` | `PUT /api/companies/:companyId/issues/:issueId/dod` |
| `write_verdict` | verdict route (`routes/verdicts.ts`) for `in_review` → verdict |
| `create_interaction` | `POST /api/issues/:issueId/interactions` (suggest_tasks / ask_user_questions / request_confirmation) |
| `get_quota` | `GET /api/companies/:companyId/quota` |
| (+ connector sends: Slack/Gmail) | existing connector routes, only if the archetype needs them |

Notably **not** included (case-b coding only, out of scope for launch): file edit, shell, git/worktree, browser.

### `testEnvironment(ctx)` 
Return `pass` if the gateway is reachable and a key is present (cloud platform key or company BYO); `fail` otherwise. Far stronger than today's static checks, and cheap (a tiny gateway ping or a 1-token completion).

### Session / resume
Implement `sessionCodec` storing a conversation-state id in `sessionParams` (heartbeat persists/rehydrates it via `SESSIONED_LOCAL_ADAPTERS`-style handling). Trivial vs. the external-CLI resume dance.

### Registration
Add `"agentdash_native"` to `server/src/adapters/builtin-adapter-types.ts` and the registry map (`registry.ts:676-692`). Make it the **default** for new hires (`onboarding-orchestrator.ts:161`, `agent-creator-from-proposal.ts:26` currently default `claude_local`).

### Rollout (de-risked)
1. Land the adapter behind a flag; do not change the default yet.
2. Run it **side-by-side** with the working Hermes/claude_local on a throwaway/instance-B agent; compare success rate + cost.
3. Once `adapter_failed` < 5% and outputs match, flip the new-hire default to `agentdash_native`; keep Hermes/Claude/Codex as opt-in.

### Exit criteria
Native adapter is the default, zero-install, reliability ≥ current Hermes, with no fs/shell tools (live-source mutation impossible by construction).

---

## Build order
1. **Gateway MVP** (Part A) — nothing else works without model access; also retires cc-switch for the existing adapters.
2. **`agentdash_native` execute + tools** (Part B) behind a flag, pointing at the gateway.
3. **Side-by-side validation** on instance B → flip default.
4. (Parallel, Phase 0) preflight-probe PR to `main` + sandbox agent cwd.
