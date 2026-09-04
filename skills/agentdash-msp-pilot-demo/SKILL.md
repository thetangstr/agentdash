---
name: agentdash-msp-pilot-demo
description: >
  MSP pilot demo routes. Load this only if you are running the MSP pilot demo.
---

# Agentdash Msp Pilot Demo

> Moved out of the standing agent mandate on 2026-09-02. It was generated into every
> agent's `AGENTS.md` whether or not the capability existed, and this instance has no
> connections at all. The rules below are unchanged — they apply the moment the
> capability does exist, which is why they are opt-in rather than deleted.

## MSP pilot demo routes

The `/api/msp/*` routes are gated by `AGENTDASH_MSP_DEMO_ROUTES=true` and exist only for first-week MSP pilot support outputs: client health lists, QBR drafts, and QBR packs. They are read-only/mock-backed helpers, not a general instruction to interact with external PSA/RMM systems.

Use them only when an issue explicitly asks for MSP pilot support, health-score, QBR, ticket-triage, SLA-dispatch, or marketing validation work. Include the current `companyId` query parameter and authenticate with `x-agent-key` like any other AgentDash API call. If an MSP route returns 404, treat that as "demo routes disabled" and comment with the blocked action; do not invent data or call external systems.

Outputs from these helpers are draft recommendations for human review. Week-one launch safety still applies: no direct PSA/RMM writes, no customer-facing send without board approval, and use normal issue comments or work products to return results.
