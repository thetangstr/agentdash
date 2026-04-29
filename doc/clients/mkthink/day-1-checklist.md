# MKthink — Day-1 Live Walkthrough Checklist

**Use during:** the live Day-1 session with MKthink's CEO/COO.
**Time:** ~90 minutes (60 min walkthrough + 30 min Q&A).
**Pair this with:** [`doc/operator-playbook.md`](../../operator-playbook.md) — leave a copy with the operator after the session.

---

## Pre-flight (do these BEFORE the meeting)

| ✅ | Item | Owner |
|---|---|---|
| ☐ | AgentDash deployed on `TODO_SET_MKTHINK_URL` (cloud VM or self-hosted) | AgentDash team |
| ☐ | Health check passes — `curl -sf $URL/api/health` returns 200 | AgentDash team |
| ☐ | MKthink company seeded via `bash scripts/seed-mkthink.sh` (industry=construction, suggested templates pre-ranked) | AgentDash team |
| ☐ | HubSpot sandbox credentials acquired from MKthink's IT contact | AgentDash team |
| ☐ | HubSpot OAuth flow tested end-to-end with sandbox creds | AgentDash team |
| ☐ | At least 2 starter agents heartbeating (visible on `/agents`) | AgentDash team |
| ☐ | Kill switch tested in staging (halt → resume cycle works) | AgentDash team |
| ☐ | Operator playbook printed/shared with attendees | AgentDash team |
| ☐ | Anthropic API key configured (BYOT — confirm with MKthink which key) | MKthink + AgentDash |
| ☐ | AgentDash support Slack channel exists and the operator is invited | AgentDash team |

---

## Live walkthrough (60 min, with COO present)

### Block 1 — Dashboard tour (15 min)

| ✅ | Step | Talking points |
|---|---|---|
| ☐ | Open `/` and let them read the headline | "On-track" should be green; explain the daily routine is reading this line |
| ☐ | Click each top-level tile (MRR, daily burn, issues in flight, approvals) | Show what each metric means; show how to drill in |
| ☐ | Click an agent on the workforce strip | Show role, adapter, recent runs, current task |
| ☐ | Open `/issues` | Explain status pills; show how blocked/attention items surface |
| ☐ | Open `/approvals` | Show a real approval (or seed one); demonstrate one-click approve |

### Block 2 — Goal-setting & first agent (15 min)

| ✅ | Step | Talking points |
|---|---|---|
| ☐ | Open `/goals` → New Goal | Have COO type a real business goal in their words ("close 5 new construction contracts this quarter") |
| ☐ | Show how the Chief of Staff agent proposes a plan | Explain: agents don't just execute — they propose work for human approval |
| ☐ | Approve the proposed plan (or edit + approve) | Show that approval is the only "agent does something irreversible" gate |
| ☐ | Show the spawned issues for the first agent to pick up | Watch one agent grab the first issue from the queue |

### Block 3 — Kill switch + safety (10 min)

| ✅ | Step | Talking points |
|---|---|---|
| ☐ | Walk to Security page | This is the "stop everything" button — explain when to use it |
| ☐ | Click HALT ALL AGENTS → confirm | Watch the status flip; show audit trail |
| ☐ | Wait 30 seconds | Let the silence sink in — system is fully halted |
| ☐ | Click Resume All Agents | Status flips back to running; agents resume from their last checkpoint |
| ☐ | Show per-agent halt | Sometimes you only need to stop one agent, not all |

### Block 4 — HubSpot integration (10 min)

| ✅ | Step | Talking points |
|---|---|---|
| ☐ | Open `/connectors` and confirm HubSpot is connected | Sandbox first, then production after pilot week 1 |
| ☐ | Show a synced account in `/crm/accounts` | Same data, both directions; HubSpot remains source of truth |
| ☐ | Show a deal that has agent activity | Agent action timeline lives alongside HubSpot timeline |
| ☐ | Show webhook receiver is healthy | Real-time updates from HubSpot land in AgentDash within seconds |

### Block 5 — Daily routine handoff (10 min)

| ✅ | Step | Talking points |
|---|---|---|
| ☐ | Walk through the daily 60-sec routine | (per [`doc/operator-playbook.md`](../../operator-playbook.md) §Daily routine) |
| ☐ | Walk through the weekly ~30-min routine | (per playbook §Weekly routine) |
| ☐ | Show the escalation table | (per playbook §When something is wrong) |
| ☐ | Confirm Slack support channel is in their workspace | They should never feel stuck |

---

## Q&A (30 min)

Common questions to be ready for:

- **"What if an agent does something wrong?"** → kill switch, audit trail, every action is reversible at the data layer
- **"What does this cost us in LLM tokens?"** → BYOT model; daily burn card shows real-time spend; tier caps prevent runaway
- **"Can we add or remove agents anytime?"** → yes, spawn from templates in 2 clicks; retire from agent detail
- **"What about data security?"** → company-scoped data, no agent can see another company's data; policy engine blocks egress
- **"What if HubSpot goes down?"** → AgentDash queues changes; syncs when HubSpot returns

---

## Post-walkthrough — same day

| ✅ | Item | Owner |
|---|---|---|
| ☐ | Send the operator playbook + this checklist as PDFs | AgentDash team |
| ☐ | Confirm Day-1 kill switch test was logged in audit trail (proof it works) | AgentDash team |
| ☐ | Schedule daily Slack check-in for week 1 (5 min/day, async) | AgentDash team |
| ☐ | Schedule Day-7 review meeting | AgentDash team + COO |
| ☐ | Capture Day-1 baseline metrics (per [AGE-95](https://linear.app/agentdash/issue/AGE-95)) | AgentDash team |

---

## If something goes wrong during the walkthrough

- **Demo agent crashes mid-tour** → halt that agent only; show how the system isolates failure
- **HubSpot sync fails** → show retry logic + manual re-sync; reassure that data isn't lost
- **Kill switch doesn't reactivate** → known recovery path: `pnpm agentdash heartbeat-run` from CLI; if needed, escalate

The walkthrough succeeding is more important than the walkthrough being perfect. If you hit an issue, narrate it: "this is exactly why we test in pilot — let me show you the recovery." That builds trust faster than a perfect demo.
