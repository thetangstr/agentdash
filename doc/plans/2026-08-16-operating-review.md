# What is still missing to run MKThink on agent workers

**Written:** 2026-08-16, against the live `mkboard` instance.
**Method:** probed the running system and read the database back. Every claim
below names what was checked. Where something is a judgement rather than a
measurement, it says so.

This is deliberately wider than the launch gates. The gates cover what we had
already decided to fix; this covers what nobody had asked about yet.

---

## 0. The state of the real workspace

Measured on `mkboard`, not `uat`:

| | |
|---|---|
| humans | **1** (Titus) |
| agents | 6 live |
| issues | 4, all `done` |
| goals / projects | 1 goal, **0 projects** |
| heartbeat runs, ever | **8** |
| budget policies | **0** |
| approvals, ever | **0** |
| connectors configured | **0** |
| activity log rows | 83 |

Read that table before reading anything else. The product has not yet been
used in anger by anyone: eight agent runs total, no projects, no second person.
Most of what follows is not a bug report — it is the list of things that have
never been exercised because there has never been a second user.

---

## 1. ~~You cannot add Sam and Megan today~~ — WRONG, retracted

**This finding was incorrect and is retracted. I did not test it.**

I read `FREE_HUMAN_CAP = readCap("AGENTDASH_FREE_HUMAN_CAP", 1)`, saw one human
already present, and asserted that inviting a second returns 402. I never sent
the request.

What I missed, four lines further down the same file:

```
export function isBillingDisabled(): boolean {
  if (process.env.AGENTDASH_BILLING_DISABLED === "true") return true;
  if (!process.env.STRIPE_SECRET_KEY) return true;   // <- this one
  return false;
}
```

and in `access.ts`, `withTierCapacityForInviteWrite` opens with
`if (isBillingDisabled()) return work(db)`. No Stripe key means the cap check
never runs.

Measured against the running server (pid 7815): no `STRIPE_SECRET_KEY`, no
`AGENTDASH_BILLING_DISABLED`, no `AGENTDASH_FREE_*` in its environment. Then
tested end to end — `POST /companies/:id/invites` for a second human returned
**201**, twice.

**MKThink already has unlimited access.** There was no cap to raise and no
decision to make. The lesson is the one this file is otherwise about: a
constant read out of context is not a measurement.

---

## 1b. Invites are bearer links, not invitations to a person

Found while doing the above. `createCompanyInviteSchema` has no email field:

```
allowedJoinTypes, humanRole, defaultsPayload, agentMessage, autoApprove
```

So there is no such thing as "Sam's invite". There is a link that grants a
role, and whoever opens it takes that role. If a link is forwarded, screenshotted
into a group chat, or sits in a mail archive, the next person to click it is an
operator in the MKThink workspace.

Partly compensated: with `autoApprove: false` the holder lands as a pending join
request that an owner must approve, so a leaked link costs an unwanted approval
prompt rather than immediate access. That is the setting both colleague invites
were created with. It is a mitigation, not a fix — the approval names whoever
signed up, not who the link was meant for.

## 2. No role expresses "does the work, does not set the direction"

You asked for colleagues who create their own projects and agents but cannot
change the goals leadership sets. Measured against the four roles:

| role | create projects | create agents | rewrite your goals |
|---|---|---|---|
| owner / admin | yes | yes | yes |
| operator | yes | **no** | **yes** |
| viewer | no | no | no |

Three separate findings sit in that table.

**2a. `viewer` is read-only for everything, not just direction.**
`assertCompanyAccess` refuses a viewer ANY non-GET request — literally
`"Viewer access is read-only"` — before route-level permission checks run. A
viewer cannot comment on an issue, let alone start a project.

**2b. `operator` cannot create agents.** `grantsForHumanRole("operator")`
returns `tasks:assign` and nothing else. The role that CAN start projects
cannot hire.

**2c. The word "member" silently means `operator`.**
`normalizeHumanRole` maps the string `"member"` to `operator` — which can
rewrite company goals. We have been saying "member" for colleagues throughout
this project; anyone typing it gets a person who can edit your goals.

I added `projects:create` as a grantable permission and separated project
creation from direction authority, which is necessary. It is not sufficient,
because of 2a: the grant cannot be reached by the only role that lacks
direction authority. **Closing this is a product decision, not a patch** —
either a fifth "contributor" tier, or drop `operator` from
`canSetCompanyDirection` and let it be the contributor tier. The second
reverses an explicit earlier decision ("operator should set directions, yes"),
which is why it is written here rather than done.

---

## 3. Nothing prevents project collision — the concern was well founded

`projects` has **no `createdByUserId`** and **no unique constraint on
`(company_id, name)`**. The only index is on `company_id`.

So there is no way to tell "Sam's project" from a leadership project, and
nothing stops two projects called "Weekly board pack" existing side by side.
`goalId` is nullable, so a project need not hang off any goal either.

Three cheap pieces would close it: a `createdByUserId` column, a uniqueness
guard on name within a company, and a warning when a new project's name is
close to an existing one. None exist today.

---

## 4. Five of six agents have no steward

| agent | role | steward |
|---|---|---|
| Chief | chief_of_staff | yes |
| Platform | engineer | **none** |
| Delivery | engineer | **none** |
| Dex | general | **none** |
| Quinn | general | **none** |
| Aria | general | **none** |

Stewardship is the mechanism that makes an agent answerable to a person. Gate 3
assumes it. Five agents currently answer to nobody in particular.

---

## 5. Nobody is told when anything goes wrong

There is **no outbound notification channel configured at all** — no SMTP, no
Slack, no webhook. Zero matching lines in `mkboard.env`, and zero rows in every
`connector` table.

That has two consequences worth separating:

- **Failures are silent.** If an agent fails, or a run wedges, or the disk
  fills, the only way anyone finds out is by opening the dashboard and looking.
  For a box in an office running unattended overnight, that is the difference
  between a five-minute problem and a five-day one.
- **Agents cannot reach anything.** No connectors means agents cannot send
  email, touch a CRM, or file anything outside AgentDash. Whether that is a gap
  depends on what MKThink expects them to do — but it should be a decision, not
  a discovery.

---

## 6. A reboot leaves the machine down until someone logs in

All five services are **LaunchAgents** in `~/Library/LaunchAgents`, not
LaunchDaemons in `/Library/LaunchDaemons`:

```
agentdash LaunchDaemons: 0
agentdash LaunchAgents:  5
```

LaunchAgents load at **user login**. Auto-login was considered and declined.
So after a power cut or an OS update reboot, Postgres and both servers stay down
until somebody physically logs into the Mac Mini.

Crash recovery itself is fine — `KeepAlive` is configured to restart on crash
but not on a clean exit 78, which is the right shape. It is specifically the
cold-boot path that is broken.

**Either** enable auto-login for the service account, **or** move these to
LaunchDaemons so they start at boot. Both are small; neither is done.

---

## 7. Backups run, and have never been restored

Hourly and nightly jobs are loaded, and the newest backups are current
(`mkboard-20260816-033001.sql.gz`, four files retained; uat three). That is the
good half.

The untested half: **no restore has ever been performed.** A backup nobody has
restored is a hypothesis, not a safety net — and the one time you need it is
the worst time to discover the format, the credentials, or the retention
window is wrong.

A restore drill into a scratch database would take fifteen minutes and would
convert this from an assumption into a fact.

---

## 8. Spend is unmeasured AND uncapped

Covered in Gate 2, but it compounds here: there are **0 budget policies** on
`mkboard`. So there is no ceiling on agent spend, and — because the Hermes
adapter emits no token counts — no way to observe it either.

Either half alone is survivable. Together they mean an agent in a loop is
invisible until a provider bill arrives.

---

## 9. The hermes adapter is not sandboxed

Full detail in the launch-gates file. Summary: `hermes-paperclip-adapter`
resolves `@paperclipai/adapter-utils` to the **published `2026.325.0`** from
npm rather than our workspace copy, and that published copy contains no
sandbox support at all. The confinement that is proven covers the `process`
adapter; the six live agents all run hermes.

Root cause is shared with the packaging work: our packages export raw `.ts`,
which a plain-JS consumer in `node_modules` cannot load.

---

## What I would do first

Ordered by what bites soonest, not by effort:

1. **Raise the Free caps** (or move to a paid tier). Nothing else about
   multi-user matters until this is done — §1.
2. **Decide the contributor role.** Fifth tier, or drop `operator` from
   direction. Sam and Megan cannot be set up correctly until this is
   answered — §2.
3. **Fix cold boot.** LaunchDaemons or auto-login. One afternoon — §6.
4. **Configure one notification channel.** Even just email on run failure — §5.
5. **Do a restore drill.** Fifteen minutes, converts a hope into a fact — §7.
6. **Set a budget policy**, even a nominal one, so the ceiling exists before
   the metering does — §8.
7. Project ownership and name collision — §3.
8. Stewards for the five unstewarded agents — §4.

Items 1, 2 and 6 are decisions. The rest is work.
