# AgentDash Epic Registry

Reference for all AgentDash epics, their scope, and key CUJs (Critical User Journeys).

## Epics

### epic:crm
**CRM & Revenue Operations** — Customer lifecycle management, deal pipeline, contact tracking.

| CUJ | Description | Pages |
|-----|-------------|-------|
| CUJ-CRM-1 | View CRM pipeline overview with deal stages and revenue metrics | `/crm` |
| CUJ-CRM-2 | Manage accounts with enrichment (deals, contacts, value) | `/crm/accounts`, `/crm/accounts/:id` |
| CUJ-CRM-3 | Browse and search contacts across all accounts | `/crm/contacts` |
| CUJ-CRM-4 | Track leads and convert to accounts | `/crm/leads` |
| CUJ-CRM-5 | Drag-drop deals across pipeline stages (kanban) | `/crm/kanban` |
| CUJ-CRM-6 | View deal detail with activities timeline | `/crm/deals/:id` |
| CUJ-CRM-7 | Configure HubSpot sync | `/crm/hubspot` |

### epic:pipelines
**Agent Pipelines & Proposals** — Multi-agent orchestration, action approval workflows.

| CUJ | Description | Pages |
|-----|-------------|-------|
| CUJ-PIP-1 | View and manage agent pipeline definitions with stages | `/pipelines` |
| CUJ-PIP-2 | Monitor pipeline runs with stage progress | `/pipelines` |
| CUJ-PIP-3 | Review and approve/reject agent action proposals | `/action-proposals` |
| CUJ-PIP-4 | View proposal evidence packets and confidence scores | `/action-proposals` |

### epic:agents
**Agent Management & Intelligence** — Agent lifecycle, skills, research, OKRs.

| CUJ | Description | Pages |
|-----|-------------|-------|
| CUJ-AGT-1 | View agent dashboard with activity charts and status | `/agents/:id/dashboard` |
| CUJ-AGT-2 | Configure agent instructions and permissions | `/agents/:id/configuration` |
| CUJ-AGT-3 | Manage skill versions — pin, rollback, track history | `/skill-versions` |
| CUJ-AGT-4 | View AutoResearch cycles with findings and sources | `/research`, `/research/:id` |
| CUJ-AGT-5 | Track agent OKRs with progress on key results | `/agents/:id/okrs` |
| CUJ-AGT-6 | Browse and deploy agent templates | `/templates` |

### epic:governance
**Budget, Security & Policy** — Financial controls, security policies, capacity planning.

| CUJ | Description | Pages |
|-----|-------------|-------|
| CUJ-GOV-1 | View budget forecast vs actual with allocation breakdown | `/budget` |
| CUJ-GOV-2 | Monitor capacity across workforce and departments | `/capacity` |
| CUJ-GOV-3 | Manage security policies and sandbox configurations | `/security` |
| CUJ-GOV-4 | Set per-agent budget limits with override approval | `/agents/:id/budget` |

### epic:ux
**Visualization & User Experience** — Task graphs, feeds, navigation.

| CUJ | Description | Pages |
|-----|-------------|-------|
| CUJ-UX-1 | Visualize task dependency DAG with status coloring | `/task-dependencies` |
| CUJ-UX-2 | Personalized feed with urgency-tiered issue surfacing | `/feed` |
| CUJ-UX-3 | Company-scoped sidebar navigation with CRM + AgentDash sections | Sidebar |

### epic:onboarding
**Setup & Onboarding** — Company creation, agent provisioning, data import.

| CUJ | Description | Pages |
|-----|-------------|-------|
| CUJ-ONB-1 | Guided onboarding wizard with LLM context extraction | `/setup` |
| CUJ-ONB-2 | Import data from external sources | `/company/import` |
| CUJ-ONB-3 | Dry-run onboarding via CLI for testing | `scripts/dry-run-onboarding.sh` |

## Label Convention

Issues in Linear use `epic:<name>` labels (e.g., `epic:crm`, `epic:pipelines`).
Size labels: `XS` (1pt), `S` (2pt), `M` (3pt), `L` (5pt), `XL` (8pt).
