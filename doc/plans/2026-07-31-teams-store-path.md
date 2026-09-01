# Microsoft Teams: the path to a Teams Store app

**Date:** 2026-07-31
**Status:** Approved direction, not scheduled work
**Owner decision:** *"i do want it to be in the store eventually as an app for teams"*
**Supersedes:** the Teams entry in
[`2026-07-30-agentdash-mk-scope-override.md`](../../docs/superpowers/specs/2026-07-30-agentdash-mk-scope-override.md) §7

This exists so that when Teams is scheduled, nobody re-derives the research or
re-discovers the blocker. It is not a commitment to build now.

## What the decision settles

The distribution gate is **open**. Multi-tenant bot creation was deprecated by
Microsoft after 2025-07-31 and this project has no grandfathered registration,
so the only path to a bot reachable from customer tenants is **one single-tenant
Azure Bot published through AppSource / the Teams Store**. The owner has
accepted that commitment.

That makes **finishing the existing bot the right engineering answer**, and
retires the no-bot alternative (a Workflows webhook notifier with a deep link
back). The notifier was only ever the answer if the store was refused; it has no
inbound Teams surface and could not have become one incrementally.

## What is already done

Two of the original slices landed on 2026-07-31 as part of ordinary security
work, before this decision:

- **Shared-layer hardening** (`625f074e`) — global unique index on active
  `(provider, external_user_id)`, fail-closed on duplicate bindings,
  `verifiedAt` required in the binding lookup, and the self-assert route
  inverted from a blocklist to an empty allowlist. Turning Teams inbound on
  would have armed all four of those defects.
- **Doc corrections** (`625f074e`) — the false "SDK exports no standalone
  validator" claim removed from `teams-connector.ts`, `docs/api/agentdash-mk.md`,
  and audit criterion 10.

## Sequenced plan

Each slice is independently verifiable, in the shape this branch has been
shipping. Slices 3 and 4 **must land together** — see the warning on 4.

| # | Slice | Size | Note |
|---|---|---|---|
| 3 | Inbound validation | M | `createTeamsActivityVerifier` using `ServiceTokenValidator` via deep import from `@microsoft/teams.apps/dist/middleware/`. **Pin the dependency to exact `2.0.14`** — drop the `^`. The import reaches into `dist/` and works only because the package ships no `exports` map, so add a module-resolution smoke test that fails CI the day that path moves. Reject activities carrying no `serviceUrl`. Needs net-new test infrastructure: a real RS256 key and a local JWKS server. Budget for that; it is most of the slice. |
| 4 | Pairing ceremony | M | Mint a challenge in-app → the steward DMs the code to the bot → the inbound message carries a BFS-validated `aadObjectId` → complete the binding. Same shape as `telegram-connector.ts`. **Non-optional, and must ship with or before slice 3** — validation without a ceremony converts a dormant vulnerability into a live one, because the only way to create a Teams binding today is the self-assert route, which is now correctly closed. |
| 5 | Outbound delivery | S | Bot token, then `POST {serviceUrl}/v3/conversations/{id}/activities`. Use the **single-tenant** authority `https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token`; the multi-tenant `/botframework.com/` path is now the wrong default. Read `serviceUrl` from the stored binding, never from the inbound activity. Adds the Teams branch to `approval-card-delivery.ts`, which currently falls through to "no delivery implemented". |
| 6 | App package + AppSource submission | unknown calendar time | Manifest, icons, Partner Center, validation cycles. Runs in parallel with 3–5 and gates nothing in code. |

`buildApprovalCard` and `decideFromCardAction` are already built and tested and
should not be touched. `consumeCallbackToken` in the Teams path is
provider-scoped where Telegram's is not — **do not weaken it to match**.

## Verify before spending engineering time

These are cheap, and two of them can invalidate the plan.

1. **Does cross-tenant proactive send actually work after an AppSource install?**
   Every Microsoft statement found saying yes was a *forum moderator answer*, not
   documentation. The SDK's `TokenManager.getBotToken()` resolves one fixed
   tenant authority with the target conversation's tenant never threaded in —
   contrast `getGraphToken(tenantId)`, which does take one. Multiple Q&A threads
   report `401 Authorization has been denied for this request` on exactly this.
   **Cannot be spiked in one tenant; needs two.** Until it is proven, "the
   steward receives a card" is not closed, and slice 5 may be impossible as
   written.
2. **Is `activity.from.aadObjectId` reliably populated on `adaptiveCard/action`
   invokes — including guest, B2B, and federated users? Is
   `channelData.tenant.id` present on invokes specifically?** The identity model
   turns on the first; tenant isolation on the second, whose fallback to
   `conversation.tenantId` is a guess. Microsoft's request-format docs omit both.
   *Check: install in a test tenant, invite a B2B guest, capture the raw invoke
   JSON. One afternoon.*
3. **Does the Express body parser deliver a parsed body to
   `ServiceTokenValidator.check(authHeader, body)`?** It dereferences
   `body.serviceUrl` and will throw on undefined. *Check: one supertest request
   through the assembled app.*

## Sign-off required before shipping

**Channel endorsement validation is implemented by neither Microsoft SDK.**
`grep endorsement` returns nothing in both. A live JWKS pull on 2026-07-31 found
**255 keys, of which only 54 are endorsed for `msteams`** — so roughly 79% of
currently-valid signing keys would be accepted for an activity claiming
`channelId: "msteams"`. Pinning `channelId` in code does not help: that field
lives in the *unsigned* body, authored by the same party as the claim.

The only real control is enabling solely the Teams channel on the bot
registration — per-customer portal configuration, with no server-side
verification and no audit trail. Microsoft's own guidance is that failing any of
the seven checks "will leave the bot open to attacks."

Shipping six of seven is a defensible trade, but it is a trade. Someone with
authority should accept it **in writing, before** engineering starts.

## What this will not deliver

- **Sovereign clouds.** Public cloud only. GCC High, DoD, and China need
  `@microsoft/teams.api` added for `CloudEnvironment` values.
- **A fast start.** Slice 3 alone needs JWKS test infrastructure that does not
  exist in this repo, and slice 6 has a calendar tail nobody controls.
- **Parity with Telegram on day one.** Telegram has a pairing ceremony,
  bidirectional chat, and pushed cards. Teams reaches pushed cards and decisions
  at slice 5; steward↔agent chat over Teams is not in this plan.
