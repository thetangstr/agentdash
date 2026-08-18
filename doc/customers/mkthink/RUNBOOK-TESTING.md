# MKThink test runbook

Everything built and changed in this cycle, what state it is in, and exactly how
to exercise it. Written to be worked through top to bottom.

**Honesty convention.** Each item says what was actually verified and how.

| Mark | Means |
|---|---|
| **VERIFIED LIVE** | Driven against the running instance, result quoted below |
| **VERIFIED IN TEST** | Automated test only — the real path has not been driven by hand |
| **NOT VERIFIED** | Built, compiles, unproven. Expect to find problems here |
| **KNOWN BROKEN** | Confirmed not working, listed so it is not a surprise |

Current suite state: monorepo **4,819 passing / 0 failed** (624 files), browser
e2e **20 passed / 2 skipped**, journey gate **exit 0**.

---

## 0. Start here

1. Open `http://mkmini.local:3102` — this is the clean MKThink instance.
   `:3100` and `:3101` are separate, older, still on Claude. **Do not restart
   `:3100`** — it owns the Postgres process for all three.
2. Sign in as `owner@example.com`. Reset links expire after **one hour**, so
   you will usually need a fresh one. Minting it is two steps, because the mail
   sender is not wired (`RESEND_API_KEY` unset) and the token only ever goes
   into the email body — it is never logged:

   ```sh
   # 1. generate the token (note: request-password-reset, NOT forget-password,
   #    which 404s on this Better Auth version)
   curl -s -o /dev/null -w "%{http_code}\n" \
     -X POST http://mkmini.local:3102/api/auth/request-password-reset \
     -H "content-type: application/json" \
     -H "Origin: http://mkmini.local:3102" \
     -d '{"email":"owner@example.com","redirectTo":"http://mkmini.local:3102/reset-password"}'

   # 2. read it out of the verification table (columns are snake_case)
   cd cli && pnpm exec tsx -e '
     import postgres from "postgres";
     const sql = postgres("postgres://paperclip:paperclip@127.0.0.1:54329/mkboard");
     const r = await sql`select identifier, expires_at from verification order by created_at desc limit 1`;
     console.log("http://mkmini.local:3102/reset-password?token=" +
       r[0].identifier.replace("reset-password:", ""), "expires", r[0].expires_at);
     await sql.end();'
   ```
3. **If nothing responds, the stack is down.** Start order matters: the
   embedded Postgres lives in `:3100`'s cluster
   (`~/.paperclip/instances/lantest/db`) and every instance connects to it on
   54329, so `:3100` comes up first or `:3102` dies with `ECONNREFUSED`.

   ```sh
   # 1. Postgres host
   cd server && PAPERCLIP_INSTANCE_ID=lantest PORT=3100 \
     PAPERCLIP_DEPLOYMENT_MODE=local_trusted PAPERCLIP_BIND=loopback \
     BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
     PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32) \
     pnpm exec tsx src/index.ts > ~/.local/state/agentdash-logs/lantest.log 2>&1 &

   # 2. MKThink instance, from the durable env
   cd server && bash -c 'set -a; source ~/.config/agentdash/mkboard.env; set +a; \
     exec pnpm exec tsx src/index.ts' > ~/.local/state/agentdash-logs/mkboard.log 2>&1 &
   ```

   `:3100`'s throwaway secrets only affect `:3100` — it is acting as the
   database host. `:3102`'s real secrets live in
   `~/.config/agentdash/mkboard.env` (mode 600), which is why a restart does not
   lose them. Logs go to `~/.local/state/agentdash-logs/`, not a temp directory.

4. Optional, for the command-line steps below:
   ```sh
   export BASE=http://127.0.0.1:3102
   export AGENTDASH_API_KEY=<the pcp_board_… key>
   export DATABASE_URL="postgres://paperclip:paperclip@127.0.0.1:54329/mkboard"
   ```

---

## 1. Inference runs on MiniMax China through Hermes — **VERIFIED LIVE**

**What it is.** Agent replies are produced by AgentDash → `hermes_local` adapter
→ Hermes CLI → MiniMax (China region). No Anthropic anywhere in the path.

**Result.** A real Chief-of-Staff reply came back in ~23s:
> "Scope creep landing mid-sprint without a decision owner is the biggest risk
> to Q3 delivery — what specific outcome does MKThink need to hit in the next
> 0–3 months?"

Logs show `"adapter":"hermes_local"`, zero fallbacks, zero errors. Region proven
by contradiction: the same key returns **401 on `api.minimax.io`** (international)
and **200 on `api.minimaxi.com`** (China).

**How to test.**
1. Open the workspace and message your Chief of Staff in chat.
2. Expect a coherent reply in roughly 20–30 seconds.
3. First reply after a reboot can take minutes — Hermes compiles its Python
   modules once. Subsequent replies are ~12s.
4. To confirm the provider from the box:
   ```sh
   grep -o '"adapter":"[a-z_]*"' ~/.local/state/agentdash-logs/mkboard.log | tail -1
   ```

---

## 2. Onboarding wizard, six steps — **VERIFIED IN TEST**

**What it is.** Company → Agent → **Mandate** → **Goal** → Task → Launch. The
Mandate step turns wizard answers into the agent's `AGENTS.md`; the Goal step
offers worked examples.

**Result.** Playwright drives the whole flow in a real browser and reaches the
created issue: **passing, 8.2s**. It was broken earlier today (I added the
Mandate and Goal steps and the spec still walked the old three-step path); the
spec never ran automatically, so nothing caught it.

**How to test.**
1. Go to `/onboarding`.
2. Name the company → **Next**.
3. Accept the agent name → **Next**.
4. Mandate step: every answer is pre-set to the careful option. Change what
   matters → **Next**.
5. Goal step: pick the example closest to your week → **Next**.
6. Give it a task → **Next** → **Create & Open Issue**.
7. You should land on the created issue.

**Watch for:** any step where **Next** does nothing, or a value you typed not
appearing on the Launch summary.

---

## 3. Deep interview reaches a proposal — **VERIFIED LIVE**

**What it is.** The CoS interviews you, then proposes an agent team.

**This was the "goals are not broken down into tasks" bug.** At four follow-ups
the code returned a null message with status `exceeded_max`, which nothing in the
routes or the UI handles — so you answered a question and got **silence,
permanently**, after the model had already produced a usable proposal.

**Result.** Fixed and driven live. The cap now forces the proposal:
> "Got it — I have what I need to propose your first hire. Team: **Scout**
> (email-thread status collector, Thursday EOD nudges) + **Rivet** (passive
> Revit/BIM milestone tracker) + **Aria** (board-deck composer, Monday 9am
> brief). 90-day OKR: a Monday 9am board brief delivered with zero chasing…
> Greenlight to stand them up?"

State confirmed `ready_to_propose` with a non-empty message.

**How to test.**
1. Start onboarding and answer the three fixed questions honestly.
2. Keep answering follow-ups. **Deliberately give vague answers** to push past
   four follow-ups — that is the case that used to die.
3. You must always get a reply. If you ever send a message and get nothing back,
   that is the regression: report it immediately.
4. Expect a named team with roles and a 90-day OKR.

**Related, NOT VERIFIED:** whether accepting that proposal creates the agents.
`planGenerated` was `false` on my run because the plan card fires on the
*transition* into `ready_to_propose`, which my conversation had already passed.
**Test this on a fresh conversation** — it is the next thing I would check.

---

## 4. Board deck, end to end — **VERIFIED LIVE**

**What it is.** Titus's agent asks the Product, Engineering and Marketing agents
for their contributions; each escalates to **its own human's laptop** over the
bridge; each human answers; answers come back attributed; the CoS consolidates
and posts the deck.

**Result.** `ok=26 broken=0`, run repeatedly today, most recently after every
change. Produces a 927-character deck with `<untrusted-agent-answer>` framing
intact on every contribution.

**How to test.**
```sh
node scripts/demo/board-deck.mjs
```
1. Watch four humans get paired one-to-one with agents.
2. Watch escalations reach machines over the bridge.
3. Read the printed deck at the end.
4. Open the `dashboard=` URL it prints to see the board item.

**Caveat worth knowing:** the *human answers* in that run are supplied by the
script. It proves the pipeline, the bridge, stewardship and escalation — **not**
the model's writing quality.

---

## 5. First-run / handoff brief — **VERIFIED LIVE**

**What it is.** Stands up a workspace the way a customer would have one and
prints a brief a fresh agent can follow.

**Result.** `ok=9 broken=0`.

**How to test.**
```sh
node scripts/demo/first-run.mjs
```
Read the printed brief — it is the thing a new operator is handed, so judge it as
documentation, not just as output.

---

## 6. The journey gate — **VERIFIED LIVE**

**What it is.** One command that runs both journeys above and fails loudly.

**Result.** `pnpm gate:journeys` → **exit 0**, first-run `ok=9`, board-deck
`ok=26`. It also **caught a real regression on its first run** (`ok=5 broken=4`),
which is the point of it.

**How to test.**
```sh
pnpm gate:journeys ; echo "exit=$?"
```
Use this after any change. `exit=0` means both journeys hold.

---

## 7. Agents that cannot run are refused — **VERIFIED LIVE**

**What it is.** A `process` agent with no command used to be accepted and then
fail **every run forever**, visible only in the server log. That was "runs that
just don't run".

**Result.** Verified both directions live:
- No command → **rejected** with a message naming the fix.
- With a command → **201 created**.

**How to test.**
1. Create an agent through the UI as normal — should work.
2. From the command line, try to create a broken one and confirm it is refused:
   ```sh
   curl -s -X POST "$BASE/api/companies/<companyId>/agents" \
     -H "Authorization: Bearer $AGENTDASH_API_KEY" -H "content-type: application/json" \
     -d '{"name":"Broken","role":"engineer","adapterType":"process"}'
   ```
   Expect a validation error mentioning `adapterConfig.command`.

**Note on scope.** This checks *configuration completeness* ("could this ever
run"), **not** *environment readiness* ("is the binary on this machine"). You can
still create a `claude_local` agent on a box without Claude — deliberately, since
configure-then-install is a real flow.

**The gap this did not close, and now does.** The rule above only applies at
*creation*. Chief and Delivery were seeded on 2026-08-08, before it existed, and
sat unrunnable for four days: every heartbeat threw `Process adapter missing
command` into the server log, while the whole suite passed and the demo deck
reported `ok=26 broken=0`. Nothing in the suite had ever *executed* an agent —
the deck drives agents over the API with their keys, which never spawns an
adapter.

`server/src/__tests__/agent-execution.test.ts` now does. It spawns real child
processes through the real adapter registry (hermetic — the only binary it needs
is the Node already running it) and asserts a working agent produces streamed
output, a commandless one **throws** rather than resolving, and a non-zero exit
is reported as a failure instead of a successful run. It also guards the
first-run seed against reintroducing the original defect; that guard was
falsified before being trusted — reverting the seed fix makes it fail with
`expected 1 to be +0`, and restoring it makes it pass.

Both live agents were repaired to `hermes_local` and audited clean
(`total=2 broken=0`).

---

## 8. Readiness reporting tells the truth — **VERIFIED LIVE**

**What it is.** `/health` and the onboarding model screen report whether the
configured adapter can actually answer.

**This was lying.** It reported `"hermes binary not found on PATH"` while the
server was actively serving replies through that exact binary — a `require` call
in an ESM runtime that threw on every invocation and was swallowed.

**Result.** Endpoint now returns `{"adapter":"hermes_local","ready":true,
"preset":"hermes","reason":null}`.

**How to test.**
```sh
curl -s "$BASE/api/onboarding/adapter-status" -H "Authorization: Bearer $AGENTDASH_API_KEY"
```
Expect `ready: true`. Then open the model screen in the UI and confirm it agrees.

---

## 9. Model presets include MiniMax and Hermes — **VERIFIED IN TEST**

**What it is.** The onboarding model screen previously offered only
Claude/OpenAI/Gemini/stub, and labelled your running configuration "custom" — so
picking anything moved you back to Claude.

**Result.** Both presets added, MiniMax pinned to `api.minimaxi.com` (China).
Covered by tests. **The screen itself has not been clicked through.**

**How to test.**
1. Open the onboarding model screen.
2. Confirm **MiniMax (China)** and **Hermes (local harness)** appear.
3. Confirm your current setup shows as **Hermes**, not "custom".
4. **Do not switch presets on `:3102`** unless you intend to — applying one
   rewrites the adapter env.

---

## 10. The bridge stops eating your rate limit — **VERIFIED IN TEST**

**What it is.** The laptop worker polls every 5 seconds — 180 requests per
15-minute window against a 200-request budget shared with everything else you do.
A connected laptop consumed 90% of its own quota and real work tipped it into
429s. That is "the connection bumps all the time".

**Result.** The poll is now exempt; `/bridge/result` and `/bridge/decline`, which
actually write, stay limited. Tests verified in both directions — without the fix
they report *"polling ate the mutation budget"*.

**NOT VERIFIED LIVE over a real window.** This is the one I most want you to
stress.

**How to test.**
1. Enrol a laptop and leave it connected for **20+ minutes**.
2. Then do a burst of real work — create several issues, answer fact requests,
   run a pipeline.
3. Nothing should 429. Previously ~10 of 30 actions would.

---

## 11. Local harnesses run with least privilege — **VERIFIED LIVE**

**What it is.** Hermes reads other agents' output, which this system treats as
untrusted. It used to run with `terminal`, `file`, `code_execution`, `browser`
and `computer_use` enabled, and inherited the server's entire environment —
including the agent-JWT signing secret and database credentials.

**Result.** Tools restricted (a restricted Hermes asked to run `id -un` answers
that it cannot), and the child environment is now an allowlist. Verified live:
replies still work, board deck still `ok=26`.

**How to test.** Nothing to click — confirm agent replies still work normally
(sections 1 and 4). If replies break, this is the first suspect.

---

## 12. `pnpm start` works — **VERIFIED LIVE**

**What it is.** Running the built server. It could not resolve the shared package
and failed; every real deployment path had quietly worked around it.

**Result.** Boots and `/api/health` returns **200**.

**How to test.**
```sh
cd server && PORT=3197 PAPERCLIP_DEPLOYMENT_MODE=local_trusted pnpm start
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3197/api/health
```

---

## 13. The five critical-path runs — **VERIFIED LIVE, 2026-08-12**

Before this, `agent_runs`, `heartbeat_runs`, `deliverable_runs` and
`issue_work_products` were all **0**. No agent had ever executed in this
install; the four board-pack issues had sat in `backlog` since 2026-08-08. The
suite passed and the demo deck reported `ok=26 broken=0` because neither ever
spawns an adapter. All five runs below were then executed against the live
instance on `:3102`.

**1. An agent executes assigned work.** `POST /api/agents/<chief>/wakeup` → 202.
Run `e8a68bdf` **succeeded**, exit 0, 115s, through
`[hermes] Starting Hermes Agent (model=MiniMax-M3)`. Its stdout ends
`MKT-2 is now done`.

**2. The work is real, and sourced.** The Chief posted a 3,369-character
delivery-status section, having queried `/api/companies/…/issues` and
`/dashboard` for its own figures — it correctly reported 4 issues, 1 in
progress, 3 in backlog.

**3. The backlog clears autonomously.** Four runs succeeded (58s, 115s, 205s,
227s) and **MKT-1, MKT-2, MKT-3, MKT-4 all reached `done`** without further
prompting.

**4. The deliverable exists on disk.**
`~/.paperclip/instances/mkboard/workspaces/<chief>/board-pack-week-1/BOARD-PACK.md`,
151 lines, leading with the sourced fact — Northgate schematic set, bond vote
pulled forward, attributed to Titus, captured 2026-08-08 — and stating plainly
that it is *"the only fact I could source this cycle that is signed off"*, with
an attribution table naming each section's status.

**5. Hire → run.** The Chief created the `Platform` agent (**201**), preflight
returned `status: pass` (Hermes v0.20.0, Python 3.11.15), and that brand-new
agent then executed its own run: **succeeded, exit 0, 36s**, correctly reporting
that nothing was assigned to it.

**Security boundaries held under test, unprompted.** An agent key was refused
when it tried to raise its own permissions (`Only CEO can manage permissions`)
and when it tried to wake a different agent (`Agent can only invoke itself`). A
`process` agent with no command was refused at create with **400** and the exact
remediation text.

### Two defects this surfaced, both fixed

**The Chief could not hire.** Agents are created with
`canCreateAgents: false`, only the CEO can change it, and the seed never did —
so step 2 of the first-run brief ("For each lead, create an agent") was an
instruction the API would always refuse with *"Agent Chief lacks the
agents:create capability"*. `first-run.mjs` now grants `canCreateAgents` and
`canAssignTasks` immediately after creating the Chief.

**A malformed run id returned 500.** Found by the agent, not by the suite: the
Chief called assemble with the slug it had been given, `board-pack-week-1`, and
got `500 Internal server error`, because the raw path segment went into a query
against a uuid column. It worked around the failure and reported it inside the
deliverable, which is the only reason it was noticed. Reproduced exactly —
non-uuid → 500, well-formed-but-missing uuid → correct 404 — and fixed with a
`router.param` guard covering every `:runId` route.
`server/src/__tests__/deliverable-run-id-guard.test.ts` pins it, and was
falsified first: neutering the guard fails 2 of its 3 tests.

### Still open from these runs

- **Usage metering reads zero.** The 115s run recorded
  `token_count=0, cost_cents=0`. Budgets and cost reporting cannot work until
  MiniMax usage is captured.
- **One orphaned run.** `3f26126c` has been `running` since 15:01 with no
  process behind it. The watchdog did not reap it.
- **`Platform` is a real agent now.** Created during run 5; delete it if you
  want the roster back to Chief + Delivery.

---

## 14. Agents no longer inherit the server's secrets — **FIXED AND VERIFIED LIVE**

**What was wrong.** `runChildProcess` — the single spawn path used by both the
`process` adapter and the Hermes adapter — inherited the server's whole
environment, stripping only names prefixed `PAPERCLIP_`. Every agent harness
therefore received `DATABASE_URL` with live credentials, `BETTER_AUTH_SECRET`
(enough to forge a session for any user), `MINIMAX_API_KEY` and
`AGENTDASH_LICENSE_KEY`. Confirmed against the running server's own environment,
not inferred.

That matters because the process receiving them is built from issue text, other
agents' output and anything it fetches — content this system wraps in
`<untrusted-agent-answer>` precisely because it is untrusted. The blast radius of
one prompt injection was direct Postgres access, not "runs a command".

The prefix rule hid it in the most ordinary way: `PAPERCLIP_AGENT_JWT_SECRET`
was stripped and `BETTER_AUTH_SECRET` was not, because one carried the prefix
and the other did not.

**The fix.** `inheritableAdapterEnv` in
`packages/adapter-utils/src/server-utils.ts` is an allowlist: enough to find a
binary, write to scratch, and read the harness's own per-user config, and
nothing else. Anything an adapter genuinely needs beyond it goes in that agent's
`adapterConfig.env`, which is merged afterwards and always wins — an explicit,
per-agent, visible escape hatch instead of whatever the server happened to be
started with.

This works because the harnesses hold their own credentials under `$HOME`:
`MINIMAX_API_KEY` lives in `~/.hermes/.env` (mode 0600), so Hermes still
authenticates with `HOME` alone.

**How to test.** `server/src/__tests__/adapter-env-isolation.test.ts` spawns a
real child and asks what it can see. Both halves matter — secrets must not
cross, and `PATH`/`HOME` must, or nothing runs. Falsified before being trusted:
restoring the old inherit-everything behaviour fails 3 of its 4 tests.

**Verified live after the fix**, on the restarted `:3102`:
- Chief woke, ran, and **succeeded, exit 0, 25s**, through
  `[hermes] Starting Hermes Agent (model=MiniMax-M3)` with a coherent reply —
  so the allowlist does not break real execution.
- The `board-pack-week-1` slug that used to return **500** now returns **404**,
  matching the well-formed-but-missing control exactly.

### Two things left open, deliberately

- **Hermes prompts are visible in `ps`.** `hermes chat -q <prompt>` passes the
  prompt in argv, and the Hermes CLI has no stdin input — so this is a property
  of the harness, not something AgentDash can fix. `claude_local` already uses
  stdin. Do not run this on a shared host with real content.
- **`claude_local` has no toolset restriction.** `hermes_local` runs with
  `-t clarify --ignore-rules`; `claude_local` runs `claude --print -` with
  default tool access over the same untrusted input.

---

## 15. Onboarding, end to end — **VERIFIED LIVE, 2026-08-12**

The one gap that had stayed NOT VERIFIED all along was the plan card becoming
real agents. It works.

1. `POST /api/onboarding/bootstrap` → **200**. Note it is **idempotent per
   installation**: it returns the existing workspace rather than making a new
   one. AgentDash is one workspace per install; a "fresh company" means a fresh
   instance, not a second workspace.
2. `POST /api/onboarding/interview/turn` × 6. The three fixed questions return
   instantly with no model call; the adaptive turns ran on real MiniMax
   (**47s, 38s, 9s**) and produced a coherent two-agent proposal.
3. A `agent_plan_proposal_v1` card was written, carrying each agent's name,
   role, responsibilities, KPIs and `adapterType: "hermes_local"`.
4. `POST /api/onboarding/confirm-plan` → **201**, materializing three agents
   (Aria, Dex, Quinn). All three are `hermes_local` with runnable configuration
   — none of the commandless-`process` shape that broke Chief and Delivery.
5. Waking Aria with the owner's key → **succeeded, exit 0, 29s**, through
   `[hermes] Starting Hermes Agent (model=MiniMax-M3)`.

**Not covered:** account signup itself, which needs a real email address. That
is the first step of a cold install and is left for the human tester.

**One fidelity gap:** the plan card proposed Aria as `operations_lead`, and the
agent materialized with role `general`. The proposed role is not carried
through — cosmetic today, but it means org structure in the proposal is not the
org structure you get.

## 16. The clean instance for acceptance testing

A second, empty installation for testing onboarding from zero, so the MKThink
workspace is not disturbed.

| | |
|---|---|
| URL | `http://mkmini.local:3103` (loopback: `http://127.0.0.1:3103`) |
| Instance | `uat` |
| Database | `uat` on the existing Postgres at `127.0.0.1:54329` |
| State | 0 companies, 0 agents, 0 issues, 0 users |
| Signup | self-serve on, invite validation off — first account claims the install |

Start it again after a reboot with the mkboard env plus these overrides:

```sh
cd ~/agentdash/server
set -a; . ~/.config/agentdash/mkboard.env
DATABASE_URL="postgres://paperclip:paperclip@127.0.0.1:54329/uat"
PORT=3103 PAPERCLIP_INSTANCE_ID=uat
PAPERCLIP_PUBLIC_URL=http://mkmini.local:3103
PAPERCLIP_API_URL=http://127.0.0.1:3103
PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://mkmini.local:3103
set +a; pnpm exec tsx src/index.ts
```

---

## Known broken / not built — expect these

| Item | State |
|---|---|
| Connectors (SharePoint, HubSpot) | **Mocked.** Anything expecting real data will be empty |
| Codex in CoS chat | **Not wired.** Installed; usable for agent execution only |
| `:3100` and `:3101` | Still on `claude_local`, not MiniMax |
| Plan card → agent creation from interview | **NOT VERIFIED** — test on a fresh conversation |
| Telegram / WhatsApp channels | Not exercised this cycle |
| Multi-user invite → accept → steward, in a browser | Only exercised via script |
| `claude_local` toolset restriction | Not applied — no equivalent flag to Hermes's `-t` |
| 88 test files can silently skip without Postgres | No gate on the skip count |

---

## What to report back

1. **The step number** where it broke, and **whether the UI said anything**.
   Silent failures matter most — this codebase degrades quietly, and that is the
   root of most of what you have hit.
2. Anything that *looks* like it worked but produced text you would not send to a
   client.
3. Anything slower than ~30s that is not the first call after a reboot.

## Command reference

```sh
pnpm gate:journeys                                    # both journeys, exits non-zero on failure
pnpm exec vitest run                                  # full monorepo suite
npx playwright test --config tests/e2e/playwright.config.ts   # browser suite
node scripts/demo/board-deck.mjs                      # business case only
node scripts/demo/first-run.mjs                       # onboarding + handoff brief
```
