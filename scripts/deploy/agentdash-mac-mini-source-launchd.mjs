#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_LABEL = "ai.agentdash.agent";
const DEFAULT_PORT = 3100;

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function abs(value) {
  return path.resolve(process.cwd(), expandHome(value));
}

function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function assertGitSha(targetSha) {
  if (typeof targetSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(targetSha.trim())) {
    throw new Error("targetSha is required and must be a pinned 7-40 character git SHA.");
  }
}

function readEnvValue(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(.*)\\s*$`);
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    return match[1]?.replace(/^['"]|['"]$/g, "") ?? "";
  }
  return null;
}

function setEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=`);
  let replaced = false;
  const next = lines.map((existing) => {
    if (pattern.test(existing)) {
      replaced = true;
      return line;
    }
    return existing;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(line);
  }
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}

export function buildMacMiniSourceLaunchdPlan(input = {}) {
  const repoDir = abs(input.repoDir ?? "~/workspace/agentdash_msp_launch");
  const targetSha = String(input.targetSha ?? "").trim();
  assertGitSha(targetSha);
  const publicUrl = input.publicUrl ?? input.baseUrl;
  if (!publicUrl) {
    throw new Error("publicUrl is required. Use the Tailscale/private URL operators will open in the browser.");
  }

  const label = input.label ?? DEFAULT_LABEL;
  const agentdashHome = abs(input.agentdashHome ?? "~/.agentdash");
  const configDir = abs(input.configDir ?? "~/.config/agentdash");
  const launchAgentDir = abs(input.launchAgentDir ?? path.join(os.homedir(), "Library", "LaunchAgents"));
  const envFile = input.envFile ? abs(input.envFile) : path.join(configDir, "agentdash.env");
  const binDir = path.join(agentdashHome, "bin");
  const logDir = input.logDir ? abs(input.logDir) : path.join(agentdashHome, "logs");
  const backupDir = input.backupDir ? abs(input.backupDir) : path.join(agentdashHome, "backups");
  const stateDir = input.stateDir ? abs(input.stateDir) : path.join(agentdashHome, "deployments");
  const port = String(input.paperclipPort ?? DEFAULT_PORT);

  const paths = {
    repoDir,
    agentdashHome,
    envFile,
    binDir,
    logDir,
    backupDir,
    stateDir,
    plist: path.join(launchAgentDir, `${label}.plist`),
    supervisorScript: path.join(binDir, "agentdash-source-supervisor.sh"),
    backupScript: path.join(binDir, "agentdash-backup-db.sh"),
    readinessScript: path.join(binDir, "agentdash-readiness.sh"),
    updateScript: path.join(binDir, "agentdash-source-update.sh"),
    rollbackScript: path.join(binDir, "agentdash-source-rollback.sh"),
    runbook: path.join(agentdashHome, "RUNBOOK.md"),
  };

  return {
    version: 1,
    mode: "source-checkout",
    label,
    targetSha,
    remoteName: input.remoteName ?? "origin",
    paths,
    env: {
      NODE_ENV: "production",
      PORT: port,
      SERVE_UI: "true",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      PAPERCLIP_PUBLIC_URL: publicUrl,
      PAPERCLIP_API_URL: input.paperclipApiUrl ?? `http://127.0.0.1:${port}`,
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
      AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT: "true",
      AGENTDASH_SOURCE_SHA: targetSha,
      PAPERCLIP_HOME: input.paperclipHome ? abs(input.paperclipHome) : abs("~/.paperclip"),
      BETTER_AUTH_SECRET: input.betterAuthSecret ?? randomSecret(32),
      PAPERCLIP_AGENT_JWT_SECRET: input.agentJwtSecret ?? randomSecret(32),
    },
  };
}

export function mergeSourceEnv(existingContent, plan) {
  let content = String(existingContent ?? "");
  for (const [key, value] of Object.entries(plan.env)) {
    if ((key === "BETTER_AUTH_SECRET" || key === "PAPERCLIP_AGENT_JWT_SECRET") && readEnvValue(content, key)) {
      continue;
    }
    content = setEnvValue(content, key, value);
  }
  return content;
}

export function renderSourceSupervisorScript(plan) {
  return `#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO_DIR="${plan.paths.repoDir}"
ENV_FILE="${plan.paths.envFile}"

mkdir -p "${plan.paths.logDir}" "${plan.paths.backupDir}" "${plan.paths.stateDir}"
set -a
. "$ENV_FILE"
set +a
EXPECTED_SHA="\${AGENTDASH_SOURCE_SHA:-${plan.targetSha}}"

cd "$REPO_DIR"
actual_sha="$(git rev-parse HEAD)"
case "$actual_sha" in
  "$EXPECTED_SHA"*) ;;
  *)
    echo "Refusing to start AgentDash from unexpected SHA $actual_sha; expected $EXPECTED_SHA" >&2
    exit 1
    ;;
esac

exec pnpm --filter @paperclipai/server exec tsx src/index.ts
`;
}

export function renderSourceBackupScript(plan) {
  return `#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ENV_FILE="${plan.paths.envFile}"
BACKUP_DIR="${plan.paths.backupDir}"
mkdir -p "$BACKUP_DIR"
set -a
. "$ENV_FILE"
set +a

resolve_pg_dump() {
  if [[ -n "\${PG_DUMP_BIN:-}" && -x "\${PG_DUMP_BIN:-}" ]]; then
    echo "$PG_DUMP_BIN"
    return 0
  fi

  for candidate in \\
    /opt/homebrew/opt/libpq/bin/pg_dump \\
    /opt/homebrew/Cellar/libpq/*/bin/pg_dump \\
    /usr/local/opt/libpq/bin/pg_dump \\
    /usr/local/Cellar/libpq/*/bin/pg_dump \\
    /opt/homebrew/bin/pg_dump \\
    /usr/local/bin/pg_dump \\
    /usr/bin/pg_dump; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  command -v pg_dump
}

PG_DUMP="$(resolve_pg_dump)"
output="$BACKUP_DIR/predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
if [[ -n "\${DATABASE_URL:-}" ]]; then
  "$PG_DUMP" "$DATABASE_URL" -Fc > "$output"
elif [[ -n "\${PAPERCLIP_EMBEDDED_POSTGRES_PORT:-}" ]]; then
  PGPASSWORD="\${POSTGRES_PASSWORD:-paperclip}" "$PG_DUMP" \\
    -h 127.0.0.1 \\
    -p "\${PAPERCLIP_EMBEDDED_POSTGRES_PORT}" \\
    -U "\${POSTGRES_USER:-paperclip}" \\
    -d "\${POSTGRES_DB:-paperclip}" \\
    -Fc > "$output"
else
  echo "DATABASE_URL or PAPERCLIP_EMBEDDED_POSTGRES_PORT is required for source-checkout backups." >&2
  exit 1
fi
chmod 600 "$output"
echo "$output"
`;
}

export function renderSourceReadinessScript(plan) {
  const baseUrl = plan.env.PAPERCLIP_PUBLIC_URL.replace(/\/+$/, "");
  return `#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO_DIR="${plan.paths.repoDir}"
ENV_FILE="${plan.paths.envFile}"
BASE_URL="${baseUrl}"
LABEL="${plan.label}"
PORT="${plan.env.PORT}"

set -a
. "$ENV_FILE"
set +a
EXPECTED_SHA="\${AGENTDASH_SOURCE_SHA:-${plan.targetSha}}"

file_mode() {
  if stat -f %Lp "$1" >/dev/null 2>&1; then
    stat -f %Lp "$1"
  else
    stat -c %a "$1"
  fi
}

pid_has_ancestor() {
  local pid="$1"
  local ancestor="$2"
  local parent

  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" ]]; do
    if [[ "$pid" == "$ancestor" ]]; then
      return 0
    fi
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    [[ -n "$parent" && "$parent" != "$pid" ]] || return 1
    pid="$parent"
  done
  return 1
}

for attempt in $(seq 1 30); do
  if health_json="$(curl -fsS "$BASE_URL/api/health")"; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    echo "AgentDash health did not become ready at $BASE_URL/api/health after $attempt attempts." >&2
    exit 1
  fi
  sleep 2
done

node - "$health_json" <<'NODE'
const payload = JSON.parse(process.argv[2]);
if (payload.status !== "ok") throw new Error("Unexpected health status: " + payload.status);
if (payload.deploymentMode !== "authenticated") {
  throw new Error("Unexpected deployment mode: " + payload.deploymentMode);
}
if (payload.bootstrapStatus !== "ready") {
  throw new Error("Unexpected bootstrap status: " + payload.bootstrapStatus);
}
NODE
echo "[PASS] Authenticated application health is ready at $BASE_URL/api/health"

if ! launchd_state="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null)"; then
  echo "launchd service is not loaded: $LABEL" >&2
  exit 1
fi
launchd_pid="$(printf '%s\n' "$launchd_state" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
if [[ ! "$launchd_pid" =~ ^[0-9]+$ ]]; then
  echo "launchd service has no live PID: $LABEL" >&2
  exit 1
fi
echo "[PASS] launchd service is loaded: $LABEL"

actual_sha="$(git -C "$REPO_DIR" rev-parse HEAD)"
case "$actual_sha" in
  "$EXPECTED_SHA"*) ;;
  *)
    echo "Unexpected source SHA $actual_sha; expected $EXPECTED_SHA" >&2
    exit 1
    ;;
esac
echo "[PASS] Source SHA matches the configured deployment pin"

if [[ "$(file_mode "$ENV_FILE")" != "600" ]]; then
  echo "Runtime env file must have mode 600: $ENV_FILE" >&2
  exit 1
fi
[[ "\${PAPERCLIP_DEPLOYMENT_MODE:-}" == "authenticated" ]] || {
  echo "PAPERCLIP_DEPLOYMENT_MODE must be authenticated" >&2
  exit 1
}
[[ "\${PAPERCLIP_DEPLOYMENT_EXPOSURE:-}" == "private" ]] || {
  echo "PAPERCLIP_DEPLOYMENT_EXPOSURE must be private" >&2
  exit 1
}
for required_secret in BETTER_AUTH_SECRET PAPERCLIP_AGENT_JWT_SECRET; do
  if [[ -z "\${!required_secret:-}" ]]; then
    echo "$required_secret is required" >&2
    exit 1
  fi
done
echo "[PASS] Runtime env mode and private authenticated posture are valid"

if [[ -n "\${DATABASE_URL:-}" ]]; then
  echo "[PASS] DATABASE_URL is configured"
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "SELECT 1" >/dev/null
    echo "[PASS] PostgreSQL connection responds"
  fi
elif [[ -n "\${PAPERCLIP_EMBEDDED_POSTGRES_PORT:-}" ]]; then
  echo "[PASS] Embedded PostgreSQL is configured"
else
  echo "DATABASE_URL or PAPERCLIP_EMBEDDED_POSTGRES_PORT is required" >&2
  exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to prove launchd owns configured PORT=$PORT" >&2
  exit 1
fi
listener_pids="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
if [[ -z "$listener_pids" ]]; then
  echo "No process is listening on configured PORT=$PORT" >&2
  exit 1
fi
listener_owned=false
while IFS= read -r listener_pid; do
  if [[ -n "$listener_pid" ]] && pid_has_ancestor "$listener_pid" "$launchd_pid"; then
    listener_owned=true
    break
  fi
done <<< "$listener_pids"
if [[ "$listener_owned" != "true" ]]; then
  echo "Configured PORT=$PORT is not owned by launchd service $LABEL" >&2
  exit 1
fi
echo "[PASS] listener process belongs to launchd service"

if [[ "\${AGENTDASH_READINESS_RUN_HARNESS_SMOKE:-}" == "true" ]]; then
  if [[ -z "\${AGENTDASH_READINESS_COMPANY_ID:-}" ]]; then
    echo "AGENTDASH_READINESS_COMPANY_ID is required when running harness smoke." >&2
    exit 1
  fi
  if [[ ! -x "$REPO_DIR/scripts/agent-harness-smoke.sh" ]]; then
    echo "Agent harness smoke script is unavailable in the pinned source checkout." >&2
    exit 1
  fi
  harness_args=(
    "$REPO_DIR/scripts/agent-harness-smoke.sh"
    --base-url "$BASE_URL"
    --company-id "$AGENTDASH_READINESS_COMPANY_ID"
  )
  if [[ -n "\${AGENTDASH_READINESS_AUTH_HEADER:-}" ]]; then
    case "$AGENTDASH_READINESS_AUTH_HEADER" in
      Bearer\\ *) harness_args+=(--bearer-token "\${AGENTDASH_READINESS_AUTH_HEADER#Bearer }") ;;
      *)
        echo "AGENTDASH_READINESS_AUTH_HEADER must use the Bearer scheme for harness smoke." >&2
        exit 2
        ;;
    esac
  fi
  "\${harness_args[@]}"
fi

echo "Source-checkout readiness passed."
`;
}

export function renderSourceUpdateScript(plan) {
  return `#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <commit-sha>" >&2
  exit 2
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO_DIR="${plan.paths.repoDir}"
ENV_FILE="${plan.paths.envFile}"
STATE_DIR="${plan.paths.stateDir}"
LABEL="${plan.label}"
TARGET_SHA="$1"
mkdir -p "$STATE_DIR/receipts"

case "$TARGET_SHA" in
  [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) ;;
  *)
    echo "Target must be a pinned git SHA." >&2
    exit 2
    ;;
esac

cd "$REPO_DIR"
previous_sha="$(git rev-parse HEAD)"
pending_previous_sha="\${AGENTDASH_PENDING_PREVIOUS_SHA:-$previous_sha}"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$STATE_DIR/pending.json" <<JSON
{
  "version": 1,
  "mode": "source-checkout",
  "previousSha": "$pending_previous_sha",
  "targetSha": "$TARGET_SHA",
  "startedAt": "$started_at"
}
JSON
chmod 600 "$STATE_DIR/pending.json"
"${plan.paths.backupScript}" >/tmp/agentdash-last-backup-path.txt
backup_path="$(cat /tmp/agentdash-last-backup-path.txt)"
git fetch --all --tags --prune
git checkout --detach "$TARGET_SHA"
pnpm install --frozen-lockfile
pnpm run build
node - "$ENV_FILE" "$TARGET_SHA" <<'NODE'
const fs = require("node:fs");
const [file, sha] = process.argv.slice(2);
let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const line = "AGENTDASH_SOURCE_SHA=" + sha;
const pattern = /^\\s*AGENTDASH_SOURCE_SHA\\s*=.*$/m;
content = pattern.test(content)
  ? content.replace(pattern, line)
  : content.replace(/\\n*$/, "") + "\\n" + line + "\\n";
fs.writeFileSync(file, content, { mode: 0o600 });
fs.chmodSync(file, 0o600);
NODE
launchctl kickstart -k "gui/$(id -u)/$LABEL"
"${plan.paths.readinessScript}"

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
receipt="$STATE_DIR/receipts/$completed_at-source-update.json"
cat > "$STATE_DIR/state.json" <<JSON
{
  "version": 1,
  "mode": "source-checkout",
  "currentSha": "$TARGET_SHA",
  "previousSha": "$previous_sha",
  "updatedAt": "$completed_at",
  "lastReceiptPath": "$receipt"
}
JSON
cat > "$receipt" <<JSON
{
  "version": 1,
  "action": "source-update",
  "repoDir": "$REPO_DIR",
  "previousSha": "$previous_sha",
  "targetSha": "$TARGET_SHA",
  "backupPath": "$backup_path",
  "completedAt": "$completed_at"
}
JSON
chmod 600 "$STATE_DIR/state.json" "$receipt"
rm -f "$STATE_DIR/pending.json"
echo "$receipt"
`;
}

export function renderSourceRollbackScript(plan) {
  return `#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STATE_FILE="${path.join(plan.paths.stateDir, "state.json")}"
PENDING_FILE="${path.join(plan.paths.stateDir, "pending.json")}"
if [[ -f "$PENDING_FILE" ]]; then
  rollback_source="$PENDING_FILE"
elif [[ -f "$STATE_FILE" ]]; then
  rollback_source="$STATE_FILE"
else
  echo "No source deployment or pending rollback state found." >&2
  exit 1
fi
previous_sha="$(node -e "const s=require(process.argv[1]); if(!s.previousSha) process.exit(2); console.log(s.previousSha)" "$rollback_source")"
AGENTDASH_PENDING_PREVIOUS_SHA="$previous_sha" "${plan.paths.updateScript}" "$previous_sha"
`;
}

export function renderSourceLaunchdPlist(plan) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(plan.paths.supervisorScript)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(plan.paths.logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(plan.paths.logDir, "launchd.err.log"))}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(plan.paths.repoDir)}</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
</dict>
</plist>
`;
}

export function renderSourceRunbook(plan) {
  return `# AgentDash Mac Mini Source-Checkout Runbook

This host is configured for a private, authenticated AgentDash source-checkout deployment managed by launchd.

Use this mode when Docker is unavailable on the first design-partner Mac mini. It must still be pinned to a reviewed git SHA and must pass the same readiness gates as the Docker package.

## Paths

- Repository: \`${plan.paths.repoDir}\`
- Expected SHA prefix: \`${plan.targetSha}\`
- Env file: \`${plan.paths.envFile}\` (mode 600)
- Launchd plist: \`${plan.paths.plist}\`
- Logs: \`${plan.paths.logDir}\`
- Deploy receipts: \`${path.join(plan.paths.stateDir, "receipts")}\`
- Backups: \`${plan.paths.backupDir}\`

## Service

\`\`\`sh
launchctl bootstrap gui/$(id -u) ${plan.paths.plist}
launchctl kickstart -k gui/$(id -u)/${plan.label}
launchctl bootout gui/$(id -u) ${plan.paths.plist}
tail -f ${path.join(plan.paths.logDir, "launchd.err.log")}
\`\`\`

## Update

\`\`\`sh
${plan.paths.updateScript} <commit-sha>
\`\`\`

The update wrapper runs a database backup, fetches the reviewed SHA, checks it out detached, installs dependencies, builds, restarts launchd, runs readiness proof, and writes a deploy receipt.

## Rollback rehearsal

\`\`\`sh
${plan.paths.rollbackScript}
\`\`\`

Rollback uses the previous SHA from deployment state. Restore a database backup only after explicit human approval.
`;
}

function writeFileMode(filePath, content, mode) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { mode });
  chmodSync(filePath, mode);
}

export async function runMacMiniSourceLaunchdInstall(input = {}) {
  const plan = buildMacMiniSourceLaunchdPlan(input);
  const rendered = {
    env: mergeSourceEnv(
      existsSync(plan.paths.envFile) ? readFileSync(plan.paths.envFile, "utf8") : "",
      plan,
    ),
    supervisor: renderSourceSupervisorScript(plan),
    backup: renderSourceBackupScript(plan),
    readiness: renderSourceReadinessScript(plan),
    update: renderSourceUpdateScript(plan),
    rollback: renderSourceRollbackScript(plan),
    plist: renderSourceLaunchdPlist(plan),
    runbook: renderSourceRunbook(plan),
  };

  if (input.dryRun || !input.write) {
    return { dryRun: true, plan, rendered };
  }

  mkdirSync(plan.paths.binDir, { recursive: true });
  mkdirSync(plan.paths.logDir, { recursive: true });
  mkdirSync(plan.paths.backupDir, { recursive: true });
  mkdirSync(plan.paths.stateDir, { recursive: true });
  mkdirSync(path.dirname(plan.paths.plist), { recursive: true });
  mkdirSync(path.dirname(plan.paths.envFile), { recursive: true });

  writeFileMode(plan.paths.envFile, rendered.env, 0o600);
  writeFileMode(plan.paths.supervisorScript, rendered.supervisor, 0o755);
  writeFileMode(plan.paths.backupScript, rendered.backup, 0o755);
  writeFileMode(plan.paths.readinessScript, rendered.readiness, 0o755);
  writeFileMode(plan.paths.updateScript, rendered.update, 0o755);
  writeFileMode(plan.paths.rollbackScript, rendered.rollback, 0o755);
  writeFileMode(plan.paths.plist, rendered.plist, 0o644);
  writeFileMode(plan.paths.runbook, rendered.runbook, 0o644);

  return { dryRun: false, plan, rendered };
}

function printHelp() {
  console.log(`Usage:
  node scripts/deploy/agentdash-mac-mini-source-launchd.mjs --repo-dir <path> --target-sha <git-sha> --public-url http://<tailnet-host>:3100 [options]

Options:
  --repo-dir <path>             Source checkout directory.
  --target-sha <sha>            Required reviewed git SHA to run.
  --public-url <url>            Required private/Tailscale URL.
  --runtime-env-file <path>     Default: ~/.config/agentdash/agentdash.env.
  --agentdash-home <path>       Default: ~/.agentdash.
  --paperclip-home <path>       Default: ~/.paperclip.
  --launch-agent-dir <path>     Default: ~/Library/LaunchAgents.
  --label <label>               Default: ai.agentdash.agent.
  --better-auth-secret <value>  Optional; generated when missing and env lacks one.
  --agent-jwt-secret <value>    Optional; generated when missing and env lacks one.
  --paperclip-port <port>       Default: 3100.
  --write                       Write files. Without this, prints a dry-run plan.
  --help                        Show help.
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "repo-dir": { type: "string" },
      "target-sha": { type: "string" },
      "public-url": { type: "string" },
      "runtime-env-file": { type: "string" },
      "agentdash-home": { type: "string" },
      "paperclip-home": { type: "string" },
      "launch-agent-dir": { type: "string" },
      label: { type: "string" },
      "better-auth-secret": { type: "string" },
      "agent-jwt-secret": { type: "string" },
      "paperclip-port": { type: "string" },
      write: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const result = await runMacMiniSourceLaunchdInstall({
    repoDir: values["repo-dir"],
    targetSha: values["target-sha"],
    publicUrl: values["public-url"],
    envFile: values["runtime-env-file"],
    agentdashHome: values["agentdash-home"],
    paperclipHome: values["paperclip-home"],
    launchAgentDir: values["launch-agent-dir"],
    label: values.label,
    betterAuthSecret: values["better-auth-secret"],
    agentJwtSecret: values["agent-jwt-secret"],
    paperclipPort: values["paperclip-port"],
    write: values.write,
  });

  console.log(JSON.stringify({
    dryRun: result.dryRun,
    mode: result.plan.mode,
    label: result.plan.label,
    targetSha: result.plan.targetSha,
    paths: result.plan.paths,
    env: {
      PAPERCLIP_PUBLIC_URL: result.plan.env.PAPERCLIP_PUBLIC_URL,
      PAPERCLIP_DEPLOYMENT_MODE: result.plan.env.PAPERCLIP_DEPLOYMENT_MODE,
      PAPERCLIP_DEPLOYMENT_EXPOSURE: result.plan.env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
      AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT: result.plan.env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT,
    },
    next: result.dryRun
      ? "Re-run with --write to create files, then review RUNBOOK.md before launchctl bootstrap/kickstart."
      : "Review RUNBOOK.md, then run launchctl bootstrap/kickstart when ready.",
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[agentdash-mac-mini-source-launchd] ${error.message}`);
    process.exitCode = 1;
  });
}
