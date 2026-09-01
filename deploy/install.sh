#!/bin/zsh
# Turn a checkout on a Mac Mini into something you can leave behind.
#
# Idempotent: safe to re-run after a code change or a config edit.
#
# LaunchAgents, not LaunchDaemons, deliberately. The harnesses keep their
# credentials under $HOME — Hermes reads ~/.hermes/.env, Claude reads
# ~/.claude — and the instance data lives in ~/.paperclip. A daemon runs as
# root with a different HOME and would authenticate as nobody. The cost of that
# choice is real and stated at the end: a user agent needs the user logged in.
set -eu

INSTANCE="${AGENTDASH_INSTANCE:-mkboard}"
APP_DIR="${AGENTDASH_APP_DIR:-$HOME/agentdash}"
ENV_FILE="${AGENTDASH_ENV_FILE:-$HOME/.config/agentdash/${INSTANCE}.env}"
DEPLOY_DIR="$APP_DIR/deploy"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/agentdash"
SERVER_LABEL="com.agentdash.$INSTANCE.server"
BACKUP_LABEL="com.agentdash.$INSTANCE.backup"

say() { printf '  %s\n' "$1"; }

UID_NUM="$(/usr/bin/id -u)"

# Reload a launchd service, tolerating the gap between bootout and gone.
#
# `bootout` returns before the service is actually unloaded, so bootstrapping
# straight after it fails with "Bootstrap failed: 5: Input/output error" — and
# because bootout DID succeed, the service is left unloaded rather than
# restarted. Observed exactly once, in the worst way: re-running the installer
# removed a running server and did not put it back.
reload_service() {
  LABEL="$1"
  /bin/launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  for _ in $(/usr/bin/seq 1 10); do
    /bin/launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || break
    /bin/sleep 1
  done
  for ATTEMPT in 1 2 3; do
    if /bin/launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/$LABEL.plist" 2>/dev/null; then
      return 0
    fi
    /bin/sleep 2
  done
  echo "could not load $LABEL — try: launchctl bootstrap gui/$UID_NUM $AGENTS_DIR/$LABEL.plist" >&2
  return 1
}

echo "AgentDash install — instance '$INSTANCE'"

# ---- preconditions ---------------------------------------------------------
[ -d "$APP_DIR" ]  || { echo "no checkout at $APP_DIR" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE — copy doc/customers/mkthink/agentdash.env.template and fill it in" >&2; exit 1; }
say "checkout $APP_DIR"
say "env      $ENV_FILE"

/bin/mkdir -p "$AGENTS_DIR" "$LOG_DIR"
/bin/chmod 700 "$LOG_DIR"
/bin/chmod +x "$DEPLOY_DIR/agentdash-server.sh" "$DEPLOY_DIR/agentdash-backup.sh"

# The env file holds DATABASE_URL, BETTER_AUTH_SECRET and the license key.
/bin/chmod 600 "$ENV_FILE"
say "env file permissions set to 600"

# ---- build the UI ----------------------------------------------------------
# Not optional. The server serves a pre-built bundle from ui/dist, so a stale
# build means the browser silently shows old code — observed in the wild as a
# five-day-old bundle that made UI fixes look like they had not been applied.
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
echo "building the UI bundle..."
( cd "$APP_DIR/ui" && pnpm build >/dev/null 2>&1 ) && say "ui/dist rebuilt" \
  || { echo "UI build failed — run 'cd $APP_DIR/ui && pnpm build' to see why" >&2; exit 1; }

# ---- keep the machine awake ------------------------------------------------
# A sleeping Mac Mini is a dead AgentDash: agents stop, the bridge stops, and
# the person who depends on it finds out from silence.
if /usr/bin/sudo -n /usr/bin/pmset -a sleep 0 disksleep 0 2>/dev/null; then
  say "sleep disabled (pmset)"
else
  say "SKIPPED sleep settings — run: sudo pmset -a sleep 0 disksleep 0"
fi

# ---- the database ----------------------------------------------------------
# Installed before the servers, and waited for, because a server that starts
# first simply crash-loops on ECONNREFUSED and blames itself in the log.
# Shared by every instance, so it is labelled without one and re-running the
# installer for a second instance leaves it alone.
PG_LABEL="com.agentdash.postgres"
PGPORT_VALUE="${AGENTDASH_PGPORT:-54329}"
cat > "$AGENTS_DIR/$PG_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PG_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$DEPLOY_DIR/agentdash-postgres.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTDASH_APP_DIR</key><string>$APP_DIR</string>
    <key>AGENTDASH_PGPORT</key><string>$PGPORT_VALUE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/postgres.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/postgres.log</string>
</dict>
</plist>
PLIST
say "wrote $PG_LABEL.plist"

if /usr/sbin/lsof -nP -iTCP:"$PGPORT_VALUE" -sTCP:LISTEN >/dev/null 2>&1; then
  # Something already holds the port — almost always a hand-started cluster
  # from before this service existed. Adopting it would leave an unsupervised
  # process behind, so stop it and let launchd own the database from here.
  say "port $PGPORT_VALUE already in use — handing it to launchd"
  PGBIN_DIR="$(/usr/bin/find "$APP_DIR/node_modules/.pnpm" -type d -name bin -path '*@embedded-postgres*darwin*' 2>/dev/null | /usr/bin/head -1)"
  PGDATA_DIR="${AGENTDASH_PGDATA:-$HOME/.paperclip/instances/lantest/db}"
  [ -n "$PGBIN_DIR" ] && "$PGBIN_DIR/pg_ctl" -D "$PGDATA_DIR" -m fast stop >/dev/null 2>&1 || true
  /bin/sleep 3
fi

reload_service "$PG_LABEL"

printf '  waiting for postgres on %s' "$PGPORT_VALUE"
PG_UP=""
for _ in $(/usr/bin/seq 1 20); do
  /bin/sleep 2
  if /usr/bin/nc -z -w 2 127.0.0.1 "$PGPORT_VALUE" 2>/dev/null; then PG_UP=1; break; fi
  printf '.'
done
echo
[ -n "$PG_UP" ] || { echo "postgres did not come up — see $LOG_DIR/postgres.log" >&2; exit 1; }
say "postgres is up and supervised"

# ---- the server agent ------------------------------------------------------
cat > "$AGENTS_DIR/$SERVER_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEPLOY_DIR/agentdash-server.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTDASH_INSTANCE</key><string>$INSTANCE</string>
    <key>AGENTDASH_APP_DIR</key><string>$APP_DIR</string>
    <key>AGENTDASH_ENV_FILE</key><string>$ENV_FILE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <!-- Restart on crash, but not on a clean exit 78 (bad config): retrying a
         misconfiguration forever hides the reason in a loop of log noise. -->
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/$INSTANCE-server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$INSTANCE-server.log</string>
</dict>
</plist>
PLIST
say "wrote $SERVER_LABEL.plist"

# ---- the nightly backup agent ---------------------------------------------
cat > "$AGENTS_DIR/$BACKUP_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$BACKUP_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEPLOY_DIR/agentdash-backup.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTDASH_INSTANCE</key><string>$INSTANCE</string>
    <key>AGENTDASH_APP_DIR</key><string>$APP_DIR</string>
    <key>AGENTDASH_ENV_FILE</key><string>$ENV_FILE</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <!-- The Mini may be asleep or off at 03:30; run the moment it is awake. -->
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG_DIR/$INSTANCE-backup.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$INSTANCE-backup.log</string>
</dict>
</plist>
PLIST
say "wrote $BACKUP_LABEL.plist"

# ---- (re)load --------------------------------------------------------------
for LABEL in "$SERVER_LABEL" "$BACKUP_LABEL"; do
  reload_service "$LABEL"
done
/bin/launchctl enable "gui/$UID_NUM/$SERVER_LABEL" 2>/dev/null || true
say "services loaded"

# ---- prove it ---------------------------------------------------------------
PORT_VALUE="$(/usr/bin/grep -E '^PORT=' "$ENV_FILE" | /usr/bin/tail -1 | /usr/bin/cut -d= -f2 | /usr/bin/tr -d '[:space:]')"
PORT_VALUE="${PORT_VALUE:-3000}"
echo "waiting for http://127.0.0.1:$PORT_VALUE/api/health ..."
for i in $(/usr/bin/seq 1 24); do
  /bin/sleep 5
  CODE="$(/usr/bin/curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_VALUE/api/health" || true)"
  if [ "$CODE" = "200" ]; then
    echo
    echo "AgentDash is up on port $PORT_VALUE and will restart on boot."
    say "logs:    $LOG_DIR/$INSTANCE-server.log"
    say "backups: nightly 03:30 -> ~/.paperclip/backups/$INSTANCE"
    say "status:  launchctl print gui/$UID_NUM/$SERVER_LABEL | head"
    echo
    echo "One thing this cannot do for you: a user LaunchAgent needs this user"
    echo "logged in. On an unattended Mini, turn on automatic login"
    echo "(System Settings > Users & Groups > Automatic login), or the service"
    echo "will not come back after a power cut."
    exit 0
  fi
done

echo "server did not answer health within 120s — check $LOG_DIR/$INSTANCE-server.log" >&2
exit 1
