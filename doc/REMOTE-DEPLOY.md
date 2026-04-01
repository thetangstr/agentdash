# Remote Deploy via GitHub Actions

Deploy AgentDash to a Docker-capable remote machine using GitHub Container Registry and a manual GitHub Actions workflow.

## What This Path Does

1. [`.github/workflows/docker.yml`](../.github/workflows/docker.yml) publishes a Docker image to GHCR on pushes to `agentdash-main`, on stable tags `v*`, and on manual runs.
2. [`.github/workflows/deploy-remote.yml`](../.github/workflows/deploy-remote.yml) uploads the versioned remote compose assets to your server over SSH, writes the runtime `.env`, pulls the selected image tag, and runs `docker compose up -d`.

This is a single-machine deployment path for a remote host with Docker and the Docker Compose plugin installed.

## Remote Machine Prerequisites

- Linux host with Docker Engine installed
- Docker Compose plugin available as `docker compose`
- SSH access for the GitHub Actions runner user
- A writable deploy directory such as `/opt/agentdash`
- Public internet access from the server to `ghcr.io`

## GitHub Environment Secrets

Create a GitHub Actions environment such as `production` or `staging`, then add these secrets:

- `REMOTE_HOST`
  - host or IP of the remote machine
- `REMOTE_PORT`
  - optional SSH port, defaults to `22`
- `REMOTE_USER`
  - SSH username on the remote machine
- `REMOTE_SSH_KEY`
  - private key used by the workflow to connect to the machine
- `REMOTE_KNOWN_HOSTS`
  - optional pinned `known_hosts` entry; if omitted, the workflow falls back to `ssh-keyscan`
- `GHCR_USERNAME`
  - GitHub username or machine user that can pull from GHCR
- `GHCR_READ_TOKEN`
  - GitHub token with at least `read:packages`
- `REMOTE_ENV_FILE`
  - full contents of the runtime `.env` file to write on the remote host
- `DEPLOY_HEALTHCHECK_URL`
  - optional URL to poll after deploy, for example `https://agentdash.example.com/api/health`

## Runtime `.env`

Start from [`deploy/remote.env.example`](../deploy/remote.env.example). A minimal authenticated deployment needs:

```dotenv
AGENTDASH_PORT=3100
AGENTDASH_DATA_DIR=/opt/agentdash/data
HOST=0.0.0.0
PORT=3100
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_PUBLIC_URL=https://agentdash.example.com
BETTER_AUTH_SECRET=replace-with-a-long-random-secret
```

Add any provider keys or auth overrides you need. Keep `AGENTDASH_IMAGE` out of this file when you use the workflow because the workflow injects the image tag per deployment.

## How to Deploy

1. Ensure the Docker image you want already exists in GHCR.
   - `latest` is published from `agentdash-main`
   - `agentdash-main` is also published as a branch tag
   - stable tags produce image tags such as `v2026.331.0` and `2026.331.0`
   - every published image also gets a `sha-...` tag
2. Open GitHub Actions and run [`.github/workflows/deploy-remote.yml`](../.github/workflows/deploy-remote.yml).
3. Pick the GitHub environment, image tag, and remote deploy directory.
4. Wait for the workflow to upload:
   - [`deploy/docker-compose.remote.yml`](../deploy/docker-compose.remote.yml)
   - [`scripts/deploy-remote.sh`](../scripts/deploy-remote.sh)
   - the `.env` content from `REMOTE_ENV_FILE`
5. The workflow logs into GHCR on the remote machine, pulls the selected image, and runs `docker compose up -d`.

## Manual Remote Recovery

If you need to recover manually on the server:

```bash
cd /opt/agentdash
export AGENTDASH_IMAGE=ghcr.io/thetangstr/agentdash:latest
export GHCR_USERNAME=...
export GHCR_TOKEN=...
./deploy-remote.sh /opt/agentdash
```

## Notes

- This workflow is deployment-only. It does not replace the npm/GitHub release flow.
- Data lives on the remote host under `AGENTDASH_DATA_DIR`.
- The remote deployment path uses the existing compatibility env names (`PAPERCLIP_*`) because the runtime still supports them.
