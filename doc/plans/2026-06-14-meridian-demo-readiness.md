# Meridian Pay × Clockchain — Demo Readiness Plan & Validation

**Date:** 2026-06-14 · **Owner:** demo prep · **Status:** validating

## The story this demo proves

Meridian Pay is a vendor-disbursement business run by a CoS-led team of AI agents. Every
consequential action — payments, KYB, fraud calls, reconciliations, audits — is
cryptographically **attested on the Clockchain testnet** with verifiable consensus time,
producing regulator-ready, tamper-evident proof. The agents don't just *log* to Clockchain;
they **call the Clockchain MCP themselves** during their runs.

Three things make it land:
1. A real, lived-in company (vision → team goals → ~40 tasks across statuses, ~4 weeks of history).
2. Each of the 7 agents uses a **distinct** Clockchain MCP capability tied to its job.
3. The receipts are **real on-chain anchors** anyone can re-verify, not mock data.

## Demo-ready criteria (validation checklist)

| # | Criterion | How validated | Status |
|---|---|---|---|
| C1 | Server healthy, reachable on the demo URL | `GET /api/health` | ✅ |
| C2 | Coherent goal tree (one vision → team goals, no duplicates) | API list | ✅ dup folded in as achieved wk-1 pilot |
| C3 | ~40 issues across all 6 statuses, backdated to look lived-in | API counts + dates | ✅ (41, 6 statuses, 05-17→06-11) |
| C4 | All "done" issues carry a real Clockchain receipt comment | API per-issue comments | ✅ (25 done w/ receipts) |
| C5 | Each agent maps to a DISTINCT MCP feature; all on MiniMax-M2.7-highspeed | API adapterConfig + task descriptions | ✅ |
| C6 | Agents genuinely call the MCP (not just seeded) | live agent run | ✅ (Probe MER-41, Onboard) |
| C7 | End-to-end autonomy works (agent self-persists + closes) | live run, no interruption | ✅ (Probe MER-41) |
| C8 | At least one receipt re-verifies on-chain live | MCP `get_log_entry`/`verify_*` | ✅ Vega $180k ledger a8b40093, keyless match @block 3746557 |
| C9 | Stable, safe state for handoff (agents paused, box healthy) | API agent status | ✅ (7/7 paused) |
| C10 | Access path documented (URL + login) | runbook | ✅ (below) |
| C11 | Org chart shows CoS-led hierarchy (Atlas → 6 reports, real titles) | org.png render | ✅ fixed (was flat under generic root) |
| C12 | App serves on the demo URL | browser load | ✅ landing renders; logged-in view needs owner sign-in |

## Validation result (2026-06-14): READY FOR DEMO ✅

All 12 criteria pass. Gaps found and fixed during validation: (C2) duplicate weekly goal folded into the
vision tree as an "achieved" week-1 pilot; (C11) org chart was flat under a generic "Organization" root —
reset so Atlas (Chief of Staff) is the root with the other 6 reporting to it, each given a real job title.

Evidence: org chart asset at `~/Downloads/meridian-pay-org-chart.png`; receipt `a8b40093` re-verified
keyless on-chain (anchoredHash matches; chain head live at block ~3.79M).

**Open item for the demo driver:** the only thing I can't do is log into the company UI (entering a
password is out of scope), so the visual click-through must be done signed in as `kailortang@gmail.com`.
NOTE: the user's browser was found logged into the **old Studio instance** (`mac-studio.tailcbe14e.ts.net`)
— demo MUST use the **mini** (`http://100.71.225.125:3100`), which is where this whole build lives.

## Demo walkthrough script (5–7 min)

1. **Open the company** — `http://100.71.225.125:3100` (tailnet) or `http://192.168.86.48:3100` (LAN), log in as `kailortang@gmail.com`. Land on Meridian Pay.
2. **The vision & goals** — show the company goal "Become the court-grade standard for agentic vendor disbursements" and its 4 team goals (weekly disbursement, audit-readiness, zero-fraud onboarding, sub-second settlement).
3. **The org** — 7 agents (Atlas CoS + Vega/Onboard/Sentinel/Tally/Ledger/Probe), each a clear role.
4. **The board** — ~40 tasks across done/in-progress/todo/backlog/blocked; ~4 weeks of history. Pick a done payment task (Vega, Northwind $180k).
5. **The proof** — open that task's Clockchain receipt comment: ledgerId + block height. Each agent's done tasks show *its* MCP tool (attest_action / mint_identity / verify_cross_party / log_action / build_evidence_package / get_time / delegate_authority).
6. **Live, if desired** — unpause one agent, give it a task, let it run (don't pause mid-run): it calls the Clockchain MCP and posts a real receipt itself. (Proven with Probe → MER-41.)
7. **Verify anywhere** — take a ledgerId and re-verify it on-chain via the hosted MCP (`mcp.clockchain.network`).

## Agent → MCP capability map

| Agent | Role | Clockchain MCP feature(s) |
|---|---|---|
| Atlas | Chief of Staff | mint_identity, delegate_authority, generate_compliance_report |
| Vega | Disbursements | attest_action, verify_receipt |
| Onboard | Vendor KYB | mint_identity, delegate_authority, get_identity_history |
| Sentinel | Fraud / security | verify_cross_party, verify_identity_at, revoke_identity |
| Tally | Reconciliation | log_action, verify_asset, search_actions |
| Ledger | Audit / evidence | build_evidence_package, generate_audit_trail, get_log_entry |
| Probe | Consensus / SLA | get_time, get_validation, verify_package, get_timestamp |

## Known limitations / talk-track

- **Single-validator testnet** — workflow + proofs are real; mainnet adds multi-validator supermajority.
- **Agent auth flakiness** — agents hand-build API callbacks and occasionally retry on a 401 before succeeding; they complete tasks **as long as they aren't paused mid-run**. Hardening tracked: `x-agent-key` server fix (PR #401, deployed to mini as a working-tree patch) + a future move to structured Paperclip MCP tools.
- **Mini deploy** — runs a working-tree patch at pinned SHA `ab48dc14`; permanent path = merge #401 + re-pin.
- **Keep agents paused** between demos (heartbeat mass-spawn safety).
