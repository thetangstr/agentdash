# Deep Interview Spec: Ship the MKThink agent workforce

## Metadata
- Interview ID: 7c1f4a92-3d0e-4b16-9a55-2e8b1c6f0d43
- Rounds: 2 (plus Round 0 topology gate)
- Final Ambiguity Score: 16%
- Type: brownfield
- Generated: 2026-08-06
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.88 | 0.35 | 0.308 |
| Constraint Clarity | 0.75 | 0.25 | 0.188 |
| Success Criteria | 0.82 | 0.25 | 0.205 |
| Context Clarity | 0.92 | 0.15 | 0.138 |
| **Total Clarity** | | | **0.839** |
| **Ambiguity** | | | **0.161** |

## Topology

Six components, all confirmed active, all serving one outcome. Ordered by
dependency rather than by severity — the profile fix gates three of the others.

| Component | Status | Description | Coverage |
|-----------|--------|-------------|----------|
| `workspace-profile` | active | Existing workspaces are `productProfile: default`, so My Agent, the connect panel, peer asks and the bridge are invisible. Includes the `PATCH` hole that sets the profile with no invite code. | AC-1, AC-2 |
| `real-agent-replies` | active | `conversations.ts` hardcodes `adapterFor` to return `"Stub agent reply"`, bypassing a working `dispatchLLM`. | AC-3, AC-4 |
| `bridge-enrolment` | active | No real person has ever enrolled their own machine; escalation silently degrades to a notice. | AC-5, AC-6 |
| `first-goal-tutorial` | active | The missing beat between creating the CoS and handing off. Goals are currently created programmatically by a script. | AC-7 |
| `mcp-convergence` | active | Titus's handoff brief makes raw HTTP calls while a 71-tool MCP exists; all four brief bugs were prose-vs-API drift. | AC-8 |
| `authorization-gaps` | active | Billing routes authorize on membership rather than role: any member can cancel the subscription. | AC-9 |

## Goal

Three real MKThink colleagues, plus Titus, are using the AgentDash instance on
the office LAN: each has their own agent paired to them, connected to the Claude
Code or Codex they already use, with their own machine enrolled on the bridge —
and a board pack has been assembled by the Chief of Staff from answers those
three people actually gave from their own terminals, with real model-written
agent contributions rather than canned strings.

## Constraints

- **LAN-first.** All four machines are on the same office network as
  `192.168.86.57` for the initial rollout. Remote access exists but its protocol
  is unknown, so nothing may *depend* on Tailscale or any specific remote path.
- **No new model spend assumed.** `AGENTDASH_DEFAULT_ADAPTER=claude_local` is
  already configured on both LAN instances and `dispatchLLM` supports it by
  spawning `claude --print -`. This uses the local Claude subscription; no
  `ANTHROPIC_API_KEY` is set and none should be required.
- **No email provider.** Invites and password links are handed over directly;
  `emailStatus: "skipped"` is the expected, correct outcome.
- **Real people, real time.** Three colleagues must accept invites, run one
  command, and answer one escalation. Their availability is a dependency, not
  something buildable.
- **Their laptops must have Claude Code or Codex.** Unconfirmed; a prerequisite
  check belongs in the rollout, not an assumption.
- **The owner's `lantest` instance must not be destroyed.** It carries a real
  180-day licence and the user's own claim.

## Non-Goals

- Remote/off-LAN access for the three colleagues. Explicitly deferred — the
  protocol is unknown and nothing may hard-depend on one.
- Publishing `@agentdash/mcp-server` to npm. The instance serves the tarball;
  that is sufficient and works air-gapped.
- Owner-added custom destructive-action classes (T5b).
- Real Telegram/WhatsApp delivery, and real SharePoint/HubSpot reads. Mocked
  connectors are acceptable for this milestone.
- Turning the wizard's manual route into the only path in.

## Acceptance Criteria

- [ ] **AC-1** Both existing `mkthink` workspaces report
      `productProfile: agentdash_mk`, and `My Agent` renders for a paired
      steward rather than the "does not use the AgentDash-MK profile" notice.
- [ ] **AC-2** Setting a non-default `productProfile` via `PATCH /companies/:id`
      requires a valid invite code in `authenticated` mode, closing the bypass;
      an owner without a code gets a refusal naming the reason. A test covers it.
- [ ] **AC-3** `@mention`-summoning an agent produces a model-written reply. The
      string `"Stub agent reply"` no longer exists in `server/src`.
- [ ] **AC-4** The summoner routes through the same adapter selection as
      `cosReplier` (`AGENTDASH_DEFAULT_ADAPTER`), and fails with an explicit
      error rather than a canned string when no adapter is configured. A test
      asserts a stub reply can never be returned silently.
- [ ] **AC-5** A person can enrol their own machine on the bridge from their own
      terminal, discoverable from `My Agent` — not by an operator running a seed
      script. Enrolment grants `bridge:read` only.
- [ ] **AC-6** With a real enrolled endpoint, a CoS fact request escalated to a
      steward arrives on that person's machine, they answer from their terminal,
      and the answer appears attributed to them. Verified with at least one real
      colleague, not a seeded endpoint.
- [ ] **AC-7** The first-run experience includes an interactive first-goal step:
      the owner sets a goal in the UI (with a pre-written example they can accept)
      and it becomes a real goal owned by the CoS, with its collection tasks —
      no script required.
- [ ] **AC-8** Titus's handoff brief instructs the harness to use the MCP tools
      rather than raw HTTP for the calls MCP covers, keeping the narrative
      (who the agents are, which mandates to ask for, carrying the goal) and
      dropping the hand-maintained endpoint documentation.
- [ ] **AC-9** Billing routes that mutate a subscription require owner or admin
      role, not bare membership. A test proves a plain member cannot reach the
      Stripe portal or cancel.
- [ ] **AC-10** End to end, cold: claim → password → CoS + mandate → first goal
      in the UI → handoff builds 3 agents and 3 human accounts → 3 colleagues
      accept, connect, and enrol → CoS-coordinated run yields a board pack with
      attributed, model-written contributions.

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "Ship" means the demo works when Yang walks it | Asked what must be *true*, not what must be *shown* | Rejected the solo walkthrough and the polished-demo readings: shipped means three real colleagues are using it and a board pack came from their real answers |
| Real agent replies need an API key and new spend | Checked `dispatchLLM` before assuming | False. `claude_local` is already configured and supported; the stub bypasses a working path. The fix is wiring, not integration |
| Remote access needs solving first | Asked where the machines actually are | Same office LAN to start; remote exists but protocol unknown, so it becomes an explicit non-goal rather than a hidden dependency |
| The six gaps are independent tickets | User added that the goal is to ship the whole thing | They are one outcome with a dependency order; `workspace-profile` gates three others |
| Bridge escalation works because `board-deck.mjs` proved it | Distinguished seeded endpoints from real enrolment | The mechanism is proven; the *human* path has never been walked. Enrolment by a real person is untested and is now AC-5/AC-6 |

## Technical Context

Verified firsthand against running instances during the session preceding this
interview, rather than by a fresh exploration pass:

- `server/src/routes/conversations.ts` — `adapterFor: (_t: string) => ({ execute: async () => ({ output: "Stub agent reply" }) })`. The `replier` beside it already uses `dispatchLLM`.
- `server/src/services/dispatch-llm.ts:30` — supported adapters: `claude_api`, `minimax`, `openai_compat`, `hermes_local`, `claude_local`. `claude_local` spawns `claude --print -`.
- `server/src/routes/companies.ts:345` — create-time invite-code gate, `authenticated` mode only. `assertCanUpdateProductProfile` (line 119) requires only owner/admin on update, with no code — the bypass.
- `server/src/services/agent-fact-requests.ts:695` — escalation requires an endpoint with `enrolledAt` and `bridge:read`; otherwise `teams.sendNotice`.
- `ui/src/pages/MyAgent.tsx` — gated entirely on `productProfile === "agentdash_mk"`.
- `ui/src/components/OnboardingWizard.tsx` — 5 steps; step 3 harvests the mandate and writes `AGENTS.md` before the task is created.
- MCP: `@agentdash/mcp-server`, 71 tools, served at `/downloads/agentdash-mcp-server.tgz`; `selectPlaybook` picks the steward contract when `PAPERCLIP_AGENT_ID` is set. Verified over LAN — `whoami` returned `CoS / chief_of_staff`.
- Instances: `lantest` 192.168.86.57:3100 (owner's, real licence — do not destroy), `mkdemo` :3101 (clean, claimed as titus@mkthink.com), `fresh1` :3500 and `fresh2` :3600 (scratch).

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Owner/Steward | core domain | name, email, userId, role | stewards exactly one Agent per Workspace |
| CoS Agent | core domain | id, name, mandate, key | is Titus's agent AND the company's Chief of Staff |
| Teammate Agent | core domain | id, name, role, mandate, key | stewarded by one Human Counterpart |
| Human Counterpart | core domain | email, userId, membership | pairs 1:1 with a Teammate Agent |
| Workspace | core domain | id, name, productProfile, inviteCode | contains Agents, Goals, Issues |
| Goal | core domain | id, title, level, ownerAgentId | parent of Issues |
| Issue | core domain | id, title, status, assigneeAgentId | belongs to a Goal |
| Mandate | core domain | path (AGENTS.md), content | entry file of an Agent's instruction bundle |
| Fact Request | core domain | factKey, runId, pipelineId, sourceKind, status | from one Agent to another, may escalate |
| Bridge Endpoint | core domain | id, enrolledAt, capabilities | belongs to a Human Counterpart's machine |
| API Key | supporting | token, name | board key (a person) or agent key (an Agent) |
| MCP Connection | external system | apiUrl, apiKey, companyId, agentId | binds a harness to one Agent |
| Adapter | external system | name, command | `claude_local` spawns the local Claude CLI |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 12 | 12 | - | - | N/A |
| 2 | 13 | 1 (Adapter) | 0 | 12 | 92% |
| 2 (rescore) | 13 | 0 | 0 | 13 | 100% |

Converged: the same 13 entities held with no renames once the adapter fact
landed, so the domain model is stable.

## Execution Order

Dependency-ordered, because `workspace-profile` gates three others and
`real-agent-replies` is what makes the run meaningful:

1. `workspace-profile` — flip both workspaces; close the `PATCH` bypass. (AC-1, AC-2)
2. `real-agent-replies` — wire the summoner to `dispatchLLM`. (AC-3, AC-4)
3. `bridge-enrolment` — self-serve enrolment surfaced on My Agent. (AC-5)
4. `first-goal-tutorial` — the missing UI beat. (AC-7)
5. `mcp-convergence` — rewrite the handoff brief onto MCP tools. (AC-8)
6. `authorization-gaps` — role-gate the billing mutations. (AC-9)
7. Rollout with the three colleagues; verify AC-6 and AC-10 cold.

## Interview Transcript

<details>
<summary>Full Q&A (2 rounds + topology gate)</summary>

### Round 0 — Topology confirmation
**Q:** Six top-level components proposed; which are in scope?
**A:** All six, plus: "review our previous overall requirement as well — the goal and scope of this exercise is to ship this thing."
**Effect:** Topology locked at 6 active, 0 deferred, re-anchored to the original `/goal` flow rather than treated as separate tickets.

### Round 1 — Success Criteria (weakest at 0.35)
**Q:** What has to be true for you to call this shipped?
**A:** Three real MKThink colleagues are using it — invites accepted and paired, each connecting their own harness, each enrolling their own machine on the bridge, and a board pack assembled from their real answers.
**Ambiguity:** 47% → 25% (Goal 0.85, Constraints 0.45, Criteria 0.80, Context 0.92)

### Round 2 — Constraints (weakest at 0.45)
**Q:** Where are the three colleagues' machines relative to 192.168.86.57?
**A:** "Same office LAN to start, their remote access is available but I don't know the protocol."
**Ambiguity:** 25% → 16% (Goal 0.88, Constraints 0.75, Criteria 0.82, Context 0.92) — threshold met.

</details>

## Status

`pending approval`
