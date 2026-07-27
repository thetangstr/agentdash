# G0 Mini Cutover Runbook — Two-Instance Aware — 2026-06-18

Supersedes the cutover section of `2026-06-18-g0-trunk-reconciliation-inventory.md`, which only
accounted for the demo instance. The mini runs **two instances on one shared embedded PG cluster**,
and the work-company instance carries unpaused active agents — both materially change the procedure.

## Live state snapshot (recon 2026-06-18, read-only)

| Fact | Value |
|---|---|
| Checkout dir (shared by BOTH instances) | `/Users/maxiaoer/workspace/agentdash_msp_launch` |
| **Current live SHA** | `53321c5e6` (`age/mcp-onboard-mini` — ab48dc14 + atlas-wire + provision-user) |
| Rollback target | `53321c5e6` (NOT `ab48dc14` — the old memory was stale) |
| **Deploy target** | `age/atlas-wire-overlay` @ `d99a45e1e` (= `main` + Atlas Wire; drops provision-user #7, verified caller-free) |
| Instance A | launchd `ai.agentdash.agent`, `:3100`, DB `paperclip` (193 MB), PUBLIC funnel — Atlas Wire + Meridian demos |
| Instance B | launchd `com.agentdash.instance-b`, `:3200`, DB `paperclip_work` (181 MB), PRIVATE — **8 real work companies** |
| Shared-cluster hazard | Both DBs live in A's embedded PG (`127.0.0.1:54329`). If A's server stops, B loses its DB. |
| SSH | `maxiaoer@192.168.86.48` (key auth works) / tailnet `100.71.225.125` |

### Agent state — the crash-loop hazard
- **Instance A:** 26 agents, **all paused** ✅. Issues: 2 `in_progress`, 2 `in_review` (verify no checkout-held runs).
- **Instance B:** **21 `idle` + 10 `error` + 4 `terminated` + 1 `paused`.** The **21 idle agents are ACTIVE** — on restart the heartbeat will attempt to spawn them → EPIPE adapter-spawn crash-loop (the 2026-06-11 incident). **All must be paused before any restart of B.**

### Tooling facts that shape the steps
- `agentdash-source-update.sh <sha>`: backs up **only DB A** (`paperclip`) → `git fetch --all` → `git checkout --detach <sha>` (**no stash**) → `pnpm install --frozen-lockfile` → build → write `AGENTDASH_SOURCE_SHA` → kickstart **`ai.agentdash.agent` only**.
- ⚠️ It does **not** back up `paperclip_work`, does **not** stash, and does **not** restart Instance B. All three must be handled manually.
- Working tree is **dirty** (Fantasy WIP: modified `app.ts`/`auth.ts`/`routes/index.ts` + untracked `fantasy.*`). `git checkout --detach` will fail until stashed.
- Overlay deploys via `--frozen-lockfile`, so its committed lockfile must match — it does (overlay verified typecheck+build green 2026-06-18).

---

## Phase 1 — Pre-flight (non-destructive; can run before the window)

1. **Pause every active agent on BOTH instances.** Critical for B (21 idle + 10 error). Prefer the API/admin pause; SQL fallback (verify column names first):
   `UPDATE agents SET status='paused' WHERE status IN ('idle','error');` on **both** `paperclip` and `paperclip_work`. Re-verify 0 non-paused agents on each.
2. **Pause Atlas schedulers:** `launchctl bootout gui/$(id -u)/com.agentdash.atlaswire.ingest` and `.digest` (or unload the plists). Confirm no ingest cycle is mid-run.
3. **Back up BOTH DBs explicitly** (default deploy misses B):
   `PGPASSWORD=paperclip /opt/homebrew/opt/postgresql@18/bin/pg_dump -h 127.0.0.1 -p 54329 -U paperclip paperclip -Fc > ~/predeploy-A-<ts>.dump`
   `… paperclip_work -Fc > ~/predeploy-B-<ts>.dump`
   Verify both dump sizes are sane (~tens of MB+).
4. **Stash the Fantasy WIP:** `git -C <checkout> stash -u -m "pre-g0-cutover-<ts>"` so the detach checkout succeeds. (Note: prior Fantasy stashes exist at `stash@{0}/{1}` — do not drop them.)
5. Confirm `age/atlas-wire-overlay` @ `d99a45e1e` is on origin (it is) so `git fetch --all` will see it.

## Phase 2 — Deploy (the downtime window; affects BOTH instances)

6. Run `/Users/maxiaoer/.agentdash/bin/agentdash-source-update.sh d99a45e1e`. This backs up A again, fetches, checks out the overlay, installs, builds, writes SOURCE_SHA, and kickstarts **Instance A**. A boots → migrations apply to `paperclip` (includes the new `0088_news_events.sql`).
7. **Restart Instance B manually:** `launchctl kickstart -k gui/$(id -u)/com.agentdash.instance-b`. B boots on the same new code → migrations apply to `paperclip_work`.
8. Watch both for the EPIPE crash-loop. With all agents paused (Phase 1), neither should spawn adapters. If either flaps, go to Rollback.

## Phase 3 — Verify (before declaring success)

9. Health: `GET :3100/api/health` and `GET :3200/api/health` both `ok`; both processes stable >2 min.
10. **Instance A / demos:** Meridian company loads (goal tree + 7 agents + ~41 tasks); open a done payment task → Clockchain receipt present; re-verify one ledgerId on-chain. Atlas Wire: run one ingest cycle manually → confirms a `news_events` row + a real Clockchain receipt.
11. **Instance B / work companies:** all 8 companies load at `:3200`; spot-check issue lists + agent rosters intact; no data loss vs the pre-deploy `paperclip_work` dump.
12. Re-enable Atlas schedulers (step 2 reversed) only if Atlas verified.

## Phase 4 — Settle

13. **Decide unpause policy** (see decision below). Default: leave B's agents paused (they were idle/error, not actively working) until you choose to resume work. Demos stay paused per standing safety rule.
14. Retire `age/mcp-onboard-mini` / `age/atlas-wire-mini` / `feat/cos-minimax-adapter-deploy` branches — archive, don't delete. The mini now tracks `age/atlas-wire-overlay`.

## Rollback (any failure in Phase 2–3)

- `git -C <checkout> checkout --detach 53321c5e6` → `pnpm install --frozen-lockfile` → build → kickstart `ai.agentdash.agent` AND `com.agentdash.instance-b`.
- If data looks wrong, restore: `pg_restore --clean --if-exists -d paperclip ~/predeploy-A-<ts>.dump` and `… -d paperclip_work ~/predeploy-B-<ts>.dump`.
- Keep all agents paused. Re-verify both health endpoints. `53321c5e6` is the known-good safe state.

---

## DECISIONS STILL NEEDED FROM HUMAN

1. **Cutover window.** Phase 2 takes both instances down for ~5–15 min (install + build + boot). Demos *and* the 8 work companies are unavailable during it. When is clear?
2. **Unpause policy for Instance B after cutover.** B had 21 idle + 10 error agents. Leave them paused (recommended — resume deliberately later) or attempt to resume the idle ones? The error ones should stay paused pending triage regardless.
3. **Who runs Phase 2.** I have SSH (`maxiaoer`) and can drive the whole thing, OR hand you the exact commands to run yourself. Phase 1 (pre-flight) and Phase 3 (verify) I can do live and report before/after the irreversible step.
