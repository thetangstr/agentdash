# AgentDash — Product Requirements Document

**Version:** 1.0
**Date:** 2026-03-28
**Status:** Draft — Needs Review

---

## 1. Product Overview

**AgentDash** is an AI agent orchestration platform that lets companies deploy, manage, and scale AI agent workforces with human oversight. It sits between CRM/business systems (System of Record) and AI agent runtimes (System of Execution), serving as the **System of Action** — the brain that turns business intent into autonomous agent work.

**Tagline:** Your AI workforce, at a glance.

**Target customers:**
- SMBs deploying 5-20 AI agents to augment existing teams
- Enterprises deploying 20-200+ agents across departments
- First client: SMB using HubSpot CRM

**Core value proposition:**
- Deploy agents on your own infrastructure (BYOT — bring your own tokens)
- Plug into existing CRM and workflow tools (HubSpot, Slack, GitHub)
- Scale agent teams up/down dynamically based on workload
- Human oversight at decision points, autonomous execution elsewhere

---

## 2. User Personas

### P1: Board Operator (CEO / Founder / Ops Lead)
- The human who oversees the AI workforce
- Checks the dashboard daily (60-second morning scan)
- Approves spawn requests, reviews escalations, monitors spend
- Cares about: outcomes, cost, velocity, what needs attention

### P2: Department Lead (VP Eng / Growth Lead)
- Manages agents within a function
- Creates projects, sets goals, assigns work
- Spawns additional agents when deadlines are tight
- Cares about: delivery timelines, task dependencies, team capacity

### P3: External Stakeholder (Customer / Partner)
- Interacts with agents indirectly through CRM, Slack, email
- May not know they're talking to an agent
- Cares about: responsiveness, quality, follow-through

---

## 3. Critical User Journeys (CUJs)

### CUJ-1: First-Time Setup (Onboarding)

**Persona:** P1 (Board Operator)
**Trigger:** New customer deploys AgentDash
**Goal:** Go from zero to a working agent team in under 30 minutes

**Flow:**
1. Deploy AgentDash (Docker or bare metal)
2. Open dashboard at localhost:3100 — see onboarding wizard
3. **Discovery step:** Enter company info (paste description, upload docs, or connect to wiki)
4. **Scope step:** Choose operating mode (whole company / department / team / project)
5. **Goals step:** Define 1 company goal + 2-3 team goals with measurable KPIs
6. **Access step:** Set up primary overseer (name, email), configure approval requirements
7. **Bootstrap step:** System suggests initial agent team from templates → approve → agents created
8. First agent heartbeat fires → agent picks up an assigned task → work begins

**Success criteria:**
- [ ] User has a working agent team within 30 minutes
- [ ] At least 1 agent has completed a task within 2 hours of setup
- [ ] User understands how to check status via the dashboard

**Current state:** Onboarding wizard UI exists (/setup route). Backend services exist (onboarding.ts with 12 methods). Context extraction is placeholder (needs LLM integration). Team suggestion returns all templates (needs LLM ranking).

---

### CUJ-2: Morning Check-In (Daily Dashboard)

**Persona:** P1 (Board Operator)
**Trigger:** Start of workday
**Goal:** Understand company health in 60 seconds

**Flow:**
1. Open AgentDash dashboard
2. See greeting + date + company name
3. **Scan "Needs Attention"** section:
   - Any agent errors? → click to investigate
   - Any blocked tasks? → click to unblock or reassign
   - Any pending approvals? → click to approve/reject
   - Budget incidents? → click to review
   - If all clear: green "All clear" banner → done
4. **Glance at Team Pulse:** See agent count and status dots (green/amber/red)
5. **Check Progress:** Tasks completed this month, spend vs budget
6. **Skim Recent Activity:** What happened since yesterday
7. Close dashboard, go about their day

**Success criteria:**
- [ ] User can assess company health in under 60 seconds
- [ ] Attention items are prominently displayed with clear actions
- [ ] No information overload — show exceptions, not norms
- [ ] Works on mobile (responsive)

**Current state:** Dashboard redesigned to morning briefing layout. Attention items, team pulse, progress summary, activity feed all implemented. Fetches from existing dashboard API.

---

### CUJ-3: Scale the Team (Agent Factory)

**Persona:** P2 (Department Lead) or P1 (Board Operator)
**Trigger:** Aggressive deadline, increased workload, or new project
**Goal:** Spawn additional agents quickly from templates

**Flow:**
1. Go to Templates page → browse available agent templates
2. Select a template (e.g., "Frontend Engineer")
3. Click "Spawn" → enter quantity (e.g., 3), reason, target project
4. If approval required: spawn request created → P1 reviews in Approvals
5. If no approval required (P1 acting): agents created immediately
6. New agents appear in Agents list with status "idle"
7. Assign tasks to new agents → agents begin work via heartbeat
8. Monitor progress via Capacity dashboard

**Success criteria:**
- [ ] Spawn 3 agents from a template in under 2 minutes
- [ ] Approval flow works end-to-end (request → approve → agents created)
- [ ] New agents have correct role, skills, OKRs from template
- [ ] Capacity dashboard shows updated workforce snapshot

**Current state:** Agent templates CRUD, spawn requests with approval integration, OKR assignment all implemented. 93+ API endpoints. Template page exists in UI. Spawn UI needs a "Spawn from template" dialog (currently button placeholder).

---

### CUJ-4: Manage Task Dependencies (DAG)

**Persona:** P2 (Department Lead)
**Trigger:** Creating a project plan with dependent tasks
**Goal:** Define task execution order so agents work on the right things in the right sequence

**Flow:**
1. Create issues for a project (e.g., "Design API" → "Build endpoints" → "Write tests")
2. Add dependencies: "Build endpoints" blocked by "Design API", "Write tests" blocked by "Build endpoints"
3. System validates no circular dependencies
4. Assign "Design API" to an agent → agent works on it
5. Agent completes "Design API" → status changes to "done"
6. **Auto-unblock:** "Build endpoints" transitions from "blocked" to "todo"
7. Assigned agent gets woken up via heartbeat → starts "Build endpoints"
8. Chain continues automatically until all tasks complete

**Success criteria:**
- [ ] Dependencies can be added/removed via API
- [ ] Circular dependency detection prevents invalid DAGs
- [ ] Auto-unblocking works end-to-end (tested and verified)
- [ ] Agent wakeup fires when dependencies resolve
- [ ] Dependency graph viewable for a project

**Current state:** Fully implemented and tested. addDependency, detectCycle (BFS), processCompletionUnblock with auto-wakeup all working. API endpoints exist. Dependency graph endpoint exists. No UI for visualizing the graph yet.

---

### CUJ-5: Emergency Stop (Kill Switch)

**Persona:** P1 (Board Operator)
**Trigger:** Agent misbehavior, security concern, or budget emergency
**Goal:** Instantly halt all agent activity

**Flow:**
1. Go to Security page
2. See kill switch panel at top
3. Click "HALT ALL AGENTS" → confirm
4. All agents immediately paused (status = paused, reason = kill_switch)
5. All active heartbeat runs cancelled
6. Dashboard shows halted state
7. Investigate the issue
8. When resolved: click "Resume All Agents" → agents return to idle

**Success criteria:**
- [ ] All agents halt within 5 seconds of clicking
- [ ] Halt is logged in audit trail
- [ ] Resume restores agents to previous state
- [ ] Kill switch status visible on dashboard
- [ ] Works for company-wide and per-agent scope

**Current state:** Kill switch fully implemented — activate, resume, status. Tested end-to-end. Security page UI has the kill switch panel with halt/resume buttons.

---

### CUJ-6: CRM Pipeline Review

**Persona:** P1 (Board Operator)
**Trigger:** Revenue review, pipeline check
**Goal:** See customer pipeline, deals, leads, and partner status

**Flow:**
1. Click "Pipeline" in CRM sidebar section
2. See summary cards: pipeline value, accounts, leads, deals, partners
3. See pipeline by stage (deal count + value per stage)
4. Review recent deals table
5. Check new leads
6. Review partner relationships
7. (Future) Deals sync bidirectionally with HubSpot

**Success criteria:**
- [ ] Pipeline page loads with summary data
- [ ] All CRM entities visible (accounts, contacts, deals, leads, partners)
- [ ] Data syncs with HubSpot (when connector is active)
- [ ] Agents can read customer context for informed decision-making

**Current state:** CRM schema complete (6 tables: accounts, contacts, deals, activities, leads, partners). CRM service with 30+ methods. 25 API endpoints. CrmPipeline UI page created and wired into router + sidebar. HubSpot plugin manifest created (implementation pending).

---

### CUJ-7: Research Cycle (AutoResearch)

**Persona:** P1 or P2
**Trigger:** Company has a measurable goal and wants to experiment to achieve it
**Goal:** Run hypothesis-driven experiment loops automatically

**Flow:**
1. Go to Research page → click "New Research Cycle"
2. Link to a company goal (e.g., "Reach 50K monthly visitors")
3. Research agent generates hypotheses (e.g., "Social sharing will increase organic acquisition by 20%")
4. Human approves a hypothesis for testing
5. Experiment is designed: success criteria, budget cap, time limit
6. Human approves experiment → agent team executes
7. Measurement window: metrics collected automatically
8. Evaluation: system analyzes results, produces verdict
9. Next hypothesis generated or cycle completes

**Success criteria:**
- [ ] Research cycle tied to a goal with measurable success criteria
- [ ] Human approval gates at hypothesis and experiment stages
- [ ] Budget caps and time limits enforced per experiment
- [ ] Evaluation produces clear verdict (validated/invalidated/inconclusive)
- [ ] Loop continues automatically until goal met or budget exhausted

**Current state:** Full schema (6 tables), service (22 methods), API (21 endpoints), constants. Research dashboard page in UI. Metrics integration layer defined (plugin-based). No LLM integration yet for hypothesis generation.

---

### CUJ-8: Security Policy Configuration

**Persona:** P1 (Board Operator)
**Trigger:** Setting up governance rules for agents
**Goal:** Define what agents can and cannot do

**Flow:**
1. Go to Security page
2. See existing policies in table
3. Click "Add Policy" → configure:
   - Name (e.g., "No production deploys")
   - Type (action_limit, resource_access, rate_limit, etc.)
   - Target (all agents, specific role, specific agent)
   - Rules (e.g., deploy_prod requires approval)
   - Effect (deny/allow)
   - Priority
4. Policy takes effect immediately
5. When an agent triggers the policy → action denied/escalated → logged in audit trail
6. Review policy evaluations in audit log

**Success criteria:**
- [ ] Policies enforceable before agent actions
- [ ] 5 policy types: resource_access, action_limit, data_boundary, rate_limit, blast_radius
- [ ] Audit trail of all policy evaluations
- [ ] Agent sandboxes configurable (isolation level, network/filesystem policies)

**Current state:** Full schema (4 tables), service (12 methods), API (12 endpoints), UI page. Policy evaluation runs on hot path. Audit log is append-only.

---

### CUJ-9: Skill Management

**Persona:** P2 (Department Lead) or P1
**Trigger:** Creating or updating agent skills
**Goal:** Author, review, and deploy skills with version control

**Flow:**
1. Go to Skills page → see existing skills
2. Create or edit a skill → new version created as "draft"
3. Submit for review → creates an approval
4. Reviewer approves → version status = "approved"
5. Publish → skill becomes active, injected into agents at runtime
6. View analytics: which skills are used, by which agents, with what outcomes
7. Deprecate old versions when no longer needed

**Success criteria:**
- [ ] Skills are versioned (sequential version numbers)
- [ ] Review workflow: draft → in_review → approved → published → deprecated
- [ ] Skill dependencies tracked with circular dependency prevention
- [ ] Usage analytics available (by skill, by agent, outcome correlation)
- [ ] Publishing copies skill content to active agent runtime

**Current state:** Full schema (3 tables), services (skills-registry 11 methods + skill-analytics 5 methods), API (17 endpoints). UI page exists for skills. Version review workflow ties into existing approval system.

---

### CUJ-10: Budget Monitoring & Forecasting

**Persona:** P1 (Board Operator)
**Trigger:** Monthly budget review or cost concern
**Goal:** Understand spend, forecast future costs, track ROI

**Flow:**
1. Go to Costs page → see current spend by agent/project
2. Go to Capacity dashboard → see budget forecasts
3. Check burn rate: daily average, trend (up/down), days until exhaustion
4. Check project ROI: cost per completed task
5. Review resource usage beyond LLM tokens (compute, SaaS APIs)
6. Adjust budget allocations between departments/projects
7. Set alert thresholds for early warning

**Success criteria:**
- [ ] Hierarchical budgets: company → department → project → agent
- [ ] Burn rate calculation with trend
- [ ] Days-until-exhaustion projection
- [ ] ROI per project (cost vs. outcomes)
- [ ] Multi-resource tracking (not just LLM tokens)

**Current state:** Full schema (4 tables), services (budget-forecasts 9 methods + capacity-planning 5 methods), API (16 endpoints). Capacity dashboard page in UI. Departments table supports hierarchy. Budget allocations support flexible parent-child relationships.

---

## 4. Feature Inventory

| Feature | Schema | Service | API | UI | Status |
|---------|--------|---------|-----|-----|--------|
| Agent Templates | agent_templates | agentFactoryService | 5 endpoints | Templates page | Complete |
| Spawn Requests | spawn_requests | agentFactoryService | 3 endpoints | Needs spawn dialog | Backend complete, UI partial |
| Agent OKRs | agent_okrs, agent_key_results | agentFactoryService | 3 endpoints | Needs OKR display | Backend complete, UI missing |
| Task Dependencies | issue_dependencies | taskDependencyService | 5 endpoints | Needs DAG viz | Backend complete, tested |
| Prompt Builder | — | promptBuilderService | — (heartbeat hook) | — | Complete |
| Security Policies | security_policies, policy_evaluations | policyEngineService | 12 endpoints | Security page | Complete |
| Agent Sandboxes | agent_sandboxes | policyEngineService | 2 endpoints | Needs sandbox config UI | Backend complete |
| Kill Switch | kill_switch_events | policyEngineService | 3 endpoints | Security page | Complete, tested |
| Departments | departments | budgetForecastService | 3 endpoints | Capacity page | Complete |
| Budget Allocations | budget_allocations | budgetForecastService | 2 endpoints | Needs allocation UI | Backend complete |
| Budget Forecasts | budget_forecasts | budgetForecastService | 2 endpoints | Needs forecast UI | Backend complete |
| Resource Usage | resource_usage_events | budgetForecastService | 2 endpoints | Needs usage UI | Backend complete |
| Capacity Planning | — | capacityPlanningService | 5 endpoints | Capacity page | Complete |
| Skill Versions | skill_versions | skillsRegistryService | 8 endpoints | Needs version UI | Backend complete |
| Skill Dependencies | skill_dependencies | skillsRegistryService | 3 endpoints | Needs dep UI | Backend complete |
| Skill Analytics | skill_usage_events | skillAnalyticsService | 4 endpoints | Needs analytics UI | Backend complete |
| Research Cycles | research_cycles | autoresearchService | 4 endpoints | Research page | Complete |
| Hypotheses | hypotheses | autoresearchService | 3 endpoints | Needs hypothesis UI | Backend complete |
| Experiments | experiments | autoresearchService | 5 endpoints | Needs experiment UI | Backend complete |
| Metrics | metric_definitions, measurements | autoresearchService | 6 endpoints | Needs metrics UI | Backend complete |
| Evaluations | evaluations | autoresearchService | 3 endpoints | Needs eval UI | Backend complete |
| Onboarding | onboarding_sessions, sources, context | onboardingService | 11 endpoints | Onboarding wizard | UI exists, LLM integration pending |
| CRM Accounts | crm_accounts | crmService | 4 endpoints | Pipeline page | Complete |
| CRM Contacts | crm_contacts | crmService | 4 endpoints | Pipeline page | Complete |
| CRM Deals | crm_deals | crmService | 5 endpoints | Pipeline page | Complete |
| CRM Leads | crm_leads | crmService | 5 endpoints | Pipeline page | Complete |
| CRM Partners | crm_partners | crmService | 4 endpoints | Pipeline page | Complete |
| CRM Activities | crm_activities | crmService | 4 endpoints | — | Backend complete |
| CRM Pipeline Summary | — | crmService | 1 endpoint | Pipeline page | Complete |
| HubSpot Integration | — | plugin manifest | 6 agent tools | — | Manifest only |
| Slack Integration | — | plugin manifest | — | — | Manifest only |
| GitHub Integration | — | plugin manifest | — | — | Manifest only |
| Linear Integration | — | plugin manifest | — | — | Manifest only |
| Plugin SDK Extensions | protocol.ts | placeholder handlers | 4 RPCs | — | Placeholder |
| Company Theme Colors | companies.themeAccentColor | CompanyTheme.tsx | — | Settings | Complete |
| Dashboard | — | — | — | Morning briefing | Redesigned |

---

## 5. Technical Summary

- **86 schema tables** across 60 migrations (14 AgentDash-specific: 0046-0059)
- **83 services** across all domains
- **200+ API endpoints** across 39 route modules
- **62 UI pages** (Pipelines, Action Proposals, Feed, CRM suite, Budget Forecast, Research, Onboarding, Security, Capacity, Agent Templates, Skill Versions, User Profile, and more)
- **4 integration plugin manifests** (HubSpot, Slack, GitHub, Linear)
- **Design system**: Teal primary, Inter font, customizable accent colors, light/dark mode

---

## 6. Open Items / Next Steps

### P0 (Must-have for first client)
- [ ] HubSpot connector implementation (beyond manifest — actual bidirectional sync)
- [ ] Spawn dialog in Templates UI (button exists, dialog missing)
- [ ] Task dependency visualization in Issue Detail page
- [ ] OKR display on Agent Detail page
- [ ] LLM integration in onboarding (context extraction, team suggestion)
- [ ] End-to-end agent execution test with OpenCode + MiniMax

### P1 (Important)
- [ ] Skill version management UI
- [ ] Budget forecast display in Capacity page
- [ ] Research cycle detail pages (hypothesis list, experiment timeline)
- [ ] CRM deal → issue linking UI
- [ ] Mobile responsive polish on new pages
- [ ] License key system for tier gating

### P2 (Nice to have)
- [ ] Slack/GitHub/Linear plugin implementations
- [ ] Metrics plugin implementations (PostHog, custom API)
- [ ] Analytics/charts page (for those who want the deep dive)
- [ ] Multi-tenant SaaS mode
- [ ] White-labeling support
- [ ] Helm chart for Kubernetes deployment
