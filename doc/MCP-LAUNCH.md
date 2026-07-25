# MCP Launch Runbook — 2026-07-24

**Fresh Mac mini → self-driving AgentDash via a local Claude Code agent.**

Audience: the founder or a technician standing up a brand-new customer Mac mini.
Everything below is copy-pasteable.

## 0. What this flow is

A local Claude Code agent, connected to the AgentDash MCP server
(`packages/mcp-server`), drives the entire customer lifecycle on the machine:
install and boot the AgentDash server, run the deep-interview onboarding with
the customer, provision their company and agent team, and keep operating the
workspace afterwards. The agent works autonomously through a
status → next-action loop, but every risky action (hiring beyond the confirmed
plan, budget changes, resuming paused agents) is gated behind human approval in
the AgentDash UI at `/approvals`. You watch and approve; the agent does the
work.

## 1. Prerequisites

- macOS (Apple Silicon Mac mini, fresh or wiped)
- Node.js 20+ (`node --version`)
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- git (`xcode-select --install` if missing)
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`) and
  logged in with a subscription (`claude` → follow the login prompt)
- The AgentDash repo cloned to `~/agentdash`

## 2. Add the MCP server to Claude Code

Production shape (after `pnpm --filter @agentdash/mcp-server build` has produced
`dist/`):

```sh
claude mcp add agentdash \
  --env PAPERCLIP_API_URL=http://localhost:3100 \
  --env PAPERCLIP_API_KEY=<agent-key> \
  -- node ~/agentdash/packages/mcp-server/dist/stdio.js
```

Pre-build dev variant (runs straight from TypeScript source):

```sh
claude mcp add agentdash \
  --env PAPERCLIP_API_URL=http://localhost:3100 \
  --env PAPERCLIP_API_KEY=<agent-key> \
  -- pnpm --dir ~/agentdash exec tsx packages/mcp-server/src/stdio.ts
```

### Fresh install: MCP-native signup (no browser form)

On a fresh machine there is no server, no user, and no API key yet. That is
expected — `PAPERCLIP_API_KEY` is **optional** and the whole claim happens
through the MCP server:

1. First run, add the MCP server **without** a key (just omit the
   `PAPERCLIP_API_KEY` env line). The unauthenticated tools —
   `agentdash_install_checklist` and `agentdash_setup_status` — work
   immediately and walk the agent through install and first boot.
2. Once the server is healthy, `agentdash_setup_status` reports phase
   `sign_up` on a fresh authenticated-mode instance (requires
   `AGENTDASH_SELF_SERVE_BOOTSTRAP=true` in the server env). The agent asks
   the customer for their email **in conversation** and runs
   `agentdash_sign_up` — the server creates the founding user, promotes them
   to instance admin, and returns a board API key. No browser signup form,
   no password (set one later via "Forgot password" on the web UI). The
   session continues authenticated immediately.
3. Persist the returned key so future sessions stay signed in:

```sh
claude mcp remove agentdash
claude mcp add agentdash \
  --env PAPERCLIP_API_URL=http://localhost:3100 \
  --env PAPERCLIP_API_KEY=<key-returned-by-agentdash_sign_up> \
  -- node ~/agentdash/packages/mcp-server/dist/stdio.js
```

`agentdash_sign_up` only works while the instance has ZERO users — the moment
anyone exists it answers `409 instance_already_claimed`, forever.

## 3. The kickoff prompt

Start `claude` in `~/agentdash` and paste this verbatim:

```text
You are setting up AgentDash for a new customer on this Mac mini. Read the
agentdash://playbook resource first.

Operating loop: call agentdash_setup_status, execute its nextAction, verify
the result, and repeat until the customer's company is provisioned and its
agents are running. If the server is not installed yet, follow
agentdash_install_checklist step by step. On a fresh install, sign the
customer up first with agentdash_sign_up — ask them for their email; never
invent one.

Interview the customer conversationally (deep-interview) to understand their
business, goals, and constraints before confirming any plan. Use
agentdash_start_interview and agentdash_interview_turn; only call
agentdash_confirm_plan after the customer has explicitly agreed to the
proposed agent team.

BOUNDARIES:
- Never hire agents beyond the confirmed plan.
- Never delete anything or change budgets.
- Never resume agents a human has paused.
- For any such action, call agentdash_request_approval and WAIT for the
  approval to be granted in the AgentDash UI (/approvals). Do not proceed
  on a pending or rejected approval.
- If blocked for any other reason, stop and create a task for the human
  describing exactly what you need.
```

## 4. The approval flow

When the agent calls `agentdash_request_approval`, a card appears in the
AgentDash UI under **Approvals** (`http://localhost:3100/approvals`), and as a
"needs your call" card on the Overview page. The five approval types:

| Type | Requested when |
|------|----------------|
| `hire_agent` | Agent wants to add a team member beyond the confirmed plan |
| `approve_ceo_strategy` | A CEO-level strategy proposal needs sign-off |
| `budget_override_required` | An action would exceed a configured budget |
| `request_board_approval` | Anything the playbook marks board-level |
| `resume_paused_agent` | Agent wants to resume a human-paused agent |

**Approve** executes the gated action and unblocks the agent's loop on its next
`agentdash_setup_status` poll. **Reject** cancels the action; the agent must
carry on without it (or create a task for the human explaining the impact).
Nothing gated ever executes while the request is pending.

## 5. Verification checklist

Run these after the agent reports the company is provisioned:

```sh
# 1. Server healthy
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/api/health   # expect 200

# 2. Company exists (in the UI: Overview shows the company name)
open http://localhost:3100

# 3. N agents running — Overview "agent fleet" shows the confirmed team,
#    with the status pill showing "N running" (not "all idle")

# 4. Test task round-trip: create a small task in the UI (or ask the agent
#    to), watch an agent pick it up, and confirm it reaches "done" with
#    activity logged.
```

All four pass → the mini is self-driving. Leave the Claude Code session
running (or wire it into launchd per `doc/LAUNCH.md`).

## 6. Troubleshooting

| Symptom | Fix |
|---------|-----|
| MCP tools error "connection refused" / server not up | `cd ~/agentdash && pnpm dev` (or the launchd service); re-check `curl http://localhost:3100/api/health`. `agentdash_install_checklist` still works without the server. |
| `401` from authenticated tools | The `PAPERCLIP_API_KEY` is missing, stale, or a placeholder. Get the real agent key (bootstrap output, or the agent's Keys panel in the UI) and re-add the MCP server with it (section 2). |
| `503` from `agentdash_start_interview` / `agentdash_interview_turn` | No LLM adapter is configured on the server, so the interview brain can't run. Set `AGENTDASH_DEFAULT_ADAPTER=minimax` (or another configured adapter) per the environment guidance in `doc/LAUNCH.md`, restart the server, retry. |
| Interview stalls mid-way | Call `agentdash_setup_status` — it reports the resumable state and `nextAction`. |
| Agent tries a gated action and hangs | Check `/approvals`; a pending card is waiting for you. |

## 7. See also

- [`doc/LAUNCH.md`](LAUNCH.md) — full clean-clone → production launch guide
  (env vars, Stripe, deploy, launchd)
- [`doc/customers/mkthink/`](customers/mkthink/) — the first real customer
  install: onsite operating procedure, remote support access
- [`packages/mcp-server/README.md`](../packages/mcp-server/README.md) — MCP
  server tool reference and per-client (Claude Desktop, Cursor) config
