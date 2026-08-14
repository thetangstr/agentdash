# Functionality test plan — pre-deployment

Two halves, run independently.

- **Part A — manual, user-facing.** You drive a browser. Every case is something
  a real person at MKThink does.
- **Part B — API, harness-facing.** I drive the API with real agent keys, the way
  a person's Claude Code or Codex would through the bridge. Not endpoint-by-
  endpoint curl: whole use cases, in order, with the evidence recorded.

**Test target:** `:3103` (instance `uat`), workspace **MKThink** — created by
`scripts/demo/mkthink-company.mjs`, with Titus/Chief, Priya/Delivery,
Raj/Platform, Maya/People. `buzzhive` is also on this instance; leave it alone.

Reach it at `http://mkmini.local:3103` on the LAN, or
`http://<tailscale-ip>:3103` over Tailscale. **Not `127.0.0.1`** — loopback is not
a trusted origin and sign-in returns `403 INVALID_ORIGIN`.

Mark each case **PASS**, **FAIL**, or **BLOCKED**, and for anything that is not
a pass write down what you actually saw rather than what it should have been.

---

## Part A — manual, user-facing (you)

### A1. Getting in

| # | Case | Steps | Expect |
|---|---|---|---|
| A1.1 | Sign in | Open `/auth`, sign in | Lands on the dashboard, workspace selected |
| A1.2 | Wrong password | Sign in with a bad password | Refused with a readable message, no crash |
| A1.3 | Session survives reload | Reload the page | Still signed in |
| A1.4 | Over Tailscale | Repeat A1.1 at `http://<tailscale-ip>:3103` | Identical behaviour |

### A2. Onboarding a new workspace

Run this **once**, on a name you don't mind keeping (there is no working delete).

| # | Case | Expect |
|---|---|---|
| A2.1 | Wizard step 1 — company | Workspace created; you are its owner |
| A2.2 | Step 2 — first agent | Agent created; adapter defaults sensibly; no "preflight required" banner over a working agent |
| A2.3 | Step 3 — mandate, 8 questions | Q8 "Anything else it should know?" is present and optional |
| A2.4 | Mandate free text lands | What you type in Q8 appears in the generated mandate under "Also from &lt;you&gt;" |
| A2.5 | Step 4 — goal is a *choice* | **Nothing is pre-selected.** Continue is disabled until you pick an example, write your own, or tick skip |
| A2.6 | Goal you wrote is the goal you get | The goal and its tasks match what you chose — not a board-pack template |
| A2.7 | Agent has a key | Without visiting any other screen, the new agent already has an API key |

### A3. The Chief of Staff conversation

| # | Case | Expect |
|---|---|---|
| A3.1 | Start the interview | Three fixed questions answer instantly (no model wait) |
| A3.2 | Adaptive follow-ups | Later turns take 10–50s and read as coherent follow-ups, not restarts |
| A3.3 | Proposal appears | A plan card listing proposed agents with roles and responsibilities |
| A3.4 | Accept the plan | Agents are created and appear in the agent list |
| A3.5 | Those agents are runnable | Each shows a valid adapter; none says "requires a command" |

### A4. The three employees

| # | Case | Expect |
|---|---|---|
| A4.1 | Send an invite | Invite link generated |
| A4.2 | Employee opens the link | Can create an account and join the workspace |
| A4.3 | Employee sees only their workspace | No other company visible |
| A4.4 | Pair person to agent | Priya ↔ Delivery, Raj ↔ Platform, Maya ↔ People |
| A4.5 | "Connect your harness" | Shows a key and paste-ready instructions |
| A4.6 | Employee cannot administer | An ordinary member cannot change permissions or billing |

### A5. Doing work

| # | Case | Expect |
|---|---|---|
| A5.1 | Create a task | Appears in the list with an identifier (MKT-n) |
| A5.2 | Assign to an agent | Assignment sticks |
| A5.3 | Wake the agent | A run starts; status visible |
| A5.4 | Watch the run | Logs stream; run reaches succeeded |
| A5.5 | Read the output | The agent's comment is on the task and is about *your* task |
| A5.6 | Task status is honest | A task the agent said it was blocked on is **not** shown as done |
| A5.7 | Cost/usage panel | Note what it shows — see Known Gaps |

### A6. Oversight

| # | Case | Expect |
|---|---|---|
| A6.1 | Approvals queue | An agent request appears and can be approved or rejected |
| A6.2 | Rejection is respected | Rejected work does not proceed |
| A6.3 | Activity log | Shows who did what, agent vs person |
| A6.4 | Pause an agent | A paused agent stops picking up work |
| A6.5 | Company health | Settings → health reports something truthful |

### A7. Things that should *not* happen

| # | Case | Expect |
|---|---|---|
| A7.1 | No stray banners | No "harness preflight required" over agents that are working |
| A7.2 | No dead-end errors | Every error names what to do next |
| A7.3 | No other tenant's data | `buzzhive` is never visible from MKThink |
| A7.4 | Refresh mid-run | Reloading during a run does not lose the run |

---

## Part B — API, harness-facing (me)

Driven with the four real agent keys, as a local harness would.

| # | Case | Why it matters |
|---|---|---|
| B1.1 | Agent key authenticates; garbage key refused | The whole harness model rests on this |
| B1.2 | Agent key is scoped to its own company | Cross-tenant read must fail |
| B2.1 | Register a bridge endpoint, approve it, poll it | The connect-your-harness path |
| B2.2 | Create a bridge task, poll receives it, post a result | The actual work channel |
| B2.3 | Decline a task | The refusal path exists and is recorded |
| B2.4 | Poll does not consume the rate limit | 180 polls/15min against a 200 budget |
| B3.1 | Agent wakes itself → run succeeds | Core execution |
| B3.2 | Agent cannot wake a different agent | `Agent can only invoke itself` |
| B3.3 | Agent cannot raise its own permissions | `Only CEO can manage permissions` |
| B4.1 | Read issues and dashboard with an agent key | What Chief used to build the board pack |
| B4.2 | Create and assign an issue | Delegation between agents |
| B4.3 | Post a comment | How work product is delivered |
| B4.4 | Move an issue to done | Normal completion |
| B4.5 | **Declare BLOCKED then try to close** | Must land in `blocked`, not `done` — new guard |
| B5.1 | Create a `process` agent with no command | Must be refused, 400, with remediation text |
| B5.2 | Create a `hermes_local` agent with empty config | Must succeed |
| B5.3 | Adapter environment test | Reports real harness state |
| B6.1 | Fact request lifecycle (agentdash_mk) | Chief asking a lead for a number |
| B6.2 | Deliverable run: open → collect → assemble | The board pack machinery |
| B6.3 | Malformed run id | 404, not 500 — regression guard |
| B7.1 | Instructions bundle read/write | Mandates over the API |
| B7.2 | Agent directives / governance read | Ceilings a harness must respect |

### Evidence I will record

For each: HTTP status, the decisive part of the body, and for anything
asynchronous the resulting database state. Failures get the actual response,
not a summary.

---

## Known gaps — do not report these as bugs

- **Usage metering reads zero.** `token_count=0`, `cost_cents=0` on every run.
  Any cost figure is meaningless.
- **Connectors are mocked.** No real Slack, email or calendar.
- **Company deletion does not work.** 74 foreign keys at `NO ACTION`.
- **Codex is not wired to CoS chat.**
- **Outbound email is off.** `RESEND_API_KEY` unset, so invites do not send —
  copy links from the UI.
