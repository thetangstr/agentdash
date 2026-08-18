#!/bin/zsh
# The database, supervised by launchd.
#
# This existed as an unmanaged process for the whole of development — started
# once by hand, kept alive by luck. When it died, both AgentDash instances
# crash-looped with `ECONNREFUSED 127.0.0.1:54329` and the logs blamed the
# server, not the thing that was actually missing. On a reboot it would simply
# never have come back, and the install would have looked like a server bug.
#
# One service, not one per instance: both instances share a single Postgres
# cluster and address separate databases inside it.
#
# `postgres` in the foreground rather than `pg_ctl start`, because pg_ctl
# daemonizes and returns — launchd would see the launcher exit, call it a crash,
# and restart it forever against a cluster that is already running.
set -eu

PGDATA_DIR="${AGENTDASH_PGDATA:-$HOME/.paperclip/instances/lantest/db}"
PGPORT_VALUE="${AGENTDASH_PGPORT:-54329}"
APP_DIR="${AGENTDASH_APP_DIR:-$HOME/agentdash}"

# Ships inside the embedded-postgres package rather than on PATH. Globbed
# rather than pinned so a version bump does not silently stop the database.
PGBIN="$(/usr/bin/find "$APP_DIR/node_modules/.pnpm" -type d -name bin -path '*@embedded-postgres*darwin*' 2>/dev/null | /usr/bin/head -1)"
[ -n "$PGBIN" ] || { echo "postgres: no embedded-postgres bin dir under $APP_DIR" >&2; exit 69; }
[ -d "$PGDATA_DIR" ] || { echo "postgres: no data directory at $PGDATA_DIR" >&2; exit 78; }

echo "postgres: starting from $PGDATA_DIR on port $PGPORT_VALUE"
exec "$PGBIN/postgres" -D "$PGDATA_DIR" -p "$PGPORT_VALUE"
