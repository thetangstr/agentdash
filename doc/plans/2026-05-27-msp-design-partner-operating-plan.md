# MSP Design Partner Operating Plan

**Purpose:** Prove AgentDash can help an MSP operator get useful work from a local agent company during week one without requiring deep PSA/RMM integrations or broad production automation.

**Launch stance:** AgentDash is the control plane. Hermes is the local execution harness for this pilot path.

## Why These Workflows

Recent MSP market signals point to three launch wedges:

- Operational efficiency: Kaseya's 2025 MSP benchmark highlights tool underuse, tool switching, lack of integration, and the need to connect RMM, PSA, backup, and documentation tools as major MSP bottlenecks ([Kaseya benchmark highlights](https://www.kaseya.com/blog/key-findings-from-kaseyas-2025-global-msp-benchmark-report/), [Kaseya growth trends](https://www.kaseya.com/blog/msp-benchmark-2025-growth-trends/)).
- Ticket handling and repetitive work: Kaseya reports MSPs using AI to reduce repetitive tasks and automate ticket handling, with the goal of reducing burnout and moving technicians toward higher-value work ([Kaseya growth trends](https://www.kaseya.com/blog/msp-benchmark-2025-growth-trends/)).
- Client-facing trust: MSP incident-management products emphasize SLA compliance, multi-client separation, status visibility, and AI-assisted reporting as MSP value drivers ([ilert MSP use case](https://www.ilert.com/use-cases/msp)).
- Security context: ConnectWise's 2025 MSP Threat Report points to ransomware, EDR evasion, edge-device targeting, vulnerability/patch management, continuous monitoring, and security-awareness needs as active MSP concerns ([ConnectWise MSP Threat Report](https://www.connectwise.com/company/press/releases/2025/02/msp-threat-report-2025)).

For week one, AgentDash should avoid risky direct writes into PSA/RMM systems. The best design-partner proof is a human-reviewed operator workflow where AgentDash turns messy MSP context into structured decisions, tasks, and customer-facing artifacts.

## Week-One Workflows

### 1. Ticket Concierge

**User:** service manager or dispatcher.

**Input:** 5-20 copied tickets, alerts, or ticket-export rows from the partner's PSA/helpdesk.

**AgentDash output:**

- classify by client, urgency, likely category, SLA risk, and missing information
- identify duplicate or related tickets
- propose next action and owner
- draft client-safe reply or internal technician note
- create AgentDash tasks for follow-up work

**Boundary:** no direct PSA writes in week one. A human copies approved notes/actions back into the PSA.

**Success metric:** operator accepts or lightly edits at least 60% of recommended triage actions.

### 2. Daily MSP Ops Briefing

**User:** owner, service manager, or vCIO.

**Input:** prior-day ticket export, open critical tickets, overnight alerts, and any manually pasted notes from the service team.

**AgentDash output:**

- top client risks today
- aging/SLA-risk tickets
- blocked technician handoffs
- security or backup concerns needing review
- 3-5 prioritized actions for the day

**Boundary:** briefing is advisory and must link back to supplied evidence. It does not claim complete visibility into PSA/RMM data unless the operator supplied complete data.

**Success metric:** briefing is useful enough to become part of the partner's morning routine by day three.

### 3. Client Value Report

**User:** MSP owner, account manager, or vCIO.

**Input:** completed work list, notable tickets, security/backup notes, and operator annotations for one friendly client.

**AgentDash output:**

- concise client-facing summary of work completed
- risks reduced or prevented
- recurring issue patterns
- recommended next steps
- internal follow-up tasks

**Boundary:** no sensitive client details leave the private Mac mini instance. Human review is required before any report is sent to a client.

**Success metric:** one report draft is sent or approved for use with minor edits.

### 4. Security Watchlist, Read-Only

**User:** security lead or senior technician.

**Input:** pasted alert summaries, vulnerability notes, patch backlog, or EDR/SIEM digest.

**AgentDash output:**

- rank by client impact and urgency
- identify missing context
- draft remediation checklist for human approval
- produce client-safe update language

**Boundary:** read-only. No endpoint, firewall, or identity remediation is performed by AgentDash during week one.

**Success metric:** at least one meaningful security follow-up is identified without increasing operational risk.

## Launch Cadence

| Day | Goal | Evidence |
| --- | --- | --- |
| Day 0 | Install Mac mini, pass readiness script, verify Hermes run | `scripts/msp-mac-mini-readiness.sh --run-backup` output, CoS transcript, agent run transcript |
| Day 1 | Ticket Concierge with sample tickets | triage output, accepted/rejected action notes |
| Day 2 | Daily MSP Ops Briefing | morning briefing artifact, operator usefulness rating |
| Day 3 | Repeat Ticket Concierge with live-but-sanitized data | number of accepted recommendations, friction notes |
| Day 4 | Client Value Report draft | report artifact, human review notes |
| Day 5 | Retro and launch decision | metrics, blocker list, go/no-go for more users |

Default check-in: 15 minutes daily at the partner's preferred morning operations time.

Default issue channel: one private `#agentdash-pilot` Slack channel or Google Chat space with the AgentDash launch owner, partner champion, and service manager. If the partner does not want chat, use a single email thread plus GitHub issue links for product defects.

Default response SLA during week one:

- P0 install/security/data-loss issue: same business day, interruptible
- P1 workflow blocker: next business day
- P2 product friction or feature request: captured for weekly triage

## Roles

| Role | Responsibility |
| --- | --- |
| AgentDash launch owner | Owns Mac mini readiness, PR status, daily check-ins, and product issue triage |
| Partner champion | Confirms business value, chooses pilot data, approves expansion |
| MSP service manager | Runs Ticket Concierge and Daily Ops Briefing workflows |
| Security reviewer | Confirms data boundaries, tailnet access, logs, and secret posture |

Named people must be filled in before week-one usage expands beyond the initial operator.

## Data Boundaries

- Use private-network access only.
- Do not paste passwords, API keys, SSH keys, OAuth tokens, seed phrases, or raw customer secrets.
- Do not paste regulated PHI, payment-card data, tax IDs, or HR records.
- Use sanitized tickets first; live ticket data is allowed only after the partner champion approves the boundary.
- Keep all PSA/RMM writes human-mediated during week one.
- Client-facing output must be reviewed by a human before sending.
- Security remediation remains advisory/read-only during week one.

## Success Metrics

- Time to first useful Hermes-backed CoS response.
- Time from ticket paste to accepted triage recommendation.
- Number of tickets triaged.
- Recommendation acceptance rate.
- Number of operator-created follow-up tasks.
- Agent run success rate.
- Operator time saved estimate.
- Partner trust/friction notes.
- Any data-boundary or security concerns raised.

## Expansion Criteria

Do not expand beyond the initial operator until:

- P0 gates in `doc/plans/2026-05-27-design-partner-launch-readiness.md` are complete.
- The partner has accepted at least one workflow output with real operational value.
- Backup/rollback evidence exists.
- The issue channel and response SLA are confirmed.
- The partner agrees which data classes may be used in AgentDash.
