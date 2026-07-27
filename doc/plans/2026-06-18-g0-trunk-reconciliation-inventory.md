# G0 Trunk Reconciliation Inventory — 2026-06-18

**Read-only inventory.** No source changed; this doc is the only write. Scope: make `main`
a superset of the Mac-mini line's genuinely-useful features, drop drift `main` has superseded,
then redeploy the mini *from* `main` and retire `ab48dc14`.

- **Trunk (canonical):** `origin/main` @ `dadf59dff` (holds the billing substrate: `cost_events`,
  `costService`, Stripe, run-quota).
- **Mini live SHA:** `ab48dc14f` (lineage `feat/cos-minimax-adapter-deploy` → branch
  `origin/age/mini-fre-cherrypick`, whose HEAD *is* `ab48dc14f`).
- **Merge-base(`ab48dc14`, `main`):** `55ccc069c`.

## TL;DR — the "9k lines / 106 files" was mostly a squash-merge artifact

The plan-time figure (`git diff --stat 55ccc069c..ab48dc14` = 125 files / +10,161) is misleading.
`main` merged the same work as **squashed PRs** (#377 launch/harness, #386/#387 FRE) while the
mini carries it as **unsquashed commits**. Diffing by *file content* (`git diff main:<f> ab48dc14:<f>`)
shows the harness cluster and FRE cluster are **byte-identical** in `main` and the mini.

**The real mini-only delta at `ab48dc14` is two migration files.** Everything else genuinely
new on the mini lives on two branches built *on top of* `ab48dc14`:
`origin/age/atlas-wire-mini` (newsroom) and `origin/age/mcp-onboard-mini` (provision-user).

## Divergence direction & lineage (verified)

| Branch | HEAD | Built on | Commits past merge-base | In `main`? |
|---|---|---|---|---|
| `mini-fre-cherrypick` | `ab48dc14f` | merge-base | 11 | content already in `main` (see below) |
| `atlas-wire-mini` | `3d75f69a7` | **`ab48dc14`** | 24 | newsroom NOT in `main` |
| `mcp-onboard-mini` | `53321c5e6` | **`ab48dc14`** (superset of atlas) | 26 | provision-user NOT in `main` |
| `feat/cos-minimax-adapter-deploy` | `616617e1e` | `8006d6b9d` | 9 | **identical, already in `main`** |

`main` gained **25 commits** since the merge-base, including the billing substrate (#384/#389/#393),
connectors (#383/#388/#390), MCP onboarding tools (#398), SKUs G1–G5 (#399), security fixes
(#406/#407/#408/#401), and the squashed launch/harness PR (#377). Several of these **supersede**
mini work (see ALREADY-IN-MAIN + DROP rows).

---

## Cluster inventory

| # | Cluster | Subsystem | Files | One-line | Classification | Confidence |
|---|---|---|---|---|---|---|
| 1 | Mac-mini launch evidence + harness quality | `scripts/*`, `scripts/ci/*`, `scripts/deploy/*`, harness services/UI, `.github/`, `docker/launchd/` | ~70 | Launch sign-off gates, harness preflight/readiness, run-failure classifier, IssueRunLedger, OTA/launchd deploy scripts | **ALREADY-IN-MAIN** | high |
| 2 | FRE: invite auto-approve + self-serve bootstrap | `packages/db/schema/invites.ts`, `services/invites.ts`, `routes/companies.ts`, `CompanyInvites.tsx` | ~10 | Invite auto-approve toggle (default on) + first-user bootstrap | **ALREADY-IN-MAIN** | high |
| 3 | Migration `0083_normalize_legacy_dod_arrays` | `packages/db/migrations` | 1 | Normalize legacy DoD arrays | **ALREADY-IN-MAIN** (renumbered `0085` in `main`, byte-identical) | high |
| 4 | Migration `0084_invite_auto_approve` (mini idempotent variant) | `packages/db/migrations` | 1 | Mini-local idempotent `auto_approve` column add | **DROP** (superseded; collides) | high |
| 5 | MiniMax CoS adapter | `services/minimax-llm.ts`, `services/dispatch-llm.ts` | 4 | Anthropic-compatible MiniMax adapter for CoS dispatch | **ALREADY-IN-MAIN** (`minimax-llm.ts` byte-identical; `main` dispatch-llm is newer) | high |
| 6 | Atlas Wire newsroom | `server/src/services/news-ingest/*`, `schema/news_events.ts`, `0085_news_events.sql`, `deploy/launchd/atlas-wire-*` | ~35 | RSS→extract→hash→dedup→write→Clockchain-attest world-events pipeline + launchd schedulers | **DEMO-CRITICAL / PORT** | high |
| 7 | `provision-user` onboarding endpoint | `routes/provision-user.ts`, `app.ts`, `onboarding-orchestrator.ts` | ~6 | `POST /api/onboarding/provision-user` (create user + bootstrap workspace) | **DROP** (superseded by `main` MCP tools) | med |

**Cluster count: 7.** PORT/DEMO-CRITICAL: **1** (#6). DROP: **2** (#4, #7).
ALREADY-IN-MAIN: **4** (#1, #2, #3, #5).

### Evidence per cluster

**#1 ALREADY-IN-MAIN.** All 8 harness/launch commits (`de02d8bc2`…`8006d6b9d`) landed in `main`
squashed as #377 `cc0acdf01`. Byte-for-byte file diff `main` vs `ab48dc14` = **0 lines** for
`agent-harness-smoke.mjs`, `msp-mac-mini-readiness.mjs`, `agentdash-ota-update.mjs`,
`agent-harness-preflight-readiness.ts`, `agent-run-failure-classifier.ts`, `IssueRunLedger.tsx`,
`check-launch-signoff.mjs`, `check-pr-process.mjs`, `agentdash-mac-mini-source-launchd.mjs`.
Drop from the mini line — `main` already has it.

**#2 ALREADY-IN-MAIN.** Mini `#386`/`#387` = `main` `8ce002ef9`/`3784a0e58`. `invites.ts`,
`schema/invites.ts`, `CompanyInvites.tsx`, `companies.ts`, `onboarding-v2.ts` diff `main` vs mini = **0 lines**.
(Note the known P1 onboarding-invite `autoApprove` thread gap is a `main` issue, not a port.)

**#3 ALREADY-IN-MAIN.** Mini `0083_normalize_legacy_dod_arrays.sql` ≡ `main`
`0085_normalize_legacy_dod_arrays.sql` (content diff = 0 lines). `main` renumbered it to land
after its own billing migrations (`0084` invite, `0086`/`0087` agent_runs). No action.

**#4 DROP.** Mini `0084_invite_auto_approve.sql` is a 13-line idempotent re-statement of the
auto-approve column for *that instance's* DB (`ab48dc14`'s "chore(mini)" commit). `main` already
has its own `0084_invite_auto_approve.sql`. The mini variant exists only because the mini's DB had
drifted; it has no place on trunk. Drop.

**#5 ALREADY-IN-MAIN.** `minimax-llm.ts` is byte-identical (`main` vs `cos-minimax`, 0-line diff).
`dispatch-llm.ts` differs by 128 lines — `main`'s is the **newer** version (carries the SKU/openai-compatible
adapter work from #399). Take `main`'s. No port.

**#6 DEMO-CRITICAL / PORT.** Self-contained `news-ingest/` service tree (feed-parser, extractor
[MiniMax + heuristic fallback], event-hash, dedup writer, per-beat ingest orchestrator with caps +
failure isolation, **Clockchain MCP client**, active-agent safety guard, digest), `news_events`
table + `0085_news_events.sql`, run scripts, and launchd schedulers. **None of it is in `main`.**
This is what powers the Atlas Wire newsroom logging ~300 events/day to Clockchain. Effort: low-medium
(additive, isolated under `server/src/services/news-ingest/` and `deploy/launchd/`). Risk: **migration
number collision** — atlas's `0085_news_events.sql` clashes with `main`'s `0085_normalize_legacy_dod_arrays.sql`;
must renumber to the next free slot (`main` is at `0087`, so `0088_news_events.sql`) and regenerate
`_journal.json` (`pnpm db:generate` reconciliation). Note: code is also tracked on `feat/atlas-wire-newsroom`.

**#7 DROP (med confidence).** `provision-user` adds `POST /api/onboarding/provision-user`. `main` #398
shipped the MCP server with `agentdashBootstrapWorkspace` ("provision a workspace for the authenticated
user — creates the company, a Chief of Staff agent, and the opening conversation") + `agentdashCreateCompany`.
That is the trunk-blessed provisioning path and supersedes the bespoke REST endpoint. Recommend drop.
Med confidence: confirm no live mini integration calls the REST path before deleting.

### Demo dependency analysis (what breaks if dropped)

- **Meridian Pay × Clockchain (`:3100` on mini):** **NOT code-dependent on the mini line.** The demo is
  **data-seeded** (company, 7 agents, ~41 tasks, backdated history) on the mini's DB, and the agents call
  the **hosted Clockchain MCP** (`mcp.clockchain.network`) themselves at runtime — no repo `clockchain`
  code. Its only hard code dependency was the `x-agent-key` auth fix, **now in `main` (#401 `c16e94521`)**,
  which lets the mini drop its working-tree patch. **Meridian survives a redeploy from `main` as-is**,
  provided the seeded company/agent data is preserved in the DB (the seed lives in data, not code).
- **Atlas Wire newsroom:** **code-dependent on cluster #6.** If #6 is dropped, the ingest cron, the
  `news_events` writes, and the Clockchain attestations stop — the newsroom demo dies. #6 **must** port.

---

## Cutover + rollback runbook

### Pre-flight (before touching the mini)

1. **Pause all agents on the mini.** The heartbeat adapter-spawn EPIPE crash-loop (2026-06-11 incident)
   takes down the whole server if active agents/in-progress issues exist on boot. Agents MUST stay paused
   for the entire cutover. Verify 0 active agents and 0 `in_progress` issues via the API before redeploy.
2. **Full DB backup of the mini** (`pg_dump`, using the compatible binary per `c4f73b41d`). The Meridian
   seed and Atlas Wire `news_events` history live in data — protect them.
3. Tag the current mini SHA for rollback: it is `ab48dc14f` (no new tag needed; pin it).

### Port order (on `main`, via MAW, each with full gauntlet + cherry-pick-log entry)

1. **#6 Atlas Wire newsroom — the only real port.** Bring `server/src/services/news-ingest/**`,
   `packages/db/src/schema/news_events.ts`, the run scripts, and `deploy/launchd/atlas-wire-*` onto `main`.
   **Renumber** `0085_news_events.sql` → `0088_news_events.sql`; regenerate `_journal.json`
   (`pnpm db:generate`). Export `news_events` from `packages/db/src/schema/index.ts`.
2. Drop clusters **#4** and **#7** (no-op — they simply don't come along).
3. Confirm clusters **#1, #2, #3, #5** require nothing (already in `main`).
4. Verify on `main`: `pnpm -r typecheck && pnpm test:run && pnpm build`.

### Redeploy mini from `main` + verification

5. Deploy `main` to the mini (source-update launchd path, `agentdash-mac-mini-source-launchd.mjs`),
   apply pending migrations (`pnpm db:migrate`) against the **restored** mini DB so Meridian + Atlas data persist.
6. Health: `GET /api/health` green; server stays up (no EPIPE loop) with agents **still paused**.
7. **Meridian verification:** company loads at `:3100`; goal tree + 7 agents + ~41 tasks intact; open a
   done payment task → Clockchain receipt comment present; re-verify one ledgerId on-chain
   (`mcp.clockchain.network`). The `x-agent-key` path now native (drop the working-tree patch).
8. **Atlas Wire verification:** run one ingest cycle manually (`server/scripts/news-ingest/run-cycle.ts`)
   → confirms a `news_events` row written + a real Clockchain receipt; launchd schedulers loaded.
9. Only after both demos verify, **retire `ab48dc14`** (and the `age/*` mini branches) — archive, don't delete.

### Rollback

- If the mini regresses (demo breaks, or any EPIPE/crash-loop symptom): stop the launchd service,
  re-pin/redeploy `ab48dc14f`, restore the pre-cutover `pg_dump`, keep agents paused, re-verify health.
  The mini is the on-prem *reference* install, not the cloud SKU — a clean rollback to `ab48dc14` is
  always acceptable as the safe state.

---

## DECISIONS — resolved 2026-06-18

1. **Cluster #7 (`provision-user`) — DROP, confirmed.** `git grep` across all of `origin/main`
   found **zero callers** of `provision-user` / `provisionUser` outside the route file itself. The
   trunk-blessed path is `main`'s MCP `agentdashBootstrapWorkspace`/`agentdashCreateCompany` (#398).
   Dropped (no-op; it simply doesn't come along).
2. **Cluster #6 (Atlas Wire) — KEEP AS DEPLOY OVERLAY, not ported into trunk.** Owner decision
   2026-06-18: Atlas Wire is a showcase/demo, not product. The product trunk (`main`) stays free of
   newsroom code. Instead, branch `age/atlas-wire-overlay` = `main` + the 8 newsroom commits (migration
   renumbered to `0088_news_events.sql`) becomes the branch the mini deploys. G0's "one canonical trunk"
   is satisfied: `main` is canonical; the mini runs `main` + a thin, clearly-scoped overlay.

## STILL NEEDED FROM HUMAN

1. **Cutover window.** Redeploying the mini interrupts the Meridian/Atlas demos and requires agents
   paused throughout. **When is a safe maintenance window** (no scheduled demo, Atlas ingest cron paused)?
   This is the only remaining gate — the overlay branch + drops are prepared in code ahead of time.

## Revised G0 = three steps

1. ✅/⏳ Build `age/atlas-wire-overlay` (`main` + 8 commits, migration → `0088`, gauntlet green) — in progress.
2. Drop clusters #4 + #7 — no-op (they don't come along; #7 caller-free, confirmed).
3. Windowed redeploy: mini checks out `age/atlas-wire-overlay`, DB preserved, agents paused; verify
   Meridian + Atlas per the runbook above; then retire `ab48dc14` + `age/*` mini branches (archive).
