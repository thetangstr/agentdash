# Launch Readiness Review & Plan — 2026-06-11

Full-codebase review (server, UI/onboarding, security, upstream Paperclip delta, launch ops, open-PR triage) run 2026-06-11 on `main` @ `990321f2d`. Baseline: `pnpm -r typecheck && pnpm test:run && pnpm build` all pass on main.

## Verdict

Main is healthy and type/test/build-green, but **not launch-ready**. Two critical server bugs, one privilege-escalation gap, an unenforced billing quota, the G0 trunk/mini divergence, and human-gated Stripe/domain setup stand between here and launch.

---

## Progress update — 2026-06-18

Worked the P0 code blockers. All merges admin-bypassed only the known `e2e` Playwright-install infra flake; `verify` (typecheck+test+build), `policy`, and `dependency-audit` were green on every merge. Mac mini left untouched (still pinned at `ab48dc14` for the Meridian demo / G0).

**Merged to `main`:**
- **P0.4** — run-quota enforcement gate (#393)
- **P0.3** — Stripe `current_period_end` read from subscription item + pinned `apiVersion` (#406)
- **P0.1 + P0.2** — Slack signature fail-closed + `express.urlencoded` body parser (#407)
- **P0.5** — invite role-ceiling, invite-create + join-approve paths (#408)
- Enablers: release-workflow `main` targeting (#397); `x-agent-key` auth (#401, lets the mini drop its working-tree patch — partial P0.7)

**Open, awaiting normal review:**
- **P0.6** — dep CVE bumps (drizzle 0.38→0.45 et al.) + blocking `pnpm audit` CI gate (#410, on `chore/refresh-lockfile` to satisfy the lockfile guard). Surfaced + fixed a latent bug: drizzle 0.45 wraps driver errors so 9 `err.code === "23505"` unique-violation checks silently broke; added a shared unwrap helper + test. Audit went 1 critical + 21 high → 0/0.

**Still open from P0:** P0.7 (G0 trunk reconciliation — mini divergence) and P0.8 (human-gated: Stripe meter G4, domain/cert + preflight G5, OpenRouter/Fireworks key G1, 22 `TODO_SET_*` in `admin.md`). P1/P2 untouched.

**CI gap noted for follow-up:** real dependency-version bumps have no clean normal-branch path — `policy` forbids committed lockfiles but `verify` needs `--frozen-lockfile` to match. Consider teaching the guard to allow lockfile changes that accompany `package.json` dependency changes.

---

## P0 — Launch blockers (fix before any paying customer)

### P0.1 Slack webhook signature verification fails open
`server/src/routes/slack-connector.ts:86,155` — if `SLACK_SIGNING_SECRET` is unset, ALL signature checks are skipped; anyone can POST forged events/interactions. Fix: fail closed with 503 (mirror the Stripe webhook guard at `billing.ts:200`).

### P0.2 Slack interactions endpoint is dead — no urlencoded body parser
`server/src/app.ts:171` registers only `express.json` with the rawBody verify hook. Slack sends interactions as `application/x-www-form-urlencoded` → `req.body.payload` and `rawBody` are undefined → every legitimate interaction 401s. Fix: add `express.urlencoded({ extended: true, verify: captureRawBody })`.

### P0.3 Stripe `current_period_end` read from wrong object + unpinned API version
`server/src/services/entitlement-sync.ts:72` reads `sub.current_period_end`; on Stripe API ≥ 2025-03-31 it lives on the subscription item → `planPeriodEnd` becomes epoch-1970 and corrupts the quota billing window (`quota.ts:33-48`). `new Stripe(stripeKey)` at `app.ts:305` has no pinned `apiVersion`. Fix: pin apiVersion; read `sub.items.data[0].current_period_end` with fallback.

### P0.4 Agent-run quota computed but never enforced
`server/src/services/quota.ts` has no enforcement caller; Free/Pro companies can run unlimited agent-runs. **PR #393 (AGE-121) is exactly this gate and is MERGEABLE** — only the 'Model Used' PR-template field fails policy. Action: fill the field, re-run CI, merge. Also verify `reportUsageToStripe` is actually wired into the metering path (`agent-runs.recordRun` does not call it today).

### P0.5 Invite role-ceiling missing → admin self-escalates to owner
`server/src/routes/access.ts:2979-3000` — `createCompanyInviteForCompany` accepts `humanRole: "owner"` + `autoApprove: true` with no check that invited role ≤ inviter's role. Fix: enforce role ceiling (mirror `getProtectedMemberReason` at `access.ts:1114`); apply same in join-request approve path (`access.ts:3925+`).

### P0.6 Production dependency CVEs
`pnpm audit`: 1 critical (dev-only vitest), 15 high. Production-reachable: drizzle-orm `^0.38.4` (SQLi CVE-2026-39356, fixed 0.45.2), better-auth (auth core), path-to-regexp (DoS), dompurify, react-router. Fix: bump, run full gauntlet, add `pnpm audit --audit-level=high` as blocking CI gate.

### P0.7 G0 trunk reconciliation (Mac mini divergence)
Spec `doc/2026-06-08-deployment-and-inference-skus.md`. Decision is made (`main` is canonical) but the mini still runs a ~9k-line / 106-file divergent branch (`feat/cos-minimax-adapter-deploy` lineage @ `ab48dc14f`). Every mini deploy until reconciliation risks regressing one side. This is the single biggest structural launch risk. Action: schedule the reconciliation merge (human-gated).

### P0.8 Human-gated launch ops (G1/G4/G5)
- G1: issue real OpenRouter/Fireworks key + live mini CoS check
- G4: create Stripe Billing Meter + metered price (NOT in LAUNCH.md step 3, which only covers per-seat)
- G5: public domain/cert + run `scripts/cloud-preflight.mjs` against prod env
- Fill the 22 `TODO_SET_*` placeholders in `.claude/commands/admin.md` (deploy/health flows inert until then)

---

## P1 — Fix before/at launch (high-value, short)

### Code fixes
1. **Onboarding invite auto-approve inconsistency** — CoS-chat invite path never sends `autoApprove`; server defaults false (`onboarding-v2.ts:855`), contradicting #386/#387 "default on". Settings-page invites auto-approve, onboarding invites queue. Fix: thread `autoApprove: true` through `CoSConversation.tsx:92-108` → `onboardingApi.sendInvites`.
2. **Silently swallowed confirmPlan/revisePlan errors** — `CoSConversation.tsx:72-91` empty `catch {}`; non-402 failures invisible to user (Confirm does nothing). Surface non-402 errors.
3. **Webhook ledger marks events processed before handling** — `entitlement-sync.ts:159-160`; a throw after ledger insert permanently drops the entitlement update. Two-phase (pending→done) or transactional.
4. **Stripe webhook shares the IP-keyed 20/window billing rate limiter** (`app.ts:310`) — Stripe's small IP set can get 429'd → entitlement drift. Exempt or raise limit for `/api/billing/webhook`.
5. **Pending OAuth rows stored as `status:"active"`** (`connectors.ts:503-514`) — tokenless rows selectable by `resolveActingAs`. Use `pending_oauth` status.
6. **`resolveActingAs` missing `assertBoard` + agent-company check** (`routes/connectors.ts:213-238`).
7. **`isBillingDisabled()` prod bypass** (`tier-policy.ts:34-38`) — missing `STRIPE_SECRET_KEY` silently disables all caps. Fail closed in production deployment mode.
8. **`local_trusted` default + secrets master key** — default `deploymentMode` to `authenticated` in production (refuse `local_trusted` when `NODE_ENV=production`); require `PAPERCLIP_SECRETS_MASTER_KEY` in cloud mode instead of auto-generating per-instance (multi-instance = undecryptable tokens).
9. **WS message ordering** — `ui/src/realtime/useMessages.ts:29-34` appends without sorting by `createdAt`; sort with id tie-break.

### Upstream cherry-picks (all dry-run verified clean against main; pick in this order, full gauntlet + cherry-pick-log entry each)
1. `242a2c2f2b` — **worktree init --force wipes `worktrees/`** (data-loss; MAW uses worktrees daily; buggy line at `cli/src/commands/worktree.ts:1388`)
2. `5d315ab778` — forceFreshSession wakes silently coalesced; poisoned CoS sessions can't cold-restart (pick before 3/4 — they build on its helper)
3. `a0f7d3daba` — timer-wake session bloat (long-lived CoS = exactly this pattern; hits metered-inference cost)
4. `b853ce5183` — heartbeat reuses old task session after agent model change
5. `f3db7b88ea` — stale `checkoutRunId` wedges issues permanently; adds backstop sweeper

Plus, with adaptation: `93206f73fa` (archived companies keep waking agents — billing/cost leak in a paid product). Bench: `0713dfa41f` (claude-local --resume UUID validation), `901c088e14` (company-scoped wake-context identifier lookup — also check the local heartbeat lookup for the tenant-isolation question it implies). Native salvage from skipped `1f70fd9a22`: add cascade-delete FKs on `execution_workspaces`/`workspace_operations` companyId (2 schema lines + `pnpm db:generate`) — needed by AGE-144 deprovisioning.

### Open PR queue (recommended sequence)
1. **#397** (release workflow main targeting) — fix PR-body template fields, merge. Unblocks canary releases.
2. **#393** (quota gate, AGE-121) — fill 'Model Used', merge. Closes P0.4.
3. **#396** (positioning doc + connector tests) — rebase onto repaired main (verify failure is the stale costs-service mock fixed by #400); e2e flake needs admin-bypass per standing policy.
4. **#395** (run ledger, AGE-123) — rework: it re-adds `agent_runs` schema that main already has (0086). Post-pilot.
5. **#394** (MCP client), **#392** (Outlook), **#289** (Clockchain attestation: lockfile + migration renumber) — post-launch rebases. **#338** stays draft.

---

## P2 — Shortly after launch

- **e2e coverage gaps** (zero specs today): billing checkout/Stripe trial, cap-exceeded → upgrade-prompt, CoS chat substrate (typed cards, @-mention summon, WS live append), agent hire via plan-card Confirm, onboarding invite auto-approve regression test, invite partial-failure resend (dup-invite bug in `InvitePrompt.tsx:42-51`).
- LAUNCH.md doc gaps: backup story for cloud path (subsystem exists, defaults on, undocumented), connector OAuth env vars (`GOOGLE_*`, `SLACK_*`), usage-billing knobs (`AGENTDASH_USAGE_*`, license vars), `PAPERCLIP_AGENT_JWT_SECRET` fallback note. CLAUDE.md migration count stale (says 60; actual 87 through `0086_agent_runs.sql`).
- SSRF guard centralization: the strong `access.ts` validator isn't applied to connector OAuth/token-exchange or the OpenClaw gateway URL; pin DNS-validated IPs to close rebinding TOCTOU.
- Gmail: log token-refresh persistence failures (`gmail-connector.ts:277-291`); strip CR/LF from RFC2822 header values; Slack `findConnectionByTeamId` is a dead path (inbound routing incomplete — track as feature).
- Billing service bare `Error` → typed 4xx (`billing.ts:29,56,66`); `Math.ceil` for trial days-left; quota route should use `assertCompanyAccess`; localStorage `paperclip:`→`agentdash.*` migration (weigh upstream-compat); `requestBaseUrl` X-Forwarded-Host trust → use configured `publicBaseUrl`; adapter-install npm allowlist; ChatPanel read-pointer debounce keyed on `lastMessageId`; interview counters persisted instead of substring-derived (`onboarding-v2.ts:929-933`); InviteLanding pending-approval live update; confirm stub LLM routes (`onboarding-v2.ts:300,333`) are unreachable or remove.
- Suspected latent races from skipped `1f70fd9a22` (finalize barriers: dependent wakes before finalize, env reuse across assignees) — monitor; adopt natively if dependent-issue workflows are exercised.

## Suggested execution order

1. **Week 1 (now):** P0.1–P0.6 as MAW issues (one builder PR for Slack pair, one for Stripe pair, one for role ceiling, one for dep bumps + CI audit gate). Merge #397 + #393. Cherry-pick batch (242a2c2f2b first).
2. **Week 1–2:** P1 code fixes (onboarding pair + webhook ledger/rate-limit + connector hardening + prod-mode fail-closed). Rebase/merge #396.
3. **Human-gated, parallel:** G0 reconciliation merge; G1 inference key; G4 Stripe meter; G5 domain + preflight; fill admin.md placeholders.
4. **Launch gate:** full gauntlet + the new billing/onboarding e2e specs + a real Stripe-test-mode checkout on the prod domain.

## What was found CLEAN (meaningful absence)

Tenant isolation (`assertCompanyAccess` discipline verified across sampled route files), auth core/agent JWT, Stripe webhook signature verification, secrets-at-rest (AES-256-GCM), LLM→shell/SQL trust boundary (execFile array-args everywhere, no eval), plugin-UI CORS, plugin SQL sandbox, invite-path SSRF guard (one of the stronger implementations reviewed), Gmail service-layer company scoping, agent-run metering idempotency, OAuth CSRF state handling, WS reconnect logic, 402 cap-exceeded UX centralization, revise-plan prompt-injection discipline.
