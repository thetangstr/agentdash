#!/bin/bash
# C1: move the five AgentDash services from login-scoped LaunchAgents to
# boot-scoped LaunchDaemons. Run with sudo. Verified FileVault is OFF, so the
# home volume is readable at boot and this actually buys unattended restart.
#
#   sudo bash install-launchdaemons.sh
#
# Rollback: sudo bash install-launchdaemons.sh --rollback
set -euo pipefail

STAGED="$(cd "$(dirname "$0")/launchdaemons" && pwd)"
UID_YANG=$(id -u yang)

if [[ "${1:-}" == "--rollback" ]]; then
  for f in "$STAGED"/com.agentdash.*.plist; do
    label=$(basename "$f" .plist)
    launchctl bootout system "/Library/LaunchDaemons/$label.plist" 2>/dev/null || true
    rm -f "/Library/LaunchDaemons/$label.plist"
    agent_plist="/Users/yang/Library/LaunchAgents/$label.plist"
    [[ -f "$agent_plist.disabled" ]] && mv "$agent_plist.disabled" "$agent_plist"
    launchctl bootstrap "gui/$UID_YANG" "$agent_plist" || true
    echo "rolled back $label"
  done
  exit 0
fi

for f in "$STAGED"/com.agentdash.*.plist; do
  label=$(basename "$f" .plist)
  # 1. stop the login-scoped copy so the two never fight over the port
  agent_plist="/Users/yang/Library/LaunchAgents/$label.plist"
  launchctl bootout "gui/$UID_YANG" "$agent_plist" 2>/dev/null || true
  # ...and take its name away, because booting it out is not enough: launchd
  # re-bootstraps everything in ~/Library/LaunchAgents at the next login, and
  # any later `launchctl bootstrap gui/501 …` resurrects it by hand. Observed
  # on the MKThink Mini on 2026-08-18: two mkboard servers, the loser of the
  # port race silently falling back from 3102 to 3103 — healthy, reachable,
  # and serving nobody, since Caddy only proxies 3102. Renamed, not deleted,
  # so --rollback can put it back.
  [[ -f "$agent_plist" ]] && mv "$agent_plist" "$agent_plist.disabled"
  # 2. install the daemon (root-owned, 644, or launchd refuses it)
  install -o root -g wheel -m 644 "$f" "/Library/LaunchDaemons/$label.plist"
  # 3. start it in the system domain
  launchctl bootstrap system "/Library/LaunchDaemons/$label.plist"
  echo "installed $label"
done

# The agents' plists stay in ~/Library/LaunchAgents as `*.plist.disabled`:
# present for --rollback, but invisible to launchd, which only loads files
# ending in .plist. Delete them once the reboot test passes.

echo
echo "Now verify:"
echo "  launchctl print system/com.agentdash.mkboard.server | head -5"
echo "  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3102/api/health"
echo
echo "The only test that counts: reboot the machine, do NOT log in,"
echo "and from another device confirm http://mkmini.local:3102 answers."
