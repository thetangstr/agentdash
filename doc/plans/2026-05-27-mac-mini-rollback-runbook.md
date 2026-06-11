# Mac Mini Rollback Runbook

**Target:** `maxiaoer@192.168.86.48`  
**Service:** `ai.agentdash.agent`  
**Launch checkout:** `/Users/maxiaoer/workspace/agentdash_msp_launch`  
**Current launch checkout SHA:** capture with `git rev-parse HEAD`; before launch it should match the latest PR #376 head.

Use this only for the first MSP design-partner Mac mini path. It assumes the instance uses the Homebrew PostgreSQL 17 database configured in `~/.config/agentdash/agentdash.env`.

## Pre-Rollback Check

Run this before any rollback decision:

```sh
ssh maxiaoer@192.168.86.48 'zsh -s' <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$HOME/workspace/agentdash_msp_launch"
git rev-parse HEAD
git status --short
launchctl list | awk '$3 == "ai.agentdash.agent" { print }'
find "$HOME/.agentdash/instances/default/data/backups" -type f -name "*.sql*" -print | sort | tail -n 3
find "$HOME/.agentdash/instances/default/data/backups" -type f -name "agentdash-instance-files-*.tgz" -print | sort | tail -n 3
curl -fsS http://127.0.0.1:3100/api/health
REMOTE
```

Dry-run evidence captured on 2026-05-27:

- target checkout HEAD: latest PR #376 head
- target checkout dirty entries: `0`
- launchd service loaded: `ai.agentdash.agent`
- latest database backup: `/Users/maxiaoer/.agentdash/instances/default/data/backups/paperclip-20260527-171657.sql.gz`
- latest instance-file backup: `/Users/maxiaoer/.agentdash/instances/default/data/backups/agentdash-instance-files-20260528T001657Z.tgz`
- env file mode: `600`
- local health: authenticated/ready

## Code Rollback

This rolls back code only. It does not modify the database or instance files.

```sh
ssh maxiaoer@192.168.86.48 'zsh -s' <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$HOME/workspace/agentdash_msp_launch"

rollback_sha="<KNOWN_GOOD_SHA>"

git fetch origin
git status --short
git rev-parse HEAD
git show --stat --oneline "$rollback_sha" --max-count=1

launchctl unload "$HOME/Library/LaunchAgents/ai.agentdash.agent.plist" 2>/dev/null || true
git reset --hard "$rollback_sha"
bash ./docker/launchd/install.sh

curl -fsS http://127.0.0.1:3100/api/health
curl -fsS http://192.168.86.48:3100/api/health
REMOTE
```

Known rollback candidate before the latest Hermes command fix: `ec7fcf04a9e652fe9855f04f3cb5f3474b7b9d50`. Prefer a newer known-good SHA if one exists, because `ec7fcf04a9e652fe9855f04f3cb5f3474b7b9d50` predates the Hermes agent execution fix.

## Database Restore

Use only if data corruption or migration rollback requires it. This is destructive to current database state.

```sh
ssh maxiaoer@192.168.86.48 'zsh -s' <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

backup_file="/Users/maxiaoer/.agentdash/instances/default/data/backups/paperclip-20260527-171657.sql.gz"

launchctl unload "$HOME/Library/LaunchAgents/ai.agentdash.agent.plist" 2>/dev/null || true
dropdb -h localhost -U paperclip paperclip
createdb -h localhost -U paperclip paperclip
gunzip -c "$backup_file" | psql -h localhost -U paperclip -d paperclip
bash "$HOME/workspace/agentdash_msp_launch/docker/launchd/install.sh"
curl -fsS http://127.0.0.1:3100/api/health
REMOTE
```

## Instance File Backup

Database backups do not include the env file, local storage, or local secret material. The readiness script can create the on-host archive without copying secrets into the repo:

```sh
ssh maxiaoer@192.168.86.48 'zsh -s' <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$HOME/workspace/agentdash_msp_launch"
scripts/msp-mac-mini-readiness.sh --run-instance-backup --base-url http://192.168.86.48:3100
REMOTE
```

Manual fallback:

```sh
ssh maxiaoer@192.168.86.48 'zsh -s' <<'REMOTE'
set -euo pipefail
archive="$HOME/agentdash-instance-files-$(date -u +%Y%m%dT%H%M%SZ).tgz"
tar -czf "$archive" \
  "$HOME/.config/agentdash/agentdash.env" \
  "$HOME/.agentdash/instances/default/config.json" \
  "$HOME/.agentdash/instances/default/data/storage" \
  "$HOME/.agentdash/instances/default/secrets/master.key" 2>/dev/null || true
chmod 600 "$archive"
ls -lh "$archive"
REMOTE
```

If `data/storage` or `secrets/master.key` is absent, rerun after the first upload/work-product or secret write.
