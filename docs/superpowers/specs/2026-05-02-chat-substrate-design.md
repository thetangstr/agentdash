# Multi-human + CoS chat substrate — design spec

**Date:** 2026-05-02
**Status:** Approved-pending-review
**Target:** AgentDash v2

---

## 1. Context

This is the chat surface that the rest of v2 hangs off. The onboarding flow lives inside it. Multi-human is core; CoS is the front door; the chat is the company's nervous system.

This spec **must land before the onboarding plan starts** because the onboarding flow assumes the chat substrate exists (proposal cards, invite prompts, multi-participant threads).

Companion decisions already locked elsewhere:
- CoS chat is the front door of AgentDash. ([onboarding spec § 1](./2026-05-02-onboarding-design.md#1-context))
- Target persona is a 2–5-human team. ([onboarding spec § 3](./2026-05-02-onboarding-design.md#users-and-success-criteria))
- One CoS agent per company, auto-provisioned. ([onboarding spec § 4 stop 2](./2026-05-02-onboarding-design.md#stop-2--auto-provision-invisible-to-user))
- Multi-human invite happens during onboarding. ([onboarding spec § 4 stop 5](./2026-05-02-onboarding-design.md#stop-5--invite-teammates))

---

## 2. Goal

Provide the persistent, multi-human chat surface that CoS lives in, with structured-card messages, @-mention summoning of direct reports, real-time delivery, and per-participant read state. Lean enough to ship in one PR, but the right shape to grow into the company's nervous system.

---

## 3. Conversation model

### One conversation per company, persistent

There is exactly **one** `assistant_conversations` row per company. Created when the user is auto-provisioned during onboarding. Lives forever; never archived in v1. Every human who joins the company is added as a participant.

Trade-off acknowledged: a 50-person team running a 6-month-old workspace will have a long conversation. We accept that for v1 (per the spec's "lean" framing). If/when scrolling becomes painful, v1.1 can add date-jumping or per-topic threads. Not now.

### Participants

`assistant_conversation_participants` (defined in onboarding spec § 9) joins many users to one conversation. Roles: `owner` (the original creator), `member` (anyone invited later). Membership is independent of company membership — a user can be in the company but not yet in the conversation (e.g., during the moment between accepting an invite and CoS picking them up).

### Agent presence

Per brainstorm Q1 (option C — Hybrid):
- **CoS is always present.** Speaks unprompted (when an agent reports back) and on every human turn.
- **Direct-report agents are summoned by `@mention`.** A human typing `@reese what's the status?` sends a message addressed to the SDR named "Reese." The agent gets the last 20 messages of conversation context, posts one reply, and is done. Each subsequent `@reese` is a fresh summon — no persistent per-agent sub-thread in v1.
- **Mention by name OR role.** `@reese` is the canonical form. `@SDR` resolves to whoever holds the SDR role under the speaker's command chain (typically just one). If ambiguous, CoS clarifies *"You have two SDRs — Reese and Mira; which one?"*

---

## 4. Message model

### Schema (v1 changes)

Existing tables, ported in the v2 base migration plan:

```sql
-- assistant_conversations: one row per company
CREATE TABLE assistant_conversations (
  id              UUID PRIMARY KEY,
  company_id      UUID NOT NULL UNIQUE REFERENCES companies(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- assistant_messages: every turn in every conversation
CREATE TABLE assistant_messages (
  id              UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  author_kind     VARCHAR(16) NOT NULL,  -- 'user' | 'agent'
  author_id       UUID NOT NULL,         -- user.id or agent.id
  body            TEXT NOT NULL,         -- plain text payload
  card_kind       VARCHAR(32),           -- nullable; non-null = card message
  card_payload    JSONB,                 -- typed JSON for the card
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX msg_conversation_created_idx ON assistant_messages (conversation_id, created_at DESC);
```

**New for the chat substrate** (not in v1, not in onboarding spec):

```sql
-- Per-participant read pointer. Powers unread badges and the daily digest.
ALTER TABLE assistant_conversation_participants
  ADD COLUMN last_read_message_id UUID REFERENCES assistant_messages(id) ON DELETE SET NULL;
```

### Card kinds (v1)

Card payloads are typed; the UI has a switch on `card_kind` to render the right component. Each kind's schema is versioned via the column name (e.g., `proposal_card_v1`); breaking changes get a `_v2` and the old code path keeps reading old rows.

| `card_kind` | Payload shape | Renders as | Emitted by |
|---|---|---|---|
| `proposal_card_v1` | `{ name, role, oneLineOkr, rationale }` | Agent hire card with Confirm / Try-again buttons | Onboarding flow (CoS) |
| `invite_prompt_v1` | `{ companyId, conversationId }` | Email-list input + Send/Skip buttons | Onboarding flow (CoS) |
| `agent_status_v1` | `{ agentId, agentName, summary, severity }` | Compact status line ("Reese sent 14 drafts overnight") | Agent activity events |
| `interview_question_v1` | `{ question, fixedIndex }` (optional) | Plain question rendering with subtle "step indicator" if `fixedIndex` set | Onboarding flow (CoS) |

A message is a card if `card_kind IS NOT NULL`. Cards always have a fallback `body` text (so notification emails, screen readers, and any non-card surface have something to render).

---

## 5. Message routing

### Human turn → CoS reply

1. User posts a message via `POST /api/conversations/:id/messages`.
2. Server stores the row.
3. Server emits a `message.created` event on the WS bus.
4. **Mention parser** scans the text for `@<token>`. If a match resolves to an agent under the user's company, dispatch to `agent-summon` (next section). If no mention, dispatch to `cos-reply`.
5. The reply path (CoS or summoned agent) calls the LLM with the last 20 messages and posts the response as a new message row, also emitted on the bus.

### Agent activity → proactive CoS post

1. Agent runtime emits `agent.activity` (existing upstream Paperclip event).
2. A subscriber decides whether the activity is chat-worthy (e.g., "task completed," "email draft ready," "blocked"). Routine telemetry like "heartbeat tick" is *not* chat-worthy.
3. If chat-worthy: post an `agent_status_v1` card to the conversation, authored by the **CoS** (not the direct-report). The card payload includes `agentId` so the UI can deep-link, but the message author is CoS — preserves "one AI voice."

### `@mention` summon

1. Mention parser finds `@reese` (or `@SDR`) in a user message.
2. Resolve to an agent: by name (case-insensitive exact match), then by role under the speaker's command chain.
3. Load the last 20 messages of conversation context as system context for the agent.
4. Run the agent's adapter to produce a reply.
5. Post the reply as a message authored by the **summoned agent** (not CoS). This is the only case where a non-CoS agent appears as a message author.

### Mention disambiguation

If a mention resolves to multiple agents (e.g., `@SDR` matches both Reese and Mira), CoS posts a clarification card asking the human to pick. The original message stands; CoS's clarification is a sibling message in the thread.

---

## 6. Real-time delivery

### Transport: upstream Paperclip's WS bus

Reuse `server/src/realtime/` (carried over from upstream). New event types:
- `message.created` — fired when any message lands. Subscribers filter by `conversation_id`.
- `message.read` — fired when a participant updates their `last_read_message_id`. Used to update other participants' "Reese is reading…"-style indicators if we want them later (not in v1).

### Client subscription

The chat panel subscribes to `message.created` for the company's conversation on mount. New messages append to the bottom; if the user is scrolled up, show a "↓ N new messages" pill.

No polling fallback in v1. WS connection failure shows a banner ("Reconnecting…"); messages are only delivered via WS.

### Read pointer updates

When the chat panel scrolls a message into view, the client `PATCH`es `/api/conversations/:id/read` with the latest visible message ID. Server updates `last_read_message_id`. Throttled at 1s on the client.

---

## 7. Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/conversations/:id/messages?before=<msgId>&limit=50` | Paginated history (cursor by `created_at` desc) |
| `POST` | `/api/conversations/:id/messages` | Post a human message; body `{ body }` |
| `PATCH` | `/api/conversations/:id/read` | Update read pointer; body `{ lastReadMessageId }` |
| `GET` | `/api/conversations/:id/participants` | List participants + their read pointers (for presence indicators) |

`POST /messages` is the entry point — it stores, emits, and triggers the routing logic in § 5. Returns immediately with the human message; CoS/agent replies arrive over the WS bus.

The onboarding routes (`/api/onboarding/*`) sit on top of these — `agent/confirm` posts a `proposal_card_v1` here; `interview/turn` posts an `interview_question_v1` here.

---

## 8. Architecture units

| Unit | Responsibility | Interface | Depends on |
|---|---|---|---|
| `conversation-service` | CRUD on conversations + participants | `findByCompany`, `addParticipant`, `setReadPointer`, `listParticipants` | DB schema, upstream notifications |
| `message-service` | CRUD on messages | `post`, `paginate(before, limit)`, `byId` | DB schema, WS bus |
| `mention-parser` | Pure function: `parse(text, agents) → Mention[]` | `parse(text: string, agentDir: AgentDirectory): Mention[]` | none |
| `agent-summoner` | Run a summoned agent's adapter for one reply | `summon(agentId, contextMessages): SummonResult` | adapter framework, message-service |
| `cos-replier` | Run CoS for a reply when no mention is present | `reply(conversationId, contextMessages): CosReply` | LLM adapter, message-service |
| `activity-router` | Filter `agent.activity` events; decide chat-worthiness | `route(activity): ChatWorthyEvent \| null` | upstream WS bus |
| `cos-proactive` | Post `agent_status_v1` cards on chat-worthy activity | `postStatusCard(conversationId, activity)` | activity-router, message-service |
| `chat-panel` (UI) | Render messages + cards, handle composer + scroll + read pointer | React component tree | WS client, message API |

---

## 9. UI shape (v1)

### Layout

```
┌──────────────────────────────────────────────────┐
│ AgentDash · Acme · CoS  ·  + Invite              │   ← top bar (company, conversation title, invite shortcut)
├──────────────────────────────────────────────────┤
│                                                  │
│  Tue 4:32pm                                      │   ← day separator
│  CoS                                             │
│  Welcome to AgentDash. Let's get you set up.     │
│  What's your business and who's it for?          │
│                                                  │
│  Alice (you) · 4:33pm                            │
│  B2B SaaS for mid-market.                        │
│                                                  │
│  CoS · 4:33pm                                    │
│  What's eating your time most this month?        │
│                                                  │
│  ...                                             │
│                                                  │
│  CoS · just now                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Reese — SDR                                │  │   ← proposal_card_v1 rendered
│  │ Book 200 qualified meetings in 90 days     │  │
│  │ [Looks good →]   [Try again]               │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
├──────────────────────────────────────────────────┤
│ [Type a message…  Tip: @reese to talk to an     │   ← composer with hint
│  agent directly]                            [↑]  │
└──────────────────────────────────────────────────┘
```

- One column. No sidebar in v1 (org chart, agent activity feed are separate routes).
- Messages grouped by author + time-cluster (within 5 minutes of last message from the same author).
- Cards are inline blocks with their own padding.
- Composer is a single textarea with Enter to send (Shift+Enter for newline).
- @-mention typeahead in the composer: type `@`, see a dropdown of agents under your company; Tab to complete.

### Visual style

Defers to the UI redesign (Claude design) sub-project. v1 chat substrate ships with whatever the rebuild base provides; the redesign sub-project styles it.

---

## 10. Failure paths

| Scenario | Behavior |
|---|---|
| WS connection drops | Banner "Reconnecting…" appears; client retries with exponential backoff (1s, 2s, 4s, capped at 30s); on reconnect, re-fetch the last 50 messages and reconcile |
| Human posts faster than CoS replies | Each human message stores immediately; CoS replies are queued and post in order |
| `@reese` matches no agent | CoS posts a clarification message: "I don't see anyone named Reese. Did you mean @<closest>?" |
| `@SDR` matches multiple agents | CoS posts a clarification card asking the human to pick |
| LLM provider unavailable for CoS reply | CoS posts a fallback message ("I'm having trouble reaching my brain right now. Try again in a minute?"); message stored as text, no card |
| Summoned agent's adapter errors | Same fallback pattern — store an error message authored by the agent ("Reese: I hit an error. Tell your CoS so they can sort it.") |
| Two participants post simultaneously | Server-side timestamps tie-broken by `id` (UUIDv7 if available, else random UUIDv4 with `created_at` precedence) |

---

## 11. Out of scope (deferred)

| Item | Where it lives |
|---|---|
| Per-topic / per-project conversations | v1.1 — when scrolling becomes painful |
| Slack-style nested threads under a message | v1.1+ |
| File attachments | v1.1 — after first paying customer asks |
| Direct-report multi-turn sub-conversations (after `@summon`) | v1.1 — when summoned agents need to ask follow-ups before replying |
| Reactions / pins / starring | v1.1 — feature, not foundation |
| Voice / video | Out of scope indefinitely |
| Search across messages | v1.1 — Postgres full-text on `body` is cheap to add later |
| Editing / deleting messages | v1.1 — append-only is enough for v1; edit history surface is a UX question |
| Typing indicators ("CoS is typing…") | Nice-to-have, not v1 |
| Presence indicators ("Alice is online") | Same |

---

## 12. Testing plan

### Unit tests
- `mention-parser`: `@reese`, `@SDR`, `@reese!`, plain text without mentions, multiple mentions in one message, mentions inside code blocks (should not parse).
- `agent-summoner`: with a mocked adapter, returns a SummonResult; passes correct context window (last 20 messages).
- `cos-replier`: with a mocked LLM, returns a reply; persists it as authored by CoS.
- `activity-router`: chat-worthy events get through; routine ticks get dropped.

### Integration tests
- `POST /messages` happy path: stores, emits WS event, triggers cos-replier, which stores a reply and emits.
- `@mention` happy path: stores user message, triggers agent-summoner, which stores a reply authored by the agent.
- `PATCH /read`: updates the participant's read pointer; subsequent reads see the new value.
- Idempotency: posting the same `clientMessageId` twice (if we add that header) does not duplicate.

### E2E (Playwright)
- Two-browser test: Alice and Bob both in the same conversation. Alice posts a message. Bob's chat panel shows it within 2 seconds (over WS).
- @-mention test: Alice types `@reese what's up?`; Reese's reply appears, authored by Reese (not CoS).
- Card test: simulate a `proposal_card_v1` posted by CoS; the UI renders the card with Confirm/Try-again buttons; clicking Confirm fires the right action.

---

## 13. Inheritance summary

**From upstream Paperclip:**
- `realtime/` WS bus
- Better-auth (for `userId` on requests)
- `agent.activity` event stream

**From v1 AgentDash (carried via base migration):**
- `assistant_conversations` schema
- `assistant_messages` schema
- (NOTE: the existing v1 `assistant.ts` services *may* be reusable; the implementation plan determines whether to port or rewrite.)

**New for v2 chat substrate:**
- `assistant_conversation_participants` link table (also created by onboarding spec — only one of the two plans creates the migration, ordered first)
- `last_read_message_id` column on participants
- `card_kind` + `card_payload` columns on `assistant_messages`
- mention-parser, agent-summoner, cos-proactive units
- chat-panel UI replacing the v1 assistant UI
- Card components: ProposalCard, InvitePrompt, AgentStatusCard, InterviewQuestion

**Discarded from v1:**
- v1 assistant chat panel UI (was buried, not multi-human)
- v1 `assistant-tools.ts` if it embedded single-user assumptions

---

## 14. Decision log

| Decision | Choice | Source |
|---|---|---|
| Agent presence in chat | Hybrid (CoS by default, others when @-mentioned) | Brainstorm Q1 (option C) |
| Conversation shape | One per company, persistent, single linear thread | Default in spec, accepted |
| Message types | Text + structured cards | Default in spec, accepted |
| File attachments | Out of scope for v1 | Default in spec |
| Real-time transport | Upstream Paperclip's WS bus | Default in spec |
| @-mention resolution | Name first, role as alias | Default in spec |
| Summoned agent context window | Last 20 messages | Default in spec |
| Multi-turn agent sub-conversations | Out of scope for v1 (each summon is one turn) | Default in spec |
| Read state | Per-participant `last_read_message_id` | Default in spec |
| Schema additions | `card_kind` + `card_payload` on messages; `last_read_message_id` on participants | Default in spec |
