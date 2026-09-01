# Full reconciliation: every roadmap item, measured

**Written:** 2026-08-17. Replaces the "remaining tonight" list, which was
scoped too narrowly and dropped items — a fair challenge from the owner.

Status is **measured tonight**, not recalled. Where I checked, the evidence is
named.

---

## Done and verified (18)

| id | item | evidence |
|---|---|---|
| A1 | direction is admin-only | test pins the operator reversal |
| A2 | roles collapsed to admin+member | migration falsified on scratch DB; live rows read back |
| A3 | `created_by` on projects + agents | backfilled on both instances, read back |
| A4 | editing follows ownership | real-router tests |
| A5 | restricted projects, app-side | leak test, real routers + real DB, falsified by removal |
| A6 | name collision guard | 9 real-DB cases; corrected the "duplicates unprevented" claim |
| A8 | member agent-creation | folded into A2 |
| O1 | local error sink | live: recorded a real 500 with context |
| O2 | error surface page | live: 200, shows alerter + health |
| O3 | alerting via Resend | live: real `run_failed` email delivered unprompted |
| O4 | health that can degrade | live: db/disk/backup/stuck-runs reported |
| O6 | run-failure signals | emitted at the one status-change site |
| M2 | budget policy seeded | $500/mo, notify-only, read back |
| M3 | budget gate | 5 real-DB cases |
| M4 | runaway cap | fixed after live defect (100 → 1000) |
| G3 | approval path exercised | create→approve→reject→re-decide-refused, DB read back |
| G4 | stewardship question resolved | 1:1 pairing, not a roster |
| G5 | mandate expiry | verified already enforced; signal added |
| G6 | adapter-utils → dist | full gate + live confined agent run succeeded |
| C1 | LaunchDaemons | 7 installed, running as `yang`, KeepAlive proven |
| C5 | log rotation | falsified on a synthetic 11MB log |
| C6 | Caddy + mkcert | HTTPS 200 on :3112/:3113 |

## Not done — and three of these matter more than I implied

### The keystone: M1 (token metering)

**Measured tonight: `cost_events` = 0 rows on BOTH instances, tokens = 0.**

Nothing has ever written a cost event. That single gap invalidates a cluster:

- **D1** — the 7 cost surfaces show `$0.00` *because there is nothing to show*
- **M2/M3** — the $500 policy I seeded **can never fire**; the budget gate is
  real code guarding a metric that is permanently zero
- **M5** — cost attribution per agent/project is impossible
- The whole question "what is this costing us" is unanswerable

I described M2/M3 as done tonight. They are — as *mechanisms*. But calling
budget control "working" while spend reads zero forever would be the same
error as the Sentry transport that formatted errors and dropped them. **M1 is
the highest-value item left on the entire roadmap.**

### Packaging (D4) — you asked directly

**Verified tonight:** the packager runs — 621 source files → one 5.2 MB
bundle, **0 `.ts` files** in the output, no `@paperclipai/*` left as an npm
dependency, and the Seatbelt profile builder is inside the bundle (G6's fix
holds through packaging).

**Not done:** the packaged install has never been **booted** since tonight's
changes. The earlier proof (117 migrations, 167 tables) predates the role
collapse, O1/O2, and G6. Until it is started and probed, "it packages" is
proven and "it runs" is an assumption.

### RLS (D5) — you asked directly

**Done:** app-side enforcement, with a leak test against real routers on a
real database, falsified by removing the filter.

**Deferred, with cause:** the Postgres backstop. Under the single `paperclip`
role, `FORCE RLS` also applies to the server's own GUC-less internal reads —
the heartbeat scheduler and agent context assembly would silently lose
restricted-project rows, breaking the very agents on the access list. The
non-breaking variant is fail-open, which is theatre.

**What it actually needs:** per-request connection identity — a second,
RLS-subject database role and pool for API-path queries, with `SET LOCAL`
actor context. That is a design, ~1 day, and it is the honest completion of A5.

### The rest, still open

| id | item | note |
|---|---|---|
| O5 | silent-failure audit | the sweep for swallowing `catch`/`?? fallback` never ran |
| A7 | email-bound invites | **verified: 0 email refs in the invites schema** — still bearer links, and Sam's and Megan's are live now |
| A9 | audit-log coverage | 55 of 75 route files never checked for `logActivity` |
| C2 | restore drill | 15 min; "we have backups" is still an assumption |
| C7 | retention policy | **no pruner outside plugins**; needs your Q6 answer |
| C8 | runbook | **absent** — nothing tells Titus what to do when it breaks |
| G2 | connector scoping | design only; 0 connectors exist, so it gates a door not yet open |
| G7 | agent output review | deferred; the RFP scenario tests it in miniature |
| G8 | transcript retention | client data kept forever |
| U1 | track upstream paperclip | fork diverges further every release |
| — | packaged install boot | D4 above |
| — | RLS backstop | D5 above |
| — | 7 cost surfaces | blocked on M1 |
| — | plugin `/status` rate limit | cosmetic |
| — | `packages/connect` typecheck | pre-existing, dangling tsconfig ref |

### Descoped by you

C3 off-volume backups, C4 encrypted backups.

### Yours, not mine

Reboot test · mkcert CA per machine · Sam/Megan accepting invites · retention
windows (Q6) · spend ceiling once metering is real.

---

## Revised plan

The RFP scenario stays the centre — it is still the only thing that answers
"can they finish work together". But two items should be promoted:

**Tier 1 — tonight, in order**
1. **Goal 1** — agents can research, confined *(45 min cap)*
2. **Goal 2** — seed the knowledge base *(30 min)*
3. **Goal 3** — run the RFP scenario end to end *(60–90 min)*

**Tier 2 — the moment Tier 1 lands, or tomorrow**
4. **M1 token metering** — the keystone; unblocks D1, M2, M3, M5 and the whole
   cost question
5. **C2 restore drill** — 15 minutes, converts your only remaining data-loss
   assumption into a fact
6. **C8 runbook** — Titus cannot operate this without one
7. **Boot the packaged install** — closes D4

**Tier 3 — needs a sitting of its own**
8. RLS backstop (per-request connection identity, ~1 day)
9. A7 email-bound invites · O5 silent-failure audit · G2 · G8 · U1 · A9
