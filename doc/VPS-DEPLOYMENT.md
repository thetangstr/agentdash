# Managed VPS Deployment

This is the launch path for a private, single-tenant AgentDash instance on a customer-owned or AgentDash-managed VPS. It is also the model to mirror for a Mac mini behind Tailscale until we have a richer updater service.

## Production Shape

- Ubuntu LTS host or equivalent.
- Docker Engine with Compose v2.
- One AgentDash instance per customer.
- Private access first: Tailscale, VPN, or LAN. Public HTTPS should wait for an explicit hardening review.
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`.
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private` for private-network access.
- `AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true` for launch-mode agent-run gating.
- Env files mode `600`.
- Updates consume pinned GHCR SHA images, not local source builds or floating `latest`.
- Every update writes a deploy receipt and has a previous-image rollback pointer.

## Files

- `docker/docker-compose.production.yml` runs Postgres 17 plus the AgentDash server from `AGENTDASH_IMAGE`.
- `scripts/deploy/agentdash-ota-update.mjs` pins an image, runs backup, pulls, restarts, checks health, optionally runs readiness proof, and writes deploy state.

## Initial Host Setup

Create an install directory and copy the production compose file:

```sh
sudo mkdir -p /opt/agentdash
sudo cp docker/docker-compose.production.yml /opt/agentdash/docker-compose.yml
sudo chown -R "$USER":"$USER" /opt/agentdash
```

Create `/opt/agentdash/agentdash.env`:

```sh
cat > /opt/agentdash/agentdash.env <<'EOF'
AGENTDASH_IMAGE=ghcr.io/<owner>/<repo>:sha-<commit>
AGENTDASH_RUNTIME_ENV_FILE=/opt/agentdash/agentdash.env

POSTGRES_USER=paperclip
POSTGRES_PASSWORD=<random-postgres-password>
POSTGRES_DB=paperclip

PAPERCLIP_PORT=3100
PAPERCLIP_PUBLIC_URL=https://agentdash-customer.example.com
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true
PAPERCLIP_MIGRATION_AUTO_APPLY=true
BETTER_AUTH_SECRET=<openssl-rand-hex-32>

# Optional adapter/provider keys:
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# RESEND_API_KEY=
# STRIPE_SECRET_KEY=
EOF
chmod 600 /opt/agentdash/agentdash.env
```

Start the instance:

```sh
docker compose --env-file /opt/agentdash/agentdash.env \
  -f /opt/agentdash/docker-compose.yml up -d
```

Verify:

```sh
PUBLIC_URL="$(grep '^PAPERCLIP_PUBLIC_URL=' /opt/agentdash/agentdash.env | cut -d= -f2-)"
curl -fsS "$PUBLIC_URL/api/health"
```

## OTA Update Flow

Use the updater from a reviewed checkout of the repo. Always dry-run first:

```sh
mkdir -p /opt/agentdash/backups
PUBLIC_URL="$(grep '^PAPERCLIP_PUBLIC_URL=' /opt/agentdash/agentdash.env | cut -d= -f2-)"

node scripts/deploy/agentdash-ota-update.mjs \
  --target-sha <commit-sha> \
  --image-repo ghcr.io/<owner>/<repo> \
  --compose-file /opt/agentdash/docker-compose.yml \
  --runtime-env-file /opt/agentdash/agentdash.env \
  --state-dir /opt/agentdash/deployments \
  --base-url "$PUBLIC_URL" \
  --backup-command 'docker compose --env-file /opt/agentdash/agentdash.env -f /opt/agentdash/docker-compose.yml exec -T db pg_dump -U paperclip -d paperclip -Fc > /opt/agentdash/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump' \
  --readiness-command "curl -fsS '$PUBLIC_URL/api/health'" \
  --dry-run
```

Then run without `--dry-run`.

The updater will:

1. Verify the target image exists in GHCR.
2. Run the backup command unless `--skip-backup` is explicitly passed.
3. Write `AGENTDASH_IMAGE=<pinned image>` into the env file.
4. Pull and restart the `server` Compose service.
5. Wait for `/api/health`.
6. Run the optional readiness command.
7. Write a receipt under `/opt/agentdash/deployments/receipts/`.
8. Update `/opt/agentdash/deployments/state.json` with current and previous image pointers.

## Rollback

Rollback switches back to the previous pinned image from deployment state. It does not automatically restore the database; use database restore only when the failed release introduced a destructive data problem and a human has approved restore.

```sh
PUBLIC_URL="$(grep '^PAPERCLIP_PUBLIC_URL=' /opt/agentdash/agentdash.env | cut -d= -f2-)"

node scripts/deploy/agentdash-ota-update.mjs \
  --rollback \
  --compose-file /opt/agentdash/docker-compose.yml \
  --runtime-env-file /opt/agentdash/agentdash.env \
  --state-dir /opt/agentdash/deployments \
  --base-url "$PUBLIC_URL" \
  --backup-command 'docker compose --env-file /opt/agentdash/agentdash.env -f /opt/agentdash/docker-compose.yml exec -T db pg_dump -U paperclip -d paperclip -Fc > /opt/agentdash/backups/prerollback-$(date -u +%Y%m%dT%H%M%SZ).dump'
```

## Launch Evidence

Before handing a VPS to a design partner, collect:

- `/api/health` output.
- Current `AGENTDASH_IMAGE` value from `/opt/agentdash/agentdash.env`.
- Latest deploy receipt JSON.
- Latest backup file path and timestamp.
- A login proof from the partner network.
- One real assigned agent run that produces a concrete response.
- Confirmation that failed agent runs surface a clear error category or support escalation path.
