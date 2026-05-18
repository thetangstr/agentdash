#!/usr/bin/env bash
# Verify the Docker image builds successfully.
# Skips gracefully when docker/podman is not available.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Detect container runtime
if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
else
  echo "SKIP: neither docker nor podman found — skipping build test"
  exit 0
fi

# Verify the daemon is reachable (docker may be installed but not running)
if ! "$RUNTIME" info >/dev/null 2>&1; then
  echo "SKIP: $RUNTIME is installed but not running — skipping build test"
  exit 0
fi

IMAGE_TAG="agentdash-build-test:$$"
CONTAINER_NAME="agentdash-build-test-$$"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentdash-docker-build-test.XXXXXX")"
trap '"$RUNTIME" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true; "$RUNTIME" rmi "$IMAGE_TAG" >/dev/null 2>&1 || true; rm -rf "$DATA_DIR"' EXIT

echo "==> Testing Docker build with $RUNTIME"
"$RUNTIME" build \
  -f "$REPO_ROOT/Dockerfile" \
  -t "$IMAGE_TAG" \
  --target production \
  "$REPO_ROOT"

echo "==> Verifying key binaries in image"
"$RUNTIME" run --rm "$IMAGE_TAG" sh -c '
  set -e
  test -f /app/dist/index.js
  test -f /app/ui-dist/index.html
  test -d /app/node_modules/@paperclipai/db/dist/migrations
  test ! -e /app/src
  test ! -e /app/server
  test ! -e /app/ui
  test ! -e /app/packages
  ! find -L /app/node_modules/@paperclipai \( -path "*/src" -o -path "*/test" -o -path "*/tests" \) -type d | grep -q .
  ! grep -R "\"./src" /app/package.json /app/node_modules/@paperclipai/*/package.json
  node --version
  git --version
  gh --version
  rg --version
  python3 --version
  curl --version | head -1
  claude --version 2>/dev/null || echo "claude CLI not found (OK in minimal builds)"
'

echo "==> Verifying container health"
"$RUNTIME" run -d \
  --name "$CONTAINER_NAME" \
  -p 127.0.0.1::3100 \
  -v "$DATA_DIR:/paperclip" \
  "$IMAGE_TAG" >/dev/null

HOST_PORT="$("$RUNTIME" port "$CONTAINER_NAME" 3100/tcp | sed -E 's/.*:([0-9]+)$/\1/' | head -1)"
if [[ -z "$HOST_PORT" ]]; then
  echo "FAIL: could not resolve mapped container port" >&2
  "$RUNTIME" logs "$CONTAINER_NAME" >&2 || true
  exit 1
fi

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" >"$DATA_DIR/health.json"; then
    break
  fi
  if [[ "$("$RUNTIME" inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" != "true" ]]; then
    echo "FAIL: container exited before health became ready" >&2
    "$RUNTIME" logs "$CONTAINER_NAME" >&2 || true
    exit 1
  fi
  sleep 1
done

if [[ ! -f "$DATA_DIR/health.json" ]]; then
  echo "FAIL: /api/health did not become ready" >&2
  "$RUNTIME" logs "$CONTAINER_NAME" >&2 || true
  exit 1
fi

grep -q '"status":"ok"' "$DATA_DIR/health.json"
grep -q '^BETTER_AUTH_SECRET=' "$DATA_DIR/agentdash.env"
grep -q '^PAPERCLIP_AGENT_JWT_SECRET=' "$DATA_DIR/agentdash.env"

echo "PASS: Docker build test succeeded"
