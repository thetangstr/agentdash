---
name: setup-codebase-harness
description: >
  Assess and improve the agent harness for a repo so an agent can work it reliably:
  legible (map-not-manual docs + custom lints), executable (one-command dev stack,
  worktree-friendly), verifiable (e2e gate + an independent verify-before-ship loop),
  plus the loops/ knowledge substrate so runs compound. Use when onboarding a repo to
  agent-driven development — "set up the harness", "make this repo agent-ready",
  "harness this codebase".
user_invocable: true
---

# Set up the codebase harness

**Harness engineering:** the model is fixed — what you engineer is the *scaffolding* around it
(the environment, the docs, the feedback loops, the shared memory) so an agent can build and
verify software with minimal human attention. Humans steer; agents execute. Make the repo
**legible, executable, verifiable** — and give it a **shared brain** so work compounds.

Work **incrementally and depth-first**: assess what exists, build the one missing capability, use
it to unlock the next. Don't boil the ocean. When the agent struggles, the fix is almost never
"try harder" — ask *"what capability is missing, and how do I make it legible and enforceable?"*

For AgentDash specifically, much of this already exists — this skill is mostly an **assessment +
gap-fill**, not a from-scratch build. Current state (2026-06):

| Pillar | AgentDash today |
|---|---|
| Legible | `AGENTS.md`/`CLAUDE.md` index + `doc/` specs ✅ · `scripts/check-architecture.mjs` lints ✅ |
| Executable | `pnpm dev` (one command, :3100) ✅ · git-worktree workflow (`/workon`) ✅ |
| Verifiable | `tests/e2e` Playwright gate ✅ · `/tester` independent verifier gate ✅ |
| Shared brain | `loops/` substrate (signals/docs/domains + LOG) ✅ |

## 0. Assess

Survey the repo: stack, package manager, services/ports, infra deps, existing docs/tests/CI, and
the *implicit* rules (buried in READMEs, PR comments, people's heads). Note what's missing per
pillar below before building anything.

## 1. Legible — the agent can reason about the repo

> What the agent can't see doesn't exist. Knowledge in chat threads / heads is invisible — push it
> into versioned, repo-local artifacts.

- **a) Map, not manual.** Keep the root agent doc (`AGENTS.md` / `CLAUDE.md`) a slim table of
  contents (overview, tree, golden rules, a "where to look" table). Depth lives in `doc/`. AgentDash
  caps `CLAUDE.md` at 200 lines by policy — honor it.
- **b) Custom lints with remediation.** Promote prose golden rules into **mechanical checks** whose
  error message **injects the fix**. AgentDash uses standalone `scripts/check-*.mjs` (e.g.
  `check:architecture`, `check:tokens`) wired into `.github/workflows/pr.yml` — add a new rule by
  pushing onto `RULES` in `scripts/check-architecture.mjs`, with a test in the sibling
  `.test.mjs`. One lint per invariant.

## 2. Executable — the agent can run & drive the app

- One-command stack: `pnpm dev` (server + UI, :3100). State reset: `rm -rf data/pglite && pnpm dev`.
- **Worktree-friendly** so parallel agents don't collide — the MAW `/workon` flow creates a
  per-issue worktree and warms deps. Carry over gitignored `.env` files into new worktrees.
- Make the app drivable: Playwright / Chrome automation; logs reachable.

## 3. Verifiable — the agent can prove it works

- **e2e gate** (`tests/e2e`): real flows over bypass, a reusable auth/session helper, layered
  client→server→product assertions, video/trace evidence, sandbox-only external services. Critical
  flows that must never break: signup, upgrade/billing. (Billing e2e is a known gap — add it.)
- **Verify-before-ship**: an **independent** read-only verifier drives the running app to confirm
  the feature works — never self-verify. In AgentDash that's the `/tester` gate (Phase 4 CUJ +
  video proof). The verifier judges; the builder fixes until green.
- **Proof, not claims**: attach the e2e/CUJ video to the PR via the `pr-evidence` gh prerelease so
  a human can watch the feature work.

## 4. Shared brain — runs compound

- `loops/` is the substrate: `signals/` (evidence), `docs/` (durable knowledge), `domains/`
  (loops), `LOG.md` (global feed). Every loop reads the last few LOG entries before starting and
  appends one when it finishes; friction/ideas get filed as signals. See `loops/ARCHITECTURE.md`.
- Stand up a new recurring loop with the `new-loop` skill.

## 5. Keep it coherent over time

- **Commit hygiene** + light merge gates (at high agent throughput, corrections are cheap, waiting
  is expensive). **Agent-to-agent review** for correctness-critical changes (independent reviewers,
  not self-review). Periodic small refactor/cleanup PRs rather than debt in painful bursts.

## Order & what you leave behind

Assess (0) → fill the missing pillar. For a fresh repo: **map → dev-up → e2e + verifier → lints →
shared brain.** The artifacts — slim map + `doc/`, `pnpm dev`, an `e2e/` suite, the verifier gate,
`check-*.mjs` lints, and `loops/` — are each a reusable capability that compounds. Prefer boring,
composable, stable tech the agent can fully model.
