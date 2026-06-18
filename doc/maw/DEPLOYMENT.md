# Deployment Guide

> Multi-Agent-Workflow v6 -- Environment architecture, staging, production promotion, decentralized deployment, and OTA updates.

---

## 1. Environment Architecture

AgentDash operates across five environment tiers. Each tier has distinct infrastructure, data isolation, and access controls.

| Environment | Infrastructure | Database | Deploy Trigger | Access |
|-------------|---------------|----------|----------------|--------|
| **Development** | localhost:3100 | Embedded PG (`~/.paperclip/instances/default/db/`) | Manual (`pnpm dev`) | Developer only |
| **CI** | GitHub Actions runners | Ephemeral (per-run) | PR open/push | Automated |
| **Staging** | Mirrors production config | Separate DB, seeded test data | Auto on merge to `main` | Team + stakeholders |
| **Production** | Same infra as staging, different secrets | Production DB | Manual promote (or auto for XS/S) | End users |
| **Edge** | Client-managed (Mac minis, VPS, cloud, self-hosted) | Instance-local DB | OTA pull from release registry | Per-client |

### Data Isolation

Every environment has its own database, secrets, and API keys. Production data never flows to staging or development. Staging uses seeded test data that mirrors production schemas without real user content.

### Secret Management

- **Development**: `.env` file (git-ignored), `AGENTDASH_BILLING_DISABLED=true` for billing bypass
- **CI**: GitHub Actions secrets
- **Staging / Production**: Platform-native secret stores (environment variables injected at deploy time)
- **Edge**: Instance-local `.env` provisioned during onboarding, rotated via the admin channel

---

## 2. Staging Environment

Staging is the verification gate between code merge and production. It runs identical configuration to production with separate secrets and isolated data.

### Auto-Deploy on Merge

When a PR merges to `main`:

1. GitHub Actions builds production artifacts from the merge commit.
2. Artifacts deploy to the staging environment.
3. The staging smoke test suite runs automatically.
4. Results post as a commit status on the merge commit.

### Staging Properties

- **URL**: Accessible at the configured staging URL for manual verification.
- **Config parity**: Same runtime flags, feature gates, and service topology as production. Only secrets and database endpoints differ.
- **Seeded data**: Pre-populated with representative test data (workspaces, agents, conversations, billing states) to exercise all code paths.
- **Ephemeral on request**: Staging data can be reset to the seed state via `/admin reset-staging` without affecting production.

### Smoke Test Suite

The automated smoke suite validates critical paths after every staging deploy:

- Health endpoint responds with 200
- Database migrations applied successfully
- WebSocket connections establish and maintain heartbeat
- CoS chat round-trip completes (send message, receive response)
- Agent creation and task assignment cycle
- Billing webhook endpoint accepts test events
- Authentication flow (login, session, logout)

Failures block production promotion and notify the team.

---

## 3. Production Promotion

### Standard Promotion (`/tpm promote`)

The TPM agent controls production promotion. Running `/tpm promote` initiates the following sequence:

**Prerequisites (all must pass):**
- Staging smoke tests are green on the current `main` HEAD
- No issues in `Blocked` status in the current cycle
- No active incident flags

**Promotion Steps:**

```
1. Tag release on main
   └── Format: vYYYY.MM.DD (or vYYYY.MM.DD.N for same-day releases)

2. Build production artifacts
   └── Deterministic build from the tagged commit
   └── Generate checksums (SHA-256)
   └── Sign artifacts with release signing key

3. Deploy to production infrastructure
   └── Blue-green swap: new version starts alongside current
   └── Traffic shifts after health check passes

4. Run production smoke tests
   └── Same suite as staging, against production endpoints
   └── Includes canary traffic validation (5-minute window)

5a. If pass: mark release as stable
    └── Update /releases/latest.json in the OTA registry
    └── Clean up previous blue-green slot
    └── Post release notification to the team

5b. If fail: auto-rollback to previous stable release
    └── Swap traffic back to previous version
    └── Post incident alert
    └── Tag the release as failed in the registry
```

### Auto-Promotion for XS/S Changes

Issues sized XS or S that pass local tests and staging smoke are eligible for auto-promotion without human verification. The TPM agent handles this automatically during `/tpm sync`. M+ issues always require explicit `/tpm promote` with human sign-off.

### Rollback

Production rollback is immediate (blue-green swap back):

```sh
/admin rollback production        # Revert to previous stable release
/admin rollback production v2026.05.28  # Revert to a specific version
```

Rollback triggers an automatic incident report and blocks further promotions until the team resolves the issue.

---

## 4. Decentralized Deployment Model

AgentDash is designed to run on diverse infrastructure. Each deployment is a standalone instance with its own database, secrets, and runtime -- connected to the central release registry for updates.

### Supported Platforms

| Platform | Example | Notes |
|----------|---------|-------|
| **Client Mac minis** | On-premise at client offices | ARM64, launchd service |
| **VPS instances** | DigitalOcean, Hetzner, Linode | Docker or bare metal |
| **Cloud platforms** | Railway, Fly.io, Render | Platform-native deploy |
| **Managed cloud** | AWS ECS/EKS, GCP Cloud Run | Container orchestration |
| **Self-hosted** | Client Kubernetes clusters | Helm chart provided |

### Instance Independence

Each instance is fully self-contained:

- Own PostgreSQL database (no shared state across instances)
- Own environment configuration and secrets
- Own user base and workspace data
- Independent uptime -- other instances going down has no effect

The only shared dependency is the central release registry for OTA updates, and even that is optional (instances can be updated manually).

### First Boot

On first boot, a new instance:

1. Runs database migrations to initialize the schema.
2. Registers with the central release registry (if configured).
3. Enters `local_trusted` deployment mode for the founding user.
4. Provisions the default workspace and CoS agent.

---

## 5. OTA Update System

### Architecture

```
Central Release Registry
  |
  +-- /releases/latest.json          Current version manifest
  |
  +-- /releases/vYYYY.MM.DD/         Per-release directory
  |     +-- manifest.json            Version, checksum, changelog, min-compatible-version
  |     +-- agentdash.tar.gz         Application bundle
  |     +-- agentdash.tar.gz.sig     Ed25519 signature
  |
  +-- /channels/
  |     +-- stable.json              Points to latest stable release
  |     +-- beta.json                Points to latest beta release
  |     +-- canary.json              Points to latest canary release
  |
  +-- /instances/                    Instance registration and status
        +-- {instance_id}.json       Per-instance state
```

### Pull-Based Model

Edge instances poll the registry on a configurable interval (default: every 15 minutes). Updates are pull-only -- the registry never pushes to instances.

**Update Cycle:**

```
1. GET /channels/{channel}.json
   └── Returns: { "version": "vYYYY.MM.DD", "manifest_url": "..." }

2. Compare with current running version
   └── If same: no action, log checkin
   └── If newer: proceed to step 3

3. Download artifact
   └── GET /releases/vYYYY.MM.DD/agentdash.tar.gz
   └── GET /releases/vYYYY.MM.DD/agentdash.tar.gz.sig

4. Verify integrity
   └── Validate SHA-256 checksum from manifest
   └── Verify Ed25519 signature against pinned public key
   └── Check min-compatible-version (skip if current DB is too old)

5. Apply update (blue-green local deploy)
   a. Extract to staging directory (/opt/agentdash/next/)
   b. Run pre-update health check (DB compatibility, disk space, config)
   c. Run database migrations in a transaction
   d. Swap symlink: /opt/agentdash/current -> /opt/agentdash/next/
   e. Restart the application process
   f. Run post-update health check (HTTP 200, DB connected, WS alive)
   g. If healthy: move old version to /opt/agentdash/previous/, clean up
   h. If unhealthy: swap symlink back, rollback migrations, report failure
```

### Instance Registration

Each edge instance registers with the registry on first boot and checks in on every poll cycle:

```json
{
  "instance_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "client-office-mac-mini",
  "platform": "darwin-arm64",
  "current_version": "v2026.06.01",
  "last_checkin": "2026-06-01T12:00:00Z",
  "health": "healthy",
  "auto_update": true,
  "update_channel": "stable",
  "update_interval_minutes": 15,
  "capabilities": {
    "gpu": false,
    "memory_gb": 16,
    "disk_free_gb": 45
  }
}
```

Registration is optional. Unregistered instances can still pull updates anonymously -- they just do not appear in the admin dashboard.

### Update Channels

| Channel | Description | Audience |
|---------|-------------|----------|
| **stable** | Production-promoted releases only | All production instances (default) |
| **beta** | Staging-verified, not yet production-promoted | Internal testing, willing early adopters |
| **canary** | Specific instances receive updates first | Designated canary instances for phased rollout |

Channel assignment is per-instance and can be changed via the admin dashboard or `/admin set-channel <instance> <channel>`.

### Canary Rollout Strategy

For high-risk releases, the TPM can use a phased canary rollout:

1. Publish release to the `canary` channel.
2. Canary instances pick it up on their next poll cycle.
3. Monitor canary instance health for a configurable soak period (default: 2 hours).
4. If healthy: promote to `beta`, then `stable` after another soak period.
5. If unhealthy: hold the release, investigate, and canary instances auto-rollback.

### Rollback

Each instance retains the previous version for instant rollback:

- **Automatic**: Post-update health check fails -- the instance swaps back without intervention.
- **Manual (per-instance)**: `/admin rollback <instance>` triggers the instance to revert on next checkin.
- **Manual (fleet-wide)**: `/admin rollback all` reverts every instance to the previous stable release.

Rollback events are logged in the registry and surfaced in the admin dashboard.

---

## 6. GitHub Actions Integration

### CI Pipeline (on every PR)

Triggered on: `pull_request` to `main`

```yaml
jobs:
  ci:
    steps:
      - pnpm install
      - pnpm -r typecheck          # Type-check all packages
      - pnpm lint                   # Lint (ESLint)
      - pnpm test:run               # Unit + integration tests
      - pnpm build                  # Build all packages
      - npm audit --audit-level=moderate  # Security audit
      # Results post as PR status checks
```

All checks must pass before merge. No manual overrides.

### Deploy to Staging (on merge to main)

Triggered on: `push` to `main`

```yaml
jobs:
  deploy-staging:
    steps:
      - Build production artifacts (deterministic, from merge commit)
      - Deploy to staging infrastructure
      - Wait for staging to become healthy
      - Run staging smoke test suite
      - Post commit status: staging-deploy (pass/fail)
      - If fail: alert team, block future promotions until resolved
```

### Promote to Production (manual trigger or /tpm promote)

Triggered on: `workflow_dispatch` or via the TPM agent

```yaml
jobs:
  promote-production:
    steps:
      - Verify staging smoke tests green on HEAD
      - Verify no Blocked issues in current cycle
      - Tag release (vYYYY.MM.DD)
      - Build production artifacts from tag
      - Sign artifacts (Ed25519)
      - Generate checksums (SHA-256)
      - Deploy to production (blue-green)
      - Run production smoke tests
      - If pass:
          - Mark release stable
          - Publish to OTA registry (/releases/latest.json)
          - Post release notification
      - If fail:
          - Auto-rollback production
          - Post incident alert
          - Mark release as failed in registry
```

### Publish to OTA Registry (post-production)

After a successful production promotion:

```yaml
jobs:
  publish-ota:
    steps:
      - Upload agentdash.tar.gz to release registry
      - Upload agentdash.tar.gz.sig (signature)
      - Write manifest.json (version, checksum, changelog, min-compatible-version)
      - Update /channels/stable.json to point to new release
      - Edge instances pick up the update on their next poll cycle
```

---

## Quick Reference

| Action | Command | Who |
|--------|---------|-----|
| Run locally | `pnpm dev` | Developer |
| Run CI checks | Automatic on PR | GitHub Actions |
| Deploy to staging | Automatic on merge to `main` | GitHub Actions |
| Promote to production | `/tpm promote` | TPM agent |
| Rollback production | `/admin rollback production` | Admin agent |
| Rollback an edge instance | `/admin rollback <instance>` | Admin agent |
| Change instance update channel | `/admin set-channel <instance> <channel>` | Admin agent |
| Reset staging data | `/admin reset-staging` | Admin agent |
| Check instance fleet status | `/admin fleet-status` | Admin agent |
