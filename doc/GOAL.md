# Paperclip

## Active Goal — Hermes-Supervised Target Testing (2026-05-19)

Current launch goal: use the target Mac mini Hermes agent as the independent tester for AgentDash, while Codex supervises from this repo, fixes filed issues, and sends Hermes back through the same tests until the launch scenario succeeds.

Source repo: https://github.com/thetangstr/agentdash

### Current Status

- 2026-05-19: Hermes completed the first target-machine pass against `agentdash_dev` at commit `74cc0f74e7668def6a373e687627e5668b73e4fb`.
- Launch blocker fixed and closed: https://github.com/thetangstr/agentdash/issues/358 via https://github.com/thetangstr/agentdash/pull/359 at `62afdb534e89dd53f00fb80769b873b22f027f1d`.
- Retest result: Hermes retest `agentdash-retest-359b` passed the #358 isolation check on `62afdb534e89dd53f00fb80769b873b22f027f1d`; `pnpm dev` started on `3101` from repo-local `.paperclip/.env`, `/api/health` was healthy, and `/instance/settings/about` plus `/instance/settings/changelog` returned 200.
- Launch blocker fixed and closed: https://github.com/thetangstr/agentdash/issues/360 via https://github.com/thetangstr/agentdash/pull/361 at `d23a546ee70074a9f1ef3de1ef8cf73974633549`.
- Retest result: target smoke on the Mac mini passed the #360 alias path on `d23a546ee70074a9f1ef3de1ef8cf73974633549`; `POST /api/companies/:companyId/agents` with `type: "hermes_local"` and `config: {}` returned `adapterType: "hermes_local"` / `adapterConfig: {}`, and wakeup run `d36c404c-edc6-4d44-b359-d34d057f2069` succeeded with `exitCode: 0`.
- Retired target finding: https://github.com/thetangstr/agentdash/issues/345 — focused `workspace-runtime.test.ts` and full `pnpm test:run` both passed on the Mac mini at `d23a546ee70074a9f1ef3de1ef8cf73974633549`; issue closed as stale/transient.
- Launch blocker fixed and closed: https://github.com/thetangstr/agentdash/issues/363 via https://github.com/thetangstr/agentdash/pull/362 at `12874d4f40d143b2b7b232ffb3ac2d53c25ccee7`.
- Post-merge target result: Codex directly retested latest `origin/main` on the Mac mini in `/Users/maxiaoer/workspace/agentdash_dev`; the isolated authenticated multi-user UAT on port `3216` passed with `pnpm test:e2e:multiuser-authenticated` (`1 passed`, 17.6s). Production `/Users/maxiaoer/agentdash` and port `3100` were not touched.
- Safety intervention: the follow-up Hermes transcript showed broad process cleanup commands while preparing dev port `3101`; production `3100` was immediately checked and was healthy, then Hermes was steered to stop broad `pkill` usage and avoid `3100` except read-only health checks.
- Launch blocker fixed and closed: https://github.com/thetangstr/agentdash/issues/354 via https://github.com/thetangstr/agentdash/pull/365 at `2346ef3374be8e134a494505aff2f42b491240b4`.
  - Target result: `agentdash_dev` pulled latest main; focused Hermes/session tests passed, full `pnpm test:run` passed, `pnpm -r typecheck` passed, and `pnpm build` passed on the Mac mini. Issue #354 auto-closed after merge.
- Launch blocker fixed and closed: https://github.com/thetangstr/agentdash/issues/366 via https://github.com/thetangstr/agentdash/pull/367 at `ca737cc3735130ad901127fa09be03d58b80609a`.
  - Target result: local trusted dev UAT stopped tripping the API rate limiter; `POST /api/companies/:companyId/join-requests/:requestId/approve` succeeded after the fix, with production `3100` checked read-only and healthy.
- Launch blocker fixed and closed: https://github.com/thetangstr/agentdash/issues/368 via https://github.com/thetangstr/agentdash/pull/369 at `cd8a34f8ca19b7938b315d79a8145bba8a4c71bd`.
  - Target result: `agentdash_dev` pulled latest main, dev `3101` was restarted cleanly, and Hermes CoS wakeup run `30bd39c2-7be7-44b5-a092-517808bba675` succeeded with `exitCode: 0` and result `Checked: no open issues assigned to me, and no unassigned backlog issues. Nothing to do.`
- Final target status on 2026-05-19: `/Users/maxiaoer/workspace/agentdash_dev` is at `cd8a34f8ca19b7938b315d79a8145bba8a4c71bd`; production `http://127.0.0.1:3100/api/health` is healthy and was not mutated; dev `http://127.0.0.1:3101/api/health` is healthy in `local_trusted` mode.
- Final focused target verification on `cd8a34f8ca19b7938b315d79a8145bba8a4c71bd`: `pnpm exec vitest run server/src/__tests__/rate-limit.test.ts server/src/__tests__/runtime-api.test.ts server/src/__tests__/paperclip-env.test.ts server/src/__tests__/adapter-registry.test.ts server/src/__tests__/hermes-local-adapter-patch.test.ts` passed (`5` files, `39` tests).
- Adapter availability on the target:
  - `hermes_local`: environment test returned `warn` only because AgentDash env has no LLM API keys, but Hermes can use its local `~/.hermes` provider config; real wakeup run `30bd39c2-7be7-44b5-a092-517808bba675` succeeded.
  - `codex_local`: environment test returned `warn`; Codex native auth is present (`admin@yarda.pro`), but the hello probe did not return exactly `hello`. Remediation: run the probe manually with `codex exec --json -` and inspect output before using Codex for launch-critical work.
  - `claude_local`: environment test returned `fail` because `claude` is not in `PATH`. Remediation: install Claude Code CLI or add the authenticated `claude` binary to the target service PATH, then rerun the adapter environment test.

### Next Work

1. Keep https://github.com/thetangstr/agentdash/issues/350 as post-launch release/platform work unless a launch criterion starts depending on production readiness external gates.
2. Before relying on non-Hermes adapters for launch-critical work, rerun:
   - `codex_local` manual hello probe: `codex exec --json -` with prompt `Respond with hello`.
   - `claude_local` environment test after installing or exposing the `claude` CLI in the target service PATH.
3. Archive or refresh stale draft files under `/tmp/agentdash-target-issues/` on the target machine; the rate-limit draft is fixed by #367, and the old workspace-runtime timeout draft was retired by the later full target `pnpm test:run`.

### Operating Loop

1. Hermes runs on the target machine against the test environment, not production data.
   - Target host: `192.168.86.48`
   - Hermes profile: `agentdash`
   - Target checkout: `/Users/maxiaoer/workspace/agentdash_dev`
   - Pull the latest `origin/main` before each test pass.

2. Hermes owns black-box validation.
   - Install or upgrade AgentDash from GitHub.
   - Confirm the running app exposes its version/about/changelog information.
   - Exercise the first-time onboarding path for a new company with two C-level humans, CEO and COO, and one shared Chief of Staff agent.
   - Confirm the CoS can create company goals and support more than one human user.
   - Exercise adapter setup and environment tests for the configured local adapters, especially `hermes_local`; also test `codex_local` when Codex OAuth is available and `claude_local` when Claude local auth is available.
   - Run the available automated checks that fit the target environment: `pnpm test:run`, `pnpm -r typecheck`, `pnpm build`, and browser/UAT checks when the app is running.

3. Hermes files GitHub issues for every reproducible failure.
   - File issues on https://github.com/thetangstr/agentdash/issues.
   - Include: tested commit SHA, AgentDash version, target machine/environment, exact steps, expected result, actual result, logs/screenshots, and whether production data was touched.
   - Use labels when available: `target-machine-test`, `hermes-found`, and `launch-blocker` for anything that blocks the target onboarding scenario.

4. Codex monitors, fixes, and asks Hermes to retest.
   - Monitor open `target-machine-test` issues.
   - Fix one launch-blocking issue at a time in small, reviewable diffs.
   - Verify locally before pushing.
   - Ask Hermes to pull the fix and rerun the relevant test plus any impacted regression checks.
   - Keep looping until Hermes can complete the target onboarding scenario without launch-blocking failures.

### Done Criteria

- Hermes completes a clean install or upgrade of latest AgentDash in `agentdash_dev`.
- The target app shows version/about/changelog information from the UI.
- The two-executive onboarding scenario succeeds end to end: company created, CEO and COO onboarded, one shared CoS available, company goals created, and agent setup verified.
- `hermes_local` passes its environment test and can execute at least one successful agent run.
- Any available `codex_local` OAuth and `claude_local` auth paths are either verified or documented as unavailable with exact remediation.
- Automated checks pass on the target machine, or every failure is filed as a GitHub issue with enough evidence for Codex to fix it.
- No open `launch-blocker` / `target-machine-test` GitHub issues remain untriaged.

### Safety Rules

- Do not mutate production company data during testing unless the user explicitly requests it.
- Use `agentdash_dev` or another clearly named test workspace for destructive or setup tests.
- Prefer archived throwaway companies over deleting rows from test databases when run/cost records exist.
- Never paste secrets into GitHub issues, commits, logs, or prompts.

**Paperclip is the backbone of the autonomous economy.** We are building the infrastructure that autonomous AI companies run on. Our goal is for Paperclip-powered companies to collectively generate economic output that rivals the GDP of the world's largest countries. Every decision we make should serve that: make autonomous companies more capable, more governable, more scalable, and more real.

## The Vision

Autonomous companies — AI workforces organized with real structure, governance, and accountability — will become a major force in the global economy. Not one company. Thousands. Millions. An entire economic layer that runs on AI labor, coordinated through Paperclip.

Paperclip is not the company. Paperclip is what makes the companies possible. We are the control plane, the nervous system, the operating layer. Every autonomous company needs structure, task management, cost control, goal alignment, and human governance. That's us. We are to autonomous companies what the corporate operating system is to human ones — except this time, the operating system is real software, not metaphor.

The measure of our success is not whether one company works. It's whether Paperclip becomes the default foundation that autonomous companies are built on — and whether those companies, collectively, become a serious economic force that rivals the output of nations.

## The Problem

Task management software doesn't go far enough. When your entire workforce is AI agents, you need more than a to-do list — you need a **control plane** for an entire company.

## What This Is

Paperclip is the command, communication, and control plane for a company of AI agents. It is the single place where you:

- **Manage agents as employees** — hire, organize, and track who does what
- **Define org structure** — org charts that agents themselves operate within
- **Track work in real time** — see at any moment what every agent is working on
- **Control costs** — token salary budgets per agent, spend tracking, burn rate
- **Align to goals** — agents see how their work serves the bigger mission
- **Preserve work context** — comments, documents, work products, attachments, and company state stay attached to the work

## Architecture

Two layers:

### 1. Control Plane (this software)

The central nervous system. Manages:

- Agent registry and org chart
- Task assignment and status
- Budget and token spend tracking
- Issue comments, documents, work products, attachments, and company state
- Goal hierarchy (company → team → agent → task)
- Heartbeat monitoring — know when agents are alive, idle, or stuck

It also enforces execution-control semantics such as single-assignee issues, atomic checkout and execution locks, blockers, recovery issues, and workspace/runtime controls.

### 2. Execution Services (adapters)

Agents run externally and report into the control plane. Adapters connect different execution environments and define how a heartbeat is invoked, observed, and cancelled:

- **Local CLI/session adapters** — built-in adapters for tools such as Claude Code, Codex, Gemini, OpenCode, Pi, and Cursor
- **HTTP/process-style adapters** — command or webhook/API integrations for custom runtimes
- **OpenClaw gateway** — integration for OpenClaw-style remote agents
- **External adapter plugins** — dynamically loaded adapters installed outside the core app

The control plane doesn't run agents. It orchestrates them. Agents run wherever they run and phone home.

## Core Principle

You should be able to look at Paperclip and understand your entire company at a glance — who's doing what, how much it costs, and whether it's working.
