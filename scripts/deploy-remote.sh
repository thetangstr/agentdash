#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="${1:-${DEPLOY_DIR:-$PWD}}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"

fail() {
  echo "deploy-remote: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required on the remote machine."
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required on the remote machine."

[ -n "${AGENTDASH_IMAGE:-}" ] || fail "AGENTDASH_IMAGE must be set."
[ -n "${GHCR_USERNAME:-}" ] || fail "GHCR_USERNAME must be set."
[ -n "${GHCR_TOKEN:-}" ] || fail "GHCR_TOKEN must be set."

cd "$DEPLOY_DIR"
[ -f "$COMPOSE_FILE" ] || fail "compose file not found: $DEPLOY_DIR/$COMPOSE_FILE"
[ -f "$ENV_FILE" ] || fail "env file not found: $DEPLOY_DIR/$ENV_FILE"

echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null

export AGENTDASH_IMAGE
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

if [ -n "${AGENTDASH_HEALTHCHECK_URL:-}" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl is required for AGENTDASH_HEALTHCHECK_URL checks."
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error "$AGENTDASH_HEALTHCHECK_URL" >/dev/null; then
      echo "deploy-remote: health check passed."
      docker image prune -f >/dev/null 2>&1 || true
      exit 0
    fi
    sleep 3
  done
  fail "health check failed for $AGENTDASH_HEALTHCHECK_URL"
fi

docker image prune -f >/dev/null 2>&1 || true
echo "deploy-remote: deployment complete."
