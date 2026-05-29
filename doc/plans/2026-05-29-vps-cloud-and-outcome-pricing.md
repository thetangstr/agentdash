# VPS, Cloud, and Control-Plane Pricing Plan

Status: Draft for first MSP design-partner launch
Date: 2026-05-29
Owner: AgentDash launch team

## Summary

AgentDash should not jump from Mac mini pilot directly to a conventional multi-tenant SaaS. The next production shape should be a managed, single-tenant VPS deployment operated by AgentDash, with a path to multi-tenant cloud only after the first two or three MSP partners prove the workflows and pricing.

The commercial model should also move away from per-seat SaaS, but AgentDash should not pretend to sell vertical outcomes it does not directly own. AgentDash is the control plane: customers create their own agents, prompts, workflows, and success definitions. Price the product around managed control-plane value, agent orchestration, governance, auditability, support, and customer-defined value events.

## Research Signals

Last-30-days social research for the exact query was low-signal: the `/last30days` run found only 3 weakly relevant X posts and no useful Reddit/YouTube/TikTok results. Stronger evidence came from current vendor sources and recent MSP-specific announcements.

Important caveat: Intercom, Zendesk, Salesforce, ConnectWise, and Kaseya can price against specific support, sales, or ITSM outcomes because they own a vertically defined workflow surface. AgentDash does not initially own those workflow definitions. These sources are evidence that buyers are accepting value-aligned pricing for AI work, not evidence that AgentDash should publish fixed SKUs such as "ticket triage" or "QBR package" before it provides those as first-party templates.

- Intercom has moved Fin from resolution-only pricing to outcome pricing. Its public help docs list $0.99 outcomes for resolution, procedure handoff, and disqualification, and $9.99 for qualification. It also says failed procedures and explicit human-escalation paths are not billed, and only one outcome is charged per conversation. Source: [Intercom Fin outcomes](https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-outcomes/).
- Intercom's product rationale is that "resolution" is too binary once agents do useful work before a human handoff; outcomes can include safely gathering context, taking an action, and handing off for confirmation. Source: [Intercom blog, March 12 2026](https://www.intercom.com/blog/from-resolutions-to-outcomes-evolving-how-fin-delivers-value/).
- Zendesk announced outcome-based pricing for its Autonomous Service Workforce on May 19, 2026, with charged resolutions verified by the resolving AI agent and a separate evaluation model; spam and routine exchanges are excluded. Source: [Zendesk Relate 2026 announcement](https://www.zendesk.com/newsroom/press-releases/relate-2026/).
- Salesforce Agentforce offers both conversation pricing and Flex Credits. Flex Credits meter individual actions and are positioned as aligning cost to value, with current public pricing at $500 per 100k credits and examples where standard actions consume 20 credits. Source: [Salesforce Agentforce pricing](https://www.salesforce.com/agentforce/pricing/).
- MSP incumbents are converging on ticket triage and connected PSA/RMM automation. ConnectWise positions AI ticket triage around classifying, prioritizing, routing, remediation, documentation, and margin expansion. Source: [ConnectWise automated ticket triage](https://www.connectwise.com/solutions/automated-ticket-triage).
- Kaseya announced a Ticket Triage Digital Specialist on April 28, 2026, and explicitly tied MSP AI value to unified data plus execution, not disconnected recommendations. Source: [Kaseya agentic platform announcement](https://www.kaseya.com/press-release/kaseya-unveils-the-first-agentic-it-management-platform-turning-data-into-autonomous-action/).
- Kaseya's Autotask Community Live recap says MSP AI outcomes depend on connected systems, structured data, standardized documentation, and consistent processes. Source: [Autotask Community Live 2026 recap](https://www.kaseya.com/blog/autotask-community-live-2026-recap/).

Infrastructure references:

- Tailscale Funnel is for public internet sharing; Tailscale Serve is the private tailnet path. Source: [Tailscale Funnel docs](https://tailscale.com/docs/features/tailscale-funnel).
- Caddy is a simple production reverse proxy with automatic HTTPS when a hostname is configured. Source: [Caddy reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy).
- PostgreSQL backups need a clear, rehearsed backup and restore approach. Source: [PostgreSQL Backup and Restore](https://www.postgresql.org/docs/16/backup.html).
- DigitalOcean Droplets are per-second billed VMs and a straightforward VPS baseline. Source: [DigitalOcean Droplet pricing docs](https://docs.digitalocean.com/products/droplets/details/pricing/).
- Fly.io is usage-priced and useful later for regional app deployment, but it is less straightforward than a single VPS for the first managed MSP install. Source: [Fly.io resource pricing](https://fly.io/docs/about/pricing/).

## Repo Starting Point

AgentDash already has useful launch pieces:

- `doc/LAUNCH.md` covers the current cloud container path: Dockerfile, external Postgres, authenticated mode, Stripe, Resend, LLM adapter env, and smoke tests.
- `doc/DEPLOYMENT-MODES.md` defines `local_trusted` vs `authenticated`, plus private/public exposure and tailnet binding.
- `doc/DOCKER.md` documents Docker, Compose, full-stack Postgres, authenticated compose, and systemd/Podman Quadlet patterns.
- `doc/DATABASE.md` documents logical database backup scope and explicitly notes that non-database files and the secrets master key require separate backup.
- `doc/billing-roadmap.md` says the current Stripe plumbing is mostly backend-complete but framed around `free`, `pro_trial`, and `pro_active`.
- `doc/plans/2026-03-14-billing-ledger-and-reporting.md` already separates provider cost events from account-level financial events. Work/value billing should build beside that ledger, not overload model-cost accounting.

## Deployment Strategy

### Recommendation

Use this sequence:

1. Mac mini private pilot for the first design partner if already committed.
2. Managed single-tenant VPS for the next production deployment.
3. Managed single-tenant cloud container for repeatability.
4. Multi-tenant AgentDash Cloud only after workflow, support, security, and billing are proven.

The reason is operational trust. MSPs handle tickets, endpoint data, documentation, client names, backup status, and security context. Single-tenant deployments make data boundaries easier to explain and support while we are still learning the product and pricing model.

### P0: Managed VPS Shape

Default VPS architecture:

- Ubuntu LTS host.
- One AgentDash instance per MSP.
- Docker Compose or systemd-managed container.
- Postgres 17 either as a managed database or a colocated container for design partners with explicit backup evidence.
- Caddy on the VPS for HTTPS reverse proxy when public access is needed.
- Tailscale on the VPS for private support access and partner access.
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`.
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private` for Tailscale-only deployments, `public` only after hardening review.
- `PAPERCLIP_PUBLIC_URL` set to the customer-visible URL.
- Env file mode `600`; no secrets in git remotes, logs, or screenshots.
- Backups for database, uploads, workspace files, and the local encrypted secrets master key.

Recommended provider default:

- Start with DigitalOcean or AWS Lightsail for US design partners because they are simple, support predictable small-instance operations, and are easy to hand off.
- Use Hetzner only when price/performance matters more than US-first support expectations.
- Do not use a GPU VPS. Agent execution is orchestration and external-model/API/CLI work, not local model inference.

### P0: VPS Release Flow

1. PR merges to `main` after CI and launch-signoff checks.
2. GitHub Actions builds and publishes an image tagged by commit SHA.
3. VPS pulls the pinned SHA image.
4. Pre-deploy backup runs.
5. Container restarts.
6. `/api/health` and authenticated login proof pass.
7. Readiness script passes with zero failures.
8. Rollback command remains available against the previous image tag and database backup.

No manual rsync, no editing production source files in place, and no deploy from an unreviewed local branch.

### OTA Update Reality Check

Current repo capability is only partial:

- `.github/workflows/docker.yml` builds and pushes multi-arch Docker images to GHCR on `main`/`master` pushes and `v*` tags. Tags include `latest`, semver tags, and `sha-*` tags.
- `.github/workflows/release.yml` publishes npm canary/stable packages and GitHub releases, but it does not deploy customer instances.
- `.github/workflows/release-smoke.yml` can smoke-test a published npm dist-tag inside Docker, but it does not update a remote host.
- `docker/docker-compose.yml` currently builds from local source instead of pulling a pinned GHCR image, so it is not yet an OTA deployment compose file.
- `docker/launchd/install.sh` builds locally and rsyncs artifacts into `/usr/local/share/agentdash`; that is useful for Mac mini service install, but it is not a repeatable OTA update mechanism.

So the answer is: AgentDash has the artifact publishing foundation for OTA, but it does **not** yet have true over-the-air update capability for VPS, Mac mini, or managed cloud installs.

P0 OTA requirements:

1. Publish every launch-candidate image by immutable commit SHA.
2. Add a production compose/systemd/launchd deployment path that consumes `ghcr.io/<owner>/<repo>:sha-<commit>` instead of building locally.
3. Add a host-side updater script:
   - verify target SHA exists in GHCR
   - run database and instance-file backup
   - write/update the pinned image SHA
   - pull image
   - restart service
   - run `/api/health`
   - run authenticated readiness proof
   - write a deploy receipt with previous SHA, new SHA, backup id, timestamp, and operator
4. Add rollback:
   - restore previous pinned image SHA
   - restart service
   - verify health
   - optionally restore DB backup only for destructive migration failures
5. Add a protected GitHub Actions deploy workflow:
   - manual `workflow_dispatch`
   - target environment selection (`design_partner_mac_mini`, `vps_staging`, `vps_production`)
   - required GitHub Environment approval for production
   - connects through Tailscale SSH, a self-hosted runner inside the tailnet, or a pull-based agent on the host
   - never stores raw SSH keys or customer secrets in repo files

Preferred first implementation: pull-based host updater. The customer host periodically or manually runs an authenticated updater that asks AgentDash for the approved target SHA, then performs backup/restart/health locally. This avoids opening SSH inbound to every customer machine and works for both Mac mini and VPS.

### P0: Agent Harness Reliability

OTA and deployment reliability are necessary but not sufficient. The highest-risk week-one failure mode is that a customer onboards, creates their own agents, launches real work, and then sees opaque harness errors: missing credentials, unavailable adapters, bad workspace permissions, model/rate-limit failures, stale active runs, or recovery-noise issues. If the operator cannot tell whether the problem is setup, customer configuration, model provider, adapter harness, or AgentDash itself, the product will feel unreliable even if the app server is healthy.

Treat agent harness reliability as part of launch readiness:

1. Add preflight validation before a customer-created agent can run:
   - adapter installed and enabled
   - CLI/API credentials present
   - model/provider reachable
   - workspace path exists and is writable
   - environment bindings/secrets resolve
   - network and rate-limit posture are known
2. Classify run failures into customer-actionable categories:
   - missing credential
   - adapter not installed
   - rate limited
   - permission denied
   - workspace unavailable
   - model unavailable
   - timeout
   - AgentDash product bug
3. Surface guided recovery actions:
   - retry
   - pause agent
   - open credential setup
   - switch adapter/model
   - attach logs only with consent
   - escalate to Support Watch
4. Add first-run smoke coverage for each supported adapter: create or select a simple task, run the assigned agent, verify a concrete reply, and confirm no recovery-noise issues were created.
5. Monitor failure rate by adapter, company, host, and error category. Support Watch should alert on failure clusters before the customer has to explain that agents "just don't work."

This should be tracked as launch-blocking work, not polish.

### P1: Managed Single-Tenant Cloud

After the first VPS deployment is stable, package the same model as "AgentDash Managed Cloud":

- One app/container per customer.
- One Postgres database per customer.
- One object storage bucket/path per customer.
- One DNS hostname per customer.
- Shared AgentDash billing/entitlement service outside customer instances.
- Central monitoring, release inventory, and support metadata controlled by AgentDash.

This is cloud, but not classic multi-tenant SaaS. It keeps customer data separation and makes onboarding repeatable.

### P2: Multi-Tenant Cloud

Only move to multi-tenant once these are proven:

- tenant isolation tests around every company-scoped API
- audit logging for support impersonation and access consent
- SSO/SAML or at least stronger org auth
- mature backup/restore by tenant
- usage and work/value ledger correctness
- support workflow and incident process

Multi-tenant cloud is a scale optimization, not the next launch blocker.

## Pricing Model

### Positioning

Do not sell "AgentDash seats." Sell the managed operating layer for customer-created AI workforces.

The old subscription can remain as an entitlement and billing container, but the economic unit should be one of:

- a managed deployment: private instance, updates, monitoring, backups, and support
- an orchestration transaction: AgentDash launched, tracked, recovered, reviewed, or governed an agent work cycle
- a governed action: a human approved an agent-proposed action through AgentDash
- an accepted work product: a customer-created agent produced a deliverable that a human accepted
- a customer-defined value event: the customer configures what "valuable work" means for their own agents

The key is not charging for noisy agent activity. Do not bill for raw runs, failed attempts, recovery issues, duplicate comments, hallucinated recommendations, or outputs rejected by the operator.

### Recommended Initial Commercial Package

For the first MSP design partner:

- One-time launch deposit: `$500-$1,500`
  - covers real setup work but is credited against the first 60 days of platform/work usage
  - keeps the pilot paid without asking the customer to accept mature-contract pricing on day one
- Month 1 instrumented pilot: activity-driven with a customer-friendly cap
  - no `$1,500+` platform minimum in month one
  - charge only for active managed agents, governed runs, accepted work products, approved actions, and support-assisted recovery
  - cap month-one billing at `$500-$1,000` unless the customer explicitly opts into higher volume
- Month 2 value calibration: small committed minimum
  - `$500-$1,000` minimum, credited toward activity/value usage
  - use this month to define the customer's accepted-work and value-event rules
- Month 3+ production: earned platform/work commitment
  - graduate to `$1,500-$3,000` monthly minimum only after the customer has working agents, visible accepted work, and a mutually understood value ledger
- Overage: bill by generic control-plane unit or customer-defined value event after included credits are exhausted
- Week-one rule: human-reviewed outputs only; no direct PSA/RMM writes without approval

This gives the customer a low-risk ramp while still making the pilot commercially real. AgentDash earns the larger recurring commitment by proving that the control plane can create inspectable, accepted work.

### Pricing Ramp

The ramp should move from activity-priced to value-priced as evidence improves:

| Stage | Timing | Commercial model | Graduation signal |
|---|---|---|---|
| Setup | pre-launch through week 1 | small credited launch deposit | authenticated instance running, first customer-created agents configured |
| Instrumented pilot | month 1 | pay for platform activity, capped | agents complete governed runs and operators start accepting/rejecting work |
| Value calibration | month 2 | small monthly minimum plus activity/value credits | customer-defined value-event rules are agreed and visible in reports |
| Production | month 3+ | monthly minimum work-credit commitment plus overage | accepted-work rate and support burden justify managed production pricing |

Do not require a high monthly minimum before the customer has evidence. Use caps and credits to remove budget fear:

- month-one cap protects the customer from runaway agent activity
- launch deposit credits protect the customer from feeling double-charged for setup
- accepted-work and customer-defined value events become billable only after the operator can inspect and dispute them
- high-touch support is included during the ramp, but repeated support-assisted recovery should be separately visible so AgentDash understands margin

### Ramp Unit Schedule

Use lower prices in month one because the value model is still being calibrated:

| Unit | Month 1 pilot price | Production target |
|---|---:|---:|
| Active managed agent | `$10-$25/agent/mo` | `$25-$100/agent/mo` |
| Governed run | `$0.05-$0.25` | `$0.10-$1.00` |
| Human-reviewed work product | `$0.50-$2.00` | `$1.00-$10.00` |
| Governed external action | `$2.00-$10.00` | `$2.00-$25.00` |
| Customer-defined value event | not billed until defined | customer-specific price code |
| Managed instance | included during ramp | included in minimum or `$500-$1,500/mo` |

### Control-Plane Unit Schedule

Use this as the production target price card after the ramp. Treat it as a learning schedule, not final packaging. These are generic AgentDash units, not MSP workflow SKUs.

| Unit | Billable event | Initial price |
|---|---|---:|
| Managed instance | private VPS/cloud instance operated by AgentDash for one month | included in minimum or `$500-$1,500/mo` |
| Active managed agent | customer-created agent enabled for scheduled/manual runs during the billing month | included pool, then `$25-$100/agent/mo` |
| Governed run | agent run completes with trace, summary, artifact/comment, and no recovery failure | `$0.10-$1.00` |
| Human-reviewed work product | an operator marks an agent-created comment, document, issue plan, export, or artifact as accepted | `$1.00-$10.00` |
| Governed external action | an operator approves an agent-proposed action that AgentDash records as executed or ready for execution | `$2.00-$25.00` |
| Support-assisted recovery | AgentDash support/watch agent resolves or escalates an install/runtime failure | included up to SLA, then support-rate based |

The pricing page should avoid promising vertical outcomes until AgentDash ships first-party workflow packs. MSP examples can still be used in sales discovery, but they should be framed as customer-created agent use cases, not AgentDash-billed SKUs.

### Billability Rules

Every billable value event needs:

- company id
- customer/client id when applicable
- source issue/ticket id
- agent id
- workflow type
- customer-defined value-event type
- evidence links
- human approver or confirmation rule
- accepted/rejected state
- correction/reopen window
- price code and price at time of event
- model/provider cost allocation where available

Recommended billability definitions:

- Governed run: bill only when the run finishes cleanly and creates a durable AgentDash record.
- Human-reviewed work product: bill only when the operator explicitly accepts it or uses it in a governed handoff.
- Governed external action: bill only when the operator approves it and AgentDash records the execution/handoff evidence.
- Customer-defined value event: bill only when the customer's configured acceptance rule is satisfied.

Add a dispute path: every value event can be reversed/credited if the operator marks it wrong inside the correction window.

## Product Changes Required

### P0

- Add a generic `value_events` or `work_events` ledger separate from `cost_events`.
- Add price codes and immutable price snapshots for control-plane units.
- Add accepted/rejected/credited state transitions.
- Attach value events to issues, comments, agent runs, customer/client labels, and optional external ids.
- Add a first usage report: governed runs, accepted work products, approved actions, rejected/credited events, model cost, estimated time saved, and estimated gross margin.
- Add an internal admin way to mark a company as `managed_pilot` and record the monthly platform/work commitment.
- Add ramp controls: credited launch deposit, monthly cap, included credits, and stage (`setup`, `instrumented_pilot`, `value_calibration`, `production`).
- Keep Stripe for payment links and invoices, but do not depend on Stripe webhooks reaching a private customer instance.
- Add customer-visible "Work Ledger" or "Value Delivered" view before charging overages.
- Add agent harness preflights, failure classification, guided recovery actions, and Support Watch escalation for failed runs.
- Add launch-signoff coverage for one real customer-created agent run on the target host.

### P1

- Sync entitlements from an AgentDash-owned billing service into private installs.
- Add Stripe metered usage or invoice item generation from approved value events.
- Add per-company price-code configuration.
- Add monthly customer value report PDF/export.
- Add value-event dispute/credit workflow.
- Add support-watch alerts for abnormal rejection rate, cost spikes, and low accepted-output ratio.

### P2

- Add customer self-serve checkout for managed cloud.
- Add annual committed work-credit packages.
- Add optional partner-specific workflow packs for ConnectWise, Autotask, HaloPSA, Slack, Teams, and Google Chat only if AgentDash chooses to sell first-party templates later.
- Add multi-tenant usage isolation and invoice consolidation if the cloud model moves beyond single-tenant.

## Implementation Backlog

### Deployment

1. Create `doc/VPS-DEPLOYMENT.md` from the current launch docs with:
   - VPS provisioning checklist
   - DNS and Tailscale modes
   - Caddy config
   - Docker Compose/systemd service
   - backup and rollback commands
   - readiness evidence checklist
2. Add a VPS readiness script that checks:
   - authenticated health
   - allowed hostnames
   - env file permissions
   - backup target existence
   - latest backup age
   - service restart policy
   - disk free space
   - current git/image SHA
3. Convert production compose/systemd/launchd paths to consume pinned GHCR SHA images where possible.
4. Add a host-side OTA updater with backup, pull, restart, health proof, deploy receipt, and rollback.
5. Add a protected GitHub Actions workflow or pull-based update service to approve target SHAs per customer environment.
6. Add release inventory: customer, environment, SHA, deploy time, backup id, rollback id.

### Agent Harness

1. Add adapter/runtime preflight checks for customer-created agents.
2. Add structured failure categories and map existing adapter errors into them.
3. Add UI recovery actions for retry, pause, credential setup, adapter/model switch, consented log bundle, and support escalation.
4. Add launch-signoff smoke for at least one assigned issue run per supported adapter on the target host.
5. Add Support Watch alerts for failed-run rate, stale active runs, repeated rate limits, repeated credential failures, and recovery-noise issue creation.

### Pricing And Billing

1. Design `value_events` or `work_events` schema.
2. Add service APIs for creating, accepting, rejecting, crediting, and listing value events.
3. Add UI for work review and monthly value report.
4. Add price-code config.
5. Add Stripe payment-link/invoice workflow for the pilot.
6. Later, add private-install entitlement pull from AgentDash billing service.

### Customer-Created Agent Validation

1. Validate that customers can create agents, assign goals/projects/tasks, run them, review outputs, and accept or reject work products.
2. Use MSP use cases such as ticket triage, QBR/TBR generation, security/access findings, and billing analysis as discovery examples, not first-party SKUs.
3. If a design partner creates a repeatable workflow, capture its acceptance criteria as a customer-defined value-event rule.
4. Avoid direct PSA/RMM writes until accepted-output quality and approval gates are proven.

## Launch Decision

The practical launch path is:

- Keep the first design partner private and high-touch.
- Deploy the next customer on a managed single-tenant VPS instead of a public multi-tenant SaaS.
- Build generic work/value metering now, even if first invoices are manually generated from the ledger.
- Start with a low-risk paid ramp: credited setup deposit, month-one capped activity pricing, month-two value calibration, then a production minimum only after accepted work exists.
- Charge a minimum platform/work commitment in production, not seats.
- Treat customer-defined value events and correction windows as product features. If the customer cannot audit why they were billed, the pricing model will fail.
