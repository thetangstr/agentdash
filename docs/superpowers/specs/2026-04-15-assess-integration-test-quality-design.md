# Design: Assess Integration + Test Quality Upgrade

**Date:** 2026-04-15
**Status:** Approved
**Approach:** Full Port + Test Foundation (Approach 1)

## Summary

Embed the Agent Readiness Assessment from `agent-marketing-research` directly into AgentDash as both a standalone page and onboarding integration. The assessment produces a **jumpstart.md** file that bootstraps company setup when customers configure their own adapter keys. Simultaneously, build shared test infrastructure and write comprehensive tests for the new feature.

## Architecture

### LLM Backend — Hardcoded MiniMax

The assess feature runs **before** customers configure their own API keys. LLM calls use MiniMax (Anthropic-compatible API), configured by the AgentDash operator:

```
ASSESS_MINIMAX_API_KEY      # MiniMax API key (operator sets once)
ASSESS_MINIMAX_BASE_URL     # defaults to https://api.minimaxi.com/anthropic
ASSESS_MINIMAX_MODEL        # defaults to MiniMax-M2.7-highspeed
```

This is completely separate from the model router (`resolveModelTier`), which uses the customer's own keys for agent workloads.

### RAG Data — Static JSON Files

Matrix data (378 industry×function cells), deep playbooks, market reports, and competitor data ship as static JSON files in `server/src/data/`. Copied from the research app. No new DB tables for this data.

### Data Storage

No new schema tables. Uses existing `company_context`:

| contextType | key | value |
|---|---|---|
| `agent_research` | `readiness-assessment` | Full markdown report |
| `agent_research` | `jumpstart` | Jumpstart markdown file |
| `agent_research` | `assessment-input` | JSON of intake form |

## New Files

### Server

```
server/src/data/                          # Static RAG data (from research app)
  matrix/index.json                       # 378 industry×function cells
  matrix/deep/*.json                      # 6 deep playbooks
  markets/*.json                          # Vertical market reports
  companies/*.json                        # Competitor platform data

server/src/services/assess.ts             # Core service: retrieve context, call MiniMax, store results
server/src/services/assess-retrieval.ts   # RAG retrieval: matrix lookup, playbook matching
server/src/services/assess-prompts.ts     # System/user prompt builders (assessment + interview + jumpstart)
server/src/routes/assess.ts               # Routes: research, interview, assess, history
```

### UI

```
ui/src/pages/AssessPage.tsx               # Standalone assessment page (6-phase flow)
ui/src/pages/AssessHistoryPage.tsx         # Past assessments list
ui/src/api/assess.ts                      # API client functions
```

### Modified Files

```
ui/src/App.tsx                            # Add /assess and /assess/history routes
ui/src/components/Sidebar.tsx             # Add Assess nav item
server/src/app.ts                         # Wire assessRoutes(db)
ui/src/pages/OnboardingWizardPage.tsx     # Discovery step calls /assess/research
ui/src/pages/SetupWizard.tsx              # Discovery step calls /assess/research
```

## API Design

### POST `/companies/:companyId/assess/research`

Lightweight company research. No LLM call.

- **Input:** `{ companyUrl, companyName }`
- **Action:** Fetches website, strips HTML, detects industry by keyword matching, extracts summary
- **Output:** `{ suggestedIndustry, summary, webContent, allIndustries }`
- **Latency:** ~1-2s

### POST `/companies/:companyId/assess/interview`

Conversational WACT interview. 3-5 rounds.

- **Input:** `{ conversationHistory, companyWebContent, industry, industrySlug, formSummary, selectedFunctions }`
- **Action:** Builds system prompt with condensed matrix + RAG context, calls MiniMax
- **Output:** `{ question, options, insights, clarityScore, done, thinkingSummary }`
- **Non-streaming** — needs full JSON response for structured parsing
- **Latency:** ~5-10s per round

### POST `/companies/:companyId/assess`

Full assessment report + jumpstart file generation.

- **Input:** Full `AssessmentInput` (company profile + interview answers)
- **Action:** RAG retrieval → build prompts → stream MiniMax response. After streaming completes, a second non-streaming MiniMax call generates the jumpstart.md from the assessment output + intake form. Two calls total: one streamed (report), one JSON (jumpstart).
- **Output:** HTTP stream of markdown (`text/plain`) or JSON (`format=json`). Jumpstart generated server-side after stream completes.
- **Storage:** Saves report + jumpstart to `company_context`
- **Latency:** ~30-60s streaming

### GET `/companies/:companyId/assess`

Retrieve stored assessment.

- **Output:** `{ markdown, jumpstart, assessmentInput }`

## UI Flow — Standalone Assess Page

### 6-Phase Flow

```
start → confirm → form (3 steps) → deepdive → generating → report
```

**Phase 1: Start** — Company name + website URL. "Research" button calls `/assess/research`.

**Phase 2: Confirm** — Auto-detected industry + company summary. User confirms or edits via dropdown (18 industries). Selects scope.

**Phase 3: Form (3 tabbed steps)**
- Step 1 Operations: employee range, revenue, key systems (multi-select, 50+ tools), automation level, AI maturity (4 dropdowns), challenges textarea
- Step 2 Functions: 6 categories × 3-4 sub-functions as multi-select grid
- Step 3 Goals: primary goal, targets, timeline, budget range

**Phase 4: Deep Dive** — Conversational interview (3-5 rounds). Left column: chat Q&A with option chips + custom answer. Right sidebar: clarity score ring + insights panel.

**Phase 5: Generating** — Streams markdown from MiniMax. Progress indicator with latest content preview.

**Phase 6: Report** — Rendered markdown report. Actions: Print PDF, Copy markdown, New Assessment.

### Routing

- `/:prefix/assess` → AssessPage
- `/:prefix/assess/history` → AssessHistoryPage

## Jumpstart File

### Purpose

The assessment produces a **jumpstart.md** stored in `company_context`. When the customer later configures their own adapter keys, the adapter reads this file + the selected scope to bootstrap the initial company structure (agents, goals, issues).

### Format

```markdown
# AgentDash Jumpstart — {Company Name}

## Company Profile
- **Industry:** {industry}
- **Size:** {employee range}
- **Revenue:** {revenue range}
- **AI Maturity:** {summary from assessment}

## Recommended Agent Opportunities

### 1. {Opportunity Name} (High Opportunity)
- **Function:** {category} > {sub-function}
- **WACT:** Workability: {score}, Access: {score}, Context: {score}, Trust: {score}
- **Agent Role:** {recommended role name}
- **Agent Description:** {what this agent does}
- **Initial Goals:**
  - {goal 1}
  - {goal 2}
- **Systems:** {relevant integrations}

### 2. ...

## Scope Recommendations

### Company-Wide
Deploy all {N} recommended agents across departments.

### Department: {name}
Focus agents: {filtered list}

### Team: {name}
Focus agent: {single agent}

## Risk Factors
- {risk with mitigation}

## Systems to Integrate
- {system} — {role}
```

### Scope Integration

The SetupWizard reads the jumpstart and filters by selected scope:
- **Company** → shows all recommended agents
- **Department** → filters to department-relevant agents from `Scope Recommendations`
- **Team** → further filters to team-level
- **Project** → single agent for one opportunity

The adapter receives `jumpstart.md` + `scope` and uses it as context to create agents, goals, and initial issues.

## Onboarding Integration

The Discovery step in `OnboardingWizardPage` and `SetupWizard` gets a "Research" button:

1. User pastes URL → calls `/assess/research` → auto-fills industry + company summary
2. Extracted `webContent` passed through as source content to the rest of the onboarding pipeline
3. Only the lightweight research step runs during onboarding — not the full interview/assessment

If the user wants a full assessment, they navigate to the standalone `/assess` page.

## Test Infrastructure

### Shared Helpers (new)

```
server/src/__tests__/helpers/
  factories.ts          # Builders: buildCompany, buildAgent, buildIssue, etc.
  api-helpers.ts        # Supertest wrappers with auth context baked in
  matchers.ts           # Custom matchers: toBeHttpError, toHaveValidUUID

tests/e2e/fixtures/
  factories.ts          # E2E data creation via API calls
```

### Factory Pattern

```typescript
export function buildCompany(overrides?: Partial<Company>): Company {
  return {
    id: randomUUID(),
    name: "Test Corp",
    issuePrefix: "TC",
    ...overrides,
  };
}

export function buildAgent(overrides?: Partial<Agent>): Agent {
  return {
    id: randomUUID(),
    companyId: "company-1",
    name: "Test Agent",
    role: "engineer",
    status: "idle",
    ...overrides,
  };
}
```

### Custom Matchers

```typescript
expect.extend({
  toBeHttpError(received, status, messagePattern?) { ... },
  toHaveValidUUID(received) { ... },
});
```

### Assess Feature Tests

**Service tests** (`server/src/__tests__/assess-service.test.ts`):
- RAG retrieval: correct matrix cells for industry, related industry lookup, playbook matching
- Prompt building: system prompt includes matrix data, user prompt includes form data + web content
- MiniMax call: mock fetch, verify request shape, handle streaming/JSON responses
- Jumpstart generation: verify markdown structure, scope recommendations present

**Route tests** (`server/src/__tests__/assess-routes.test.ts`):
- Research endpoint: mock URL fetch, industry detection, company-scoping
- Interview endpoint: mock MiniMax, verify conversation history passed, JSON parsing with fallback
- Assess endpoint: mock streaming response, verify `company_context` storage
- Auth: 401 without board token, 403 wrong company

**E2E tests** (`tests/e2e/assess.spec.ts`):
- Full flow: start → research → confirm → form → interview → report
- Jumpstart file stored after assessment completes
- Onboarding Discovery uses research endpoint

### Backfill Priority (existing gaps)

1. **Permission denial tests** — 401/403 assertions across all route files
2. **Onboarding pipeline** — Full Deploy Team flow, API error handling
3. **Error paths** — DB failures, timeouts, malformed input in services
4. **SetupWizard scopes** — Jumpstart-driven agent selection per scope
