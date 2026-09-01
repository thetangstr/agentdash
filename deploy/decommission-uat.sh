#!/bin/zsh
# Remove the uat instance from this machine. Run with sudo:
#
#   sudo bash deploy/decommission-uat.sh
#
# Why sudo, when everything else here avoids it: the plists now carry
# KeepAlive=true (unconditional), so launchd restarts the server whatever
# signal it gets and however it exits. That is the right posture for the
# production instance — it is what "the client reboots the Mini and everything
# comes back" rests on — and it means the ONLY way to stop an instance for
# good is `launchctl bootout` on its system daemon, which is root's.
#
# Why decommission at all: uat was the rehearsal workspace, and rehearsal does
# not belong on the client's machine. Two identical-looking instances with the
# same logins on adjacent ports is how real work lands on the wrong one; and
# every future client box will have exactly one instance, so this one should
# look like what we intend to ship. Update rehearsal moves to the operator's
# own hardware as part of the release pipeline (see the OTA plan).
#
# What this deliberately KEEPS:
#   - the uat database inside the shared Postgres (drop it later, on purpose,
#     not as a side effect of a decommission script)
#   - ~/.paperclip/backups/uat/ (final backup taken 2026-08-18, 581KB)
#   - ~/.paperclip/instances/uat/ (instance files, incl. the CoS agent bundle)
# The env file is renamed, not deleted: it holds the license key and secrets
# that explain what this instance WAS if anyone ever has to look.

set -eu

[ "$(id -u)" = "0" ] || { echo "run with sudo — bootout of a system daemon is root's"; exit 1; }

YANG_HOME="/Users/yang"
CONF="$YANG_HOME/.config/agentdash"
STAMP=$(date +%Y%m%d-%H%M%S)

for label in com.agentdash.uat.server com.agentdash.uat.backup; do
  plist="/Library/LaunchDaemons/$label.plist"
  if [ -f "$plist" ]; then
    launchctl bootout "system/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "  removed $label"
  else
    echo "  $label: already gone"
  fi
done

# Give the bootout a moment, then verify the port is actually silent — a
# decommission that leaves the server listening has not decommissioned anything.
sleep 3
if curl -s -o /dev/null --max-time 3 http://127.0.0.1:3103/api/health; then
  echo "  WARNING: something still answers on :3103 — investigate before trusting this"
  exit 1
fi
echo "  :3103 is silent"

# Retire the env file LAST, so a launchd restart in the window above never
# finds a half-decommissioned instance with no config.
if [ -f "$CONF/uat.env" ]; then
  mv "$CONF/uat.env" "$CONF/uat.env.retired-$STAMP"
  chown yang:staff "$CONF/uat.env.retired-$STAMP"
  echo "  uat.env -> uat.env.retired-$STAMP"
fi

# The production instance must be untouched by all of this.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3102/api/health || echo 000)
if [ "$code" = "200" ]; then
  echo "  mkboard: still healthy (200)"
else
  echo "  WARNING: mkboard answered $code — check it before walking away"
  exit 1
fi

echo ""
echo "uat is decommissioned. Left behind on purpose: the uat database in the"
echo "shared Postgres, ~/.paperclip/backups/uat/, and ~/.paperclip/instances/uat/."
