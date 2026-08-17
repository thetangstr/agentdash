#!/bin/bash
# C5: log rotation for the AgentDash services.
#
# Deliberately copy-truncate, NOT newsyslog: launchd opens StandardOutPath
# once at service start and holds the fd, so a rename-based rotator would
# leave every service writing to the renamed file until its next restart —
# rotation that silently stops the logs is worse than no rotation. launchd
# opens the file in append mode, so truncating under a live writer is safe:
# the next write lands at the new offset.
#
# Keep 5 compressed generations per log, rotate past 10MB. Runs nightly from
# com.agentdash.rotate-logs (LaunchDaemon).
set -euo pipefail

LOG_DIR="${AGENTDASH_LOG_DIR:-$HOME/Library/Logs/agentdash}"
MAX_BYTES=$((10 * 1024 * 1024))
KEEP=5

for log in "$LOG_DIR"/*.log; do
  [ -f "$log" ] || continue
  size=$(stat -f %z "$log")
  [ "$size" -ge "$MAX_BYTES" ] || continue

  # shift older generations up
  for ((i = KEEP - 1; i >= 1; i--)); do
    [ -f "$log.$i.gz" ] && mv "$log.$i.gz" "$log.$((i + 1)).gz"
  done

  cp "$log" "$log.1"
  : > "$log"
  gzip -f "$log.1"
  echo "$(date -u +%FT%TZ) rotated $(basename "$log") (${size} bytes)"
done
