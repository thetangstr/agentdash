# CI/CD Pipeline

This document describes the continuous integration and deployment pipeline for
AgentDash under MAW v6. Every PR, merge, and production deploy follows these
workflows. Agents interact with CI through GitHub Actions status checks and the
`gh` CLI -- no manual dashboard clicking required.

---

## 1. Pipeline Overview

```
PR Push
  |
  v
GitHub Actions CI (ci.yml)
  |-- Typecheck all packages
  |-- Run unit tests (JUnit XML)
  |-- Build all packages
  |-- Post status to PR checks
  |
  v
Agent reads result via `gh pr checks`
  |-- CI-Passing label set by Orchestrator on green
  |-- CI-Failing label set by Orchestrator on red; Builder auto-fixes
  |
  v
Merge to main
  |
  v
deploy-staging.yml
  |-- Build production artifacts
  |-- Deploy to staging
  |-- Run staging smoke tests
  |-- Report results (Staging-Deployed / Staging-Verified labels)
  |
  v
/tpm promote (manual trigger)
  |
  v
deploy-production.yml
  |-- Tag release
  |-- Build + sign production artifacts
  |-- Deploy to production
  |-- Run production smoke tests
  |-- On pass: publish OTA manifest (Production-Deployed / OTA-Pushed labels)
  |-- On fail: auto-rollback to previous release
```

---

## 2. GitHub Actions Workflows

### 2.1 ci.yml -- On every PR push

Runs on every push to a PR branch. This is the gate that agents poll before
advancing an issue through the pipeline.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm -r typecheck

      - name: Unit tests
        run: pnpm test:run -- --reporter=junit --outputFile=test-results/junit.xml

      - name: Build
        run: pnpm build

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: test-results/
          retention-days: 30
```

**What agents see:** The Builder and Orchestrator poll `gh pr checks <pr-number>`
after pushing. A green check means the Orchestrator applies `CI-Passing`. A red
check means the Orchestrator applies `CI-Failing` and re-dispatches the Builder
for a fix attempt (max 2 retries per the protocol in [protocol.md](./protocol.md)).

---

### 2.2 deploy-staging.yml -- On merge to main

Triggered automatically when a PR merges to `main`. Builds production artifacts,
deploys them to the staging environment, and runs smoke tests.

```yaml
# .github/workflows/deploy-staging.yml
name: Deploy Staging

on:
  push:
    branches: [main]

concurrency:
  group: deploy-staging
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build production artifacts
        run: pnpm build
        env:
          NODE_ENV: production

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-${{ github.sha }}
          path: |
            server/dist/
            ui/dist/
            cli/dist/
          retention-days: 90

  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: staging
    steps:
      - name: Download build artifacts
        uses: actions/download-artifact@v4
        with:
          name: build-${{ github.sha }}

      - name: Deploy to staging
        run: |
          # Platform-specific deploy command.
          # Replace with your deployment target (Railway, Fly, Render, etc.)
          echo "Deploying build ${{ github.sha }} to staging..."
        env:
          DEPLOY_TOKEN: ${{ secrets.STAGING_DEPLOY_TOKEN }}
          DEPLOY_TARGET: ${{ vars.STAGING_URL }}

  smoke-test:
    needs: deploy
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run staging smoke tests
        run: |
          STAGING_URL="${{ vars.STAGING_URL }}"
          # Health check
          curl --fail --retry 5 --retry-delay 5 "$STAGING_URL/api/health"
          # API smoke
          curl --fail "$STAGING_URL/api/v1/status"
        env:
          STAGING_URL: ${{ vars.STAGING_URL }}

      - name: Report result
        if: always()
        run: |
          if [ "${{ job.status }}" = "success" ]; then
            echo "Staging smoke tests passed."
          else
            echo "::error::Staging smoke tests failed. Check logs above."
          fi
```

**Label transitions:** On success, the TPM agent (or Orchestrator) sets
`Staging-Deployed` and `Staging-Verified` on the associated Linear issue. On
failure, the TPM is notified and the issue does not advance.

---

### 2.3 deploy-production.yml -- Manual trigger

Production deploys are triggered by the TPM agent via `/tpm promote` or by a
human through the GitHub Actions UI. This workflow tags the release, builds
signed artifacts, deploys, runs smoke tests, and publishes the OTA manifest.

```yaml
# .github/workflows/deploy-production.yml
name: Deploy Production

on:
  workflow_dispatch:
    inputs:
      release_tag:
        description: "Release tag (e.g. v2.4.1)"
        required: true
        type: string
      rollback_tag:
        description: "Tag to rollback to on failure (e.g. v2.4.0)"
        required: true
        type: string

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  tag:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Create release tag
        run: |
          git tag "${{ inputs.release_tag }}"
          git push origin "${{ inputs.release_tag }}"

  build:
    needs: tag
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.release_tag }}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build
        env:
          NODE_ENV: production

      - name: Sign artifacts
        run: |
          echo "$OTA_SIGNING_KEY" > /tmp/signing-key.pem
          # Generate checksums and sign with Ed25519
          find server/dist ui/dist cli/dist -type f -exec sha256sum {} \; > checksums.txt
          openssl pkeyutl -sign \
            -inkey /tmp/signing-key.pem \
            -rawin \
            -in checksums.txt \
            -out checksums.sig
          rm /tmp/signing-key.pem
        env:
          OTA_SIGNING_KEY: ${{ secrets.OTA_SIGNING_KEY }}

      - name: Upload signed artifacts
        uses: actions/upload-artifact@v4
        with:
          name: production-${{ inputs.release_tag }}
          path: |
            server/dist/
            ui/dist/
            cli/dist/
            checksums.txt
            checksums.sig
          retention-days: 365

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ inputs.release_tag }}
          files: |
            checksums.txt
            checksums.sig

  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: production
    steps:
      - name: Download signed artifacts
        uses: actions/download-artifact@v4
        with:
          name: production-${{ inputs.release_tag }}

      - name: Deploy to production
        run: |
          echo "Deploying ${{ inputs.release_tag }} to production..."
        env:
          DEPLOY_TOKEN: ${{ secrets.PRODUCTION_DEPLOY_TOKEN }}
          DEPLOY_TARGET: ${{ vars.PRODUCTION_URL }}

  smoke-test:
    needs: deploy
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.release_tag }}

      - name: Run production smoke tests
        run: |
          PROD_URL="${{ vars.PRODUCTION_URL }}"
          curl --fail --retry 5 --retry-delay 5 "$PROD_URL/api/health"
          curl --fail "$PROD_URL/api/v1/status"
        env:
          PRODUCTION_URL: ${{ vars.PRODUCTION_URL }}

  rollback:
    needs: smoke-test
    if: failure()
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Rollback to previous release
        run: |
          echo "::error::Smoke tests failed. Rolling back to ${{ inputs.rollback_tag }}."
          # Trigger a re-deploy of the previous good release.
          gh workflow run deploy-production.yml \
            -f release_tag="${{ inputs.rollback_tag }}" \
            -f rollback_tag="${{ inputs.rollback_tag }}"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  publish-ota:
    needs: smoke-test
    if: success()
    runs-on: ubuntu-latest
    steps:
      - name: Publish OTA manifest
        run: |
          # Upload OTA manifest to the release registry (S3/R2/GCS).
          # Edge instances poll this manifest to self-update.
          echo '{
            "version": "${{ inputs.release_tag }}",
            "sha": "${{ github.sha }}",
            "checksums_url": "https://github.com/${{ github.repository }}/releases/download/${{ inputs.release_tag }}/checksums.txt",
            "signature_url": "https://github.com/${{ github.repository }}/releases/download/${{ inputs.release_tag }}/checksums.sig",
            "published_at": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
          }' > ota-manifest.json
          echo "Publishing OTA manifest for ${{ inputs.release_tag }}..."
          # Upload to your OTA registry:
          # aws s3 cp ota-manifest.json s3://your-ota-bucket/manifest.json
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.OTA_REGISTRY_ACCESS_KEY }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.OTA_REGISTRY_SECRET_KEY }}
```

---

### 2.4 agent-dispatch.yml -- On Linear webhook (optional)

This optional workflow enables fully autonomous operation. When a Linear issue
label changes (e.g., `PM-Complete` is added), a webhook fires and this workflow
dispatches the appropriate agent.

```yaml
# .github/workflows/agent-dispatch.yml
name: Agent Dispatch

on:
  repository_dispatch:
    types: [linear-webhook]

jobs:
  dispatch:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Parse Linear event
        id: parse
        run: |
          ACTION="${{ github.event.client_payload.action }}"
          ISSUE_ID="${{ github.event.client_payload.issue_id }}"
          LABELS="${{ github.event.client_payload.labels }}"
          echo "action=$ACTION" >> "$GITHUB_OUTPUT"
          echo "issue_id=$ISSUE_ID" >> "$GITHUB_OUTPUT"
          echo "labels=$LABELS" >> "$GITHUB_OUTPUT"

      - name: Determine agent
        id: agent
        run: |
          LABELS="${{ steps.parse.outputs.labels }}"
          if echo "$LABELS" | grep -q "PM-Complete"; then
            echo "agent=builder" >> "$GITHUB_OUTPUT"
          elif echo "$LABELS" | grep -q "Tests-Failed"; then
            echo "agent=builder" >> "$GITHUB_OUTPUT"
          elif echo "$LABELS" | grep -q "CI-Passing"; then
            echo "agent=tester" >> "$GITHUB_OUTPUT"
          elif echo "$LABELS" | grep -q "Merge-Ready"; then
            echo "agent=tpm" >> "$GITHUB_OUTPUT"
          elif echo "$LABELS" | grep -q "Needs-PM"; then
            echo "agent=pm" >> "$GITHUB_OUTPUT"
          else
            echo "agent=none" >> "$GITHUB_OUTPUT"
          fi

      - name: Dispatch agent
        if: steps.agent.outputs.agent != 'none'
        run: |
          echo "Dispatching ${{ steps.agent.outputs.agent }} for ${{ steps.parse.outputs.issue_id }}"
          # Invoke Claude Code agent via your preferred method:
          # - GitHub Actions self-hosted runner with Claude Code installed
          # - API call to an agent orchestration service
          # - Webhook to a long-running agent process
        env:
          AGENT_DISPATCH_TOKEN: ${{ secrets.AGENT_DISPATCH_TOKEN }}
```

**Webhook setup:** Configure a Linear webhook that sends `issueUpdate` events to
`https://api.github.com/repos/<owner>/<repo>/dispatches` with the
`repository_dispatch` event type `linear-webhook`. Include the issue ID and
current labels in the payload.

---

## 3. Agent-CI Integration

Agents interact with CI exclusively through the `gh` CLI and Linear labels. No
agent has direct access to the deployment infrastructure.

### 3.1 Happy-path flow

```
1. Builder pushes to PR branch
2. ci.yml triggers automatically
3. Orchestrator polls:  gh pr checks <pr-number> --watch
4. CI passes  -->  Orchestrator sets CI-Passing label
5. Pipeline advances to Tester
```

### 3.2 Failure-recovery flow

```
1. Builder pushes to PR branch
2. ci.yml triggers automatically
3. Orchestrator polls:  gh pr checks <pr-number> --watch
4. CI fails  -->  Orchestrator sets CI-Failing label
5. Orchestrator re-dispatches Builder with failure context
6. Builder reads failure logs:  gh run view <run-id> --log-failed
7. Builder fixes and pushes again
8. Repeat (max 2 fix attempts, then escalate to human)
```

### 3.3 Useful gh commands for agents

| Command | Purpose |
|---------|---------|
| `gh pr checks <number>` | Read CI status for a PR |
| `gh pr checks <number> --watch` | Block until all checks complete |
| `gh run view <id> --log-failed` | Read failure logs from a specific run |
| `gh run list --branch <branch>` | List recent runs for a branch |
| `gh release create <tag>` | Create a release (used by TPM) |
| `gh workflow run <file> -f key=val` | Trigger a workflow (used by TPM for promote) |

---

## 4. Secrets Management

Secrets are stored in GitHub Actions secrets and environment-scoped variables.
Nothing sensitive is committed to the repository.

### 4.1 Required secrets

| Secret | Scope | Purpose |
|--------|-------|---------|
| `STAGING_DEPLOY_TOKEN` | `staging` environment | Auth for staging deployments |
| `PRODUCTION_DEPLOY_TOKEN` | `production` environment | Auth for production deployments |
| `OTA_SIGNING_KEY` | repository | Ed25519 private key for artifact signing |
| `OTA_REGISTRY_ACCESS_KEY` | repository | S3/R2/GCS access key for OTA manifest |
| `OTA_REGISTRY_SECRET_KEY` | repository | S3/R2/GCS secret key for OTA manifest |
| `AGENT_DISPATCH_TOKEN` | repository | Token for agent dispatch API (optional) |

### 4.2 Required variables

| Variable | Scope | Purpose |
|----------|-------|---------|
| `STAGING_URL` | `staging` environment | Base URL for staging smoke tests |
| `PRODUCTION_URL` | `production` environment | Base URL for production smoke tests |

### 4.3 Generating the OTA signing key

```bash
# Generate Ed25519 private key
openssl genpkey -algorithm Ed25519 -out ota-signing-key.pem

# Extract public key (distribute to edge instances for verification)
openssl pkey -in ota-signing-key.pem -pubout -out ota-signing-key.pub

# Store private key in GitHub Actions secrets as OTA_SIGNING_KEY
cat ota-signing-key.pem | gh secret set OTA_SIGNING_KEY

# Delete local copy of private key
rm ota-signing-key.pem
```

Keep `ota-signing-key.pub` in the repository (it is safe to commit public keys).
Edge instances use this to verify OTA artifact integrity.

### 4.4 .env.example

Document all environment variables in `.env.example` with placeholder values.
Never commit `.env` files. The `.gitignore` already excludes them.

---

## 5. Artifact Management

### 5.1 Build artifacts

- **PR builds:** Stored as GitHub Actions artifacts with 30-day retention.
  Agents never need to download these -- they exist only for debugging failed
  runs.
- **Staging builds:** Stored as GitHub Actions artifacts with 90-day retention.
  Named `build-<sha>` for traceability.
- **Production builds:** Stored as GitHub Releases, tagged with the version.
  Signed checksums are attached to each release. Retained indefinitely.

### 5.2 OTA artifacts

OTA manifests are JSON documents published to a release registry (S3, R2, or
GCS). Edge instances poll the manifest URL on a configurable interval and
self-update when a new version is detected.

**Manifest schema:**

```json
{
  "version": "v2.4.1",
  "sha": "abc123def456",
  "checksums_url": "https://github.com/org/repo/releases/download/v2.4.1/checksums.txt",
  "signature_url": "https://github.com/org/repo/releases/download/v2.4.1/checksums.sig",
  "published_at": "2026-06-01T12:00:00Z"
}
```

**Verification on edge:**

```bash
# Download checksums and signature
curl -sL "$checksums_url" -o checksums.txt
curl -sL "$signature_url" -o checksums.sig

# Verify signature with the public key
openssl pkeyutl -verify \
  -pubin -inkey ota-signing-key.pub \
  -rawin \
  -in checksums.txt \
  -sigfile checksums.sig

# If verification passes, download and apply the update
# If verification fails, reject the update and alert
```

---

## 6. Environment Protection Rules

GitHub environment protection rules enforce the deployment approval chain.

| Environment | Protection | Who can approve |
|-------------|-----------|-----------------|
| `staging` | None (auto-deploy on merge to main) | N/A |
| `production` | Required reviewer | Project owner or TPM agent |

Configure these in **Settings > Environments** in the GitHub repository.

---

## 7. Monitoring and Alerting

Post-deploy monitoring is outside the scope of the CI/CD pipeline itself, but
the pipeline integrates with monitoring at two points:

1. **Smoke tests** -- The staging and production smoke-test jobs act as the
   first line of defense. A failing smoke test prevents label advancement and
   triggers rollback in production.
2. **OTA health check** -- Edge instances report their version and health status
   back to the central API. The Admin agent (`/admin health`) can query this to
   verify that OTA updates have propagated.

For application-level monitoring (error rates, latency, uptime), configure your
observability platform independently and wire alerts to the team's notification
channel.
