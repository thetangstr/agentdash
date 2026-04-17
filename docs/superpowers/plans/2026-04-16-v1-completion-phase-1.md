# V1 Completion — Phase 1: Close UI Stubs by CUJ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every "coming soon" UI surface in AgentDash, grouped into 4 Critical User Journeys so each flow is end-to-end testable before moving on.

**Architecture:** No new backend services — Phase 1 is UI implementation against existing APIs (CRM, HubSpot, agent, action-proposal, feed, user, adapter routes). Where backend gaps are discovered, they are scoped into the per-CUJ task block.

**Tech Stack:** React 19, Vite, Tailwind 4, TanStack Query, existing `ui/src/api/*` clients, Playwright for CUJ E2E tests.

**Reference:** `docs/superpowers/specs/2026-04-16-v1-completion.md` — master spec.

**Execution order:** CUJ-D → CUJ-B → CUJ-A → CUJ-C → Phase-1 wrap-up.

---

## CUJ-D: Adapter Onboarding

Flip 4 gated adapters from "coming soon" → "available" atomically across all 4 surfaces. This is the lightest CUJ (boolean flag flips + skills view restore) and unblocks real agent testing for the remaining CUJs.

### Task D1: Audit gated adapters and decide per-adapter disposition

**Files:**
- Read: `ui/src/adapters/adapter-display-registry.ts`
- Read: `ui/src/pages/InviteLanding.tsx`
- Read: `ui/src/components/AgentConfigForm.tsx` (search "Coming soon")
- Read: `ui/src/pages/AgentDetail.tsx:860-890`

- [ ] **Step 1:** Enumerate every `comingSoon: true` flag and "Coming soon" string in the 4 files above. Produce a table: adapter name, file, line, reason-for-gate-if-known.
- [ ] **Step 2:** For each gated adapter, decide one of: (a) ship as available, (b) keep gated behind `custom_adapters` entitlement (Enterprise-only), (c) delete if dead code. Record decision in `docs/superpowers/plans/2026-04-16-phase-1-adapter-dispositions.md`.
- [ ] **Step 3:** Commit the disposition doc.

```bash
git add docs/superpowers/plans/2026-04-16-phase-1-adapter-dispositions.md
git commit -m "docs: adapter disposition decisions for Phase 1"
```

### Task D2: Flip adapter-display-registry to available

**Files:**
- Modify: `ui/src/adapters/adapter-display-registry.ts`
- Test: `ui/src/adapters/__tests__/adapter-display-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { adapterDisplayRegistry } from "../adapter-display-registry.js";

describe("adapter-display-registry availability", () => {
  it("exposes openclaw_gateway as available", () => {
    expect(adapterDisplayRegistry.openclaw_gateway.comingSoon).toBeFalsy();
  });
  it("exposes process as available", () => {
    expect(adapterDisplayRegistry.process.comingSoon).toBeFalsy();
  });
  it("exposes http as available", () => {
    expect(adapterDisplayRegistry.http.comingSoon).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @agentdash/ui test adapter-display-registry -- --run
```
Expected: 3 failing tests.

- [ ] **Step 3: Remove `comingSoon: true` from lines 96, 103, 109** (or whichever adapters the disposition doc marked ship-as-available). Delete any "Coming soon" copy in those entries.
- [ ] **Step 4: Run test to verify it passes**

```
pnpm --filter @agentdash/ui test adapter-display-registry -- --run
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add ui/src/adapters/adapter-display-registry.ts ui/src/adapters/__tests__/adapter-display-registry.test.ts
git commit -m "feat(adapters): flip gated adapters to available per disposition doc"
```

### Task D3: Remove "coming soon" gating from InviteLanding

**Files:**
- Modify: `ui/src/pages/InviteLanding.tsx`
- Test: `ui/src/pages/__tests__/InviteLanding.test.tsx`

- [ ] **Step 1: Write failing test — page renders all 4 adapters as selectable (no locked overlay)**

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InviteLanding } from "../InviteLanding.js";

describe("InviteLanding adapter availability", () => {
  it("renders every adapter without a 'coming soon' overlay", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><InviteLanding /></MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**
- [ ] **Step 3: In `InviteLanding.tsx`, remove `comingSoon` branches and "Coming soon" copy for adapters chosen for (a) ship-as-available in the disposition doc. For (b) Enterprise-gated adapters, replace "Coming soon" with `<Gated capability="custom_adapters">` placeholder comment — actual Gated component comes in Phase 2, for now just remove the coming-soon label.**
- [ ] **Step 4: Run test — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/InviteLanding.tsx ui/src/pages/__tests__/InviteLanding.test.tsx
git commit -m "feat(invite): unlock adapter selection on invite landing"
```

### Task D4: Remove "coming soon" from AgentConfigForm adapter dropdown

**Files:**
- Modify: `ui/src/components/AgentConfigForm.tsx:1077` (and any other "Coming soon" occurrences found in D1)
- Test: `ui/src/components/__tests__/AgentConfigForm.test.tsx`

- [ ] **Step 1: Write failing test — dropdown shows all adapters without disabled state / coming-soon label**

```tsx
it("adapter dropdown has no 'coming soon' options", () => {
  const { container } = render(<AgentConfigForm ... />);
  const opts = container.querySelectorAll("option");
  opts.forEach(o => expect(o.textContent).not.toMatch(/coming soon/i));
});
```

- [ ] **Step 2: Run test — expect FAIL**
- [ ] **Step 3: Remove "Coming soon" label at line 1077 and any `disabled` flag on the option.**
- [ ] **Step 4: Run test — expect PASS**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent-config): remove 'coming soon' label from adapter dropdown"
```

### Task D5: Re-enable skills view in AgentDetail

**Files:**
- Modify: `ui/src/pages/AgentDetail.tsx:860-890`
- Test: `ui/src/pages/__tests__/AgentDetail.test.tsx`

- [ ] **Step 1:** Open `AgentDetail.tsx:860-890` and read the commented-out skills view block (marked `// TODO: bring back later`).
- [ ] **Step 2: Write failing test — skills section renders with a list or empty-state**

```tsx
it("renders the skills section", async () => {
  const { findByText } = render(<AgentDetail />, { wrapper });
  expect(await findByText(/Skills/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run test — expect FAIL (text not found)**
- [ ] **Step 4:** Uncomment the skills view block. If it references types/props that no longer exist, adapt to current `agent` shape (check `packages/shared/src/constants.ts` and `packages/db/src/schema/agents.ts` for current fields). Remove the "TODO: bring back later" comment.
- [ ] **Step 5: Run test — expect PASS**
- [ ] **Step 6:** `pnpm --filter @agentdash/ui typecheck` — expect 0 errors.
- [ ] **Step 7: Commit**

```bash
git commit -m "feat(agents): restore skills view on AgentDetail page"
```

### Task D6: CUJ-D integration test (Playwright)

**Files:**
- Create: `tests/cujs/cuj-d-adapter-onboarding.spec.ts`

- [ ] **Step 1: Write the E2E test**

```ts
import { test, expect } from "@playwright/test";

test("CUJ-D: adapter selection flows from invite landing to agent config", async ({ page }) => {
  await page.goto("/");
  await page.goto("/invite/demo-token"); // seeded by scripts/seed-test-scenarios.sh
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  await page.getByRole("button", { name: /Claude/i }).click();
  await expect(page).toHaveURL(/.*agents.*/);
  // Open adapter dropdown on agent config
  await page.getByLabel(/adapter/i).click();
  const options = page.getByRole("option");
  await expect(options.filter({ hasText: /coming soon/i })).toHaveCount(0);
});

test("CUJ-D: AgentDetail shows skills section", async ({ page }) => {
  await page.goto("/agents/seeded-agent-id");
  await expect(page.getByRole("heading", { name: /Skills/i })).toBeVisible();
});
```

- [ ] **Step 2: Run test — expect PASS (prior tasks made it green)**

```
pnpm --filter @agentdash/ui exec playwright test cuj-d-adapter-onboarding
```

- [ ] **Step 3: Commit**

```bash
git add tests/cujs/cuj-d-adapter-onboarding.spec.ts
git commit -m "test(cuj-d): adapter onboarding end-to-end"
```

### Task D7: CUJ-D verification gate

- [ ] **Step 1:** `pnpm -r typecheck` — expect 0 errors.
- [ ] **Step 2:** `pnpm test:run` — expect 100% pass.
- [ ] **Step 3:** `pnpm build` — expect exit 0.
- [ ] **Step 4:** `bash scripts/test-cujs.sh --filter cuj-d` — expect all green.
- [ ] **Step 5:** Gate passed → proceed to CUJ-B.

---

## CUJ-B: Agent Governance Loop

Agent → ActionProposals → approve → Feed event → linked issue updated.

### Task B1: ActionProposals list page

**Files:**
- Read: `server/src/routes/action-proposals.ts` (verify GET /api/companies/:companyId/action-proposals exists; if not, create in B1a)
- Modify: `ui/src/pages/ActionProposals.tsx`
- Create: `ui/src/api/action-proposals.ts` (if not present)
- Test: `ui/src/pages/__tests__/ActionProposals.test.tsx`

**Acceptance:**
- Lists pending proposals for the current company with: title, proposing agent, linked issue, created-at, action buttons (Approve, Reject)
- Empty state: "No proposals awaiting your review"
- Loading + error states

- [ ] **Step 1: Check backend** — `grep -n "action-proposals" server/src/routes/*.ts` to confirm list+approve+reject endpoints. If missing, add them (separate task B1a before continuing).
- [ ] **Step 2: Write failing test**

```tsx
it("renders pending action proposals with approve/reject buttons", async () => {
  mockApi.get("/api/companies/:id/action-proposals").reply(200, [
    { id: "p1", title: "Send follow-up email", agentName: "SalesBot", issueId: "i1", createdAt: "2026-04-16T10:00:00Z" },
  ]);
  render(<ActionProposals />, { wrapper });
  expect(await screen.findByText("Send follow-up email")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
});
```

- [ ] **Step 3:** Implement. Structure:
  - `ui/src/api/action-proposals.ts` — client with `list()`, `approve(id)`, `reject(id)` using existing `apiClient` pattern (see `ui/src/api/agents.ts` for reference)
  - `ui/src/pages/ActionProposals.tsx` — page component using TanStack Query, card list, optimistic approve/reject
- [ ] **Step 4:** Run test — expect PASS.
- [ ] **Step 5:** Commit.

```bash
git commit -m "feat(action-proposals): implement approval queue page"
```

### Task B2: Feed page

**Files:**
- Read: existing feed route(s) — `grep -rn "feed" server/src/routes/ server/src/services/`
- Modify: `ui/src/pages/Feed.tsx`
- Create: `ui/src/api/feed.ts`
- Test: `ui/src/pages/__tests__/Feed.test.tsx`

**Acceptance:**
- Reverse-chronological list of feed events, each rendered by event type (agent_heartbeat, issue_updated, goal_progressed, proposal_approved, proposal_rejected)
- Infinite scroll or pagination (take approach from existing list pages, e.g., `ui/src/pages/Agents.tsx`)
- Empty + loading + error states

- [ ] **Step 1: Confirm or add backend `GET /api/companies/:id/feed?cursor=...`** — if missing, define schema `feed_events` (check `packages/db/src/schema/` for existing) and service + route.
- [ ] **Step 2: Write failing test**

```tsx
it("renders feed events with event-type icons", async () => {
  mockApi.get("/api/companies/:id/feed").reply(200, {
    events: [
      { id: "e1", type: "proposal_approved", title: "Send email approved", at: "2026-04-16T10:00Z", actorName: "Alex" },
      { id: "e2", type: "agent_heartbeat", title: "SalesBot woke up", at: "2026-04-16T09:55Z" },
    ],
    nextCursor: null,
  });
  render(<Feed />, { wrapper });
  expect(await screen.findByText("Send email approved")).toBeInTheDocument();
  expect(screen.getByText("SalesBot woke up")).toBeInTheDocument();
});
```

- [ ] **Step 3:** Implement. Include small `FeedEventIcon` component switching on event type.
- [ ] **Step 4:** Run test — expect PASS.
- [ ] **Step 5:** Commit.

```bash
git commit -m "feat(feed): implement activity feed page"
```

### Task B3: Wire approval → feed event + linked issue

**Files:**
- Modify: `server/src/services/action-proposals.ts` (or wherever approve lives)
- Modify: `server/src/services/feed.ts` (create if missing)
- Test: `server/src/services/__tests__/action-proposals.test.ts`

**Acceptance:**
- On `approve(proposalId)`: (a) mark proposal approved, (b) insert `feed_event` row with type `proposal_approved`, (c) if proposal.linkedIssueId present, update issue status/progress per proposal.effect spec
- Atomic transaction — all three commit together or none

- [ ] **Step 1: Write failing integration test**

```ts
it("approval creates feed event and updates linked issue", async () => {
  const prop = await seedProposal({ linkedIssueId: "i1" });
  await service.approve(prop.id);
  const events = await db.select().from(feedEvents).where(eq(feedEvents.refId, prop.id));
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("proposal_approved");
  const issue = await db.select().from(issues).where(eq(issues.id, "i1"));
  expect(issue[0].lastActionAt).not.toBeNull();
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement. Use `db.transaction()` to wrap all three writes.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit.

```bash
git commit -m "feat(action-proposals): emit feed event and update linked issue on approve"
```

### Task B4: CUJ-B integration test

**Files:**
- Create: `tests/cujs/cuj-b-agent-governance.spec.ts`

- [ ] **Step 1: Write E2E**

```ts
test("CUJ-B: propose → approve → feed + issue updated", async ({ page, request }) => {
  // Seed: 1 agent, 1 issue, 1 pending proposal linked to that issue
  await request.post("/api/test/seed/cuj-b");
  await page.goto("/action-proposals");
  await page.getByRole("button", { name: /approve/i }).first().click();
  await expect(page.getByText(/approved/i)).toBeVisible();
  await page.goto("/feed");
  await expect(page.getByText(/approved/i)).toBeVisible();
  // Check issue updated
  const issue = await request.get("/api/companies/test-co/issues/seeded-i1").then(r => r.json());
  expect(issue.lastActionAt).toBeTruthy();
});
```

- [ ] **Step 2:** Run — expect PASS.
- [ ] **Step 3:** Commit.

### Task B5: CUJ-B gate

- [ ] **Step 1:** `pnpm -r typecheck && pnpm test:run && pnpm build` — all exit 0.
- [ ] **Step 2:** `bash scripts/test-cujs.sh --filter cuj-b` — green.
- [ ] **Step 3:** Gate passed → proceed to CUJ-A.

---

## CUJ-A: Lead → Close (Sales Pipeline)

### Task A1: CrmLeads page

**Files:**
- Modify: `ui/src/pages/CrmLeads.tsx`
- Create: `ui/src/api/crm-leads.ts`
- Test: `ui/src/pages/__tests__/CrmLeads.test.tsx`

**Acceptance:**
- Table of leads: name, email, company, stage, score, last-contact
- Actions: "Create Deal" (converts lead → deal, navigates to CrmDealDetail), "Delete"
- Filter by stage; search by name/email

- [ ] **Step 1:** Confirm backend CRM lead routes exist (`grep -n "leads" server/src/routes/*.ts`). If missing, surface as separate backend task A1a.
- [ ] **Step 2:** Write failing test covering table render, filter, and convert action.
- [ ] **Step 3:** Implement using existing table pattern from `ui/src/pages/Agents.tsx`.
- [ ] **Step 4:** Test PASS.
- [ ] **Step 5:** Commit: `feat(crm): implement leads list page`

### Task A2: CrmKanban page

**Files:**
- Modify: `ui/src/pages/CrmKanban.tsx`
- Test: `ui/src/pages/__tests__/CrmKanban.test.tsx`

**Acceptance:**
- Columns per pipeline stage
- Drag deal card across columns → updates stage via API
- Click deal card → navigate to `CrmDealDetail`

- [ ] **Step 1:** Write test — renders columns, drag moves card (use `@dnd-kit` which the codebase already uses — check `package.json`).
- [ ] **Step 2:** Implement with `@dnd-kit` DndContext + column droppables.
- [ ] **Step 3:** Test PASS.
- [ ] **Step 4:** Commit: `feat(crm): implement kanban board`

### Task A3: Fix CrmPipeline WIP

**Files:**
- Modify: `ui/src/pages/CrmPipeline.tsx` (remove `@ts-nocheck`)

- [ ] **Step 1:** Remove `@ts-nocheck` comment at top of file.
- [ ] **Step 2:** `pnpm --filter @agentdash/ui typecheck` — capture errors.
- [ ] **Step 3:** Fix each type error. If a block is truly abandoned, delete it rather than patch. Preserve anything that still has product value.
- [ ] **Step 4:** Typecheck clean.
- [ ] **Step 5:** Smoke test in dev — navigate to page, verify render.
- [ ] **Step 6:** Commit: `fix(crm): restore type-safety on CrmPipeline`

### Task A4: CrmDealDetail page

**Files:**
- Modify: `ui/src/pages/CrmDealDetail.tsx`
- Test: `ui/src/pages/__tests__/CrmDealDetail.test.tsx`

**Acceptance:**
- Header: deal name, amount, stage, close date, owner
- Sections: contacts, activity timeline, linked HubSpot ID + sync status, notes
- Edit inline; changes persist via PATCH /deals/:id

- [ ] **Step 1:** Test — renders deal, edit stage, persists.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Test PASS.
- [ ] **Step 4:** Commit: `feat(crm): implement deal detail page`

### Task A5: HubSpotSettings page

**Files:**
- Modify: `ui/src/pages/HubSpotSettings.tsx`
- Create: `ui/src/api/hubspot.ts` (if not present)
- Test: `ui/src/pages/__tests__/HubSpotSettings.test.tsx`

**Acceptance:**
- OAuth "Connect HubSpot" button → redirects to Hubspot OAuth, on return shows connected portal name + disconnect
- Field mapping UI: AgentDash field ↔ HubSpot property (dropdown per field)
- Sync direction toggle: read-only / write-only / bidirectional
- Manual "Sync now" button

- [ ] **Step 1:** Confirm HubSpot OAuth routes exist in `server/src/routes/` (`hubspot-oauth.ts` or similar). If missing, surface as A5a.
- [ ] **Step 2:** Write test — renders disconnected state, click Connect navigates to oauth URL; renders connected state; renders field map.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Test PASS.
- [ ] **Step 5:** Commit: `feat(hubspot): implement settings page with OAuth + field mapping`

### Task A6: CUJ-A integration test

**Files:**
- Create: `tests/cujs/cuj-a-sales-pipeline.spec.ts`

- [ ] **Step 1:** Write E2E: seed lead → navigate /crm/leads → click Convert → redirected to /crm/deals/:id → verify created → navigate /crm/kanban → drag to next stage → navigate /crm/deals/:id → stage updated → verify HubSpot sync status (mocked).
- [ ] **Step 2:** Run — PASS.
- [ ] **Step 3:** Commit.

### Task A7: CUJ-A gate

- [ ] **Step 1:** `pnpm -r typecheck && pnpm test:run && pnpm build` — exit 0.
- [ ] **Step 2:** `bash scripts/test-cujs.sh --filter cuj-a` — green.
- [ ] **Step 3:** Gate passed → proceed to CUJ-C.

---

## CUJ-C: Personal Productivity Surface

### Task C1: UserProfile page

**Files:**
- Modify: `ui/src/pages/UserProfile.tsx`
- Create: `ui/src/api/user-profile.ts`
- Test: `ui/src/pages/__tests__/UserProfile.test.tsx`

**Acceptance:**
- Sections: identity (name, email — read-only from Better Auth), API keys (create, rotate, revoke), preferences (timezone, notification settings), danger zone (delete account — confirm modal)
- API key creation reveals secret once, then shows hash-only

- [ ] **Step 1:** Confirm backend: `user_api_keys` table + routes. If missing, surface as C1a.
- [ ] **Step 2:** Test — sections render, create key returns secret, subsequent reads show `•••••last4`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Test PASS.
- [ ] **Step 5:** Commit: `feat(user): implement profile page with API key management`

### Task C2: Enhance Feed aggregation

**Files:**
- Modify: `server/src/services/feed.ts`
- Test: `server/src/services/__tests__/feed.test.ts`

**Acceptance:**
- Feed query aggregates: agent heartbeats (last N), issue updates, goal progress events, action proposal events, within company_id scope
- `userId` filter optional — restricts to events relevant to that user (assigned issues, owned agents, pending approvals for them)

- [ ] **Step 1:** Test — seed 4 event types for user A and 4 for user B. Query with `userId: A` → only user A's events.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement using UNION ALL across sources (agents, issues, goals, action_proposals) into `feed_events` materialized view or live query.
- [ ] **Step 4:** Test PASS.
- [ ] **Step 5:** Commit: `feat(feed): aggregate heartbeats, issues, goals, and proposals`

### Task C3: CUJ-C integration test

**Files:**
- Create: `tests/cujs/cuj-c-productivity.spec.ts`

- [ ] **Step 1:** E2E: seed activity → Feed shows all 3 event types chronologically → UserProfile → create API key → assign to agent in AgentConfigForm → verify agent uses it.
- [ ] **Step 2:** Run — PASS.
- [ ] **Step 3:** Commit.

### Task C4: CUJ-C gate

- [ ] **Step 1:** `pnpm -r typecheck && pnpm test:run && pnpm build` — exit 0.
- [ ] **Step 2:** `bash scripts/test-cujs.sh --filter cuj-c` — green.
- [ ] **Step 3:** Gate passed → proceed to Phase 1 wrap-up.

---

## Phase 1 Wrap-up

### Task W1: Update PRD with new CUJs and tier matrix

**Files:**
- Modify: `doc/PRD.md`

- [ ] **Step 1:** Add CUJ-16 (Assess) — copy from `.omc/specs/assess-integration.md` if present, else summarize from existing Assess pages.
- [ ] **Step 2:** Add CUJ-17 (Assistant Chatbot) — copy from `.omc/specs/deep-interview-assistant-chatbot.md`.
- [ ] **Step 3:** Add the tier matrix table from the master spec section 4.1.
- [ ] **Step 4:** Update `doc/CUJ-STATUS.md` — mark CUJs A/B/C/D as shipped.
- [ ] **Step 5:** Commit: `docs: add CUJ-16, CUJ-17, tier matrix to PRD`

### Task W2: Phase 1 full verification

- [ ] **Step 1:** `pnpm -r typecheck` — 0 errors across 19 packages.
- [ ] **Step 2:** `pnpm test:run` — 100% pass.
- [ ] **Step 3:** `pnpm build` — exit 0.
- [ ] **Step 4:** `bash scripts/test-cujs.sh` — all CUJs green including A, B, C, D.
- [ ] **Step 5:** Manual smoke test in dev: walk through each of the 4 CUJs end-to-end in the UI.
- [ ] **Step 6:** Commit any cleanup: `chore: phase 1 final cleanup`

### Task W3: Transition to Phase 2

- [ ] **Step 1:** Write Phase 2 plan at `docs/superpowers/plans/2026-04-16-v1-completion-phase-2.md` per master spec section 5.1-5.3.
- [ ] **Step 2:** User review of Phase 2 plan (prompt user).
- [ ] **Step 3:** On approval, begin Phase 2 execution.

---

## Notes for the Executor

- **Backend gaps:** Some UI tasks reference backend routes that may not fully exist. In each case, if the route is missing, create a pre-task (e.g., B1a, C1a) to add the backend route+service+tests before the UI task. Do not build UI against non-existent APIs.
- **Seed data:** `bash scripts/seed-test-scenarios.sh` already exists — extend it with per-CUJ seed fixtures (e.g., `--scenario=cuj-b`) rather than adding one-off seed routes.
- **Gated adapters deferred to Enterprise:** For adapters that the D1 disposition doc marks Enterprise-only, leave a clear `// TODO(Phase 2): replace with <Gated capability="custom_adapters">` comment and proceed. Phase 2 will wire the actual gate.
- **Commit cadence:** every task ends in a commit. Do not batch multiple tasks per commit.
- **Test framework:** component tests use vitest + @testing-library; E2E uses Playwright. See `ui/src/pages/Agents.tsx` and corresponding test for the established patterns.
