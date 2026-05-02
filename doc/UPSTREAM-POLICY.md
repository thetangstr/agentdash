# Upstream Policy — Paperclip Fork Relationship

**Version:** 1.0
**Date:** 2026-04-17
**Status:** Active

---

## TL;DR

AgentDash forked from [Paperclip](https://github.com/paperclipai/paperclip) in early 2026 and diverged fast. As of this document, we are **339 commits behind upstream** and **27 of 73 migrations are AgentDash-specific (37%)**. Every conflict-prone file in the fork has AgentDash modifications.

**Policy:** Upstream is a **read-only reference**, not a merge source. We cherry-pick individual commits only when there's a specific reason. We do not do continuous or scheduled upstream syncs.

The `upstream` remote stays configured. `scripts/archive/upstream-sync.sh` is preserved for ad-hoc use but is not part of any routine workflow.

---

## Why "reference, don't merge"

We evaluated three options on 2026-04-17:

| Option | Continuous merge | Reference + cherry-pick | Clean break |
|---|---|---|---|
| Cost per upstream release | 1–2 engineer days | 0 unless we want something specific | 0 |
| Risk of breaking shipped AgentDash features | High (must re-verify every sync) | Low (only the cherry-picked commit touches code) | None |
| Access to upstream bug fixes | Automatic | On-demand | Manual patching required |
| Compatibility tax on new AgentDash design | High (must avoid upstream conflicts) | None | None |

We chose the middle option because we still benefit from *specific* upstream fixes (adapter bug fixes, heartbeat tweaks) but we no longer pay the continuous-merge tax or let upstream shape our roadmap.

**What triggered the change:** 339-commit backlog, all conflict-prone core files modified, 37% of migrations owned by us, and no sync in recent history. The fork is a codebase, not a branch.

---

## What we still genuinely inherit from Paperclip

Use this list when deciding whether an upstream commit is worth cherry-picking. Fixes to anything in this list may be worth grabbing:

### Core framework (inherited, lightly extended)
- **Heartbeat scheduler** (`server/src/services/heartbeat.ts`) — core tick/dispatch loop. We've extended with ~9 AgentDash edits (model routing, pipeline integration, kill-switch checks) but the scheduling logic is Paperclip.
- **Agent adapter framework** — 11 adapters: Claude (local + API), Codex, Cursor, Gemini, OpenCode, Pi, OpenClaw, Hermes, Process, HTTP. The registry and per-adapter dispatch is Paperclip; we added `claude_api`.
- **Auth substrate** — better-auth integration, actor middleware (`req.actor` with board/agent/none types), JWT, agent-key verification.
- **Issues / projects / comments / approvals core** — schema + services. We've added CRM-linked lifecycle, action proposals, and heartbeat integration on top.
- **WebSocket live-events bus** — real-time updates for comments, runs, status changes.
- **CLI command scaffolding** (Commander + esbuild). We rebranded `paperclipai` → `agentdash`.
- **Embedded Postgres dev runtime** (`~/.paperclip/instances/...` still on disk; rename is cosmetic).
- **Plugin SDK + JSON-RPC worker runtime** (`packages/plugins/sdk`) — the sandbox substrate Track B citizen-dev apps will run on.
- **Instance settings, sidebar badges, command palette.**

### What an upstream commit to one of the above might look like
- "Fix Gemini adapter streaming timeout"
- "Fix race in heartbeat when same task is claimed twice"
- "Fix JWT verification under clock skew"
- "Better-auth upgrade for new session format"
- "Plugin worker stdin handling on Windows"

These are the commits worth a 30-minute cherry-pick evaluation.

---

## What is 100% AgentDash (zero upstream value)

These systems do not exist in Paperclip. An upstream commit will never be relevant here, because there is nothing upstream to fix:

- **Entitlements & billing** — `plans`, `company_plan`, `requireTier`, Billing page, UpgradeDialog, BillingProvider (Stripe-ready stub).
- **Pipeline Orchestrator** — DAG runner, self-heal, conditional routing, fan-in/fan-out, HITL gates, wizard, run detail, stage executions.
- **Action Proposals + Policy Engine** — 5 policy types (resource_access, action_limit, data_boundary, rate_limit, blast_radius) with hot-path evaluation.
- **CRM stack** — accounts, contacts, deals, leads, partners, activities, Customer 360, Kanban, Deal detail, Account detail, Lead convert.
- **HubSpot bidirectional sync** — webhook receiver (HMAC-verified), hourly scheduler, Settings UI.
- **Operator Feed + Inbox** — aggregation, priority ranking.
- **Onboarding wizard** — 5-step flow, context extraction, LLM team suggestion.
- **Smart Model Routing** — `modelTier`, `maxToolCalls`, `verification` on `skill_versions`; pipeline-stage override.
- **Kill Switch** — company-scoped halt, per-agent halt, audit trail, kill_switch pause reason.
- **AutoResearch** — cycles, hypotheses, experiments, measurements, evaluations, detail pages.
- **Skills Registry review workflow** — draft → in_review → approved → published → deprecated, version diff, dependencies, usage analytics.
- **Budget forecasting + capacity dashboard** — burn rate, days-until-exhaustion, multi-resource tracking, allocations.
- **Assess mode** — 6-phase flow, AssessPage, history.
- **Assistant chat panel** — conversations, internal toolkit, interview engine.
- **Track B "vibecoded apps"** (planned, PRD §3 CUJ-16–20) — citizen-dev authoring, governance review, org catalog.

---

## Cherry-pick rubric

When is an upstream commit worth the evaluation cost? Check all four gates:

1. **Target is in the "still inherited" list above.** If the commit touches CRM, pipelines, entitlements, model routing, etc., stop — upstream has no fix for our code.
2. **Fix is specific and bounded.** "Fix streaming timeout in Gemini adapter" passes. "Refactor adapter registry" fails — too broad.
3. **We have a concrete reason to care.** Either we've hit the bug in prod, we're about to touch that subsystem and want the fix in first, or it closes a CVE/security finding.
4. **The commit does not touch AgentDash-modified files in a way that requires redesign.** Check against the conflict-prone list below.

If all four pass → `git cherry-pick <sha>`, run the full verification gauntlet (`pnpm -r typecheck && pnpm test:run && pnpm build` plus relevant E2E), commit as a single atomic change with the upstream SHA in the message.

If any gate fails → skip it; leave a note in this doc's "considered-and-rejected" section (future work) if it's non-obvious why.

### Conflict-prone files (every upstream merge hits these)

These files have AgentDash-specific modifications that will conflict with most upstream changes:

- `ui/src/App.tsx` — AgentDash routes
- `ui/src/components/Sidebar.tsx` — AgentDash nav items
- `ui/src/components/Layout.tsx` — AgentDash layout additions
- `server/src/app.ts` — AgentDash route wiring
- `server/src/index.ts` — AgentDash startup wiring
- `packages/shared/src/constants.ts` — AgentDash status enums
- `packages/shared/src/index.ts` — AgentDash exports
- `packages/db/src/schema/index.ts` — AgentDash table exports
- `README.md` — AgentDash branding
- `ui/index.html` — AgentDash title/meta

A commit that only edits these files is almost never worth cherry-picking; the value lives in the business logic, not the wiring.

---

## Operational procedure

### Normal work — do nothing

Don't run `git fetch upstream`. Don't run any sync script. Don't read upstream PRs looking for things to merge. Work on AgentDash.

### Weekly check (sanctioned)

`/upstream-digest` (skill in `.claude/commands/upstream-digest.md`, backed by `scripts/upstream-digest.sh`) fetches upstream and writes a classified report to `doc/upstream-digests/YYYY-MM-DD.md`. It is **read-only** — never merges, never cherry-picks. The report buckets every new upstream commit into:
- **Worth a look** — touches files in the "still inherited" list (security-keyword commits get a +2 boost on top, so the highest-scoring rows surface first).
- **Skip — agentdash-owned / conflict-only / other** — buckets we ignore.

Run it manually, or schedule it weekly via `/schedule` (Claude Code's remote-agent scheduler). The report is the receipt — if nothing in the "Worth a look" table passes the four-gate rubric below, you're done. Cherry-picks remain ad-hoc and human-driven; the digest never merges anything.

### Ad-hoc cherry-pick (rare)

```sh
# Only when you have a specific reason (per the rubric above).
git fetch upstream
git log --oneline upstream/main -- <path>   # find the commit
git cherry-pick <sha>                        # apply it
pnpm -r typecheck && pnpm test:run && pnpm build
# Run relevant E2E (e.g., bash scripts/qa/run-phase1-cujs.sh for UI changes).
git commit --amend -m "chore(upstream): cherry-pick <sha> — <short reason>"
```

Document the cherry-pick in `doc/UPSTREAM-POLICY.md` under a "Cherry-pick log" section (create if absent) with SHA, date, reason, and verification results.

### Reconsidering this policy

Revisit if any of the following become true:
- Paperclip publishes a major architectural shift we want to adopt (e.g., a new runtime or storage layer).
- We are starting a ground-up rewrite of one of the "still inherited" subsystems and want the latest upstream as a starting point.
- Upstream publishes a security CVE touching code we inherit.

Until then, keep calm and fork on.

---

## Cherry-pick log

_No cherry-picks yet under this policy (as of 2026-04-17). Record future cherry-picks here._

| Date | Upstream SHA | Reason | Verification | Author |
|------|--------------|--------|--------------|--------|
| — | — | — | — | — |
