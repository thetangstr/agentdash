# Paperclip

## Active Goal — Hermes-Supervised Target Testing (2026-05-19)

Current launch goal: use the target Mac mini Hermes agent as the independent tester for AgentDash, while Codex supervises from this repo, fixes filed issues, and sends Hermes back through the same tests until the launch scenario succeeds.

Source repo: https://github.com/thetangstr/agentdash

### Current Status

- 2026-05-19: Hermes completed the first target-machine pass against `agentdash_dev` at commit `74cc0f74e7668def6a373e687627e5668b73e4fb`.
- Launch blocker fixed and closed: https://github.com/thetangstr/agentdash/issues/358 via https://github.com/thetangstr/agentdash/pull/359 at `62afdb534e89dd53f00fb80769b873b22f027f1d`.
- Retest result: Hermes retest `agentdash-retest-359b` passed the #358 isolation check on `62afdb534e89dd53f00fb80769b873b22f027f1d`; `pnpm dev` started on `3101` from repo-local `.paperclip/.env`, `/api/health` was healthy, and `/instance/settings/about` plus `/instance/settings/changelog` returned 200.
- Current blocker: https://github.com/thetangstr/agentdash/issues/360 — agent-directed setup can send `type` / `config`, which currently defaults to a `process` agent and breaks `hermes_local` runs.
- Remaining target-machine finding: https://github.com/thetangstr/agentdash/issues/345 — `pnpm test:run` still reports a `workspace-runtime.test.ts` timeout on the Mac mini.

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
