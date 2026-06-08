# On-Prem (Self-Managed) Deployment Guide

**Date:** 2026-06-08
**SKU:** On-prem / BYO — customer hosts AgentDash and brings their own LLM tokens. See [2026-06-08-deployment-and-inference-skus.md](2026-06-08-deployment-and-inference-skus.md) (milestone G2).

The on-prem SKU is the same binary as Cloud, configured differently: the customer runs the container/host, supplies their own inference key, and there is **no inference markup** — their usage is metered for visibility only. Access is gated by a signed license instead of Stripe entitlements.

The Mac mini install is the reference on-prem deployment.

---

## 1. Host + Postgres

Same as the cloud path's infra (see [LAUNCH.md](LAUNCH.md) §1–2), but the customer owns it: one container/host running the Dockerfile + a Postgres they control. Bare-metal/LAN/Tailscale is fine (`agentdash setup` auto-detects Tailscale).

Set the standard deployment env (`PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `PAPERCLIP_MIGRATION_AUTO_APPLY=true`).

## 2. Mark this as an on-prem deployment

```sh
AGENTDASH_DEPLOYMENT_KIND=on_prem   # disables inference markup; enables the license gate
```

## 3. Bring your own inference

Pick any adapter and supply the key — **the customer's key, billed to the customer's provider account** (see LAUNCH.md §4):

```sh
AGENTDASH_DEFAULT_ADAPTER=openai_compat
OPENAI_COMPAT_API_KEY=sk-or-...        # their OpenRouter/Fireworks/etc. key
# or claude_api + ANTHROPIC_API_KEY, or hermes_local, …
```

Usage is still recorded to `cost_events` so the customer can see their own consumption (`GET /api/billing/usage` reports markup `1.0` on-prem).

## 4. License the install

AgentDash issues a signed license; the install verifies it offline with the embedded public key. No phone-home.

**One-time (AgentDash side):** generate a signing keypair.
```sh
node scripts/mint-license.mjs keygen --out license-private.pem   # keep private key SECRET
# prints the public key (SPKI PEM) -> goes in the install env
```

**Per customer (AgentDash side):** mint a license.
```sh
node scripts/mint-license.mjs mint --key license-private.pem \
  --customer "Acme Corp" --plan on_prem --seats 50 --days 365
# prints the token
```

**On the install:**
```sh
AGENTDASH_LICENSE_PUBLIC_KEY="$(cat license-public.pem)"   # the public key from keygen
AGENTDASH_LICENSE_KEY=<token from mint>
AGENTDASH_ENFORCE_LICENSE=true   # 402 on gated routes when license invalid/missing/expired
```

> `AGENTDASH_ENFORCE_LICENSE` defaults to **false** so an install boots before a license is provisioned. Flip to `true` once the license is in place. The gate (`server/src/middleware/require-license.ts`) only acts when both `ENFORCE_LICENSE=true` and `DEPLOYMENT_KIND=on_prem`.

Verify a token any time:
```sh
node scripts/mint-license.mjs verify --pub license-public.pem --token <token>
```

## 5. Smoke test

Same as LAUNCH.md §5: sign up → `/cos` → confirm a real (non-stub) CoS reply via the customer's adapter. Confirm `GET /api/billing/usage` returns markup `1.0`.

---

## What's deliberately different from Cloud

| | Cloud | On-prem |
|---|---|---|
| Inference key | AgentDash server-side secret | Customer's own key |
| Markup | Yes (`AGENTDASH_USAGE_MARKUP`) | No (markup forced to 1.0) |
| Access gate | Stripe entitlements | Signed license (`requireLicense`) |
| Billing | Stripe usage records | None (license/support contract) |
