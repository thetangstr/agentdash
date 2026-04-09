# AgentDash — Product Requirements Document

**Version:** 2.0
**Date:** 2026-04-08
**Status:** Active

---

## 1. Product Overview

**AgentDash** is an AI agent orchestration platform that lets companies deploy, manage, and scale AI agent workforces with human oversight. It sits between CRM/business systems (System of Record) and AI agent runtimes (System of Execution), serving as the **System of Action** — the brain that turns business intent into autonomous agent work.

**Tagline:** Your AI workforce, at a glance.

### Target Customers

| Segment | Company Size | AgentDash Angle |
|---------|-------------|-----------------|
| **SMB** | 10-50 people | Agents handle follow-ups, lead qualification, support tickets. BYOT (bring your own tokens). |
| **Mid-market** | 50-500 people | Agents run operational workflows, humans review escalations. HubSpot/Slack integration. |
| **Enterprise** | 500+ people | Agents as workforce layer, full governance, multi-pipeline, Salesforce sync. |

**First client:** SMB construction services company (MKthink) using HubSpot CRM.

### Core Value Proposition

- Deploy agents on your own infrastructure (BYOT) or use cloud runtime
- DAG-based pipeline orchestration with human-in-the-loop gates
- Plug into existing CRM and workflow tools (HubSpot, Slack, GitHub)
- Scale agent teams up/down dynamically based on workload
- Human oversight at decision points, autonomous execution elsewhere
- CRM as System of Action — agents read from and write to customer data

---

## 2. User Personas

### P1: Board Operator (CEO / Founder / Ops Lead)
- Oversees the AI workforce via daily dashboard (60-second morning scan)
- Approves spawn requests, reviews escalations, monitors spend
- Cares about: outcomes, cost, velocity, what needs attention

### P2: Department Lead (VP Eng / Growth Lead)
- Manages agents within a function, creates projects, sets goals
- Spawns additional agents when deadlines are tight
- Cares about: delivery timelines, task dependencies, team capacity

### P3: External Stakeholder (Customer / Partner)
- Interacts with agents indirectly through CRM, Slack, email
- May not know they're talking to an agent
- Cares about: responsiveness, quality, follow-through

---

## 3. Critical User Journeys

### CUJ-1: First-Time Setup (Onboarding)
**Persona:** P1 | **Goal:** Zero to working agent team in under 30 minutes

1. Deploy AgentDash (Docker, bare metal, or Railway)
2. Open dashboard → onboarding wizard (discovery, scope, goals, access, bootstrap)
3. System suggests initial agent team from templates (LLM-ranked) → approve
4. First agent heartbeat fires → agent picks up a task → work begins

**Status:** Fully Operational (11 API endpoints, 7 CUJ tests)

### CUJ-2: Morning Check-In (Daily Dashboard)
**Persona:** P1 | **Goal:** Understand company health in 60 seconds

1. Open dashboard → greeting + date + company name
2. Scan "Needs Attention" (errors, blocked tasks, pending approvals, budget alerts)
3. Glance at Team Pulse (agent status dots), check progress, skim activity feed

**Status:** Fully Operational (2 CUJ tests)

### CUJ-3: Scale the Team (Agent Factory)
**Persona:** P1/P2 | **Goal:** Spawn agents quickly from templates

1. Browse templates → select → spawn with quantity, reason, project
2. If approval required: request created → P1 reviews → agents created
3. New agents appear idle → assign tasks → agents begin work

**Status:** Fully Operational (11 endpoints, 9 CUJ tests)

### CUJ-4: Manage Task Dependencies (DAG)
**Persona:** P2 | **Goal:** Define task execution order

1. Create issues with dependencies → system validates no cycles (BFS)
2. Agent completes task → auto-unblock downstream → agents wake via heartbeat

**Status:** Backend Complete (5 endpoints, 6 CUJ tests). UI DAG visualization is P1.

### CUJ-5: Emergency Stop (Kill Switch)
**Persona:** P1 | **Goal:** Instantly halt all agent activity

1. Security page → "HALT ALL AGENTS" → confirm
2. All agents paused, heartbeats cancelled, audit trail logged
3. Investigate → "Resume All Agents" when resolved

**Status:** Fully Operational (3 endpoints, 4 CUJ tests)

### CUJ-6: Pipeline Orchestration (DAG Workflows)
**Persona:** P1/P2 | **Goal:** Run multi-stage agent workflows with automated routing

1. Create pipeline with stages (agent tasks, HITL gates, conditions) and edges (DAG)
2. Trigger run → entry stages launch → agents execute → stages auto-advance
3. Fan-out (parallel branches), fan-in (merge with wait-all/first-wins), conditional routing
4. HITL gates pause for human approval → approve/reject → pipeline continues/stops
5. Self-healing: failed stages get diagnosed and retried with adjusted instructions
6. Budget tracking per stage, CRM lifecycle hooks on completion

**Status:** Fully Operational (10 endpoints). Pipeline wizard and run detail UI complete.

### CUJ-7: CRM Pipeline Review
**Persona:** P1 | **Goal:** See customer pipeline, deals, leads, partner status

1. Pipeline page → summary cards (value, accounts, leads, deals, partners)
2. Pipeline by stage (deal count + value per stage)
3. Review deals, check leads, review partners
4. HubSpot bidirectional sync (contacts, companies, deals, activities)

**Status:** Fully Operational (31 endpoints, 8 CUJ tests)

### CUJ-8: Research Cycle (AutoResearch)
**Persona:** P1/P2 | **Goal:** Run hypothesis-driven experiment loops

1. Create research cycle linked to a goal → agent generates hypotheses
2. Human approves hypothesis → experiment designed with budget/time limits
3. Agent executes → measurements collected → evaluation produces verdict
4. Loop continues until goal met or budget exhausted

**Status:** Backend Complete (21 endpoints, 7 CUJ tests). Detail pages P1.

### CUJ-9: Security Policy Configuration
**Persona:** P1 | **Goal:** Define what agents can and cannot do

1. Security page → add policy (5 types: resource_access, action_limit, data_boundary, rate_limit, blast_radius)
2. Target: all agents, specific role, or specific agent
3. Policy evaluates on hot path → action denied/escalated → audit trail

**Status:** Fully Operational (14 endpoints, 5 CUJ tests)

### CUJ-10: Skill Management
**Persona:** P2 | **Goal:** Author, review, and deploy agent skills

1. Create skill → new version (draft → in_review → approved → published → deprecated)
2. Review workflow ties into approval system
3. Usage analytics by skill and agent

**Status:** Backend Complete (17 endpoints, 6 CUJ tests). Version UI P1.

### CUJ-11: Budget Monitoring & Forecasting
**Persona:** P1 | **Goal:** Understand spend, forecast costs, track ROI

1. Costs page → spend by agent/project
2. Capacity dashboard → burn rate, trend, days-until-exhaustion
3. Multi-resource tracking (LLM tokens, compute, SaaS APIs)

**Status:** Backend Complete (16 endpoints, 6 CUJ tests). Forecast UI P1.

### CUJ-12: CRM Customer 360
**Persona:** P1 | **Goal:** See everything about a customer in one place

1. Accounts list → search/filter by stage → click account
2. Account detail: header, metrics strip, contacts tab, deals tab, activity timeline, agent history
3. Activity timeline intermixes HubSpot-synced data with agent-generated actions
4. Each entry shows: timestamp, actor (agent/Board/HubSpot), description, metadata

**Status:** Backend Complete (APIs exist). UI pages P0.

### CUJ-13: Agent Impact on Customer
**Persona:** P1 | **Goal:** Trust the system by seeing what agents did for a customer

1. Open account detail → activity timeline shows pipeline stages, action proposals, CRM updates
2. See totals: tickets resolved autonomously, escalated to human, cost saved
3. Deal stages auto-advance when agents complete linked work (lifecycle hooks)

**Status:** Backend Complete (lifecycle hooks implemented). UI P1.

---

## 4. CRM Architecture

AgentDash CRM is **not** a System of Record (that's HubSpot/Salesforce). It's a **System of Action** — the layer where AI agent decisions execute against customer data.

| Layer | Purpose | Who Owns It |
|-------|---------|-------------|
| System of Record | Master customer data | HubSpot, Salesforce |
| System of Engagement | Where interactions happen | Zendesk, Intercom, email |
| **System of Action** | Where AI decisions execute | **AgentDash** |

### Lifecycle Stages

**Accounts:** prospect → active → customer → champion → churned (auto-advances via lifecycle hooks)

**Deals:** lead → qualification → proposal → negotiation → closed_won / closed_lost (auto-advances when linked issues complete)

**Leads:** new → contacted → qualified → converted / lost (conversion creates account + contact)

### What We Do NOT Build
- Email/communication integration (HubSpot owns channels)
- Marketing automation, drip campaigns
- Revenue forecasting engine
- Custom object builder

---

## 5. Deployment Modes

### Local (Mac Mini / Bare Metal)
- `pnpm dev` or `./scripts/demo.sh` for one-command demo
- Embedded PostgreSQL, all adapters available (CLI-based)
- Best for: development, demos, single-company deployments

### Docker (Self-Hosted)
- `docker compose up` with `BETTER_AUTH_SECRET` and optional API keys
- Single container with embedded PG, volume-persisted data
- Best for: small teams, on-premise deployments

### Cloud (Railway / Hosted)
- Railway one-click deploy with external PostgreSQL
- `claude_api` adapter for cloud-native agent execution (no CLI dependency)
- Best for: SaaS, multi-tenant, scalable deployments

### Hybrid
- Hosted UI + API server in cloud, local agent runtime on customer hardware
- Agents connect back to cloud API via webhook/polling
- Best for: customers with strict data residency or air-gapped networks

---

## 6. Technical Summary

- **86 schema tables** across 60 migrations
- **83 services** across all domains
- **200+ API endpoints** across 39 route modules
- **62 UI pages** (Pipelines, Action Proposals, Feed, CRM, Budget, Research, Onboarding, Security, Capacity, Templates, Skills, and more)
- **11 agent adapters**: Claude (local + API), Codex, Cursor, Gemini, OpenCode, Pi, OpenClaw, Hermes, Process, HTTP
- **4 integration manifests**: HubSpot (operational), Slack, GitHub, Linear

---

## 7. Open Items

### P0 (First Client)
- [ ] HubSpot connector implementation (beyond manifest — bidirectional sync is done, need deeper automation triggers)
- [ ] CRM UI pages: account list, account detail with activity timeline, contacts list
- [ ] LLM integration in onboarding (context extraction works, team suggestion works — needs polish)
- [ ] Cloud deployment hardening (external PG, health monitoring)

### P1 (Important)
- [ ] Task dependency DAG visualization UI
- [ ] AutoResearch cycle detail pages
- [ ] Skill version management UI
- [ ] Budget forecast display in Capacity page
- [ ] Agent OKR display on Agent Detail page
- [ ] Deal detail page, leads list with convert action
- [ ] License key system for tier gating

### P2 (Nice to Have)
- [ ] Slack/GitHub/Linear plugin implementations
- [ ] Multi-tenant SaaS mode with tenant isolation
- [ ] Helm chart for Kubernetes deployment
- [ ] White-labeling support
- [ ] Distributed execution (web + worker split, Redis pub/sub, job queue)
