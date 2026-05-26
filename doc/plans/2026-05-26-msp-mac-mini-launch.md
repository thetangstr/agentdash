# MSP Mac Mini Launch Readiness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a clean, verifiable launch candidate for an MSP pilot running AgentDash on a local Mac mini.

**Architecture:** Start from `origin/main`, keep launch hardening small, and target the local Mac mini path specifically. The service should run from the checked-out repo with built artifacts and `pnpm --filter @paperclipai/server exec tsx src/index.ts`, while launchd handles restart/logging and the env file controls network/auth/adapter settings.

**Tech Stack:** TypeScript/Node 20, pnpm 9, Express server, React/Vite UI, PostgreSQL, macOS launchd.

---

### Task 1: Clean Launch Worktree

**Files:**
- No production files.

- [x] **Step 1: Create isolated worktree**

Run:
```sh
git worktree add worktrees/msp-mac-mini-launch -b codex/msp-mac-mini-launch origin/main
```

Expected: worktree is clean and tracks `origin/main`.

- [x] **Step 2: Install dependencies**

Run:
```sh
pnpm install --frozen-lockfile
```

Expected: dependencies install without lockfile changes.

- [x] **Step 3: Baseline typecheck**

Run:
```sh
pnpm -r typecheck
```

Expected: all workspace package typechecks pass.

### Task 2: Make Hermes CoS Dispatch Portable

**Files:**
- Modify: `server/src/services/dispatch-llm.ts`
- Modify: `server/src/adapters/registry.ts`
- Modify: `server/src/__tests__/dispatch-llm.test.ts`
- Modify: `server/src/__tests__/adapter-registry.test.ts`

- [x] **Step 1: Add failing test for default Hermes command**

Add a test that sets `AGENTDASH_DEFAULT_ADAPTER=hermes_local`, leaves `AGENTDASH_HERMES_COMMAND` unset, mocks `node:child_process.spawn`, and asserts the command is `hermes` rather than a user-specific absolute path.

Run:
```sh
pnpm exec vitest run server/src/__tests__/dispatch-llm.test.ts
```

Expected before implementation: test fails because dispatch currently uses `/Users/maxiaoer/.local/bin/hermes`.

- [x] **Step 2: Implement portable default**

Change the default Hermes command to `hermes`, while preserving `AGENTDASH_HERMES_COMMAND` override behavior.

Also update Hermes agent-execution normalization in `server/src/adapters/registry.ts` so actual `hermes_local` runs use the same portable default.

- [x] **Step 3: Verify focused dispatch tests**

Run:
```sh
pnpm exec vitest run server/src/__tests__/dispatch-llm.test.ts
pnpm exec vitest run server/src/__tests__/adapter-registry.test.ts
```

Expected: all dispatch tests pass.

### Task 3: Repair Mac Mini launchd Path

**Files:**
- Modify: `docker/launchd/install.sh`
- Modify: `docker/launchd/ai.agentdash.agent.plist`
- Modify: `docs/deploy/macos.md`

- [x] **Step 1: Update installer to build/run from repo root**

Make `install.sh` run `pnpm install --frozen-lockfile` and `pnpm build`, then generate a launchd plist that starts the server with `pnpm --filter @paperclipai/server exec tsx src/index.ts` from the repo root. Preserve the existing `--with-postgres` and `--uninstall` behavior.

- [x] **Step 2: Capture production env defaults**

Ensure a newly-created `~/.config/agentdash/agentdash.env` includes authenticated/private deployment, migration auto-apply, `AGENTDASH_DEFAULT_ADAPTER=hermes_local`, optional `AGENTDASH_HERMES_COMMAND` when Hermes is on PATH, and comments for Stripe, Resend, Anthropic, and Tailscale/public URL settings.

- [x] **Step 3: Update macOS runbook**

Document install, first start, restart, logs, health check, smoke test, update, rollback, and full-instance backup paths, including `~/.paperclip/instances/default` and `~/.agentdash`.

### Task 4: Fix Launch Docs Drift

**Files:**
- Modify: `doc/LAUNCH.md`
- Modify: `packages/create-agentdash/README.md`

- [x] **Step 1: Correct CoS adapter behavior**

Update launch docs to say only `claude_api`, `claude_local`, and `hermes_local` are supported for CoS chat; unsupported adapters return 501 and are only for agent execution unless separately wired.

- [x] **Step 2: Correct setup wizard copy**

Update stale create-agentdash README text that still says setup asks for both adapter and email.

### Task 5: Final Verification

**Files:**
- No production files.

- [x] **Step 1: Run focused tests**

Run:
```sh
pnpm exec vitest run server/src/__tests__/dispatch-llm.test.ts
pnpm exec vitest run server/src/__tests__/adapter-registry.test.ts
pnpm exec vitest run --project paperclipai cli/src/__tests__/launchd-install.test.ts
pnpm exec vitest run --project paperclipai cli/src/__tests__/onboard.test.ts
bash -n docker/launchd/install.sh
```

Expected: pass.

- [x] **Step 2: Run repo checks**

Run:
```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all pass. UI build may retain the existing large chunk warning.

- [x] **Step 3: Run local service smoke when possible**

Start the launchd server command with an isolated `PAPERCLIP_HOME` and check:
```sh
curl -fsS http://127.0.0.1:3220/api/health
curl -fsSI http://127.0.0.1:3220/
```

Expected: healthy JSON response and a 200 UI response. Note: `pnpm --filter @paperclipai/server start` failed in a source checkout because workspace package exports resolve to TypeScript sources with `.js` specifiers; launchd was corrected to use the proven TSX source entrypoint.
