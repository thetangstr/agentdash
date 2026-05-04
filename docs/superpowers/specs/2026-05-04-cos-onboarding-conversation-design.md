# CoS-led onboarding conversation — design spec

**Status:** draft, awaiting user sign-off
**Date:** 2026-05-04
**Owner:** team
**Supersedes:** the implicit spec embedded in PRs #126, #127, #131, #135

## Why this exists

The current onboarding (after PR #131) hardcodes a 4-message welcome:

```
1. "Hi! I'm your Chief of Staff."
2. "Welcome to AgentDash. I'm here to help you build a team of AI agents…"
3. "Before we get started, I want to understand what you're working on…"
4. (interview card) "What's your business and who's it for?"
```

That's a placeholder, not the product. The user asked us to design the actual flow:

> Chris signs up. The CoS greets him, gives context about who the CoS is and why they're having this initial conversation, asks Chris about his short-term and long-term goals, asks whatever follow-up questions are needed to create a plan with agents to achieve those goals, presents the goals + plan, revises as needed, and then "starts the company" on AgentDash.

This spec captures that flow and what we have to build to ship it.

## The persona — Chris

Chris is the CTO of a 2,000-employee company. He's signing up because his board wants to know "can we use AI agents to do real work, the way we hire employees?" He wants:

- A system that feels like managing a team, not configuring a chatbot
- A clear plan: "for your goals, here's the agents I'd hire and what they'd do"
- Confidence to defend the plan to his CEO and board
- A revisable plan — he wants to push back on items, swap roles, change scope

Chris is the test persona for the e2e validation (see §6). His questions, push-backs, and confirmation flow drive the canonical happy-path script.

## Phases of the conversation

The CoS conversation has five distinct phases. Each phase has a clear goal, a clear handoff signal to the next phase, and an observable artifact in the DB (we can write tests against it).

### Phase 0 — Greeting + context (CoS opening turn)

**Goal:** Chris understands who the CoS is and why this conversation exists, in under 15 seconds of reading.

**CoS posts (atomically, on workspace creation):**

1. Greeting: "Hi Chris, I'm your Chief of Staff."
2. Context: "AgentDash lets you hire AI agents that do real work. I'm here to help you figure out what you actually need, propose a team, and get them set up — like an HR-plus-Chief-of-Staff hybrid for an AI workforce."
3. The first question: "What are you trying to accomplish? Tell me your top short-term goal, and where you want this to be in 6–12 months."

**Why one combined opening turn instead of three separate bubbles:** the user said this should feel like a real conversation, not a robot survey. A real CoS introduces themselves and asks one substantive question. Multiple back-to-back rapid-fire bubbles read as automation; one rich opening reads as a person.

**Open question:** does the opening LLM-generate per-user (using the user's `name` and `email` domain), or is it a static template? Static is faster + more predictable; generated is warmer. Lean static for v1, swap to generated when prompt-cache savings make it worth it.

**Artifact:** one `assistant_messages` row with `role='agent'`, `cardKind=null`, posted by the CoS agent at conversation creation time.

### Phase 1 — Goals (interactive, LLM-driven)

**Goal:** capture Chris's short-term goal + long-term goal in his own words, plus any constraints he volunteers.

**Loop:**
1. Chris replies to the opening question.
2. CoS calls dispatch-llm. The model has system-prompt instructions to:
   - Acknowledge what Chris said
   - Confirm understanding ("So short-term you want X, long-term you want Y. Got it.")
   - Ask the ONE most useful clarifying question to size the plan (NOT generic "tell me more" — concrete: "How many people on your eng team today?" / "Are you starting from zero on this or building on existing infrastructure?")
3. Chris replies. CoS evaluates: do I have enough to draft a plan?
4. If yes → Phase 2. If no → loop back to step 2 with a different clarifying question.

**Stopping criterion:** the CoS has captured enough context to draft a plan. Concretely: short-term goal + long-term goal + at least one of {team size, budget, current state, urgency}. The CoS judges this — no hard turn limit.

**Artifact:** an evolving `cos_state.goals` JSON blob attached to the conversation (new column on `assistant_conversations` or new table `cos_onboarding_state`):

```json
{
  "shortTerm": "ship the v2 dashboard by end of Q3",
  "longTerm": "have a self-running ops org by next year",
  "constraints": { "teamSize": 12, "budgetMonthly": 5000 },
  "phase": "goals",
  "turnsInGoals": 3
}
```

### Phase 2 — Plan presentation

**Goal:** present a concrete agent team for Chris's goals, with reasoning.

**CoS posts (one message, structured card):**

```
"Based on what you told me, here's the team I'd build out:

  CTO (you)         — strategic decisions, sign-off
  Engineering Lead  — Claude Code agent, owns shipping the v2 dashboard
  Product Lead      — researches users, writes specs
  QA Engineer       — tests the dashboard nightly, files bugs
  Finance           — tracks burn against the $5k/mo budget

That hits your short-term ship goal AND seeds the long-term ops org.

Want me to proceed, or should we revise?"
```

**Card payload (`cardKind: "agent_plan_proposal_v1"`):**

```json
{
  "rationale": "<short paragraph>",
  "agents": [
    {
      "role": "engineering_lead",
      "name": "Engineering Lead",
      "adapterType": "claude_local",
      "responsibilities": ["...", "..."],
      "kpis": ["..."]
    },
    ...
  ],
  "kpiSummary": "...",
  "alignmentToShortTerm": "...",
  "alignmentToLongTerm": "..."
}
```

The card renders as a structured proposal in the UI with two CTAs: **Looks good, set it up** and **Let me revise**.

**Artifact:** one row in `assistant_messages` with `cardKind='agent_plan_proposal_v1'` and the payload above.

### Phase 3 — Revision (optional loop)

**Goal:** Chris can push back on any item without restarting the whole flow.

If Chris clicks **Let me revise** OR types something like "drop the QA, swap finance for marketing, the eng lead should be GPT-5":
1. The CoS treats his message as a delta on the proposal
2. LLM revises the proposal (same `agent_plan_proposal_v1` card, new payload)
3. Posts the revised card with a one-line "Updated based on your feedback — what changed:" preamble

Loop until Chris either confirms or rejects entirely.

**Stopping criteria:**
- Confirm → Phase 4
- "Forget it, let me explore on my own" → Phase 5b (escape hatch)

### Phase 4 — Materialization

**Goal:** turn the confirmed plan into real workspace state.

When Chris confirms (button click OR clear textual confirm):
1. Server side: read the latest `agent_plan_proposal_v1` payload from the conversation
2. Iterate `payload.agents`, call `agentService.create()` for each — using the adapter type from the payload, materializing the appropriate instructions bundle
3. Post a closing message: "Done — I've set up your team. Click an agent in the sidebar to talk to them directly, or stay here and route everything through me."
4. Set `cos_state.phase = "ready"` on the conversation

**Artifact:** N new rows in `agents` (where N = `payload.agents.length`), all `companyId = current company`, plus a final agent message in the conversation marking the milestone.

### Phase 5 — Steady state OR escape hatch

After Phase 4, the conversation is in **steady state**: Chris can keep chatting with the CoS for ongoing operations, route requests to specific agents via `@mention`, etc.

If Chris bails before confirming (Phase 5b): the conversation stays in goals/plan phase and he can come back to it. No agents are created. The "let me explore on my own" exit just dismisses the proposal card — nothing destructive.

## Required server changes

This is the engineering work to ship the spec. Items in **bold** don't exist yet.

| Component | Change |
|---|---|
| `onboarding-orchestrator.ts` | Drop the hardcoded 4-message welcome; post only the **single Phase 0 greeting** (combined into one rich message) |
| `cos-onboarding-state.ts` (NEW) | Service to read/write the `cos_state` blob attached to a conversation. Handles phase transitions, goal capture, plan storage |
| `assistant_conversations` schema | Add column `cos_state JSONB` (or new table `cos_onboarding_states` with FK). Drizzle migration |
| `cos-replier.ts` | **Replace** the generic system prompt with a phase-aware one: read `cos_state.phase` and inject phase-specific instructions before calling `dispatchLLM`. The model returns a structured response that includes a `nextAction` field (e.g. `{ "phase": "plan", "card": {...} }`) — server uses this to decide what to post |
| `cos-replier.ts` | Detect when the LLM has produced a plan proposal — post it as `cardKind='agent_plan_proposal_v1'` instead of as a plain text bubble |
| `routes/onboarding-v2.ts` | New endpoint `POST /api/onboarding/confirm-plan` — reads the latest plan card, materializes the agents, transitions phase |
| `routes/onboarding-v2.ts` | New endpoint `POST /api/onboarding/revise-plan` — accepts a delta (free-text or structured), passes to the LLM, posts revised card |
| Card schemas | New `cardKind: "agent_plan_proposal_v1"` registered in `packages/shared/src/cards.ts` (or wherever card kinds live) |

## Required UI changes

| Component | Change |
|---|---|
| `cards/AgentPlanProposal.tsx` (NEW) | Renders the `agent_plan_proposal_v1` card. Lists agents, shows rationale, shows alignment to goals, two CTAs |
| `MessageList.tsx` | Wire the new card kind through `CardRenderer` |
| `cards/index.ts` | Register the new card |
| `pages/CoSConversation.tsx` | `cardContext.onProposalConfirm` calls `/api/onboarding/confirm-plan`; `onProposalReject` (or a new `onProposalRevise`) calls `/api/onboarding/revise-plan` with the user's revision text |

## Required test infrastructure

This is where the user's "Chris persona" framing comes in.

We can't unit-test phase transitions because the conversation is LLM-driven and non-deterministic. We need an **agentic e2e test** where one LLM plays Chris (the CTO) and another LLM plays the CoS (under test).

### `tests/e2e/personas/chris-cto.ts` (NEW)

A persona module:

```ts
export const chrisCto = {
  systemPrompt: `You are Chris, CTO of a 2000-employee SaaS company. Your
short-term goal is to ship a v2 dashboard by end of Q3. Your long-term
goal is to have a self-running ops organization by next year. Your eng
team is 12 people. Your monthly AI budget is $5,000. You're talking to
the AgentDash Chief of Staff to set up a team of AI agents.

Be concise (1-3 sentences per reply). Push back at least once on the
plan to make sure it's actually responsive to your goals. Confirm only
when you're satisfied. If the conversation rambles for more than 10
turns without producing a concrete plan, type "let me revise" or
"propose a plan now."`,

  // Convert the running conversation into messages for Chris's LLM:
  buildMessagesForChris: (conversation: ConversationMessage[]) => { ... },

  // Chris's adapter — separate from the CoS dispatch path so we don't
  // route Chris through the same LLM that's under test.
  llm: anthropicChrisLLM,  // or hermesChrisLLM, or claude_api with a different key
};
```

### `tests/e2e/onboarding-chris-flow.spec.ts` (NEW, replaces #135's spec)

```ts
test("Chris CTO can sign up and walk through the full plan flow", async () => {
  // 1. Sign up as Chris
  await signUpAs(page, chrisCto.email, chrisCto.password);

  // 2. Wait for the Phase 0 greeting (one message, contains "Chief of Staff")
  await page.waitForMessageCount(1);
  expect(getMessages(page)[0].body).toMatch(/chief of staff/i);

  // 3. Drive the conversation — Chris persona replies, CoS replies, etc.
  let turn = 0;
  while (turn < 15) {
    const next = await chrisCto.respondTo(getMessages(page));
    if (next === null) break;  // Chris is done
    await typeAndSend(page, next);
    await waitForNewAgentReply(page);

    // Stop when a plan card appears
    if (latestMessage(page).cardKind === "agent_plan_proposal_v1") break;
    turn++;
  }

  // 4. Assert a plan was proposed
  const planMessage = page.getByTestId("plan-proposal");
  await expect(planMessage).toBeVisible();
  const plan = await page.evaluate(() => /* read card payload */);
  expect(plan.agents.length).toBeGreaterThanOrEqual(2);
  expect(plan.alignmentToShortTerm).toBeTruthy();
  expect(plan.alignmentToLongTerm).toBeTruthy();

  // 5. Chris confirms
  await page.getByRole("button", { name: /set it up/i }).click();

  // 6. Assert agents got materialized
  await expect.poll(() =>
    fetchCompanyAgents(chrisCto.companyId)
  ).toHaveLength(plan.agents.length);
});
```

The test runs against the real LLM (Hermes if available locally, claude_api with a key in CI). With a real LLM on both sides, the assertions are about CONVERSATION SHAPE (Phase 0 greeting → goals captured → plan card emitted → confirm produces agents) rather than specific copy.

### What about determinism?

LLM-driven tests are flaky by nature. Three mitigations:

1. **Loose assertions** — assert structural facts (a card with `cardKind: agent_plan_proposal_v1` was emitted; agent count ≥ 2), not specific copy
2. **Bounded turn count** — fail if 15+ turns produce no plan card. Catches "CoS rambles forever"
3. **Pin the model + temperature** — Chris uses `claude-3-5-sonnet, temperature=0` for the same prompt → same response. CoS uses whatever production uses

## Phasing

This is a meaningful build. Splitting into ship-able phases.

| Phase | Deliverable | Approx. effort |
|---|---|---|
| **A** | Drop hardcoded 4-message welcome → one Phase 0 greeting only. Update orchestrator + tests. (~1 PR, low risk) | ~30 min |
| **B** | New `cos_state` column + service. Phase-aware system prompt in `cos-replier.ts`. CoS now drives goals capture; falls back to free chat if it can't infer phase | ~2 hr |
| **C** | New `agent_plan_proposal_v1` card kind + UI renderer. CoS posts the card when goals are captured; user can confirm via button | ~3 hr |
| **D** | Confirm → materialize agents (the real customer value moment) | ~2 hr |
| **E** | Chris persona + e2e flow test | ~2 hr |
| **F** | Revision loop polish (Phase 3) | ~1 hr |

Phase A unblocks the simpler version of the experience (single greeting + free-flowing Hermes chat). Phase D is the real customer-value milestone (agents actually get created). Phase E proves we don't regress.

I'd ship A immediately, B + C + D as one larger sequence (the real product), then E to lock it in.

## Out of scope for v1

- Multi-language CoS (English only)
- Voice / video onboarding
- Persistent conversational memory across sessions (Hermes handles this internally if used; the CoS's own memory of Chris is conversation-scoped)
- Pre-made templates ("starter pack: 5-person engineering team") — Phase 2 generates per-user
- Chris being able to UPLOAD a doc and have the CoS read it for context. Stretch goal for later

## Open questions for the user

1. **Does this flow match what you wanted?** Specifically the 5-phase split (greet → goals → plan → revise → materialize).
2. **Is "static greeting + LLM-driven follow-ups" acceptable for v1?** Or does Chris need an LLM-generated personalized greeting from turn 1?
3. **Confirm vs revise — button-only or also free-text?** "Yes, set it up" via button is unambiguous; free-text "ok looks good" works too but adds parsing complexity. Recommend button-only for v1, free-text in v1.5.
4. **Test budget per run.** Phase E's e2e test will burn ~30k tokens (Hermes + CoS having a 10-turn conversation). Acceptable in CI?
5. **What happens after Phase 4?** Today the chat is "done" but the user can keep talking. Should the CoS shift to a new system prompt (operations mode) or stay in onboarding tone?

If the flow looks right, I'll start Phase A immediately.
