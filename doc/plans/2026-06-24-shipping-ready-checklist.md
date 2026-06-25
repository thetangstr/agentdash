# AgentDash — Shipping-Ready Checklist

Date: 2026-06-24
Reads with: `2026-06-24-launch-and-runtime-independence-plan.md`, `2026-06-24-rest-of-work-execution-spec.md`, `2026-06-24-gateway-and-native-adapter-design.md`.

Architecture (settled): **managed Hermes** is the universal agent runtime; **each agent = a distinct Hermes profile**; the **inference gateway** provides token-independence; agents run **sandboxed**. (Native adapter explored and shelved — Hermes-for-all supersedes it.)

Single launch metric: **default-agent `adapter_failed` < 5% in production**, visible in Company Settings → Health.

Legend: `[x]` done/verified this cycle · `[~]` partial · `[ ]` pending.

---

## A. Runtime (managed Hermes)
- [x] Hermes is MIT (CLI + adapter) — bundling/redistribution/commercial OK.
- [x] Per-agent profile mechanism proven live on the mini (`hermes -p <profile>`, isolated, token-independent via managed config) + `scripts/hermes/provision-agent-profile.sh`.
- [x] Inference gateway MVP (resolve + price/metering) — PR #411.
- [x] Reaper false-positive fixed (live on mini; main mitigates via pid-recording).
- [x] `x-agent-key` auth header fix on main.
- [x] **Wire profile lifecycle into `hermes_local`** — `onHireApproved` provisions the profile; `execute` scopes runs via the alias wrapper (`hermes -p <profile>`). Gated by `AGENTDASH_HERMES_MANAGED_PROFILES` (default off). `services/hermes-profile.ts` (+6 tests). *(deprovision-on-terminate: TODO when an agent-terminated hook lands.)*
- [x] **Gateway-point** — `provisionAgentProfile` writes the profile's provider from `AGENTDASH_GATEWAY_*` (token-independent), else copies a managed template. *(cc-switch retires once the gateway is deployed + keyed on the mini.)*
- [x] **Sandbox `cwd`** — already handled on `main` (`resolveManagedProjectWorkspaceDir` + `workspaceDir`); the mini's Laura incident was a stale checkout → resolved by the cutover (D). No new code.
- [ ] **EPIPE guard** on adapter spawn (lives in the external `hermes-paperclip-adapter` spawn path — patch upstream or guard at the heartbeat).
- [ ] Commit the live reaper + preflight-probe fixes to main (port against main's diverged `registry.ts`).
- [ ] **Bundle + pin Hermes** in the installer (Python 3.11 + `pip install hermes-agent==<pinned>`).
- [ ] Verify default-agent `adapter_failed` < 5% on a controlled mini run (instance B).

## B. Trial / onboarding (the funnel)
- [x] No-card signup → CoS chat → first agent hire is ungated (scaffolding exists).
- [x] 14-day no-card Stripe trial + Free tier implemented.
- [ ] **Demo seed data** — a populated MSP starter company (paused/idle agents, seeded issues + DoD/verdicts), via the company-creator skill.
- [x] **Richer Free tier** — `tier-policy.ts` caps now operator-tunable via `AGENTDASH_FREE_HUMAN_CAP` / `AGENTDASH_FREE_AGENT_CAP` (launch sets 2 + 3); default 1+1 unchanged (+4 tests). *(Set the env at launch.)*
- [ ] TTFV measured **< 10 min** from a clean account to a successful first agent run.
- [ ] Free → trial → Pro cap-boundary flow E2E-tested (Playwright).

## C. Billing / pricing
- [x] Caps bypass is dev-only; enforced when `STRIPE_SECRET_KEY` set.
- [x] Duplicate `test:launch-signoff` key fixed (full sign-off suite runs).
- [ ] **Hybrid pricing live** — per-seat base + usage-based inference passthrough; Stripe tiers configured.
- [ ] Gateway usage → `costEvents` metering reconciles (the native adapter set `metered_api`; do the same for the Hermes/gateway path).
- [ ] Outcome telemetry emitting (accepted DoD/verdict counts) for later outcome-based pricing.
- [ ] Stripe test-mode dry run: checkout → trial → upgrade → metered line items.

## D. Deployment / ops (mini → production)
- [ ] **Mini cutover** to `main`/`age/atlas-wire-overlay` (carries committed fixes; runbook `2026-06-18-g0-mini-cutover-runbook-two-instance.md`).
- [ ] Fill `TODO_SET_*` env placeholders (staging/prod URLs + test creds).
- [ ] Configure `AGENTDASH_GATEWAY_BASE_URL` / `AGENTDASH_GATEWAY_API_KEY`.
- [ ] Public access verified (Tailscale funnel + `PAPERCLIP_ALLOWED_HOSTNAMES` + rate-limit `AGENTDASH_RATE_LIMIT_API_MAX`).
- [ ] DB backups scheduled; migrations apply cleanly on boot.
- [ ] **Never seed heartbeat-active agents on the public instance** (keep agents paused unless a controlled test; use instance B / throwaway).
- [ ] Health panel green (Harness Health + Task Outcome) on the live install.

## E. CI / quality gates
- [ ] `pnpm -r typecheck && pnpm test:run && pnpm build` green in CI (clean runners).
- [ ] `pnpm test:launch-signoff` (full suite) passes.
- [ ] `e2e` Playwright passes — resolve the known Playwright-install flake (mirror `PLAYWRIGHT_DOWNLOAD_HOST` or `microsoft/playwright-github-action`).
- [ ] `check-architecture` gate committed + green (0 errors).
- [ ] PRs landed: **#411 gateway** (merge); **`feat/managed-hermes-profiles`** (PR + merge); decide **#412 native** (close/shelve).
- [ ] PR-process + agents-md-drift gates pass on each.

## F. GTM / launch (parallel)
- [ ] Pick the single MSP **beachhead workflow** (recommended: tier-1 ticket triage).
- [ ] 5-minute demo on the seeded MSP company (shared with B).
- [ ] One pilot MSP running the beachhead workflow on real(istic) tickets.
- [ ] Positioning + pricing page.

## G. Security / legal
- [x] Hermes MIT — keep attribution in bundled/installer docs.
- [ ] No provider/gateway keys in logs or saved artifacts (audit the adapter spawn env + run logs).
- [ ] Agent sandboxing verified: a run cannot mutate the deployment checkout (diff cwd before/after) and cannot reach beyond its workspace.
- [ ] Clean up any stray live edits on the mini (e.g. confirm `auth.ts` is clean) before cutover.

## H. Definition of "shipped" (exit criteria)
- [ ] New user (no card) → populated MSP starter workspace → successful first agent run in < 10 min.
- [ ] Every agent runs via a managed Hermes profile, gateway-pointed (**0 customer tokens**), sandboxed; `adapter_failed` < 5%.
- [ ] No adapter spawn can crash-loop the server; no agent can edit live source.
- [ ] Hybrid pricing live; usage reconciles with `costEvents`; outcome telemetry emitting.
- [ ] Mini runs a `main`-based SHA with all fixes; Health panel green.
- [ ] One MSP pilot live.

---

### Critical path to first ship
A (runtime: profile-lifecycle wiring → gateway-point → sandbox → EPIPE guard → bundle Hermes) → B (demo data + free tier) → D (mini cutover) → H. C-hybrid and F run in parallel; outcome-based pricing is post-launch.
