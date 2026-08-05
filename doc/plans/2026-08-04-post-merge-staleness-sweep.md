# Post-merge staleness sweep — implementation plan

**Date:** 2026-08-04
**Basis:** three-reviewer staleness audit of `main` @ `cd296cf5`, findings spot-verified.
**Nature:** mechanical. Every item below carries its exact location and its exact fix; the
executing agent should need no product judgment. Where judgment IS required, the item says so
and states the decision boundary.

**Standing rules that apply to every slice** (unchanged from the harness plan except the first):
- The lockfile rule is now: **`pnpm-lock.yaml` is tracked; CI owns updates** (the
  `refresh-lockfile` bot). Do not hand-edit it in a PR — `pr.yml` blocks that. A plain
  `pnpm install --frozen-lockfile` under pnpm `9.15.4` must never modify it.
- Lore commit format; one commit per slice; RED first where a slice has testable behavior.
- Default-profile behaviour unchanged. Profile-only routes 404, not 403.
- Gates G1–G6 from `doc/plans/2026-08-02-harness-implementation-plan.md` apply as marked.

---

## S1. `.env.example` documents Teams env vars the server never reads — OPERATOR-BREAKING

The one finding in this sweep that breaks a real operator.

- `.env.example:149-150` says `TEAMS_APP_ID=` / `TEAMS_APP_PASSWORD=`.
- The code reads `TEAMS_BOT_APP_ID` (`server/src/routes/human-channels.ts:155`,
  `server/src/services/teams-connector.ts:209`), `TEAMS_BOT_APP_PASSWORD`, and
  `TEAMS_BOT_TOKEN_URL` (`teams-connector.ts:209-215`). Nothing reads the documented names.
- The stale names are copied into `docs/api/agentdash-mk.md` and
  `docs/superpowers/specs/2026-07-30-agentdash-mk-scope-override.md`.

**Fix:** rename the two vars in `.env.example` to `TEAMS_BOT_APP_ID` / `TEAMS_BOT_APP_PASSWORD`,
add `TEAMS_BOT_TOKEN_URL` (commented, with its default), and correct both docs. Keep the
existing comment noting Teams is deprioritized.

**Acceptance:** grep for `TEAMS_APP_ID`/`TEAMS_APP_PASSWORD` (without `BOT_`) returns zero hits
outside git history. **Gate:** none beyond grep — no runtime behavior changes.

## S2. The retired "never commit pnpm-lock.yaml" rule survives in ten places

The merge inverted the rule; no sweep followed. The replacement wording everywhere is some
variant of: *"`pnpm-lock.yaml` is tracked. CI owns updates via the `refresh-lockfile` bot;
never hand-edit it in a PR (`pr.yml` enforces this)."*

| Location | Stale text |
|---|---|
| `doc/DEVELOPING.md:18-24` | whole "Dependency Lockfile Policy" section; also says pushes to **`master`** — default branch is `main`. Rewrite the section, not just a line. |
| `doc/plans/2026-08-02-harness-implementation-plan.md:48` | "never commit pnpm-lock.yaml" in the **Standing** list |
| `doc/plans/2026-08-02-harness-implementation-plan.md:251` | "pnpm-lock.yaml untouched" in definition-of-done |
| `doc/plans/2026-08-01-deliverable-pipeline.md:94` | "Never commit pnpm-lock.yaml." |
| `doc/plans/2026-08-02-graph-learning-system.md:158` | "pnpm-lock.yaml untouched" |
| `doc/plans/2026-08-02-agent-pairing-architecture.md:155` | "Never commit pnpm-lock.yaml." |
| `doc/plans/2026-07-28-agentdash-mk-implementation.md:51,626` | "do not commit pnpm-lock.yaml" |
| `doc/plans/2026-07-28-agentdash-mk-claude-code-handoff.md:299,398,437` | same |
| `doc/plans/2026-07-29-agentdash-mk-acceptance-audit.md:33` | "intentionally uncommitted; CI owns it" (keep the second half) |
| `pnpm-workspace.yaml:7,10` | comments justify exclusions by "not forcing lockfile commits" — soften to "CI-owned lockfile churn" |

For dated plan docs, prefer a one-line bracketed annotation over rewriting history, e.g.
`[Superseded 2026-08-03: the lockfile is now tracked; CI owns it — see DEVELOPING.md.]`
`DEVELOPING.md` is living documentation and gets the full rewrite.

**Do NOT change:** `docs/superpowers/handshake-whole-nine-yards-plan.md:85` and
`doc/LAUNCH.md:302` — both describe the still-live "CI owns it / PR must not touch it" rule
accurately.

**Acceptance:** `grep -ri "never commit pnpm-lock"` returns only annotated/dated-historical
hits; `DEVELOPING.md` describes the tracked-lockfile reality and says `main`, not `master`.

## S3. Living top-level docs state wrong facts

1. `CLAUDE.md:164` — claims "14 migrations (0046-0059) added by AgentDash; 60 total". Truth:
   **115 total (0000–0114)**; the agentdash-mk work alone is 0096–0114. Restate, and prefer
   phrasing that doesn't need re-editing every migration ("migrations run 0000–0114 as of
   2026-08-04; check `packages/db/src/migrations/meta/_journal.json` for current head").
2. `CLAUDE.md:100` adapter list — add `acpx` (`packages/adapters/acpx-local` ships).
3. `README.md:67` — add `acpx`; remove **Hermes** (no in-repo adapter package; Hermes is
   external-plugin only — if the marketing claim matters, say "Hermes via external plugin").
4. `AGENTS.md:185-224` — delete the entire **"Fork-Specific: HenkDz/paperclip"** block. It
   documents a *different fork* (port 3101, NTFS/Windows notes, `PR #2218`), contradicts this
   repo, and creates a duplicate `## 11` heading (real §11 "Definition of Done" is at :175).
   Nothing else references it.
5. `AGENTS.md:8` "current implementation target is V1" — align with the v2 framing used by
   `CLAUDE.md`/`README.md`.

**Caution:** `AGENTS.md` edits are checked by `scripts/ci/check-agents-md-drift.mjs` in CI —
run it locally after editing. **Acceptance:** each fact above verifiable by grep/journal.

## S4. All four mandatory prompt surfaces promise Teams and omit WhatsApp — G6

The four surfaces (`server/src/onboarding-assets/default/AGENTS.md:209`, `ceo/AGENTS.md:197`,
`chief_of_staff/AGENTS.md:238`, `server/src/services/agent-creator-from-proposal.ts:166`) all
say decisions "may arrive from the dashboard, Telegram, or Microsoft Teams". Teams inbound
rejects every activity by design (deprioritized 2026-07-30); **WhatsApp shipped and is not
listed**. A second passage in all four (`default:333`, `ceo:321`, `chief_of_staff:362`,
`agent-creator-from-proposal.ts:291`) routes stall-escalation notices through Teams.

**Fix:** in all four surfaces, decision channels become "the dashboard, Telegram, or WhatsApp".
For the escalation passage, name the channel abstractly ("the steward's paired messaging
channel") rather than hardcoding a provider — the delivery code already branches per provider.
Do not remove the Teams *code*; this changes only what agents are told exists.

**Gates:** G6 — all four surfaces in one commit; CI drift check
(`check-agents-md-drift.mjs`, `hermes-prompt-drift`) must pass. The HubSpot and
Telegram/WhatsApp passages in those files are accurate — touch only the Teams claims.
**Acceptance:** grep the four surfaces for "Teams" — remaining hits must be ones that
describe Teams as deprioritized/unavailable, not as a live decision channel.

## S5. G2 blind spot: `packages/plugins/*` tests run by no runner

`packages/plugins/paperclip-plugin-fake-sandbox/src/plugin.test.ts` belongs to a workspace
member with a `test` script, but `packages/plugins/*` appears in **neither** `vitest.config.ts`
projects (lines 5-24) **nor** `scripts/run-vitest-stable.mjs` `nonServerProjects` (lines
10-32). The standard gate (`pnpm test:run`) never executes it. This is exactly the defect
class gate G2 exists for.

**Fix:** add the package to BOTH lists (G2 requires both). Expect RED: this suite has
plausibly never run — if it fails, fix the test or the plugin before landing; do not skip it.
**Exclusion that is correct as-is:** `packages/plugins/sandbox-providers/e2b` is deliberately
outside the workspace (`pnpm-workspace.yaml` excludes it) — leave it out, and add a one-line
comment in `vitest.config.ts` saying so, so the next audit doesn't re-flag it.

**Acceptance:** `pnpm test:run` executes the fake-sandbox suite (visible in output);
`vitest.config.ts` and `run-vitest-stable.mjs` lists still match 1:1.

## S6. Tracked clutter: `.vercel/`, orphaned root files

1. **`.vercel/` is committed** (`project.json` carries real `projectId`/`orgId`) while deploys
   run on Railway (`.github/workflows/deploy.yml`; no workflow references Vercel).
   `git rm -r .vercel/` and add `.vercel/` to `.gitignore`. Decide `vercel.json` at root the
   same way **only if** nothing references it (verify with grep first; if the marketing site
   still deploys via Vercel elsewhere, leave `vercel.json` and say why in the commit).
2. **`REGRESSION_AGE-4.md`** — orphaned point-in-time run log (2026-07-23, hardcodes another
   machine's paths, superseded counts). Delete; git history preserves it.
3. **`adapter-plugin.md`** — orphaned first-person WIP log for `feat/external-adapter-phase1`;
   canonical docs live at `docs/adapters/external-adapters.md`. Delete.
4. **`Dockerfile.test`** — nothing references it (no compose file, workflow, or script).
   Judgment item: delete it, UNLESS `git log -3 --format=%s Dockerfile.test` suggests active
   hand-use; in that case wire it into a script or docs so it stops being orphaned.

**Acceptance:** `git ls-files .vercel/` empty; the two logs gone; grep finds no dangling
references to any removed file.

## S7. CI alignment (small, do last)

1. Node drift: `pr.yml`/`release.yml`/`release-smoke.yml` run node 24; `e2e.yml:27` and
   `refresh-lockfile.yml:35` run node 20 — the lockfile is refreshed under a different major
   than the lane that verifies it. Align all to 24.
2. `e2e.yml:23` floats `pnpm/action-setup` `version: 9`; every other workflow pins `9.15.4`.
   Pin it.
3. Dead `master` triggers in `pr.yml:6`, `refresh-lockfile.yml:7`, `docker.yml:6` — remove;
   default branch is `main`.

**Acceptance:** grep workflows for `master` (zero hits in trigger lists), `version: 9`
(zero unpinned), `node-version: 20` (zero).

## S8. Decide `origin/chore/carried-docs` (never merged)

A remote branch carries 9 docs, 1,374 insertions, zero code — never-committed docs carried out
of the old iCloud working tree (`f1cefcc4`), same rescue pattern as the OMX carry. Purely
additive. **Open a PR and merge it.** If any doc is judged obsolete on review, drop it in the
PR rather than leaving the whole branch in limbo.

Separately, the remote carries ~180 dead branches (`age/*`, `fix/*`, `feat/*`, three
`worktree-agent-*`, `chore/refresh-lockfile` force-updated by the bot). Branch deletion is
owner's call — propose a list in the PR description of S8, do not delete unilaterally.

---

## Execution notes for the implementing agent

- Slices S1-S4 and S6 are docs/config only, but S4 runs the prompt-drift CI lanes and S5
  changes what the test gate executes — treat those two as behavior-bearing (RED first on S5).
- One commit per slice, Lore format, each commit body citing this plan.
- Full gate (`pnpm -r typecheck && pnpm test:run && pnpm build`) once at the end; record real
  numbers in the final commit or PR body. The last recorded suite figure (4,560 @ `87cade25`)
  predates the merge — report what you see, not that number.
