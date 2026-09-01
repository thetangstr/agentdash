# AgentDash-MK Scope Override

**Status:** Approved addendum — supersedes the scope boundaries in
[`2026-07-28-agentdash-mk-design.md`](2026-07-28-agentdash-mk-design.md) §17
and its exclusion list
**Date:** 2026-07-30
**Decided by:** product owner (yang@mkthink.com), verbatim record below
**Applies to:** branch `codex/agentdash-mk` and every PR that follows it

The approved design is **not edited**. This addendum is the newer document; per
the repository's document-lifecycle rule, where the two disagree, this one
governs.

## 1. Why this document exists

The design explicitly excluded WhatsApp, HubSpot, and the local computer-agent
bridge, and ranked Microsoft Teams as a P0 acceptance criterion. The product
owner reversed both halves of that after reviewing the acceptance audit. Without
a citable record, every subsequent PR reads as a unilateral violation of an
approved design.

## 2. The override, verbatim

> unblock us, team is low priority, work on everything else first, including
> whatsapp integration, hubspot integration - this could be a native integration
> from agentdash which allow users to setup their personal hubspot key or the
> local machine agent (claude or chatgpt) integration (agent handshanke between
> them?)

## 3. What changes

| Item | Design position | Position after this addendum |
|---|---|---|
| Microsoft Teams | P0 acceptance criterion 10 | **Deprioritized.** Not abandoned; no code removed |
| WhatsApp | Excluded | **In scope** |
| HubSpot | Excluded | **In scope, native, per-user BYO key** |
| Local Codex/Claude bridge | P2, deferred | **In scope, P0-of-its-own-track** |
| Salesforce, Jira, SharePoint, Google Drive | Excluded | **Still excluded** — unchanged |

The order of work is: close the remaining blocker criteria first (5, 8, 9, 11),
then WhatsApp, then HubSpot, then the bridge. Teams stays where it is.

## 4. Native vs bridge — the resolved fork

The owner posed HubSpot-native and the local-agent bridge as alternatives
("*or* the local machine agent"). They are not alternatives; they answer
different questions. The resolution is **native first, bridge second, build
both**, on this reasoning:

- **The ceiling is only an enforcement mechanism on the native path.** A native
  HubSpot call flows through `resolveActingAs`, where the `providers` and
  `dataScopes` dimensions of the owner ceiling can refuse it. A bridge task is
  executed by a machine the server does not control; the ceiling constrains what
  may be *asked*, not what the machine *could* do. For a CRM of record, that
  difference decides it.
- **The bridge's real advantage is marginal cost per additional integration**,
  and that advantage is unchanged by shipping HubSpot natively first.

Adopted as roadmap policy:

> **HubSpot native is the always-on head. The bridge owns the long tail. No
> connector #2..N gets hand-built without demand evidence.**

Before any connector beyond HubSpot: evaluate a server-side MCP client against
HubSpot's official remote MCP server instead of more hand-rolled REST.

## 5. Consequences for the acceptance audit

[`doc/plans/2026-07-29-agentdash-mk-acceptance-audit.md`](../../../doc/plans/2026-07-29-agentdash-mk-acceptance-audit.md):

- **Criterion 10 (Teams)** stays **NOT MET** and is annotated *deprioritized by
  owner decision*, not *failed*. Open-work item 1 carries the same annotation.
  The existing Teams code and its tests remain and keep running; the E2E spec
  keeps asserting that the Teams endpoint rejects unvalidated activities, so the
  gap stays visible rather than skipped.
- **Criterion 13** ("no P0 surface claims the deferred bridge or excluded
  integrations") is rewritten to assert consistency *with this addendum* rather
  than absence. It is met when the prompt surfaces, the API doc, and the
  drift test agree with the table in §3 — not when they are silent.

## 6. Scope-document debt this addendum authorizes

Three artifacts currently assert the old exclusions and must move in the same PR
as the feature that invalidates them, or the repository contradicts itself:

| Artifact | Currently asserts | Moves in |
|---|---|---|
| `docs/api/agentdash-mk.md` "Not in scope" | WhatsApp, HubSpot, bridge all excluded | each feature's own PR |
| `server/src/__tests__/agent-instruction-bundles.test.ts` "does not promise the deferred local computer-agent bridge" | no surface may mention the bridge | the bridge PR, inverted to assert presence |
| Audit criterion 13 | absence of all three | the bridge PR (last of the three) |

The four mandatory prompt surfaces
(`server/src/onboarding-assets/{default,ceo,chief_of_staff}/AGENTS.md` plus
`server/src/services/agent-creator-from-proposal.ts`) are updated by whichever
PR adds agent-visible behavior, per the rule in repo-root `AGENTS.md`.


---

## 7. Amendments (2026-07-31)

The owner revisited scope after the first pass shipped.

| Item | Decision | State |
|---|---|---|
| HubSpot private-app attribution | **Accepted.** "hubspot is fine" | Writes ship as built. Provenance stamping into HubSpot moves to the backlog, not a blocker |
| WhatsApp | **Dropped.** "lets drop whatsapp" → **"park it"** | Code **parked, confirmed 2026-07-31.** Left in place and passing; not deleted. No further investment — the out-of-window utility template is abandoned. Removal remains available later at no additional cost |
| Microsoft Teams | **Store path accepted.** *"i do want it to be in the store eventually as an app for teams"* | The distribution gate is **open**. Finishing the existing bot is now the right engineering answer; the no-bot notifier alternative is retired. **Not scheduled** — "eventually". Plan held at [`2026-07-31-teams-store-path.md`](../../../doc/plans/2026-07-31-teams-store-path.md) |

### Teams: the blocker was misdiagnosed

Criterion 10 and `teams-connector.ts` both claimed the SDK "exports no standalone
validator." That is **wrong**. `ServiceTokenValidator` exists at
`@microsoft/teams.apps/dist/middleware/`, is standalone, pins the issuer and
binds `serviceUrl` — it is simply not re-exported from the package root. All
three statements of the false claim were corrected on 2026-07-31.

The real blocker is upstream and nobody had checked it. Microsoft Learn
(*Register a Bot Framework bot with Azure*, page updated 2025-12-16):

> Multi-tenant bot creation will be deprecated after July 31, 2025. Existing
> multi-tenant bots will continue to function, but new multi-tenant bot creation
> will no longer be supported after that date.

This project holds no grandfathered registration — there is no manifest in the
repo and `TEAMS_BOT_APP_ID` / `TEAMS_BOT_APP_PASSWORD` are read by no code. The
remaining path is one **single-tenant** bot reached cross-tenant via **AppSource
/ Teams Store publication**, which is a go-to-market commitment (Partner Center
certification, publisher verification, listing maintenance) rather than an
engineering task.

**Resolved 2026-07-31: yes, eventually.** The owner accepted the AppSource
commitment. That opens the gate and retires the notifier alternative, which had
no inbound Teams surface and no incremental path to one. Criterion 10 stands as
originally written — Teams parity — rather than being renegotiated.

Two of the plan's slices already landed as ordinary security work before the
decision: shared-layer hardening and the doc corrections, both in `625f074e`.
The remainder is sequenced in the plan doc and is **not scheduled**.

Two findings that should inform the answer, both from the 2026-07-31 research:

- **Cross-tenant proactive send is unproven even with AppSource.** Every
  supporting Microsoft statement found was a forum moderator answer, not
  documentation, and the SDK's own token path resolves a single fixed tenant
  authority. Proving it needs two tenants, not one.
- **Channel endorsement validation is implemented by neither Microsoft SDK.**
  A live JWKS pull found 255 keys with only 54 endorsed for `msteams`, so ~79%
  of currently-valid signing keys would be accepted for an activity claiming to
  be from Teams. Pinning `channelId` in code does not help — that field is in
  the unsigned body. The only control is enabling solely the Teams channel on
  the registration, which is per-customer portal config with no server-side
  verification. Shipping six of seven checks should be signed off in writing
  before engineering starts.
