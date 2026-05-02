# Backlog: v2 Enterprise tier

**Status:** Backlog — not active. Triggered by first qualified customer ask.

## What it is

A third tier above Free + Pro. Sales-led, contract-billed (not self-serve Stripe), with Enterprise-only features.

## Triggering signal

A real prospect asks for one or more of: SSO, audit log, custom retention, dedicated tenancy, contract terms, multi-environment isolation. Until that ask exists, **don't build this** — speculative Enterprise infra is the canonical lean trap.

## Anticipated scope when triggered

- **SSO**: Okta + Microsoft Entra (formerly Azure AD) via SAML / OIDC. Adopt better-auth's existing SAML support if upstream paperclip has it; build only what's missing.
- **Audit log**: append-only event store of every state-changing API call (who, what, when, target). Likely a new `audit_events` table. Already half-needed by Pro for support-debugging — pull forward to Enterprise gate.
- **Custom retention**: per-tenant configurable message and run history retention (default unlimited; Enterprise can dial down for compliance).
- **Dedicated tenancy**: separate Postgres / separate worker pool / separate ECS service, depending on contract requirements. Adopt paperclip's deployment patterns (see `backlog/v2-cloud-deployment.md`) — Enterprise = a dedicated ECS task family, not a code change.
- **Contract billing**: drop Stripe checkout for Enterprise customers; invoice via Stripe Invoicing or external billing. `companies.plan_tier = enterprise`; entitlement-sync handles `enterprise` like `pro_active` for caps.
- **Custom CoS prompts**: allow Enterprise customers to override CoS's system prompt at the company level (the current `cos-system-prompt-v1` is per-deployment).
- **Support SLA + dedicated channel**: Slack Connect or shared inbox per Enterprise customer. Operational, not code.

## What stays the same as Pro

- Multi-human + CoS chat substrate (no Enterprise-specific chat shape).
- Onboarding flow (Enterprise customers go through the same flow with their tier set by sales).
- Per-seat billing math (still per-seat at the contract level, just billed differently).

## When to spec this properly

When **all** of:
1. A signed Enterprise customer (or LOI from one) exists.
2. The first 3 must-haves are concretely scoped (which IdP for SSO, what events go in the audit log, what retention SLAs).
3. Pro is generating recurring revenue (so we know the foundation is solid).

Then write `docs/superpowers/specs/<date>-enterprise-tier-design.md` and an implementation plan.

## Cross-references

- [billing-design.md § 14](../specs/2026-05-02-billing-design.md) — explicit "Enterprise out of scope for v1" decision.
- [v2-cloud-deployment.md](./v2-cloud-deployment.md) — dedicated tenancy depends on the deployment substrate.
