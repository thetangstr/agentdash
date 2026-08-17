# Decisions to review — one per finding

**Written:** 2026-08-16. Companion to `2026-08-16-operating-review.md`.

Each section: the decision, the options with what they cost, and a
recommendation. Recommendations are mine to propose and yours to accept —
nothing here is applied except where it says **DONE**.

Finding 1 is retracted and needs no decision: MKThink already has unlimited
access, there is no cap, and I was wrong about it.

---

## D1 — Invites are bearer links (review §1b)

**Decision: do we bind an invite to an email address?**

| option | cost | effect |
|---|---|---|
| **A. Leave as-is, always `autoApprove: false`** | none | a leaked link costs an unwanted approval prompt, not access |
| **B. Add an optional `email` to the invite; refuse acceptance from any other address** | ~half a day, one migration | the link is useless to anyone else |
| C. Single-use links | small | reduces the window, does not stop the first wrong holder |

**Recommend B, with A as the standing rule until B ships.** A is a real
mitigation and it is already in force for both colleague invites — but the
approval prompt names whoever clicked, not who you meant, so an owner
approving in a hurry cannot tell the difference. B makes the question
unnecessary.

---

## D2 — There is no "does the work, cannot set direction" role (review §2)

**This is the one I named badly.** I wrote "contributor model" in a summary
without ever defining it. Concretely, the decision is: **where does
`canSetCompanyDirection` draw its line?** Today it is `owner | admin |
operator`, and there is no role below `operator` that can do anything at all.

| option | cost | effect |
|---|---|---|
| **A. Drop `operator` from `canSetCompanyDirection`** | ~1 hour | direction becomes `owner \| admin`; `operator` becomes the working tier — creates projects and agents, cannot touch goals. Reverses your earlier "operator should set directions, yes" |
| B. Add a fifth role `contributor` between `viewer` and `operator` | ~1 day | nothing existing changes meaning; one more concept for everyone to learn |
| C. Make direction a grantable permission (`direction:set`) instead of role-derived | ~2 days | most flexible, and the largest blast radius — every direction check changes shape |

**Recommend A.** Your earlier decision was made before we knew `viewer` is
refused *every* non-GET request, which makes `operator` the only tier that can
actually work. Given that, "operator sets direction" and "colleagues are
operators who must not set direction" cannot both hold. A resolves it in one
edit to a predicate that already has a single implementation and full test
coverage.

Also fix regardless of which option wins, because both are latent traps:

- **`operator` gets no `agents:create`.** The role that can start projects
  cannot hire. One line in `grantsForHumanRole`.
- **`normalizeHumanRole("member") → operator`.** The word we have all been
  using silently produces someone who can rewrite your goals. Either delete the
  alias or point it at whatever the working tier ends up being.

**DONE already:** `projects:create` exists as a grantable permission and project
creation no longer requires direction authority. That is necessary for any of
A/B/C and is not sufficient alone.

---

## D3 — Project collision (review §3)

**Decision: what counts as "already taken"?**

Three independent pieces; you can take any subset:

| piece | cost | effect |
|---|---|---|
| **`createdByUserId` column** | small, one migration | makes "Sam's project" a real thing; needed by the other two and by any ownership UI |
| **Unique `(company_id, lower(name))`** | small | two projects cannot share a name. Hard-fails an import or a rename that collides |
| **Near-miss warning on create** | ~half a day | "Leadership already has a project called X — continue?" Soft, no data constraint |

**Recommend all three, in that order.** Ownership first because the other two
read better with it ("Titus already has a project called X"). Uniqueness is
what actually prevents the collision you asked about; the warning is what stops
people working around it by adding a suffix.

---

## D4 — Five of six agents have no steward (review §4)

**Decision: who is answerable for each agent?**

This is not a code question — the mechanism exists and works. It is a naming
question, and only you can answer it. Platform, Delivery, Dex, Quinn and Aria
each need a person.

**Recommend:** Titus stewards all five today so nobody is unowned, and Sam and
Megan take over the ones nearest their work once they are in. Reassigning a
steward is a single row, so a placeholder costs nothing later.

---

## D5 — Nothing tells anyone when something fails (review §5)

**Decision: what is the first alert, and where does it go?**

| option | cost | effect |
|---|---|---|
| **A. Email on run failure via SMTP** | ~half a day | works with any mail account; nothing new to run |
| B. Slack webhook | ~half a day | better if MKThink lives in Slack; one more integration to own |
| C. Nothing; check the dashboard | none | current state — an overnight failure is found the next morning at best |

**Recommend A first, B later if they want it.** The specific trigger worth
having on day one is *a heartbeat run ending in `failed` or `timed_out`*, since
that is the shape of every failure mode we have hit.

Separately and worth deciding on its own: **connectors are all at zero**, so
agents cannot send email or reach a CRM at all. That may be correct for now —
but it should be a decision rather than something discovered in week two.

---

## D6 — A reboot leaves the machine down (review §6)

**Decision: how does the box come back after a power cut?**

| option | cost | effect |
|---|---|---|
| **A. Move the five jobs to `/Library/LaunchDaemons`** | ~1 hour, needs sudo | starts at boot with no login; runs as root unless `UserName` is set |
| B. Enable auto-login for the account | minutes | simplest; the console is logged in permanently, so anyone with physical access has a live desktop |
| C. Leave it | none | someone must log in after every reboot |

**Recommend A**, with `UserName` set so it does not run as root. B trades an
unattended-boot problem for a physical-security one, and this box sits in a
client office.

Not a decision, just wrong today: the review's earlier claim that crash
recovery was missing was incorrect — `KeepAlive` is configured properly. Only
cold boot is broken.

---

## D7 — Backups have never been restored (review §7)

**No decision needed. This is just undone work.**

Fifteen minutes: restore the newest `mkboard` dump into a scratch database and
compare table counts against live. Either it works and we know, or it does not
and we find out now rather than during an incident.

I can do this without touching either instance. **Say the word and it is done.**

---

## D8 — Spend is unmeasured and uncapped (review §8)

**Decision: set a budget ceiling before metering exists?**

A cap cannot currently be enforced from spend, because no cost events are ever
written — that is Gate 0. But `budget_policies` is empty, so there is not even
a number recorded that anyone intended.

**Recommend: set a nominal monthly cap now anyway.** It costs nothing, it makes
the intent explicit, and the day metering starts working the ceiling is already
there rather than being remembered. The alternative is that the first real
number anyone sees is a provider invoice.

---

## D9 — hermes is not sandboxed (review §9)

**Decision: fix the packaging root cause, or accept unconfined agents?**

The root cause is one thing with two symptoms: our packages export raw `.ts`,
which a plain-JS consumer in `node_modules` cannot load. So the vendored hermes
adapter falls back to a published `@paperclipai/adapter-utils` that has no
sandbox support, and a packaged `npm install` pulls that same copy.

| option | cost | effect |
|---|---|---|
| **A. Build `adapter-utils` to `dist` and point `exports` at it** | ~half a day | fixes both symptoms. 12 workspace packages switch from loading source to loading a build, which reintroduces the stale-`dist` hazard — `ensure-plugin-build-deps` already guards two packages and would need extending |
| B. Vendor our own build of adapter-utils into the install and override | ~2 hours | fixes packaging, not the hermes resolution |
| C. Accept it | none | the six live agents run unconfined; the sandbox protects only the `process` adapter |

**Recommend A.** It is the only option that makes the sandbox real for the
agents that actually run, and it unblocks "no source on the client's machine"
at the same time. It is the single highest-value item on this list.

---

## Summary

| # | needs a decision from you | or is just work |
|---|---|---|
| D1 | bind invites to an email? | — |
| D2 | **where the direction line is drawn** | operator's missing `agents:create`; the "member" alias |
| D3 | which of the three collision pieces | — |
| D4 | **who stewards five agents** | — |
| D5 | which alert channel; whether agents get connectors | — |
| D6 | LaunchDaemons or auto-login | — |
| D7 | — | restore drill, 15 min |
| D8 | what the nominal cap is | — |
| D9 | accept option A's blast radius | — |

**D2 and D9 are the two that matter most.** D2 because Sam and Megan are
currently `operator`, which means they *can* edit your goals until it is
resolved. D9 because it is the difference between the sandbox being real and
being decorative.
