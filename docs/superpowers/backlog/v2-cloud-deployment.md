# Backlog: v2 cloud deployment

**Status:** Backlog — adopt paperclip's deployment foundation; layer v2 specifics on top.

## What changed in upstream paperclip

Paperclip has materially improved cloud deployment since v1. Upstream shipped:

| Artifact | Path | Purpose |
|---|---|---|
| Top-level `Dockerfile` | `Dockerfile` | Single canonical container image |
| Compose configs | `docker/docker-compose.{yml,quickstart,untrusted-review}.yml` | Local dev + zero-config quickstart |
| **AWS ECS Fargate runbook** | `doc/AWS-ECS-FARGATE.md` (commit `f0f9460d`) | First-class cloud path |
| **ECS task definition** | `docker/ecs-task-definition.json` | Drop-in for AWS deploys |
| **Quadlet (systemd) units** | `docker/quadlet/paperclip-{db,pod}.container` | Self-hosted "Mac mini in a closet" |
| **Deployment auth modes** | `doc/DEPLOYMENT-MODES.md` + `cli/src/checks/deployment-auth-check.ts` | `local_trusted` vs `authenticated` mode consolidation; preflight catches misconfig |
| **GitHub Actions** | `.github/workflows/docker.yml` | Image publish on tag |
| **AWS env example** | `docker/.env.aws.example` | Shows the exact env wiring |

This means **AgentDash v2 should not roll its own deployment story.** Adopt paperclip's artifacts as the foundation.

## What we still need to add

A short list of v2-specific concerns that paperclip's deployment doesn't cover:

### 1. Stripe webhook reachability
- Production deployment must expose `/api/billing/webhook` to Stripe's IPs.
- Decide: stick path on the same domain as the API (simplest) vs a dedicated webhook subdomain (some teams prefer this).
- ALB / ELB rules permit Stripe's documented egress IPs; `STRIPE_WEBHOOK_SECRET` set in ECS task env.

### 2. Cron-friendly process layout
- v2 has **two crons**: heartbeat email digest (daily 9am local-tz, dispatched via per-user filter) and billing reconciliation (daily 03:00 UTC).
- Naive `setInterval` in the main process works for single-instance ECS but breaks on horizontal scale (every replica fires the cron).
- Decision needed: dedicated singleton "cron" container in the task definition (cheapest), or external scheduler (EventBridge, Cloud Scheduler) with HTTP endpoints (`POST /api/cron/heartbeat-digest`, `POST /api/cron/billing-reconcile`).
- Recommendation: **EventBridge → HTTP endpoint** so the deployment scales horizontally and the cron is observable like a normal request.

### 3. Secrets management
- v2 needs: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`.
- Use AWS Secrets Manager with task-execution-role-scoped secret access (paperclip's ECS task definition already shows the pattern; expand it).

### 4. AgentDash branding
- Paperclip's Dockerfile builds with paperclip's branding; v2 needs the AgentDash brand mark, favicon, and product name baked into the image.
- Cleanest: a `Dockerfile.v2` that extends paperclip's base and replaces `ui/dist/` brand assets, OR fork the upstream Dockerfile and re-style. Decision goes in the spec.

### 5. CI / CD pipeline
- Adopt paperclip's `.github/workflows/docker.yml` shape; tag-driven releases push to ECR.
- Decision: separate AgentDash ECR repo or piggyback on paperclip's? Almost certainly separate.

### 6. Domain + TLS
- Out of scope for the spec — operational. ACM cert + Route 53 + ALB.

## Anticipated structure when specced

When this becomes active work:
- `docs/superpowers/specs/<date>-cloud-deployment-design.md` covering the 6 concerns above.
- `docs/superpowers/plans/<date>-cloud-deployment-implementation.md` with concrete tasks: fork the Dockerfile, write the ECS task def, set up Secrets Manager, deploy a staging environment, exercise Stripe webhook end-to-end, then production.

## Triggering signal

This becomes active work when **any** of:
1. The 5 v2 sub-projects are merged and we need a real environment to demo to prospects.
2. A first paying Pro customer signs up and we need to host them.
3. A first Enterprise prospect asks about deployment topology.

Until then, paperclip's local-first `pnpm dev` is enough.

## Cross-references

- [billing-design.md § 7](../specs/2026-05-02-billing-design.md) — Stripe webhook endpoint requirement.
- [onboarding-design.md § 5](../specs/2026-05-02-onboarding-design.md) — heartbeat digest cron trigger.
- [v2-enterprise-tier.md](./v2-enterprise-tier.md) — dedicated tenancy lives downstream of this.
