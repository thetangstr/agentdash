# AgentDash CRM — Product Requirements Document

**Date:** 2026-03-30
**Status:** Draft
**Owner:** AgentDash Team

---

## 1. Problem

AgentDash has a complete CRM backend (6 tables, 31 API endpoints, HubSpot sync, lifecycle hooks) but the UI only exposes a pipeline summary and HubSpot config page. Users can't see their customers, can't browse accounts, can't view what agents did for a specific customer, and can't track deals through the lifecycle.

The CRM isn't meant to replace Salesforce or HubSpot. It's the **customer data layer that AI agents read from and write to**. But humans need to see that data too — to understand what agents are doing, to review agent-customer interactions, and to make decisions that agents can't.

## 2. Target Segments

| Segment | Company Size | CRM Needs | AgentDash Angle |
|---------|-------------|-----------|-----------------|
| **SMB** | 10-50 people | Simple pipeline, contact management, activity log | Agents handle follow-ups, lead qualification, support tickets |
| **Mid-market** | 50-500 people | Deal stages, team ownership, reporting, integrations | Agents run operational workflows, humans review escalations |
| **Enterprise** | 500+ people | Custom fields, approval workflows, audit trails, multi-pipeline | Agents as workforce layer, full governance, HubSpot/Salesforce sync |

## 3. What Exists Today

### Backend (Complete)
- **6 DB tables:** accounts, contacts, deals, activities, leads, partners
- **31 API endpoints:** full CRUD for all entities + pipeline summary + CRM context builder
- **HubSpot sync:** bidirectional (contacts, companies, deals, activities), webhooks, scheduler
- **CRM lifecycle hooks:** agent actions auto-create activities, advance deal stages, update account stages
- **CRM context for agents:** `GET /crm/accounts/:id/context` returns full customer snapshot

### Frontend (Incomplete)
- **CrmPipeline.tsx** — pipeline summary with stage breakdown, recent deals, leads, partners
- **HubSpotSettings.tsx** — config, test, sync UI
- **Missing:** Account list, account detail, contact detail, deal detail, activity timeline, lead management

### Routing (Broken)
- Sidebar links go to `/crm` instead of `/:companyPrefix/crm` — 404s on click

## 4. CRM CUJs (Customer Use Journeys)

### CUJ-1: Browse and Search Customers
**As a** board operator, **I want to** see all my customer accounts in one place **so that** I can find a specific customer quickly.

**Flow:**
1. Click "Accounts" in CRM sidebar section
2. See paginated list: name, stage, owner agent, deal count, last activity
3. Search by name or filter by stage
4. Click an account to see detail

### CUJ-2: View Customer 360 (Account Detail)
**As a** board operator, **I want to** see everything about a customer on one page **so that** I understand the full relationship.

**Flow:**
1. Click account name from list
2. See account detail page with:
   - **Header:** Name, stage badge, industry, owner agent
   - **Metrics strip:** Total deal value, deal count, contact count, days since last activity
   - **Contacts tab:** People at this account (name, email, phone, role)
   - **Deals tab:** Deals linked to this account (name, stage, amount, close date)
   - **Activity timeline:** Chronological feed of everything that happened — agent actions, deal stage changes, communications, HubSpot syncs, pipeline completions, support tickets resolved
   - **Agent interactions:** Which agents worked on this customer, what proposals were made, what was approved/auto-approved

### CUJ-3: Track Deal Through Lifecycle
**As a** sales lead, **I want to** see my deals move through stages **so that** I know what's progressing and what's stuck.

**Flow:**
1. Click "Pipeline" in CRM sidebar
2. See pipeline board view: columns for each stage (Lead → Qualified → Proposal → Negotiation → Closed Won / Closed Lost)
3. Deal cards show: name, amount, account name, days in stage, owner agent
4. Click deal to see detail: activities, linked issues, linked contacts
5. When an agent completes a workflow for this deal, stage auto-advances (via lifecycle hooks)

### CUJ-4: Manage Leads
**As a** growth team member, **I want to** see incoming leads and track which are being worked **so that** I know conversion status.

**Flow:**
1. Click "Leads" in CRM sidebar
2. See lead list: name, email, company, status (new → contacted → qualified → converted → lost), source, assigned agent
3. Filter by status
4. Click lead to see detail + convert to account/contact

### CUJ-5: See Agent Impact on Customer
**As a** CEO, **I want to** see what my agents did for a specific customer **so that** I trust the system.

**Flow:**
1. Open account detail for "Acme Corp"
2. See activity timeline showing:
   - "Ticket Intake Agent classified damaged-delivery ticket" (pipeline stage)
   - "Policy Agent evaluated $94 replacement — auto-approved" (action proposal)
   - "Customer Comms Agent sent resolution notice" (pipeline stage)
   - "QA Agent logged outcome — CSAT 4.8/5" (pipeline stage)
   - "Deal stage advanced: qualification → proposal" (lifecycle hook)
3. See total: 14 tickets resolved autonomously, 3 escalated to human, $12K saved

### CUJ-6: Connect to HubSpot
**As an** admin, **I want to** sync my HubSpot data **so that** agents have customer context.

**Flow:** (Already works)
1. Go to HubSpot settings
2. Enter API key, portal ID
3. Test connection
4. Enable sync
5. Data flows: HubSpot contacts → CRM contacts, companies → accounts, deals → deals

### CUJ-7: Agent Workflow Creates Customer Activity
**As a** system, when an agent completes a pipeline stage or an action proposal is resolved, **I want to** automatically log that as a CRM activity on the customer record.

**Flow:** (Already works via lifecycle hooks)
1. Pipeline run completes stage → `crmLifecycleService.onPipelineStageCompleted()` → creates crmActivity
2. Action proposal auto-approved → `crmLifecycleService.onActionAutoApproved()` → creates crmActivity
3. Action proposal human-approved → `crmLifecycleService.onActionProposalResolved()` → creates crmActivity
4. Issue completed with crmAccountId → `crmLifecycleService.onIssueCompleted()` → advances deal stage + creates crmActivity

### CUJ-8: View Deal-to-Issue Linkage
**As a** board operator, **I want to** see which issues/tasks are linked to a deal **so that** I know what work is being done to close it.

**Flow:**
1. Open deal detail
2. See linked issues (deals schema has `linkedIssueId` and `linkedProjectId`)
3. See which agents are assigned to those issues
4. See completion status

## 5. Opportunity Lifecycle

### Account Stages
```
prospect → active → customer → champion → churned
```
- **prospect**: New account, no deals
- **active**: Has open deals or recent agent activity
- **customer**: 5+ resolved issues or closed-won deal
- **champion**: 10+ resolved issues, high engagement
- **churned**: No activity in 90 days

Account stage auto-advances via `crmLifecycleService.onIssueCompletedForAccount()`.

### Deal Stages
```
lead → qualification → proposal → negotiation → closed_won | closed_lost
```
Deal stage auto-advances via `crmLifecycleService.onIssueCompleted()` when linked issues complete.

### Lead Statuses
```
new → contacted → qualified → converted | lost
```
Lead conversion creates an account + contact via `POST /crm/leads/:id/convert`.

## 6. UI Pages to Build

### Page 1: Accounts List (`/:prefix/crm/accounts`)
- Paginated table: Name, Stage (badge), Industry, Owner, Deals (count), Contacts (count), Last Activity
- Filters: Stage dropdown, search by name
- Click row → account detail
- "New Account" button

### Page 2: Account Detail (`/:prefix/crm/accounts/:id`)
- **Header:** Account name (editable), stage badge, industry, owner agent avatar
- **Metrics strip:** 4 cards — Total Deal Value, Open Deals, Contacts, Days Since Activity
- **Tabs:**
  - **Overview:** Key info + recent activity (last 10)
  - **Contacts:** Table of contacts at this account
  - **Deals:** Table of deals linked to this account
  - **Activity:** Full chronological timeline (all activities, including agent actions)
  - **Agent History:** Which agents interacted, action proposals, pipeline runs

### Page 3: Contacts List (`/:prefix/crm/contacts`)
- Table: Name, Email, Phone, Account, Owner, Last Activity
- Search by name/email
- Click → contact detail (or inline expand)

### Page 4: Deal Detail (`/:prefix/crm/deals/:id`)
- Header: Deal name, stage badge, amount, close date, account link
- Activity timeline for this deal
- Linked issues table
- Stage progression bar (visual)

### Page 5: Leads List (`/:prefix/crm/leads`)
- Table: Name, Email, Company, Status (badge), Source, Created
- Filter by status
- "Convert" action on qualified leads
- Inline status change

### Page 6: Fix Pipeline Page
- Already exists (CrmPipeline.tsx) — just fix the routing

## 7. Sidebar Navigation Update

Current:
```
CRM
  Pipeline
  HubSpot
```

New:
```
CRM
  Accounts
  Contacts
  Pipeline
  Leads
  HubSpot
```

All links must use `/${companyPrefix}/crm/...` routing pattern.

## 8. Activity Timeline Component

The most important component across all detail pages. Shows a chronological feed of:

| Activity Type | Icon | Description | Source |
|--------------|------|-------------|--------|
| `agent_action` | Bot icon | "Policy Agent auto-approved $94 replacement" | action-proposals lifecycle hook |
| `pipeline_stage` | Flow icon | "Ticket Intake completed classification" | pipeline lifecycle hook |
| `pipeline_complete` | Check icon | "Support Resolution pipeline completed (6/6 stages)" | pipeline lifecycle hook |
| `deal_stage_change` | Arrow icon | "Deal advanced: qualification → proposal" | deal lifecycle hook |
| `note` | Pencil icon | Manual note added by human | manual |
| `email` | Mail icon | Email sent/received | HubSpot sync |
| `call` | Phone icon | Call logged | HubSpot sync |
| `meeting` | Calendar icon | Meeting scheduled | HubSpot sync |
| `hubspot_sync` | Sync icon | "Synced from HubSpot" | sync service |

Each entry shows: timestamp, actor (agent name or "Board" or "HubSpot"), description, and optional metadata expandable.

## 9. Metrics & Dashboard

The existing CrmPipeline.tsx already shows summary metrics. Enhance with:

- **Pipeline Value by Stage** — bar chart or kanban column totals
- **Win Rate** — closed_won / (closed_won + closed_lost)
- **Average Deal Size** — total value / deal count
- **Deal Velocity** — average days from lead to closed_won
- **Agent Impact** — tickets resolved autonomously vs escalated, total value of auto-approved actions
- **Activity Volume** — activities per day/week trend

## 10. Implementation Priority

### P0 — Must Have (ship first)
1. Fix sidebar routing (broken links)
2. Accounts list page
3. Account detail page with activity timeline
4. Contacts list page

### P1 — Should Have
5. Deal detail page
6. Leads list page with convert action
7. Enhanced pipeline page (kanban view)
8. Activity timeline component (reusable)

### P2 — Nice to Have
9. Contact detail page
10. CRM metrics dashboard
11. Inline editing on list pages
12. Bulk actions (assign agent, change stage)

## 11. Architectural Principle: System of Action

AgentDash CRM is **not** a System of Record (that's HubSpot/Salesforce). It's a **System of Action** — the layer where agent decisions execute against customer data.

| Layer | Purpose | Who Owns It |
|-------|---------|-------------|
| System of Record | Master customer data | HubSpot, Salesforce |
| System of Engagement | Where interactions happen | Zendesk, Intercom, email |
| **System of Action** | Where AI decisions execute | **AgentDash** |

**What this means for the CRM UI:**
- Every view answers: "What did agents do for this customer, and was it right?"
- The activity timeline intermixes HubSpot-synced data with agent-generated actions
- Each timeline entry carries a `source` badge: agent (robot icon), HubSpot (sync icon), manual (user icon)
- Agent actions show evidence packets, confidence scores, and approval status
- The pipeline board is the homepage — Pipedrive proved this is what makes a CRM feel real
- Account detail is the 360-degree review page where operators verify agent behavior

**What we do NOT build:**
- Email/communication integration (HubSpot owns channels)
- Marketing automation, drip campaigns
- Revenue forecasting engine
- Custom object builder

## 12. Schema Additions (P1)

To support proper CRM operations, we'll add these in a follow-up:

- **`crmNotes`** — free-text notes on any entity (agents leave notes, humans annotate)
- **`crmDealContacts`** — junction table for many-to-many deal↔contact (deals involve multiple stakeholders)
- **`crmTags`** — lightweight tagging for accounts/contacts/deals ("VIP", "at-risk", "enterprise")
- Promote `source` from `metadata.source` to a first-class column on `crmActivities`

## 13. Non-Goals

- **Custom fields**: Not building a custom field engine. Use metadata JSONB for ad-hoc data.
- **Email integration**: Not building email send/receive. HubSpot handles that.
- **Marketing automation**: Not building drip campaigns or email sequences.
- **Reporting builder**: Not building a drag-and-drop report builder.
- **Multi-pipeline**: One pipeline per company for now.
- **Territory management**: No geo/territory assignment.

## 12. Success Criteria

- A board operator can find any customer account within 3 clicks
- The activity timeline shows every agent action on a customer without manually searching
- Deal stages auto-advance when agents complete linked work
- HubSpot data syncs bidirectionally and appears in account timelines
- The Northstar Trail Co. scenario works end-to-end: ticket → pipeline → action proposal → CRM activity → customer record updated

## 13. Technical Notes

- All CRM pages are company-scoped (`:companyPrefix/crm/...`)
- Reuse existing Paperclip UI patterns: table components, detail pages, sidebar nav
- Activity timeline is a shared component used on account detail, deal detail, and contact detail
- CRM context endpoint (`/crm/accounts/:id/context`) already builds the agent-facing snapshot — the UI account detail is the human-facing equivalent
- No new backend work needed for P0 — all APIs exist. This is a frontend build.
