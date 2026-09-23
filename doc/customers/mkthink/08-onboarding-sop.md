# MKThink — onboarding a new person

2026-09-22 · Yang · **Draft for internal review**

The procedure lives in the product, not here. Open **Guides** in the left nav of the board, or go straight to the pages below. Every address on those pages is this instance's own, filled in at render time, so they are right even if the address changes. This file holds only what is specific to MKThink's instance.

| Who | Read |
| --- | --- |
| The new person | `http://10.50.10.129:3102/guides/steward/getting-started` — then connect your terminal, your inbox, troubleshooting |
| The admin | `http://10.50.10.129:3102/guides/board-operator/onboard-a-steward` — invite, agent, stewardship transfer, verify, offboarding |

## What is specific to us

| Fact | Value | Why it matters |
| --- | --- | --- |
| Instance address | `http://10.50.10.129:3102` | What the instance publishes; invite links and the connect command carry it. A DHCP lease — when it moves to a stable name (#547), nothing in the guides changes, because they read the address from the instance |
| Network | Office LAN, or a VPN that routes to it | `mkmini.local` does not resolve over the VPN; the IP does. `.ts.net` addresses are Yang's personal tailnet and are not available to staff |
| Instance admin | Yang | Creates accounts and transfers stewardship |
| Default agent role for new stewards | `chief_of_staff` | Matches the existing MKThink agent; change it per person if the role is different |
| Invite email | From `invites@agentdash.cloud` | Delivery is best-effort — always send the link yourself as well, on Teams |
| Approvals | Two-approver flow, Titus then CEO | The first real approval a new steward decides should be a small, deliberate one |

## What is coming

The admin half — invite, agent, stewardship — is designed to become one sentence typed into Claude Code: [`doc/plans/2026-09-22-onboard-from-claude.md`](../../plans/2026-09-22-onboard-from-claude.md). Not built yet.

## Change log

| Date | Change |
| --- | --- |
| 2026-09-22 | First version, written as a full SOP. Same day, moved the procedure into the product as in-app guides and reduced this file to the MKThink-specific overlay. |
