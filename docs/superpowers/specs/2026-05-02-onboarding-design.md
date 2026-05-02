# Onboarding (rescoped) — design spec

**Date:** 2026-05-02
**Status:** Approved (brainstorm phase complete)
**Target:** AgentDash v2 (clean rebuild on latest `upstream/master`)

---

## 1. Context

AgentDash v1's onboarding is a marketing landing page (`ui/src/pages/WelcomePage.tsx`) — value props, audience cards, deployment cards. It activates nobody. The original 5-step wizard it replaced was deleted in commit `0469a92a`.

For v2, AgentDash is being rebuilt as a clean fork of latest Paperclip. Onboarding is one of five subsystems carried over; this spec covers it in isolation. Other subsystems (UI redesign with Claude design, Assess + agent research, billing, multi-human + CoS chat) have their own specs.

**Companion decisions already locked (out of scope to relitigate here):**
- CoS chat is the front door of AgentDash.
- The first CoS session must produce a hired agent, not just an interview.
- Target user is a 2–5-human team; the founder/lead signs up first.
- Multi-human invite happens during onboarding, right after the agent hire.

---

## 2. Goal

Take a first-time visitor from sign-up to **"I have a named AI direct report on my org chart and my teammates can see them"** in under 10 minutes, via a single CoS conversation.

---

## 3. Users and success criteria

### Persona
Founder or team lead at a 2–5-human team. They want AI doing real work, not configuring software. Mixed technical background (some are CTOs, some are non-technical operators).

### Activation moment
The user has hired one named agent (with SOUL/AGENTS bundle pre-filled from the interview) **and** either invited at least one teammate or explicitly skipped invites.

### Funnel metrics (initial targets)
| Step | Conversion |
|---|---|
| Sign-up → CoS chat opened | 95% (technical floor — auto-provision works) |
| CoS chat opened → agent hired | 70% (real onboarding success) |
| Agent hired → invited ≥1 teammate | 30% |
| Agent hired → returns next day | 40% |

These are starting targets; the heartbeat email digest is the lever for the "returns next day" number.

---

## 4. Architecture — the 5-stop flow

```
┌──────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────────┐   ┌─────────────┐
│ Sign up  │──▶│ Auto-provision│──▶│ CoS interview│──▶│ Agent proposal│──▶│ Invite team │
└──────────┘   └──────────────┘   └─────────────┘   │   + hire     │   │  (or skip)  │
                                                     └──────────────┘   └─────────────┘
                                                                              │
                                                                              ▼
                                                                       Daily heartbeat
                                                                       email digest
                                                                       (re-engagement)
```

The user perceives the entire flow as **one continuous CoS chat**. There is no progress bar, no step counter, no wizard chrome.

### Stop 1 — Sign up

- Surface: email + password OR Google SSO. Both inherited from upstream Paperclip's better-auth.
- On submit, the user is redirected directly into the CoS chat. **No interstitial welcome page.**
- Existing free-mail block (current `corp-email-signup-guard.ts`) is carried forward for Pro deployments only; Free deployments accept any email.

### Stop 2 — Auto-provision (invisible to user)

Triggered server-side by the first authenticated request after sign-up. Idempotent.

| Action | Source |
|---|---|
| Create `companies` row, derive `email_domain` from creator email | Inherited from current AGE-55 logic |
| Promote creator to `owner` membership | Inherited from current AGE-55 |
| Grant `agents:create` to creator | Inherited from GH #72 fix (PR #74) |
| Create Chief of Staff agent with default SOUL/AGENTS/HEARTBEAT from `server/src/onboarding-assets/chief_of_staff/` | Inherited from current code |
| Materialize CoS instructions bundle synchronously | Inherited from GH #70 verification (PR #74) |
| Auto-create CoS API key | Inherited from GH #71 fix (PR #74) |
| Open a CoS conversation thread; seed first CoS message | New |

**User sees:** the chat panel loads with CoS's opening message already there. Sub-second perceived latency.

### Stop 3 — CoS interview (adaptive)

Three fixed grounding questions, then 2–4 adaptive follow-ups branched on the answer to question 2.

**Fixed (asked in order):**
1. *"What's your business and who's it for?"*
2. *"What's eating your time most this month?"*
3. *"What does success look like 90 days from now?"*

**Branching after question 2:**
| Answer signal | Follow-ups |
|---|---|
| Outbound / sales | Volume per week, current tools (HubSpot/Apollo/etc.), what's broken |
| Content / marketing | Platforms, cadence, who creates today |
| Operations / admin | Current tools, recurring tasks, decision authority |
| Customer support | Volume, channels, escalation path |
| (Other) | Open follow-up: "tell me more about what 'X' looks like day-to-day" |

**Stop criterion:** CoS has identified (a) the user's domain, (b) the bottleneck, and (c) can write a one-line role description. CoS does not branch indefinitely; max 7 total questions including the fixed three.

**Implementation note:** branching is LLM-driven against a system prompt that includes the stop criterion explicitly. The system prompt is versioned and committed to source so it can be edited and regression-tested.

### Stop 4 — Agent proposal and hire

CoS proposes **one** direct report based on the interview:

```
"Based on what you said, I'd hire <NAME> — <ROLE>.
90-day goal: <ONE-LINE OKR>.
Want me to bring them on?"
```

**Agent name** is generated by CoS (memorable, human-feeling, not "AssistantBot"). **Role** is one of: SDR, content writer, ops coordinator, support triage, research analyst, or a free-form role string if the user's situation doesn't match a template.

**On user confirmation:**
- New agent row created (carries the `agents:create` permission, auto-API-key, sync instructions materialization from PR #74).
- SOUL.md generated from the interview transcript (CoS writes it via LLM call against a fixed template).
- AGENTS.md written from the role + 90-day OKR.
- HEARTBEAT.md is left empty (no schedule yet — that's a later session).
- Agent appears on the org chart with the user as their boss.

**On rejection:** CoS asks "what's off?" and proposes again, max 3 attempts. After the third rejection, CoS falls back to a generic "general assistant" agent template so the flow never deadlocks.

**No pipeline, no routine, no skill assignment** in v1 onboarding. Those are later actions discoverable through CoS.

### Stop 5 — Invite teammates

CoS prompts: *"Want to bring anyone else in to watch how `<agent-name>` is doing? They'll join this same conversation."*

UI: free-form email field (comma-separated), Send button, Skip button.

**On Send:** invite emails dispatched via upstream Paperclip's invite flow (carried from the v2 rebuild base). Each invitee receives a magic link; on first sign-in they land directly in the same CoS thread, with CoS giving a 1-line catch-up. Membership granted as `member` on the company (not `owner`).

**On Skip:** onboarding ends silently, no nag.

End of onboarding. Next time the user signs in, the URL `/` lands them back in this same CoS thread.

---

## 5. Re-engagement — heartbeat email digest

Once-per-day digest from CoS to all conversation participants:

> Subject: Reese sent 14 outreach drafts overnight
>
> Body: 3 are ready for your review. [Open in AgentDash]

- Sent at 9am local time (per-user timezone).
- Skipped if no agent activity in the last 24h.
- Sender is `<cos-name>@agentdash.example` (configurable per-deployment).
- Uses upstream Paperclip's existing notification infrastructure (carried from base).
- **No push notifications, no Slack/Teams DMs in v1.** Email + in-app inbox is the only re-engagement surface.

---

## 6. What's explicitly not in v1 onboarding

| Excluded | Why |
|---|---|
| Tour / feature walkthrough | Dashboard, Pipelines, Inbox, etc. don't exist as visible pages during onboarding. Discovered through CoS. |
| Billing or paywall | First agent is free. Billing is deferred to the billing sub-project's spec. |
| Multi-step wizard chrome | The chat is the flow. No progress bar, no step counter. |
| Skip-to-dashboard escape hatch | If the user wants to abandon, they close the tab. No half-completed dashboard state to confuse them later. |
| Industry/persona templates upfront | CoS branches on live answers; no menu of personas. |
| Routine / schedule setup | Agent is hired with empty HEARTBEAT.md. Setting a schedule is a later session. |
| Skill assignment | Agent gets the role's default skills (none in v1). Skill assignment is a later session. |

---

## 7. Failure paths

| Scenario | Behavior |
|---|---|
| User abandons mid-interview | State persisted; on return, CoS resumes: *"Welcome back — last time you said you do outbound. Want to keep going?"* |
| User rejects proposed agent 3× | Fall back to generic "general assistant" template so onboarding doesn't deadlock |
| Invite email fails (typo, bounce, rate limit) | Non-blocking; onboarding ends as if Skip was pressed; user can retry from settings later |
| Auto-provision fails (DB, network) | Surface error in chat panel with retry button; do not lock the user out |
| LLM provider unavailable for interview | Fall back to a static 3-question form; CoS proposes a generic agent based on the answers |
| User signs up but never opens the chat panel | After 7 days, send a one-time "your CoS is waiting" email; do not nag again |

---

## 8. Architecture units (for the implementation plan)

Each unit has one purpose, a defined interface, and is independently testable.

| Unit | Purpose | Interface | Dependencies |
|---|---|---|---|
| `auth-redirect` | Send post-signup user directly to CoS chat | HTTP redirect from sign-up handler | better-auth (upstream) |
| `auto-provision` (server) | Create company + CoS + grants + API key idempotently | `provisionForNewUser(userId): { companyId, agentId }` | DB schema, GH #70/#71/#72 fixes |
| `cos-interview` (server) | Drive the adaptive interview to stop criterion | `runInterview(threadId): InterviewResult` | LLM provider, system prompt v1 |
| `agent-proposer` (server) | Generate name + role + OKR from interview transcript | `proposeAgent(interview): AgentProposal` | LLM provider |
| `agent-creator` (server) | Materialize agent + SOUL/AGENTS/HEARTBEAT + grants | `createFromProposal(proposal, companyId): AgentRecord` | Existing agent service (PR #74) |
| `invite-prompt` (UI) | Render the post-hire invite step in chat | React component, calls upstream invite endpoint | Upstream invite flow |
| `heartbeat-digest` (server) | Per-user daily email of agent activity | Cron job; `sendDigest(userId): void` | Notification infra (upstream) |
| `cos-system-prompt-v1` | Versioned prompt for CoS interview behavior | Static asset in `server/src/onboarding-assets/chief_of_staff/INTERVIEW.md` | none |

Each unit is independently testable: `cos-interview` can be unit-tested with a mocked LLM and assertion on stop-criterion; `auto-provision` has integration tests against an in-memory DB; `invite-prompt` has component tests.

---

## 9. Data model

Carries from current AgentDash and upstream Paperclip:

- `companies`, `agents`, `agent_api_keys`, `company_memberships`, `principal_permission_grants` — current AgentDash, ported as-is.
- `assistant_conversations`, `assistant_messages` — current AgentDash, ported as-is.

**One required schema addition:** `assistant_conversation_participants` — link table joining many users to one conversation. The CoS thread is one conversation row per company; teammates invited at Stop 5 become additional participants on the same row. Required because v1 didn't support multi-human-in-one-conversation, and upstream Paperclip's multi-user model doesn't impose a chat shape.

**Implementation may add small persistence as needed** (for example, dedup state for the daily heartbeat digest — `last_digest_sent_at` on a user row, or equivalent). This spec doesn't fix the exact shape; the implementation plan picks it.

---

## 10. Testing plan

### Unit tests
- `auto-provision`: idempotency (calling twice doesn't create two CoS agents); grant ordering (setPrincipalPermission before owner ensureMembership, per GH #72); failure rollback (DB error → no half-created state).
- `cos-interview`: stop-criterion fires after fixed-3 + 0–4 branching questions; never exceeds 7 total; resumes from persisted state.
- `agent-proposer`: produces a valid `AgentProposal` from a canned transcript; rejects empty transcripts; max 3 retries.
- `agent-creator`: SOUL/AGENTS/HEARTBEAT files materialized synchronously; agent appears on org chart with correct boss.

### Integration tests (server-level)
- Full onboarding happy path: sign up → /api/me returns a CoS conversation → POST a message → interview runs → agent gets created → invite emails dispatched.
- Resume mid-interview: drop connection after question 2, reconnect, CoS resumes correctly.
- Reject 3× fallback: every proposal rejected → generic agent created.

### E2E (Playwright)
- New user signs up via UI, sees CoS message within 2s, completes interview, hires Reese, invites a teammate, lands back in the same conversation on next sign-in.
- Invitee receives email, clicks magic link, lands in the same conversation, sees CoS catch-up message.

### Regression coverage
The carried-forward fixes from PR #74 (GH #70/#71/#72) already have tests in `agent-permissions-routes.test.ts` and `companies-email-domain-route.test.ts`. Those move with the code to v2.

---

## 11. Out of scope (explicitly deferred)

| Item | Where it lives |
|---|---|
| Billing / paywall during onboarding | Subscription + billing sub-project spec |
| What happens *after* the first agent is hired (second-session content) | A separate "engagement" spec, post-v1 |
| Routine scheduling, skill assignment, pipeline creation | Later sessions, discoverable through CoS |
| Industry-specific agent templates | Could be added as a CoS branch, but not v1 |
| Offline / no-LLM mode for the interview | Static fallback only as failure path; not a first-class flow |
| Re-onboarding existing AgentDash v1 users | Migration script lives with the v2 base-migration spec |

---

## 12. Open questions deferred to writing-plans

- **CoS interview prompt v1 content.** The system prompt itself is a deliverable in implementation; this spec sets the contract (3 fixed + 2–4 adaptive, max 7), not the literal text.
- **Email digest copy and template.** Same — deliverable in implementation.
- **Invite email subject line and body copy.** Same.
- **Specific agent role templates** (SDR / content / ops / support / research) — what their default SOUL/AGENTS look like. Implementation deliverable.

---

## 13. Inheritance summary

**From current AgentDash (v1) — port as-is:**
- Email-domain company derivation (AGE-55)
- `agents:create` grant on company creation (GH #72, PR #74)
- Auto API key on agent creation (GH #71, PR #74)
- Synchronous instructions materialization (GH #70, PR #74)
- Default Chief of Staff SOUL/AGENTS/HEARTBEAT bundle in `server/src/onboarding-assets/chief_of_staff/`
- `assistant_conversations` and `assistant_messages` schema

**From upstream Paperclip (v2 base) — adopt as foundation:**
- better-auth (email + Google SSO)
- Multi-user + invite flow (`b9a80dcf` upstream)
- Notification infrastructure
- `/live-runs` heartbeat plumbing

**New for v2 onboarding:**
- `assistant_conversation_participants` link table (multi-human in one CoS thread)
- `cos-system-prompt-v1` asset
- `auto-provision` orchestrator (combines existing pieces in idempotent order)
- `cos-interview` driver with stop criterion
- `heartbeat-digest` daily email cron

**Discarded from v1:**
- `WelcomePage.tsx` (the marketing brochure)
- The 5-step `services/wizard.ts` (already replaced upstream of this spec)
- Any pre-CoS "pick your persona" or "pick your industry" screen

---

## 14. Decision log

| Decision | Choice | Source |
|---|---|---|
| Migration strategy | A — clean rebuild on latest paperclip | Brainstorm Q1 |
| Front door | A — CoS chat | Brainstorm Q2 |
| First-session output | B — interview + first agent hire | Brainstorm Q3 |
| Target persona | B — small team (2–5 humans + AI) | Brainstorm Q4 |
| Multi-human invite timing | A — during onboarding, after agent hire | Brainstorm Q5 |
| Interview structure | Adaptive (3 fixed + 2–4 branching, max 7) | Default in design proposal, accepted |
| Billing in onboarding | None — first agent free | Default in design proposal, accepted |
| Re-engagement | Daily heartbeat email only | Default in design proposal, accepted |
