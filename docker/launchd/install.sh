#!/bin/bash
# Compatibility entrypoint for the production Mac mini launchd installer.
# The old script built and rsynced local source. Production installs must use
# pinned GHCR SHA images plus the OTA updater instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

exec node "${REPO_ROOT}/scripts/deploy/agentdash-mac-mini-launchd.mjs" "$@"
