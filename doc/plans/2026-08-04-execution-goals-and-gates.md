# Execution goals & gates — machine-checkable

**Date:** 2026-08-04
**Purpose:** the checklist the staleness-sweep workflow runs against. Each slice has a **goal**
(done-when, in one sentence) and a **gate** (an exact command whose stated result is the pass
condition). A slice is not done until its gate passes AND an independent verifier confirms it.

**Base:** `main` @ cd296cf5. **Branch:** `chore/post-merge-staleness-sweep`.
**Universal gates (apply to every slice):**
- **U1 — no lockfile churn:** `git diff --name-only cd296cf5 HEAD | grep -c pnpm-lock.yaml` = **0**.
- **U2 — one commit per slice**, Lore format, body cites `2026-08-04-post-merge-staleness-sweep.md`.
- **U3 — no install in the sweep:** agents never run `pnpm install`; any pnpm invocation is `npx pnpm@9.15.4 …`.
- **U4 — default-profile untouched:** the sweep changes docs, config, prompt `.md`, and test-runner registration only — no server/ui runtime `.ts`/`.tsx` logic.

---

| Slice | Goal (done-when) | Gate (command → pass condition) |
|---|---|---|
| **S1** | `.env.example` and the two docs name the Teams vars the server actually reads. | `grep -rEn 'TEAMS_APP_(ID\|PASSWORD)=' .env.example` → **0 hits**; and `grep -c 'TEAMS_BOT_APP_ID' .env.example` ≥ 1, `TEAMS_BOT_APP_PASSWORD` and `TEAMS_BOT_TOKEN_URL` present. |
| **S2** | The retired "never commit pnpm-lock" rule is corrected everywhere; `DEVELOPING.md` describes the tracked-lockfile reality and says `main`. | `grep -rniL 'superseded\|historical\|as of' <files containing 'never commit pnpm-lock'>` → every remaining hit is annotated; `grep -n 'master' doc/DEVELOPING.md` → 0 in the lockfile section; `grep -c 'tracked' doc/DEVELOPING.md` ≥ 1. **Do NOT touch** `handshake-whole-nine-yards-plan.md:85`, `doc/LAUNCH.md:302`. |
| **S3** | `CLAUDE.md`/`README.md`/`AGENTS.md` state correct migration count, adapter list, and carry no foreign-fork block. | `grep -n '60 total' CLAUDE.md` → 0; `grep -c 'acpx' CLAUDE.md README.md`; `grep -c 'HenkDz' AGENTS.md` → 0; `grep -c '^## 11' AGENTS.md` → 1; then `node scripts/ci/check-agents-md-drift.mjs` exits 0 (run in integration). |
| **S4** | All four prompt surfaces list dashboard/Telegram/WhatsApp as decision channels; none present Teams as a live channel. | In each of the 4 surfaces: `grep -c 'WhatsApp' <surface>` ≥ 1; `grep -En 'Telegram, or Microsoft Teams' <surface>` → 0. G6: all four in one commit. |
| **S5** | `packages/plugins/*` tests run under the standard gate. | `grep -c 'plugins' vitest.config.ts` ≥ 1 **and** `grep -c 'plugins' scripts/run-vitest-stable.mjs` ≥ 1; integration: `npx pnpm@9.15.4 test:run` executes `paperclip-plugin-fake-sandbox`. `sandbox-providers/e2b` stays excluded (comment says why). |
| **S6** | `.vercel/` untracked+ignored; orphan root logs gone. | `git ls-files .vercel/ \| wc -l` → 0; `grep -c '.vercel/' .gitignore` ≥ 1; `test ! -e REGRESSION_AGE-4.md && test ! -e adapter-plugin.md`. `vercel.json` only if unreferenced (grep first). |
| **S7** | CI workflows drop dead `master` triggers, pin pnpm 9.15.4, align node to 24. | `grep -rn 'master' .github/workflows/` → 0 in `on:` blocks; `grep -rn "version: 9$\|version: '9'$" .github/workflows/e2e.yml` → 0; `grep -rn 'node-version: .*20' .github/workflows/` → 0. |

**S8** (carried-docs merge + dead-branch list) and the whole **steward-surfaces plan (T1–T6)** are
**out of scope for this workflow** — S8 is a branch/PR decision handled by the operator, and the
T-slices are feature work needing TDD RED-first (and T5 needs product confirmation). They are the
next wave, not this one.

## Final integration gate (run once, in the main checkout, on the branch)

`npx pnpm@9.15.4 -r typecheck` = 0 · `npx pnpm@9.15.4 build` = 0 · `node scripts/ci/check-agents-md-drift.mjs` = 0 · the newly-enabled plugin suite passes. Full `test:run` (≈4,500 tests, 35-min lane) is left to CI — the sweep touches no runtime logic (U4). Record real numbers in the PR body; do not repeat the pre-merge 4,560 figure.
