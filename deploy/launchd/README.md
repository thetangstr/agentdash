# Atlas Wire — launchd schedule (Mac mini)

Drives the news-ingest pipeline OUTSIDE the AgentDash heartbeat (agents stay paused).

- `atlas-wire-ingest.sh` — one ingest cycle (`run-cycle.ts --max 1`, all 18 beats). Install to `~/.agentdash/bin/`.
- `atlas-wire-digest.sh` — daily desk + wire digests. Install to `~/.agentdash/bin/`.
- `com.agentdash.atlaswire.ingest.plist` — every 30 min (StartInterval 1800), RunAtLoad. Install to `~/Library/LaunchAgents/`.
- `com.agentdash.atlaswire.digest.plist` — daily at 23:30. Install to `~/Library/LaunchAgents/`.

Install: copy files, `chmod +x` the wrappers, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentdash.atlaswire.<job>.plist`.
Logs: `~/.agentdash/logs/atlas-wire-*.log`. Requires `CLOCKCHAIN_MCP_TOKEN` (and optionally
`MINIMAX_CN_API_KEY` for LLM extraction) in `~/.config/agentdash/agentdash.env`.
