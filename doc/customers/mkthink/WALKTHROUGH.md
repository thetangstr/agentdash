# MKThink walkthrough — from an email link to agents working together

Everything below has been run end to end against a real authenticated instance.
Where something is still a stub, it says so.

---

## 1. The email you'd receive

> **Subject:** Your AgentDash workspace is ready
>
> Hi Titus,
>
> Your AgentDash runtime is running on the Mac mini at **http://mkmini.local:3100**.
>
> Open this link to set your password and sign in — it works once and expires in about
> an hour:
>
> **http://mkmini.local:3100/reset-password?token=…**
>
> Once you're in, go to **Settings → API keys** and copy your key. You'll paste it into
> Claude Code or Codex in step 3.
>
> Your workspace code is **MK-LANTEST** — the setup prompt asks for it.

The one-time link is real: it comes back from the claim call as `passwordSetupUrl`, and
**no email provider is needed** for any of this. Invites work the same way — the server
mints `/invite/<token>` links and reports `emailStatus: "skipped"` when no provider is
configured.

## 2. Claim it, set a password, get a key

Opening the link lets you set a password; signing in gives you a session. The claim also
returns a board **API key** (`pcp_board_…`) — that is the key for step 3.

Verified: one-time link → `{"status":true}` → sign-in returns a session and user. The claim
is genuinely one-time; a second attempt answers `409 instance_already_claimed`, forever.

## 3. What you paste into your coding agent

Give Claude Code or Codex your key and this brief. It builds the company through the
AgentDash API.

```text
I run MKThink, a strategy and design consultancy. Set up my AgentDash workspace.

My AgentDash runtime is at http://mkmini.local:3100
My API key is: <paste the key from step 2>
My workspace code is: MK-LANTEST

Create the workspace with productProfile "agentdash_mk" and that workspace code in the
same request — both together, or the workforce features will be missing.

I want four agents. I get a Chief of Staff; the other three each belong to one of my
leads, and each of them gets an account so they can sign in and collect their agent's key.

  Chief     — mine (Titus). Turns one instruction from me into coordinated work across
              the others and brings back one answer, not three fragments.
  Delivery  — Priya's. Live client project status; the commitments at risk.
  Platform  — Raj's. The SharePoint estate and our repositories.
  People    — Maya's. Recruiting pipeline and who is waiting on us.

Give every agent a mandate as an AGENTS.md instruction file saying who it is, what it
must not do, how it prioritises, and whose direction wins when two people disagree. In
particular: the Platform agent must NEVER delete anything — it proposes a deletion list
for Raj to approve. No agent may contact a client or a candidate directly; they draft and
a human sends. No agent reports a number it cannot source.

Then set up three goals with tasks under them:
  1. Monthly board pack, assembled without a fire drill — Chief assembles; Delivery,
     Platform and People each contribute their part, attributed.
  2. SharePoint and repository cleanup — inventory what is stale, then a deletion
     proposal a human approves. Nothing deleted by an agent.
  3. Recruiting pipeline that never silently stalls — weekly review of who is waiting
     on us, and which roles block delivery.

Invite priya@mkthink.com, raj@mkthink.com and maya@mkthink.com with auto-approve on, so
accepting makes them members immediately — pairing a person with an agent is refused
unless they are already an active member. Then pair each person with their agent, one
person to one agent.

Finally, print each agent's own key next to its person, and the invite links, so I can
send them out.
```

The reference implementation of exactly that is `scripts/demo/mkthink-company.mjs`:

```sh
AGENTDASH_API_KEY=pcp_board_… BASE=http://mkmini.local:3100 \
  node scripts/demo/mkthink-company.mjs
```

Verified: `ok=13 broken=0` — four agents with mandates, four people paired, per-agent keys,
three goals, nine tasks.

## 4. What each person does

Each lead opens their invite link, signs up, and lands in the workspace. On **My Agent**
they find their agent and its key, which they paste into their own Claude Code or Codex.
From that point their agent is theirs — and it can be called on by the Chief of Staff.

## 5. The collaboration run

```sh
DATABASE_URL=<the instance's database> AGENTDASH_API_KEY=pcp_board_… \
  BASE=http://mkmini.local:3100 node scripts/demo/board-deck.mjs
```

Verified: `ok=26 broken=0`. The Chief agent opens the board item, calls all three
stakeholder agents, each escalates to **its own human's** laptop over the bridge, each
person answers from their machine, and the answers come back attributed and get
consolidated into the pack.

Two details worth watching in the output:

- Peer answers arrive wrapped in `<untrusted-agent-answer>` framing that tells the reading
  agent to treat them as data, never as instructions. That is the prompt-injection boundary
  holding on a real inter-agent path.
- `@Product`-style mentions resolve on a **single token** matched to the agent's name, which
  is why the agents are named in one word.

## 6. What is real and what is not

| Real | Still mocked |
|---|---|
| Claim, password, session, API keys | SharePoint/HubSpot reads |
| Workspace, agents, mandates, goals, tasks | Telegram/WhatsApp delivery |
| Human accounts, invites, membership, pairing | |
| **Agent replies — a real model, governed by the agent's mandate** | |
| Agent→agent fact requests and escalation | |
| Bridge tasks reaching a specific person's machine | |
| Consolidation with attribution | |

Agent replies used to be a hardcoded string. They are now real: the agent's
AGENTS.md becomes the system prompt, so what an agent says is governed by the
mandate its owner wrote. Asked what it watches, a Chief of Staff on the LAN box
answered:

> Watching whether the client comes back with new requirements framed as
> "feedback" after the review — that's the moment scope quietly doubles, and
> I'll flag it before you agree to anything in the room.

### Choose the adapter deliberately

`AGENTDASH_DEFAULT_ADAPTER` decides how those replies are produced, and the two
options are not equivalent for a workspace with several people in it:

| | `claude_local` | `claude_api` |
|---|---|---|
| Needs | the Mac's own signed-in Claude CLI | `ANTHROPIC_API_KEY` |
| Cost | covered by the subscription | per token |
| Latency, idle | 60–110s — it starts a whole CLI | a few seconds |
| Under concurrent load | **exceeded 120s and failed** in a measured run | unaffected |

`claude_local` is a good fit for one person trying the product. For MKThink,
with four agents and three colleagues active at once, set `ANTHROPIC_API_KEY` and
leave the adapter on `claude_api`. A failed adapter no longer answers with
placeholder text — the agent posts that it could not answer and why — so the
symptom of picking the wrong one is honest, but it is still a worse experience
than not hitting it.

Two related settings: `AGENTDASH_ADAPTER_TIMEOUT_MS` (default 120s) bounds a
local adapter, and local adapters run in an empty scratch directory so an agent
cannot absorb whatever repository the server happens to be running inside.

## 7. Two things that will bite

- **The auth rate limiter** allows a limited number of sign-ups/sign-ins per 15 minutes.
  Re-running the seed repeatedly trips it, and the failure reads as "account creation
  failed" rather than "rate limited" unless you look at the status code.
- **Seeding a non-default instance needs `DATABASE_URL`.** Without it the endpoint seeder
  writes memberships into the default database, and every pairing then fails with
  "Steward user must be an active company member" — which blames membership rather than
  the connection.
