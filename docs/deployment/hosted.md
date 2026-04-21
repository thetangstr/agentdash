# Hosted Lane — Deployment Guide

Status: **Phase 1 placeholder.** Phase 2 of the GTM build (`.omc/specs/deep-interview-agentdash-gtm-tech-deployment.md`) fills this in.

## What ships in Phase 1

- Single-tenant dashboard at `<app-domain>` (per-customer, manual provisioning — production domain TBD)
- Stripe billing wired (see `doc/STRIPE-SETUP.md`) — currently deferred until pricing model is finalized
- Marketing site at `<marketing-domain>` (Next.js, deployable to Vercel — production domain TBD)
- Self-serve signup via better-auth (email + password)

## What's coming in Phase 2

- **Per-tenant cloud workspaces** (Coder / Daytona / Fargate): each customer gets a Linux container with the AgentDash CLI + Claude/Codex/Cursor adapters preinstalled.
- **BYOK API key vault**: customers paste their Anthropic / OpenAI keys; encrypted with envelope encryption.
- **Workspace lifecycle**: provision on signup, suspend on plan downgrade, destroy on cancel.

## Phase 2 placeholder — provisioning steps

(To be filled in. Tracking issue: TBD.)

1. Customer completes signup → marketing site CTA → dashboard better-auth flow
2. Customer completes onboarding wizard → company created
3. Customer pays via Stripe Checkout → webhook fires → tier upgraded to Pro
4. *(Phase 2)* Workspace provisioner triggers Coder template instantiation
5. *(Phase 2)* Customer's CLI auth bootstraps with the new workspace endpoint
6. *(Phase 2)* Customer pastes BYOK keys → vault stores encrypted

## Related

- `.omc/specs/deep-interview-agentdash-gtm-tech-deployment.md` — full GTM spec
- `.omc/plans/2026-04-20-monetization-unlock-impl.md` — Phase 1 implementation plan
- `doc/GAPS.md` — running gap inventory
- `doc/STRIPE-SETUP.md` — Stripe configuration
