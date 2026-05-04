---
title: macOS Native Deployment
summary: Run AgentDash as a native macOS launchd service on Mac Mini
---

This guide covers running AgentDash natively on macOS using `launchd`, suitable for Mac Mini servers.

## Prerequisites

- macOS with Homebrew or direct Node.js 20+ installation
- PostgreSQL 17 (see options below)
- AgentDash source or release

## Option A: Managed Install (Recommended)

Use the installer script which handles building, environment setup, and service installation:

```sh
# Clone the repo
git clone https://github.com/thetangstr/agentdash.git
cd agentdash/docker/launchd

# Install with managed PostgreSQL via Docker
./install.sh --with-postgres

# OR install with an already-running PostgreSQL
./install.sh
```

### Setting Up

After installation, edit the environment file and set `BETTER_AUTH_SECRET`:

```sh
nano ~/.config/agentdash/agentdash.env
```

Generate a secret:
```sh
openssl rand -base64 32
```

Then restart the service:
```sh
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
```

### Managing the Service

```sh
# View logs
tail -f ~/.agentdash/logs/agentdash.log

# Stop
launchctl unload ~/Library/LaunchAgents/ai.agentdash.agent.plist

# Start
launchctl load ~/Library/LaunchAgents/ai.agentdash.agent.plist

# Restart
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent

# Uninstall
./install.sh --uninstall
```

## Option B: Manual Install

### 1. Install PostgreSQL

**Via Docker** (recommended):
```sh
docker run -d \
  --name agentdash-pg \
  --restart unless-stopped \
  -e POSTGRES_USER=paperclip \
  -e POSTGRES_PASSWORD=paperclip \
  -e POSTGRES_DB=paperclip \
  -v ~/.agentdash/data/postgres:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:17-alpine
```

**Via Homebrew**:
```sh
brew install postgresql@17
brew services start postgresql@17
createdb -U postgres paperclip 2>/dev/null || true
# Create user/database manually if needed
psql -U postgres -c "CREATE USER paperclip WITH PASSWORD 'paperclip';" 2>/dev/null || true
psql -U postgres -c "CREATE DATABASE paperclip OWNER paperclip;" 2>/dev/null || true
```

### 2. Build AgentDash

```sh
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
pnpm install
pnpm build --filter agentdash-server --filter agentdash-cli
```

### 3. Configure

```sh
mkdir -p ~/.config/agentdash
cat > ~/.config/agentdash/agentdash.env << 'EOF'
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
PORT=3100
SERVE_UI=true
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_TAILNET_BIND_HOST=100.83.171.56
PAPERCLIP_MIGRATION_AUTO_APPLY=true
BETTER_AUTH_SECRET=<generate with: openssl rand -base64 32>
EOF
chmod 600 ~/.config/agentdash/agentdash.env
```

### 4. Install launchd Service

```sh
# Copy and edit the plist
sed "s|%%HOME%%|${HOME}|g" \
  docker/launchd/ai.agentdash.agent.plist \
  | sed "s|%%SHARE_DIR%%|/usr/local/share/agentdash|g" \
  | sed "s|%%ENV_FILE%%|${HOME}/.config/agentdash/agentdash.env|g" \
  | sed "s|%%LOG_DIR%%|${HOME}/.agentdash/logs|g" \
  > ~/Library/LaunchAgents/ai.agentdash.agent.plist

# Install server files
sudo mkdir -p /usr/local/share/agentdash
sudo rsync -av --delete \
  --exclude='node_modules' --exclude='.git' --exclude='*.ts' \
  server/dist/ /usr/local/share/agentdash/server/dist/

# Load
launchctl load ~/Library/LaunchAgents/ai.agentdash.agent.plist
```

## Two-Company Setup

AgentDash supports multiple companies in the same database. Once logged in, you can create a second company via the UI at `Settings → Companies → New Company`.

Each company has its own agents, issues, and billing. Shared infrastructure (PostgreSQL, the server) is shared across both.

## Updating

```sh
cd ~/agentdash
git pull
pnpm build --filter agentdash-server --filter agentdash-cli
sudo rsync -av --delete \
  --exclude='node_modules' --exclude='.git' --exclude='*.ts' \
  server/dist/ /usr/local/share/agentdash/server/dist/
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
```
