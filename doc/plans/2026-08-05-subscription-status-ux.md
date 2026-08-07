# Subscription status — what each person should see

**Date:** 2026-08-05
**Status:** proposal, for review. No code written yet.

Your instinct is right: an ordinary member should see a badge, not a bill. But looking at
what is actually wired turned up something bigger than a UX preference, so that comes first.

---

## 1. The finding that reframes this

**Every billing route today authorises on membership, not role.** All four checks in
`server/src/routes/billing.ts` are the same shape:

```ts
if (!req.actor.companyIds?.includes(companyId)) throw forbidden("Not a member of this company");
```

That is the *only* gate on:

| Route | What it lets a plain member do |
|---|---|
| `GET /billing/status` | See the company's plan, seats paid, renewal date |
| `GET /billing/usage` | See the company's month-to-date spend |
| `POST /billing/checkout-session` | Start a paid subscription for the company |
| `POST /billing/portal-session` | **Open the Stripe customer portal** |

The last one is the problem. The Stripe portal is where you change plan, swap the card, and
**cancel the subscription**. So today any member — a viewer, an intern, anyone invited to a
workspace — can cancel the company's plan. The UI does not currently link members there, but
the route answers, so hiding a nav item is not a control.

**So this is an authorisation fix with a UX layer on top, not a UX task.** Hiding billing from
members without gating the routes would be security theatre.

## 2. Who sees what

Two audiences, and the split is sharper than "more detail vs less". They are answering
different questions.

| | A member asks | An owner/admin asks |
|---|---|---|
| Question | *"Can I use the good stuff?"* | *"Is the company paid up, and what happens next?"* |
| Needs | One bit of state | Plan, seats, renewal date, payment health, one action |
| Cares about money | No | Yes |
| Can act | No | Yes |

**Member — a badge, and nothing else.** A `Pro` pill in the workspace switcher or header.
No billing nav item, no price, no renewal date, no seat count. If they hit a paywalled
capability, the message names the capability and says *"ask an owner to upgrade"* — it must
not dead-end them at a checkout page they cannot complete. Their spend is not their business
and showing it invites anxiety they cannot resolve.

**Owner/admin — one screen that answers "are we fine?" in the first line.** Plan and state,
seats used against seats paid, what happens on the renewal date, and exactly one primary
action appropriate to the state. Everything else is secondary.

## 3. State by state

The tier vocabulary already exists (`free`, `pro_trial`, `pro_active`, `pro_past_due`).

| State | Member sees | Owner sees | Primary action |
|---|---|---|---|
| `free` | no badge | "Free — *N* of *M* included agents used" | **Upgrade** |
| `pro_trial` | `Pro` | "Pro trial — ends *date* (*N* days)" | **Add payment method** |
| `pro_trial`, ≤3 days | `Pro` | same, promoted to a banner | **Add payment method** |
| `pro_active` | `Pro` | "Pro — renews *date*, *N* seats" | **Manage billing** |
| `pro_past_due` | `Pro` *(keep working)* | "Payment failed — access ends *date*" | **Update payment** |
| `canceled`, still in period | `Pro` | "Cancelled — active until *date*" | **Resubscribe** |

Three rules behind that table:

- **Never degrade a member mid-period for a payment problem.** Past-due is the owner's
  problem; the member keeps the badge and keeps working until the period actually ends.
  Punishing the whole team for a card that expired is how you lose the team, not just the card.
- **Urgency escalates by proximity, not by state.** A trial with 12 days left is a line of
  text; with 2 days it earns a banner. Never a modal, never blocking.
- **Say what happens, with a date.** "Access ends 3 September" beats "past due". People plan
  against dates, not statuses.

## 4. The on-prem half nobody has seen

There are **two** entitlement systems and they are not the same shape:

| | Cloud | On-prem |
|---|---|---|
| Mechanism | Stripe subscription | Signed licence (`AGENTDASH_LICENSE_KEY`) |
| Expiry | `periodEnd`, auto-renews | Hard `exp` claim, no renewal path |
| Failure | `past_due`, grace, dunning emails | **402 on every product route** |
| Status UI | `BillingPage` | **none** |
| Self-service | Stripe portal | none — we mint a new licence |

MKThink is on-prem. So the page they will actually look at does not exist yet, and today the
only way an operator learns their licence state is by triggering a 402 and reading the body.
For a six-month free licence that means the failure mode is: everything works for 180 days,
then the whole product returns 402 with no prior warning anywhere in the UI.

**That is the most valuable thing to build here**, and it is small:

- One `GET /billing/entitlement` that returns a single normalised shape for both worlds:
  `{ kind: "cloud" | "on_prem", state, label, expiresAt, daysRemaining, actionable }`.
- The owner screen renders from that, so it does not branch on deployment kind.
- On-prem shows: customer name, plan, expiry, days remaining, and — from ~30 days out —
  "contact AgentDash to renew". No portal, because there isn't one.
- The member badge reads from the same endpoint, so `Pro` means the same thing in both worlds.

## 5. What I would build, in order

1. **Gate the billing routes by role** — `checkout-session`, `portal-session`, and `usage`
   become owner/admin only; `status` stays member-readable but returns a *reduced* shape for
   non-admins (just enough for the badge: `{ tier, isPro }` — no money, no dates, no seats).
   This is the security fix and it is worth doing whether or not the UI work follows.
2. **`GET /billing/entitlement`** — the normalised cloud + on-prem shape above.
3. **Member badge** — `Pro` pill, reading the reduced shape.
4. **Owner screen** — rework `BillingPage` around "are we fine?" first, one primary action.
5. **Expiry warnings** — trial ≤3 days and licence ≤30 days, in the same banner slot
   (`TrialBanner.tsx` already exists and can generalise).

Items 1 and 2 are the load-bearing ones. 3–5 are presentation and can follow.

## 6. Open questions for you

- **Should a member see the seat count?** Argument for: they can see they're one of 12.
  Argument against: it is a commercial fact and invites "are we paying for me?". I lean no.
- **Should `free` show a badge at all?** I lean no — an absent badge is the honest signal, and
  a `Free` pill reads as a nag.
- **On-prem renewal**: who does an operator contact, and do we want that as a mailto, a URL, or
  just a sentence? This is the only genuinely manual step in the on-prem lifecycle.
- **Does the 402 need a friendlier surface?** Right now an expired on-prem licence produces a
  raw 402 on every call. A dedicated "licence expired" screen would be kinder than whatever the
  UI does with an unexpected 402 today — which I have not tested.
