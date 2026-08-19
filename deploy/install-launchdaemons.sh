#!/bin/bash
# C1: move the five AgentDash services from login-scoped LaunchAgents to
# boot-scoped LaunchDaemons. Run with sudo. Verified FileVault is OFF, so the
# home volume is readable at boot and this actually buys unattended restart.
#
#   sudo bash install-launchdaemons.sh
#
# Rollback: sudo bash install-launchdaemons.sh --rollback
set -euo pipefail

STAGED="${AGENTDASH_STAGED_DIR:-$(cd "$(dirname "$0")/launchdaemons" && pwd)}"
UID_YANG=$(id -u yang 2>/dev/null || echo 501)
failures=""

# Overridable so this script can be exercised against temporary directories in
# a test, instead of only ever being proven by running it on a customer's Mac
# with sudo. It has aborted mid-run twice in production; both times the fix was
# obvious in hindsight and invisible beforehand.
DAEMON_DIR="${AGENTDASH_LAUNCHDAEMON_DIR:-/Library/LaunchDaemons}"
AGENT_DIR="${AGENTDASH_LAUNCHAGENT_DIR:-/Users/yang/Library/LaunchAgents}"
LAUNCHCTL="${AGENTDASH_LAUNCHCTL:-launchctl}"
INSTALL_OWNER_ARGS="${AGENTDASH_INSTALL_OWNER_ARGS--o root -g wheel}"

if [[ "${1:-}" == "--rollback" ]]; then
  for f in "$STAGED"/com.agentdash.*.plist; do
    label=$(basename "$f" .plist)
    "$LAUNCHCTL" bootout system "$DAEMON_DIR/$label.plist" 2>/dev/null || true
    rm -f "$DAEMON_DIR/$label.plist"
    agent_plist="$AGENT_DIR/$label.plist"
    [[ -f "$agent_plist.disabled" ]] && mv "$agent_plist.disabled" "$agent_plist"
    "$LAUNCHCTL" bootstrap "gui/$UID_YANG" "$agent_plist" || true
    echo "rolled back $label"
  done
  exit 0
fi

for f in "$STAGED"/com.agentdash.*.plist; do
  label=$(basename "$f" .plist)
  # 1. stop the login-scoped copy so the two never fight over the port
  agent_plist="$AGENT_DIR/$label.plist"
  "$LAUNCHCTL" bootout "gui/$UID_YANG" "$agent_plist" 2>/dev/null || true
  # ...and take its name away, because booting it out is not enough: launchd
  # re-bootstraps everything in ~/Library/LaunchAgents at the next login, and
  # any later `launchctl bootstrap gui/501 …` resurrects it by hand. Observed
  # on the MKThink Mini on 2026-08-18: two mkboard servers, the loser of the
  # port race silently falling back from 3102 to 3103 — healthy, reachable,
  # and serving nobody, since Caddy only proxies 3102. Renamed, not deleted,
  # so --rollback can put it back.
  [[ -f "$agent_plist" ]] && mv "$agent_plist" "$agent_plist.disabled"
  # 2. install the daemon (root-owned, 644, or launchd refuses it)
  target="$DAEMON_DIR/$label.plist"
  unchanged=0
  if [ -f "$target" ] && cmp -s "$f" "$target"; then unchanged=1; fi
  # shellcheck disable=SC2086 # deliberate word splitting: overridable owner flags
  install $INSTALL_OWNER_ARGS -m 644 "$f" "$target"

  # 3. start it in the system domain — idempotently.
  #
  # Re-running this script used to die on the first service that was already
  # loaded: `launchctl bootstrap` answers "Bootstrap failed: 5: Input/output
  # error", `set -e` took that as fatal, and every label after it never
  # installed. Seen twice — once installing the TLS renewal daemon, and again
  # on 2026-08-19, where it meant the new update job was never installed at all
  # while the run looked like it had merely "failed".
  #
  # A service already loaded from an identical plist is the desired state, not
  # an error, and reloading it would restart a healthy production server for
  # nothing.
  if "$LAUNCHCTL" print "system/$label" >/dev/null 2>&1; then
    if [ "$unchanged" = "1" ]; then
      echo "  $label: already loaded, plist unchanged — left running"
      continue
    fi
    echo "  $label: plist changed, reloading"
    "$LAUNCHCTL" bootout "system/$label" 2>/dev/null || true
    tries=0
    while "$LAUNCHCTL" print "system/$label" >/dev/null 2>&1 && [ "$tries" -lt 10 ]; do
      sleep 1
      tries=$((tries + 1))
    done
  fi

  if "$LAUNCHCTL" bootstrap system "$target" 2>/dev/null; then
    echo "  installed $label"
  elif "$LAUNCHCTL" print "system/$label" >/dev/null 2>&1; then
    # Bootstrap refused it but the job is there: adopt it rather than fail.
    "$LAUNCHCTL" kickstart -k "system/$label" 2>/dev/null || true
    echo "  $label: already present, kickstarted"
  else
    echo "  $label: bootstrap FAILED and the job is not loaded" >&2
    failures="$failures $label"
  fi
done

if [ -n "$failures" ]; then
  echo >&2
  echo "These labels did not load:$failures" >&2
  echo "Inspect one with: sudo launchctl print system/<label>" >&2
  exit 1
fi

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
