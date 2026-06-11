#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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
const DEFAULT_HEALTH_INTERVAL_SEC = 30;

function repoPath(relativePath) {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", relativePath);
}

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

function assertPinnedShaImage(targetImage) {
  if (typeof targetImage !== "string" || targetImage.trim().length === 0) {
    throw new Error("targetImage is required and must be pinned to a sha-<commit> tag.");
  }
  const tag = targetImage.split(":").pop() ?? "";
  if (!/^sha-[0-9a-f]{7,40}$/i.test(tag)) {
    throw new Error("Production Mac mini installs require a pinned image tag like ghcr.io/<owner>/<repo>:sha-<commit>.");
  }
}

function imageRepoFromImage(targetImage) {
  const index = targetImage.lastIndexOf(":");
  return index > 0 ? targetImage.slice(0, index) : targetImage;
}

export function buildMacMiniLaunchdPlan(input = {}) {
  const installDir = abs(input.installDir ?? "/opt/agentdash");
  const launchAgentDir = abs(input.launchAgentDir ?? path.join(os.homedir(), "Library", "LaunchAgents"));
  const label = input.label ?? DEFAULT_LABEL;
  const targetImage = input.targetImage ?? "";
  assertPinnedShaImage(targetImage);

  const publicUrl = input.publicUrl ?? input.baseUrl;
  if (!publicUrl) {
    throw new Error("publicUrl is required. Use the Tailscale/private URL operators will open in the browser.");
  }

  const paperclipPort = Number(input.paperclipPort ?? DEFAULT_PORT);
  const envFile = input.envFile ? abs(input.envFile) : path.join(installDir, "agentdash.env");
  const composeFile = input.composeFile ? abs(input.composeFile) : path.join(installDir, "docker-compose.yml");
  const stateDir = input.stateDir ? abs(input.stateDir) : path.join(installDir, "deployments");
  const backupDir = input.backupDir ? abs(input.backupDir) : path.join(installDir, "backups");
  const logDir = input.logDir ? abs(input.logDir) : path.join(installDir, "logs");
  const binDir = path.join(installDir, "bin");
  const imageRepo = input.imageRepo ?? imageRepoFromImage(targetImage);

  const paths = {
    installDir,
    binDir,
    envFile,
    composeFile,
    stateDir,
    backupDir,
    logDir,
    plist: path.join(launchAgentDir, `${label}.plist`),
    supervisorScript: path.join(binDir, "agentdash-compose-supervisor.sh"),
    backupScript: path.join(binDir, "agentdash-backup-db.sh"),
    readinessScript: path.join(binDir, "agentdash-readiness.sh"),
    updateScript: path.join(binDir, "agentdash-update.sh"),
    rollbackScript: path.join(binDir, "agentdash-rollback.sh"),
    otaUpdater: path.join(binDir, "agentdash-ota-update.mjs"),
    runbook: path.join(installDir, "RUNBOOK.md"),
  };

  return {
    version: 1,
    label,
    paths,
    composeSource: input.composeSource ? abs(input.composeSource) : repoPath("docker/docker-compose.production.yml"),
    otaUpdaterSource: input.otaUpdaterSource ? abs(input.otaUpdaterSource) : repoPath("scripts/deploy/agentdash-ota-update.mjs"),
    healthIntervalSec: Number(input.healthIntervalSec ?? DEFAULT_HEALTH_INTERVAL_SEC),
    env: {
      AGENTDASH_IMAGE: targetImage,
      AGENTDASH_IMAGE_REPO: imageRepo,
      AGENTDASH_RUNTIME_ENV_FILE: envFile,
      POSTGRES_USER: input.postgresUser ?? "paperclip",
      POSTGRES_PASSWORD: input.postgresPassword ?? randomSecret(24),
      POSTGRES_DB: input.postgresDb ?? "paperclip",
      PAPERCLIP_PORT: String(paperclipPort),
      PAPERCLIP_PUBLIC_URL: publicUrl,
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT: "true",
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
      BETTER_AUTH_SECRET: input.betterAuthSecret ?? randomSecret(32),
      AGENTDASH_DEPLOY_COMPOSE_FILE: composeFile,
      AGENTDASH_DEPLOY_ENV_FILE: envFile,
      AGENTDASH_DEPLOY_STATE_DIR: stateDir,
      AGENTDASH_BACKUP_COMMAND: paths.backupScript,
      AGENTDASH_READINESS_COMMAND: paths.readinessScript,
    },
  };
}

export function renderMacMiniEnv(plan) {
  const lines = [
    "# AgentDash Mac mini production runtime",
    "# Mode 600. Do not commit or share this file.",
    "",
  ];
  for (const [key, value] of Object.entries(plan.env)) {
    lines.push(`${key}=${value}`);
  }
  lines.push(
    "",
    "# Optional provider keys and product services:",
    "# OPENAI_API_KEY=",
    "# ANTHROPIC_API_KEY=",
    "# RESEND_API_KEY=",
    "# STRIPE_SECRET_KEY=",
    "",
  );
  return lines.join("\n");
}

export function renderSupervisorScript(plan) {
  return `#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
INSTALL_DIR="${plan.paths.installDir}"
ENV_FILE="${plan.paths.envFile}"
COMPOSE_FILE="${plan.paths.composeFile}"
HEALTH_URL="${plan.env.PAPERCLIP_PUBLIC_URL.replace(/\/+$/, "")}/api/health"

cd "$INSTALL_DIR"
mkdir -p "${plan.paths.logDir}" "${plan.paths.backupDir}" "${plan.paths.stateDir}"

stop_server() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop server >/dev/null 2>&1 || true
}
trap stop_server TERM INT

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d db server

while true; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    sleep ${plan.healthIntervalSec}
    continue
  fi
  echo "AgentDash health check failed at $HEALTH_URL" >&2
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps >&2 || true
  exit 1
done
`;
}

export function renderBackupScript(plan) {
  return `#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
INSTALL_DIR="${plan.paths.installDir}"
ENV_FILE="${plan.paths.envFile}"
COMPOSE_FILE="${plan.paths.composeFile}"
BACKUP_DIR="${plan.paths.backupDir}"
mkdir -p "$BACKUP_DIR"
set -a
. "$ENV_FILE"
set +a

output="$BACKUP_DIR/predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \\
  pg_dump -U "\${POSTGRES_USER:-paperclip}" -d "\${POSTGRES_DB:-paperclip}" -Fc > "$output"
chmod 600 "$output"
echo "$output"
`;
}

export function renderReadinessScript(plan) {
  return `#!/bin/bash
set -euo pipefail

HEALTH_URL="${plan.env.PAPERCLIP_PUBLIC_URL.replace(/\/+$/, "")}/api/health"
curl -fsS "$HEALTH_URL"
`;
}

export function renderUpdateScript(plan) {
  return `#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <commit-sha>" >&2
  exit 2
fi

node "${plan.paths.otaUpdater}" \\
  --target-sha "$1" \\
  --image-repo "${plan.env.AGENTDASH_IMAGE_REPO}" \\
  --compose-file "${plan.paths.composeFile}" \\
  --runtime-env-file "${plan.paths.envFile}" \\
  --state-dir "${plan.paths.stateDir}" \\
  --base-url "${plan.env.PAPERCLIP_PUBLIC_URL}" \\
  --backup-command "${plan.paths.backupScript}" \\
  --readiness-command "${plan.paths.readinessScript}"
`;
}

export function renderRollbackScript(plan) {
  return `#!/bin/bash
set -euo pipefail

node "${plan.paths.otaUpdater}" \\
  --rollback \\
  --compose-file "${plan.paths.composeFile}" \\
  --runtime-env-file "${plan.paths.envFile}" \\
  --state-dir "${plan.paths.stateDir}" \\
  --base-url "${plan.env.PAPERCLIP_PUBLIC_URL}" \\
  --backup-command "${plan.paths.backupScript}" \\
  --readiness-command "${plan.paths.readinessScript}"
`;
}

export function renderLaunchdPlist(plan) {
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
  <string>${xmlEscape(plan.paths.installDir)}</string>
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

export function renderRunbook(plan) {
  return `# AgentDash Mac Mini Runbook

This host is configured for a private, authenticated AgentDash deployment managed by launchd and Docker Compose.

## Paths

- Install directory: \`${plan.paths.installDir}\`
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

The update wrapper runs a database backup, pins the GHCR SHA image, restarts the server service, checks health, runs readiness proof, and writes a deploy receipt.

## Rollback rehearsal

\`\`\`sh
${plan.paths.rollbackScript}
\`\`\`

Rollback switches to the previous pinned image from deployment state. Restore a database backup only after explicit human approval.

## Readiness Proof

\`\`\`sh
${plan.paths.readinessScript}
curl -fsS ${plan.env.PAPERCLIP_PUBLIC_URL.replace(/\/+$/, "")}/api/health
\`\`\`

Do not expose this Mac mini publicly for week one. Use Tailscale/private routing and authenticated app access.
`;
}

function writeFileMode(filePath, content, mode) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { mode });
  chmodSync(filePath, mode);
}

export async function runMacMiniLaunchdInstall(input = {}) {
  const plan = buildMacMiniLaunchdPlan(input);
  const rendered = {
    env: renderMacMiniEnv(plan),
    supervisor: renderSupervisorScript(plan),
    backup: renderBackupScript(plan),
    readiness: renderReadinessScript(plan),
    update: renderUpdateScript(plan),
    rollback: renderRollbackScript(plan),
    plist: renderLaunchdPlist(plan),
    runbook: renderRunbook(plan),
  };

  if (input.dryRun || !input.write) {
    return { dryRun: true, plan, rendered };
  }

  mkdirSync(plan.paths.installDir, { recursive: true });
  mkdirSync(plan.paths.binDir, { recursive: true });
  mkdirSync(plan.paths.logDir, { recursive: true });
  mkdirSync(plan.paths.backupDir, { recursive: true });
  mkdirSync(plan.paths.stateDir, { recursive: true });
  mkdirSync(path.dirname(plan.paths.plist), { recursive: true });

  copyFileSync(plan.composeSource, plan.paths.composeFile);
  chmodSync(plan.paths.composeFile, 0o644);
  copyFileSync(plan.otaUpdaterSource, plan.paths.otaUpdater);
  chmodSync(plan.paths.otaUpdater, 0o755);

  writeFileMode(plan.paths.envFile, rendered.env, 0o600);
  writeFileMode(plan.paths.supervisorScript, rendered.supervisor, 0o755);
  writeFileMode(plan.paths.backupScript, rendered.backup, 0o755);
  writeFileMode(plan.paths.readinessScript, rendered.readiness, 0o755);
  writeFileMode(plan.paths.updateScript, rendered.update, 0o755);
  writeFileMode(plan.paths.rollbackScript, rendered.rollback, 0o755);
  writeFileMode(plan.paths.plist, rendered.plist, 0o644);
  writeFileMode(plan.paths.runbook, rendered.runbook, 0o644);

  if (input.load) {
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : "$(id -u)"}`;
    spawnSync("launchctl", ["bootout", domain, plan.paths.plist], { stdio: "ignore" });
    const bootstrap = spawnSync("launchctl", ["bootstrap", domain, plan.paths.plist], { stdio: "inherit" });
    if (bootstrap.status !== 0) {
      throw new Error(`launchctl bootstrap failed with exit code ${bootstrap.status}`);
    }
    const kickstart = spawnSync("launchctl", ["kickstart", "-k", `${domain}/${plan.label}`], { stdio: "inherit" });
    if (kickstart.status !== 0) {
      throw new Error(`launchctl kickstart failed with exit code ${kickstart.status}`);
    }
  }

  return { dryRun: false, plan, rendered };
}

function printHelp() {
  console.log(`Usage:
  node scripts/deploy/agentdash-mac-mini-launchd.mjs --target-image ghcr.io/<owner>/<repo>:sha-<commit> --public-url http://<tailnet-host>:3100 [options]

Options:
  --target-image <image>       Required pinned GHCR sha image.
  --image-repo <repo>          Image repository for future OTA updates.
  --public-url <url>           Required private/Tailscale URL for browser and health checks.
  --install-dir <path>         Default: /opt/agentdash.
  --launch-agent-dir <path>    Default: ~/Library/LaunchAgents.
  --label <label>              Default: ai.agentdash.agent.
  --postgres-password <value>  Optional; generated when omitted.
  --better-auth-secret <value> Optional; generated when omitted.
  --paperclip-port <port>      Default: 3100.
  --write                      Write files. Without this, prints a dry-run plan.
  --load                       After --write, bootstrap and kickstart launchd.
  --help                       Show this help.
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "target-image": { type: "string" },
      "image-repo": { type: "string" },
      "public-url": { type: "string" },
      "install-dir": { type: "string" },
      "launch-agent-dir": { type: "string" },
      label: { type: "string" },
      "postgres-password": { type: "string" },
      "better-auth-secret": { type: "string" },
      "paperclip-port": { type: "string" },
      write: { type: "boolean" },
      load: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const result = await runMacMiniLaunchdInstall({
    targetImage: values["target-image"],
    imageRepo: values["image-repo"],
    publicUrl: values["public-url"],
    installDir: values["install-dir"],
    launchAgentDir: values["launch-agent-dir"],
    label: values.label,
    postgresPassword: values["postgres-password"],
    betterAuthSecret: values["better-auth-secret"],
    paperclipPort: values["paperclip-port"],
    write: values.write,
    load: values.load,
  });

  console.log(JSON.stringify({
    dryRun: result.dryRun,
    label: result.plan.label,
    paths: result.plan.paths,
    env: {
      AGENTDASH_IMAGE: result.plan.env.AGENTDASH_IMAGE,
      PAPERCLIP_PUBLIC_URL: result.plan.env.PAPERCLIP_PUBLIC_URL,
      PAPERCLIP_DEPLOYMENT_MODE: result.plan.env.PAPERCLIP_DEPLOYMENT_MODE,
      PAPERCLIP_DEPLOYMENT_EXPOSURE: result.plan.env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
      AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT: result.plan.env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT,
    },
    next: result.dryRun
      ? "Re-run with --write to create files, then --load when ready to start launchd."
      : "Review RUNBOOK.md, then use launchctl bootstrap/kickstart or re-run with --load.",
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[agentdash-mac-mini-launchd] ${error.message}`);
    process.exitCode = 1;
  });
}
