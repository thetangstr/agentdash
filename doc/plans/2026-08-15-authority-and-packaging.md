# Authority, and what we ship to a client

**Status:** revised after a Fable 5 adversarial audit; Part 1 largely landed
**Written:** 2026-08-15, before the MKThink Mac Mini install

Two problems, found by asking rather than assuming, and both verified on the
live instance. They are separate, and the second is the one that should gate the
install.

---

## Part 1 — Authority

### What is actually enforced today

Three layers exist. Only one of them does much.

| layer | what it gates |
|---|---|
| `instance_admin` | cross-company access. Works. |
| membership role — owner / admin / operator / member / viewer | **only `viewer` is enforced**, read-only, and only in the human branch of `assertCompanyAccess` |
| 8 permission keys | `agents:create`, `environments:manage`, `users:invite`, `users:manage_permissions`, `tasks:assign`, `tasks:assign_scope`, `tasks:manage_active_checkouts`, `joins:approve` |

Nothing in that list covers goals, mandates, projects, or budgets — the things
that say what the company is trying to do. **68 mutating routes were guarded by
company membership alone.** Goals are now fixed; 67 remain.

The agent hole was the serious one, and it is worth stating plainly because it
explains the shape of the fix:

```
goal before: "Weekly board pack, assembled without a fire drill"
agent PATCH /goals/:id -> HTTP 200
goal after:  "REWRITTEN BY THE AGENT"
```

Everything downstream is measured against the goal. An agent that can move the
goal can report success by moving it, and the audit trail will faithfully record
that the goal simply changed.

### The model to settle on

Not a new permissions engine. Three tiers, named for what they protect:

1. **Direction** — goals, mandates, budgets, project definitions.
   Owner or admin. **Agents never.** This is what `assertCanSetCompanyDirection`
   already does for goals.
2. **Work** — issues, comments, deliverables, checkouts.
   Any active non-viewer member, and agents. This is the current behaviour and
   it is correct: this is the job.
3. **Administration** — members, permissions, keys, environments, connectors.
   Owner or admin, via the permission keys that already exist.

The distinction that matters is not human-vs-agent, it is *direction versus
work*. An agent should be able to do anything a member can do about the work,
and nothing at all about what the work is for.

### API — the remaining 67

Applied route by route, not by a blanket sweep, because "who should be able to
do this" is a judgement per endpoint and a wrong `403` is as damaging as a wrong
`200`.

- **Direction** (do next): `mandates` (3 routes), `projects` create + DoD (7),
  `PUT /companies/:id/feature-flags/:key`, budget routes.
- **Work** (leave as-is, deliberately): `issues` (27), attachments, comments,
  verdicts. Agents must keep these.
- **Judge individually**: `approvals`, `assess`, `assets`, `gmail send/draft`,
  `cost-events`. Sending mail as the company is arguably direction.

Each one gets the same treatment goals got: a probe against a live instance
proving the old behaviour, the guard, then the probe returning 403.

**Found by audit, verified live, and since fixed** — the original inventory
missed all of these, which is the strongest argument against trusting a
route-by-route sweep:

| route | before | now |
|---|---|---|
| `PUT /companies/:c/issues/:i/dod` | 200, persisted | 403 |
| `POST /companies/:c/routines` | 201, ACTIVE, self-assigned | 403 |
| `PATCH /agents/:id` (`budgetMonthlyCents`) | 200, 0 → 99,999,999 | 403 |

**Still open, ranked:** the plugin host exposes `goals.create/update` with no
capability enforcement at dispatch; `assertInviteRoleCeiling` exempts agents, so
an agent with `users:invite` can invite a human as **owner**; a CEO-role agent
can `PATCH /companies/:id` name and description.

**The honest caveat this plan owed you.** Route-by-route guarding of a ~67-route
surface, against agents holding a generic `api_request` HTTP tool, means
one missed route is a full bypass — and the first audit found four. A
deny-by-default middleware over direction-shaped writes would fail closed
instead. Route-by-route is still the choice here, because a wrong 403 is as
damaging as a wrong 200 and the surface is well understood — but that is a
**rejection of the safer default**, and the missed-route risk is owned rather
than hidden.

**Cost: ~1 day**, most of it deciding rather than typing.

### UI — currently has no idea

`grep` for a permission hook in `ui/src` returns nothing. There is no
`usePermissions`, no `canUser`, no capability context. One component
(`IssueRunLedger`) hand-checks `membershipRole !== "viewer"` and that is the
entire client-side story.

So today, after the API fix, an ordinary member opens a goal, sees **Edit** and
**Delete**, clicks, and gets a 403. That reads as a broken product rather than a
boundary — and it is worse than no fix, because the person cannot tell whether
they lack permission or the app is failing.

The fix, in order:

1. **`GET /api/me/capabilities?companyId=`** — returns the caller's membership
   role, instance-admin flag, and a resolved boolean per capability. One request,
   cached, so components ask a question rather than reimplement a rule.
2. **`useCapability("direction:set")`** — a hook over that, with the server as
   the single source of truth. The client must never re-derive the rule; it
   asks.
3. **Hide, do not disable.** A disabled Edit button on a goal invites someone to
   ask why. A goal they cannot edit should simply read as a goal.
4. **Say so when the server refuses anyway.** Races exist — a role can change
   mid-session — so a 403 needs a human sentence, not a toast that says "Error".

The load-bearing rule: **the UI is a courtesy, the API is the boundary.** Every
capability the UI honours must already be enforced server-side, and the tests
that matter live on the server.

**Cost: ~1–1.5 days.**

---

## Part 2 — What we ship

### What is on the client's machine right now

Verified on the Mini:

- **191 MB of git history**, plus 2,329 TypeScript/TSX source files
- Started with `pnpm exec tsx src/index.ts` — it runs *from source*
- The server runs as `yang`; the source is owned by `yang` and **writable**
- **No sandbox on the server-side execution path** — but a complete, tested
  seatbelt implementation already exists at `cli/src/bridge/sandbox.ts`
  (profile builder, egress policies, `sandbox-exec` spawn). An earlier draft of
  this plan said "no sandbox of any kind"; that was **wrong**, and it matters,
  because the job is to route server-side agent execution through the sandbox
  that exists rather than build one.
- Agents do **not** reliably run in `workspaces/<agent>`: `heartbeat.ts` resolves
  configured project cwd → managed workspace → previous session cwd → fallback.
  A profile pinned to `workspaces/<agent>` would break every real project run,
  so the profile must key off the *resolved* cwd.

A local agent runs as the same user that owns the code, unconfined. It can
rewrite the server it is running under, and nothing would notice.

To be fair about likelihood: this needs an agent to go off-mandate, or a prompt
injection to land. The *capability* is unambiguous though, and "we would notice"
is not true today.

### What to ship instead

1. **Build, do not ship source — but the 10–20 MB figure was wrong.** All 12
   workspace packages export TypeScript directly (`@paperclipai/db` exports
   `./src/index.ts`), so a compiled `server/dist` still loads `.ts` out of
   `node_modules` and still needs `tsx`. And `@embedded-postgres/darwin-arm64`
   alone is **145 MB** and is load-bearing. Pick one: (a) build all 12 packages
   and rewrite their `exports` maps, (b) esbuild-bundle the server the way
   `cli` already is in `scripts/build-npm.sh`, or (c) keep `tsx` and drop the
   "no src" claim. The honest win is dropping `.git` (191 MB) and dev
   dependencies — not a 10 MB artefact.
2. **Run as a user that cannot write the install.** A dedicated `agentdash`
   account owning `~/Library/Application Support/AgentDash` (data, logs,
   workspaces) while the install directory is owned by root and read-only to it.
   This alone closes the rewrite path, whatever an agent does.
3. **Confine agent workspaces.** Agents already run in
   `~/.paperclip/instances/<id>/workspaces/<agent>`. Make that a boundary rather
   than a convention: a seatbelt profile denying writes outside the workspace,
   and denying reads of the install directory and of `~/.config/agentdash`.
4. **Make tampering visible.** Record a manifest of file hashes at install; check
   it at startup and log loudly on mismatch. Cheap, and turns "we would notice"
   into something true.
5. **One artefact, one command.** `install.sh` already does the launchd and
   Postgres work; it should consume a built artefact rather than a git checkout.

Order matters: **(2) is still the highest value per unit of work**, but it is
not two hours. Every runtime path derives from `os.homedir()`
(`server/src/home-paths.ts`): the Postgres cluster, the secrets master key,
agent workspaces, plugins, and *two* backup trees — the launchd nightly one and
an in-server hourly one that defaults on and this plan did not know existed
(`server/src/config.ts`). A service-account switch silently relocates all of it,
Postgres refuses a cluster it does not own, and the harness credentials
(`~/.hermes`, `~/.claude`) must be re-established under the new uid. There is
also a LaunchAgent-vs-LaunchDaemon fork: Agents need a logged-in user, Daemons
break the harnesses — `deploy/install.sh` documents both.

Treat it as a migration with a checklist, not a chown. **Cost: a day, not two
hours**, and it should be rehearsed before install day rather than attempted on
it.

**Cost: ~3 days for all five.**

---

### What Part 1 does not protect against

Until confinement lands, these guards are **API-level only**. The database
credentials are `paperclip:paperclip` on loopback and agents currently run as
the same uid as the server, so an off-mandate local agent does not need
`PATCH /goals/:id` — it can `UPDATE goals` directly at `127.0.0.1:54329`.

That does not make Part 1 pointless: it closes the path for remote keys, for the
MCP endpoint, and for honest-but-curious agents, which is most of the real risk.
But the guarantee should be stated as what it is, and DB-credential rotation
plus loopback restriction should move into install week rather than "after the
first real week".

## Sequencing

1. `assertCanSetCompanyDirection` on mandates, projects, budgets — API
2. `/api/me/capabilities` + `useCapability`, hide direction controls — UI
3. Run the service as a non-owning user on the Mini — the 2-hour win
4. Build-and-ship packaging, workspace confinement, install manifest
5. External packages for the app

Steps 1–3 are worth doing before the client install. Step 4 can follow the first
real week, provided step 3 has landed.

## Open questions

- Should `operator` be able to set direction? Currently no. It sits between
  admin and member and the name suggests someone who runs things day to day.
- Does sending mail as the company (`gmail/send`) count as direction? It is the
  most externally-visible thing a non-admin can currently do.
- Is a separate service account acceptable on a machine the client's IT may also
  manage, or does that collide with their MDM?
