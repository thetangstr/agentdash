# Launch plan — shipping tomorrow

**Written:** 2026-08-16, evening. Launch is 2026-08-17.

The honest constraint first: by my own estimates the full D2 model is ~2.5 days
and email-bound invites are ~half a day plus a migration. **They do not fit
before tomorrow, and starting them tonight would leave a half-finished authz
migration on a live client system.** That is worse than not starting.

So this plan is ordered by risk reduction per hour, and it says plainly what
ships, what does not, and what interim covers the gap.

---

## Ships tonight

| # | item | why it makes the cut | risk |
|---|---|---|---|
| **L1** | Drop `operator` from `canSetCompanyDirection` | Sam and Megan are operators **right now** and can edit Titus's goals. This is the requirement that started all of this | low — one predicate, single implementation, existing coverage |
| **L2** | Move five services to LaunchDaemons | a power cut leaves the box dark until someone drives to the office | medium — touches startup; verified by actually restarting |
| **L3** | Nominal budget policy | there is no recorded ceiling at all | trivial — one row |
| **L4** | `adapter-utils` → `dist` (D9) | the difference between the sandbox being real and decorative for the six live agents | **high** — 12 packages switch from loading source to loading a build |

**L4 carries a hard gate.** Full server suite, full UI suite, typecheck, and a
live hermes run on uat that is confirmed sandboxed. If any of those fail and are
not fixed within the sitting, **L4 reverts** and launch proceeds with agents
unconfined and that fact written down. It is the one item here whose failure
mode is "everything stops working", so it does not get to be half-done.

## Does not ship tomorrow, and why

| item | estimate | interim |
|---|---|---|
| D2 full model — two roles, ownership, hybrid RLS | ~2.5 days | **L1** removes the dangerous half: members cannot touch direction. They keep more read/write reach than the final model intends, but nothing they can do is irreversible by an admin |
| D1 email-bound invites | ~half a day + migration | both colleague invites already require approval, so a leaked link costs an approval prompt rather than access. Titus must check the name on each request |
| D3 name uniqueness, near-miss warning | ~half a day | none. Two projects can share a name on day one. Cosmetic against the alternative of rushing a constraint onto live data |
| D5 alerting | ~half a day | none — **failures stay silent.** This is the biggest accepted risk of the launch and someone should look at the dashboard daily until it ships |

## Explicitly still untested

The restore drill was skipped by decision. "We have backups" remains an
assumption on launch day. Fifteen minutes whenever someone wants it to be a
fact.

---

## What "fully tested" means here, and where it stops

Four layers were asked for. Three I can do; one I cannot, and pretending
otherwise would be the exact failure this project keeps finding.

| layer | who | covers |
|---|---|---|
| **Unit / integration** | me | every guard falsified — the change is reverted and the test must fail |
| **API** | me | probe the live instance before and after, read the database back rather than trusting a 200 |
| **Agent** | me | a real hermes run on uat, checked for confinement and for still working |
| **Manual UI** | **needs a human** | I cannot click through a browser. A checklist is at the bottom for Titus |

The manual layer is not optional and it is not mine. Every UI finding this
week — the flashing editor, the "$0.00" beside "Not measured" — came from
reading code, and at least one was wrong until a test caught it. A person
clicking is a different instrument.

---

## Manual checklist for Titus (15 minutes)

Sign in as yourself on `http://mkmini.local:3102`:

1. Open a goal. Confirm you can still edit the title and description.
2. Open Costs. Confirm it reads "Not measured" and shows run counts, and that
   no `$0.00` appears next to it.
3. Open a colleague invite link in a private window. Confirm it asks you to
   sign in and creates an approval request rather than granting access.
4. Open Company Access. Confirm "Create projects" appears as a grantable
   permission.
5. Reboot the Mac Mini. Without logging in, from your laptop, confirm
   `http://mkmini.local:3102` answers.

Item 5 is the one worth actually doing. It is the only test of L2 that counts.
