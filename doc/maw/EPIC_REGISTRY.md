# AgentDash — Epic & CUJ Registry

**Owner:** PM Agent
**Version:** 2.0 — AgentDash customized
**Linear Team:** AgentDash (AGE)
**Project:** [AgentDash v1 Launch](https://linear.app/agentdash/project/agentdash-v1-launch-9230a8a1169f)

---

## Epics

| Epic Label | Description | Status |
|-----------|-------------|--------|
| `epic:crm` | CRM accounts, contacts, deals, pipeline, HubSpot, agent-customer interactions | Backend complete, UI in progress |
| `epic:pipelines` | Multi-agent workflows, pipeline orchestrator, action proposals with evidence | Backend complete, UI not started |
| `epic:onboarding` | Guided onboarding wizard, plan generation, plan execution | Complete (31/31 tests pass) |
| `epic:agents` | Templates, spawning, OKRs, skills registry, AutoResearch | Backend complete, some UI gaps |
| `epic:governance` | Security policies, kill switch, budget management, capacity | Backend complete, budget UI missing |
| `epic:ux` | UX polish, missing pages, routing fixes, DAG visualization | Backlog |

---

## CUJ Details

### epic:crm — CRM & Customer Data

| CUJ ID | Name | Description | Test |
|--------|------|-------------|------|
| `#crm-browse-accounts` | Browse accounts | User views account list, searches, filters by stage | Manual |
| `#crm-account-detail` | Account 360 | View account with contacts, deals, activity timeline | Manual |
| `#crm-pipeline-board` | Pipeline kanban | View/manage deals on kanban, drag between stages | Manual |
| `#crm-contact-browse` | Browse contacts | View/search contact list, filter by account | Manual |
| `#crm-deal-detail` | Deal detail | View deal with stage bar, contacts, activities | Manual |
| `#crm-lead-convert` | Convert lead | Convert lead → account + contact | `curl POST .../leads/:id/convert` |
| `#crm-hubspot-sync` | HubSpot sync | Configure HubSpot, trigger sync, verify data | `bash scripts/dry-run-onboarding.sh` |
| `#crm-agent-timeline` | Agent in timeline | Agent actions appear in activity timeline with source badges | Manual |
| `#crm-context` | CRM context | Agent retrieves CRM snapshot for account during workflow | `curl GET .../crm/accounts/:id/context` |

### epic:pipelines — Agent Pipelines & Action Proposals

| CUJ ID | Name | Description | Test |
|--------|------|-------------|------|
| `#pipe-create` | Create pipeline | Define multi-stage agent pipeline | `curl POST .../pipelines` |
| `#pipe-run` | Start run | Start pipeline, stages auto-create issues | `curl POST .../pipelines/:id/runs` |
| `#pipe-advance` | Auto-advance | Stage advances when issue completes | Complete issue → verify next |
| `#pipe-propose` | Action proposal | Agent proposes action, policy evaluates | `curl POST .../action-proposals` |
| `#pipe-approve` | Approve proposal | Human reviews evidence → approve → agent wakes | `curl POST .../approvals/:id/approve` |
| `#pipe-threshold` | Policy threshold | Under-threshold auto-approved, over escalated | API test |

### epic:onboarding — Company Onboarding

| CUJ ID | Name | Description | Test |
|--------|------|-------------|------|
| `#onb-wizard` | Wizard | Company → Agent → Task → Launch wizard | Manual |
| `#onb-plan-gen` | Plan generation | LLM generates plan from company context | `curl POST .../generate-plan` |
| `#onb-plan-apply` | Apply plan | Approve plan, system creates all entities | `curl POST .../apply-plan` |
| `#onb-dry-run` | Dry run | Full 31-step onboarding passes | `bash scripts/dry-run-onboarding.sh` |

### epic:agents — Agent Management

| CUJ ID | Name | Description | Test |
|--------|------|-------------|------|
| `#agent-spawn` | Spawn agent | Spawn request → approve → agent created | `bash scripts/dry-run-onboarding.sh` |
| `#agent-template` | Template | Define template with role, budget, skills | API test |
| `#agent-okr` | OKRs | Assign OKRs with key results | API test |
| `#agent-skill` | Skills | Create → version → review → publish | API test |
| `#agent-research` | Research | Cycle → hypotheses → experiments → evaluate | API test |

### epic:governance — Security, Budget & Policies

| CUJ ID | Name | Description | Test |
|--------|------|-------------|------|
| `#gov-kill-switch` | Kill switch | Halt all → verify paused → resume → verify idle | `bash scripts/dry-run-onboarding.sh` |
| `#gov-security` | Security policy | Create action_limit → verify enforcement | API test |
| `#gov-budget` | Budget | View budgets, spend, forecasts | API test |
| `#gov-capacity` | Capacity | View workforce size, pipeline count | `bash scripts/dry-run-onboarding.sh` |

### epic:ux — UX Polish

| CUJ ID | Name | Description | Test |
|--------|------|-------------|------|
| `#ux-dag` | Dependency DAG | Task dependency graph on project detail | Manual |
| `#ux-dashboard` | Dashboard | Morning briefing with attention items | Manual |
| `#ux-sidebar` | Sidebar nav | All links correct with company prefix | Manual |

---

## Test Commands

```bash
# Full onboarding dry run (31 steps)
bash scripts/dry-run-onboarding.sh

# Unit + integration tests (775 tests)
pnpm test:run

# Typecheck all packages
pnpm -r typecheck

# Build all
pnpm build

# Full verification
pnpm -r typecheck && pnpm test:run && pnpm build
```

---

## Linear Labels

### Epic Labels
```
epic:crm, epic:pipelines, epic:onboarding, epic:agents, epic:governance, epic:ux
```

### Size Labels
```
S, M, L, XL
```

### Standard Labels
```
Bug, Feature, Improvement
```

---

## Issue Sizing

| Size | Points | Effort | Scope |
|------|--------|--------|-------|
| S | 2 | 1-2 days | Single-file fix, minor feature |
| M | 3 | 3-5 days | New page, 2 layers |
| L | 5 | 1-2 weeks | Full-stack feature |
| XL | 8 | 2+ weeks | System-wide, major refactor |
