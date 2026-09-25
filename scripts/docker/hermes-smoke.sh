#!/usr/bin/env bash
#
# AgentDash (#721): smoke-test Hermes in a built AgentDash image.
#
#   scripts/docker/hermes-smoke.sh <image>
#
# 1. `hermes --version` prints the version pinned in the Dockerfile.
# 2. With a Volume at /paperclip, provisioning two agents through the server's
#    own hermes-profile code yields two profiles and two agentdash-<id> wrappers
#    under /paperclip, and both survive a fresh container on the same Volume.
#
# Needs Docker and nothing else: no network calls to a model provider.
set -euo pipefail

IMAGE="${1:?usage: hermes-smoke.sh <image>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_REF="$(sed -n 's/^ARG HERMES_REF=v\{0,1\}//p' "$REPO_ROOT/Dockerfile" | head -1)"
VOLUME="agentdash-hermes-smoke-$$"
AGENT_A="11111111-aaaa-4aaa-8aaa-111111111111"
AGENT_B="22222222-bbbb-4bbb-8bbb-222222222222"

log() { printf '[hermes-smoke] %s\n' "$*"; }
cleanup() { docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "hermes --version"
VERSION_OUT="$(docker run --rm "$IMAGE" hermes --version)"
printf '%s\n' "$VERSION_OUT"
# Hermes prints its release date as (YYYY.M.D), matching the tag vYYYY.M.D.
if [ -n "$EXPECTED_REF" ] && ! printf '%s' "$VERSION_OUT" | grep -qF "($EXPECTED_REF)"; then
  echo "hermes-smoke: expected version ($EXPECTED_REF) in the output above" >&2
  exit 1
fi

docker volume create "$VOLUME" >/dev/null

log "provisioning two agents on the Volume"
docker run --rm -v "$VOLUME:/paperclip" -e AGENTDASH_DEPLOYMENT_KIND=hosted "$IMAGE" sh -ec "
  hermes profile create agentdash --no-alias >/dev/null
  cd /app/server
  node --input-type=module -e '
    const m = await import(\"/app/server/dist/services/hermes-profile.js\");
    for (const id of [\"$AGENT_A\", \"$AGENT_B\"]) {
      const cmd = await m.ensureAgentProfileCommand(id, {}, { failClosed: m.hermesProfilesFailClosed() });
      console.log(\"provisioned\", cmd);
    }
  '
"

log "checking both profiles and wrappers from a fresh container on the same Volume"
docker run --rm -v "$VOLUME:/paperclip" "$IMAGE" sh -ec "
  for id in $AGENT_A $AGENT_B; do
    name=agentdash-\$(printf '%s' \"\$id\" | tr -d -- '-')
    test -d \"\$HERMES_PROFILES_DIR/\$name\" || { echo \"missing profile \$name\" >&2; exit 1; }
    test -x \"\$AGENTDASH_HERMES_BIN_DIR/\$name\" || { echo \"missing wrapper \$name\" >&2; exit 1; }
    grep -q -- \"-p \$name\" \"\$AGENTDASH_HERMES_BIN_DIR/\$name\"
    \"\$AGENTDASH_HERMES_BIN_DIR/\$name\" profile show \$name >/dev/null
    echo \"ok \$name\"
  done
  ls -ld /paperclip/.hermes /paperclip/.hermes/profiles /paperclip/.hermes/bin
"
log "pass"
