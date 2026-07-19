# Upstream cherry-pick recommendation — 2026-07-18

Triage of the `2026-07-18` digest (777 commits ahead, 187 "Worth a look").
Read against `doc/UPSTREAM-POLICY.md` (five-gate rubric + cherry-pick log).

**RECOMMENDATION ONLY. Nothing was cherry-picked, edited, or committed.**

Method: deeply evaluated the six score-5 rows plus the highest-value score-3/2
security drop-ins that target clearly-inherited subsystems (auth, heartbeat,
CLI, WS bus, issues, secrets, plugin SDK). For each serious candidate I read the
actual diff and grepped the **local** tree to confirm we have the buggy/vulnerable
pattern and that referenced symbols exist locally (gate 5).

**Repo facts that shape everything below:**
- Local migration head is `0090_trial_company_plan.sql` (tail is all AgentDash-specific:
  `0086_agent_runs` … `0090_trial_company_plan`). Upstream candidates carry migrations
  `0093` / `0101` / `0103`. **Any commit that adds a migration needs renumbering to the
  next local slot (`0091`+) and a regenerated snapshot/journal.** Flagged per-commit.
- AgentDash uses git worktrees (a `worktrees/` dir exists at repo root) — relevant to the
  CLI worktree fix.
- `server/src/agent-auth-jwt.ts` is byte-identical to the upstream pre-image of the JWT
  commit (verified), so that one applies clean.

---

## MUST-TAKE (security fix to inherited code, passes all five gates, drop-in)

### `70357b961f` — feat(security): per-company JWT signing keys for multi-tenant isolation (#5864)
- **Subsystem:** auth substrate (agent-key/JWT verification) — inherited. ✓ gate 1
- **Bounded:** 2 files (`server/src/agent-auth-jwt.ts` +62, test +121). ✓ gate 2
- **Why it matters / local evidence (gate 3):** Our local `agent-auth-jwt.ts` has the
  exact vulnerable pattern:
  - `createLocalAgentJwt` signs **every** company's token with the single instance-wide
    `config.secret` (`server/src/agent-auth-jwt.ts:90` → `signPayload(config.secret, signingInput)`).
  - `verifyLocalAgentJwt` verifies against that same master secret
    (`server/src/agent-auth-jwt.ts:105`).
  - TTL defaults to **48h** (`server/src/agent-auth-jwt.ts:33` → `60 * 60 * 48`).
  The fix derives a per-company key `HMAC-SHA256(master, "jwt:<companyId>")` and drops the
  default TTL to 1h, with a master-secret verification fallback so existing tokens don't
  break on deploy. AgentDash is company-scoped/multi-tenant, so a leaked master secret
  today mints tokens for *any* company — this is a real blast-radius reduction.
- **Feasibility:** drop-in. Both the source file **and** the test file are byte-identical to
  the upstream pre-image (verified via `git show <sha>^:<file>` diff) → clean `git cherry-pick`.
  No new imports (`createHmac` already imported locally). No migration.
- **Follow-on:** none required. (`57a7da81ee` below is an *optional* hardening that builds on
  this — see CONSIDER.)
- **Risk to flag:** the TTL 48h→1h default is a behavior change. If any AgentDash agent run
  can run >1h and relies on the run JWT staying valid for its whole duration, set
  `PAPERCLIP_AGENT_JWT_TTL_SECONDS` to preserve the old window. Verify our run lifetimes
  before landing; otherwise long runs could see mid-run 401s.

---

## SHOULD-TAKE (non-security inherited bug fixes, clean, we plausibly hit)

### `242a2c2f2b` — fix(cli): stop `worktree init --force` from wiping repo worktrees/ (#6240)
- **Subsystem:** CLI scaffolding — inherited. ✓
- **Why it matters / local evidence:** local `cli/src/commands/worktree.ts:1387-1389` has the
  exact data-loss code:
  ```
  if (opts.force) {
    rmSync(paths.repoConfigDir, { recursive: true, force: true });   // nukes <repo>/.paperclip/worktrees/
    rmSync(paths.instanceRoot, { recursive: true, force: true });
  ```
  `worktree init --force` recursively deletes the whole `repoConfigDir`, which contains
  `worktrees/` (every repo-managed checkout). We use worktrees (repo-root `worktrees/` dir),
  so this is a live foot-gun. Fix narrows the removal to `paths.configPath` + `paths.envPath`.
- **Feasibility:** drop-in. Both `paths.configPath` and `paths.envPath` exist locally
  (`worktree.ts:1381` and `:1417`). Context at 1387-1389 matches the upstream pre-image
  exactly. No migration.
- **Follow-on:** none.

### `e93d78b46c` — fix(server): harden live events upgrade sockets (#8383)
- **Subsystem:** WebSocket live-events bus — inherited. ✓
- **Why it matters / local evidence:** `server/src/realtime/live-events-ws.ts` exists locally
  and is **byte-identical to the upstream pre-image**. The bug: after a client disconnects
  during async WS-upgrade authorization, the server can still `write()`/`handleUpgrade()` on a
  destroyed socket; the resulting raw-socket `EPIPE`/`ECONNRESET` with no error listener can be
  **process-fatal**. Fix adds writable-state guards + a temporary socket error listener. This
  is prophylactic crash-hardening for a subsystem we run in production (reconnect churn is
  routine). Not a classic CVE, but a real availability fix.
- **Feasibility:** drop-in. Clean apply. No migration.
- **Follow-on:** none.

### `5d315ab778` — Defer same-issue forceFreshSession wakes into follow-up runs (#4080)
- **Subsystem:** heartbeat scheduler — inherited. ✓ (Digest scored this "5 / inherited+security",
  but the content is a scheduling **bug fix**, not a security fix — the score is a keyword
  false-positive. Placed here, not in MUST-TAKE.)
- **Why it matters / local evidence:** `forceFreshSession` is a live code path in our heartbeat
  (`server/src/services/heartbeat.ts:1498` and `:1573`). The bug: a `forceFreshSession: true`
  wake on the same agent/issue while a run is still `running` gets silently folded into the
  active run instead of starting a cold session — so "reset the session" is silently dropped.
  We use forceFreshSession, so we can plausibly hit this.
- **Feasibility:** drop-in-sized (2 files, heartbeat +25), **but heartbeat.ts is a conflict-prone,
  heavily-modified file** (policy lists ~9 AgentDash edits; local file is 7,944 lines vs upstream
  11,165). I verified all three hunk anchors exist locally with matching context:
  - new helper inserts between `describeSessionResetReason` (`:1570`) and `shouldAutoCheckoutIssueForWake` (`:1583`);
  - `mergeCoalescedContextSnapshot` present (`:1739`);
  - hunk 3 target `if (isSameExecutionAgent && !shouldQueueFollowupForRunningWake) {` matches
    **exactly** at `:7085-7090` (there's a second `shouldQueueFollowupForRunningWake` at `:7273`
    with different surrounding structure, so context should still disambiguate).
  Expect a likely-clean apply with **moderate** manual-conflict risk. No migration.
- **Follow-on:** none.

---

## CONSIDER / RISKY (valuable but needs a follow-on chain or partial conflict)

### `57a7da81ee` — [codex] Isolate run JWTs by control-plane instance (#9162)  *(security)*
- Extends the JWT hardening from `70357b961f` so a token minted by a worktree/fork instance
  (which deliberately shares the master secret) can't authenticate against the live plane —
  directly relevant because **we use worktrees**.
- **Why RISKY / the chain:**
  - **Hard dependency on `70357b961f`** — it patches `deriveCompanySigningKey`, the function
    that commit introduces. Cannot apply without it first.
  - Its pre-image (`7b3811943`) is a *post-70357* state with intermediate reformatting (e.g.
    `createLocalAgentJwt` signature spread across lines). Applying `70357` then jumping to
    `57a7` will likely need manual reconciliation of the intervening drift in this file.
  - New import `resolvePaperclipInstanceId` from `./home-paths.js` — **exists locally**
    (`server/src/home-paths.ts:21`), so that dependency is satisfied.
  - The instance-claim check is backward-compatible (legacy tokens without the claim still pass).
- **Recommendation:** take only after `70357b961f` lands and only if worktree-token isolation is
  a concern worth the manual reconcile. Chain: `70357b961f` → (reconcile intermediate drift) → `57a7da81ee`.

### `05bcd3ce84` — feat(security): plugin tables get company_id FK for tenant isolation (#5865)  *(security)*
- Genuine multi-tenant isolation fix for the **plugin SDK** (inherited; substrate for Track B
  "vibecoded apps"). Adds `company_id` FK to `plugin_entities/jobs/logs/webhooks`.
- **Why RISKY:**
  - Adds migration `0101_plugin_company_id_tenant_isolation.sql` — **our head is 0090**, so this
    needs renumbering to `0091` + regenerated snapshot/journal (the commit also rewrites the huge
    `meta/0090_snapshot.json`, which will not line up with our lineage).
  - Local plugin schema files exist but `plugin_entities.ts` has **no** `company_id` today, so the
    schema change is additive/applicable — but `plugin-registry.ts` (+50) and `protocol.ts` context
    must be reconciled against our version.
  - `needs-followon` heuristic + 528-line new test.
- **Recommendation:** worth doing as a bounded project (prophylactic tenant isolation before Track B
  ships) but budget for migration renumbering + registry reconcile. Not a drop-in.

### `fc95699fde` — fix(server): enforce agent secret binding sync across lifecycle flows (#8307)  *(security, score 5)*
- **Leaning SKIP.** Real security intent, but **fails gate 2 (bounded) and gate 4 (conflict-prone files):**
  1,004 insertions across 23 files, including migration `0103` (needs renumber), heavy edits to
  `server/src/services/agents.ts` (+130) and `heartbeat.ts` (+178) — both of which AgentDash has
  extended for CRM-linked agent lifecycle — plus 4 UI components. This is a broad lifecycle refactor,
  not a targeted fix; landing it would force redesign against our modified agent/heartbeat services.
  If we ever need it, treat as a scoped port, not a cherry-pick.

### `1f70fd9a22` — PAPA-430: workspace finalize gates + no-remote-git enforcement (#6969)  *(score 5)*
- **SKIP-leaning.** ~21k-line diff (bundles migration `0093` + full `0093_snapshot.json`), touches
  `heartbeat.ts` (+192), `issues.ts` (+149), `execution-workspace-policy.ts`, plus new CI workflow and
  scripts. Fails gate 2 (broad) and gate 4 (conflict-prone). The useful nugget (a `check-no-git-push`
  guard) isn't worth dragging the migration + heartbeat/issues churn.

---

## SKIP (bucketed)

**Already in the cherry-pick log — do NOT re-take:**
- `d58a862549` (coerce `anchor.createdAt` to Date, PRO-3144) — **already logged** in
  `doc/UPSTREAM-POLICY.md` (2026-06-03). The digest re-lists it because our cherry-pick got a new
  local SHA; the digest can't tell. **Flagged.** Its lineage relative `eb452fba30` ("Fix comment date
  binding regression") is the same already-handled fix family — also skip.

**Symbol-dependency dead-ends (gate 5) — referenced code absent locally:**
- `67f97e8fb0` (enforce read auth for single issue comments) — calls `assertIssueReadAllowed(req, res, issue)`,
  a helper that **does not exist in our `server/src/routes/issues.ts`** (grep: zero hits; introduced by an
  earlier upstream commit we never took). Also our single-comment route context doesn't match. Dead-end.
- `f90ea4dae4` (top-level secret ref binding sync) — patches `syncSecretRefsForTarget()` in `secrets.ts`,
  which **does not exist locally** (grep: zero hits; our `secrets.ts` is heavily diverged — its drizzle
  import is just `{ and, desc, eq }` vs upstream's 8-symbol import). The whole code path is absent. Dead-end.
- `a6b7b12fd7` (harden work timeline security filters) — target `server/src/services/work-timeline.ts`
  **does not exist locally**. AgentDash has no work-timeline service. Dead-end.

**AgentDash-owned / zero-upstream-value targets** (per policy "100% AgentDash" list) — the digest's
score-2 `other+security` UI rows (`8b04147ca4`, `02a4f52277`, `6f204605ad`, `5618ea91f6`, `903886bc79`,
`ef617bee5c`) and the many score-3 feature rows touch Sidebar/company-skills/starred-resources/release-gates,
i.e. wiring or systems we own or don't run. No fix for our code.

**Wiring-only / conflict-prone-only:** score-2 SHA/version rows (`16b95eece5`, `8516700217`, `6f204605ad`)
touch `version.ts`/`server-info.ts` build-metadata plumbing — low value, wiring.

**The remaining ~160 score-3 `needs-followon` rows** are bucketed without deep dives: the large majority are
either (a) heartbeat/execution-workspace evolution that references types/columns from intermediate upstream
commits we don't have (symbol chains — e.g. the `9xxx`-series recovery/continuation fixes from Jul 2026 that
sit atop months of heartbeat drift), (b) feature work on skills-store / annotations / sandbox-providers /
new adapters (not "targeted bug fix" — gate 2), or (c) migration-bearing commits that all need renumbering
off our `0090` head. None surfaced a bounded, high-value, low-dependency fix beyond those evaluated above.

---

## Ranked apply-order (MUST-TAKE + SHOULD-TAKE)

All four independent commits below carry **no migration** and don't depend on each other; order is by
value / cleanliness. Run the full gauntlet (`pnpm -r typecheck && pnpm test:run && pnpm build` + relevant E2E)
after each, and log each in `doc/UPSTREAM-POLICY.md`.

1. **`70357b961f`** — per-company JWT keys (MUST, security, clean). *Before landing: confirm no agent run
   needs a >1h JWT, or set `PAPERCLIP_AGENT_JWT_TTL_SECONDS`.*
2. **`242a2c2f2b`** — CLI worktree `--force` data-loss guard (SHOULD, clean, high value — we use worktrees).
3. **`e93d78b46c`** — WS upgrade-socket crash hardening (SHOULD, clean).
4. **`5d315ab778`** — heartbeat forceFreshSession deferral (SHOULD; land last of the four — heartbeat is the
   conflict-prone file, so apply it when the tree is otherwise settled; expect possible manual hunk fix-up).

**Optional chained follow-on (CONSIDER):**
5. **`57a7da81ee`** — run-JWT per-instance isolation. **Only after #1**, and only after reconciling the
   intermediate `agent-auth-jwt.ts` drift by hand. `resolvePaperclipInstanceId` dependency is satisfied locally.

**Migration renumbering flags:** none of the ranked 1–5 add a migration. The two CONSIDER items that *do*
(`05bcd3ce84` → `0101`, `fc95699fde` → `0103`) must be renumbered to the next free local slot (`0091`+) with a
regenerated Drizzle snapshot/journal — do **not** cherry-pick their migration files as-authored.
