#!/bin/zsh
# Atlas Wire — daily desk + wire digests.
cd /Users/maxiaoer/workspace/agentdash_msp_launch || exit 1
set -a; . /Users/maxiaoer/.config/agentdash/agentdash.env 2>/dev/null; set +a
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
echo "=== $(date -u +%FT%TZ) digest start ==="
exec node cli/node_modules/tsx/dist/cli.mjs server/scripts/news-ingest/run-digest.ts
