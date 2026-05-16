#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = {
    profile: "core",
    requestedRef: "",
    summary: "target-test/summary.json",
    logsDir: "target-test/logs",
    artifactName: "",
    paperclipVersion: "canary",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    index += 1;
    if (key === "profile") args.profile = value;
    else if (key === "requested-ref") args.requestedRef = value;
    else if (key === "summary") args.summary = value;
    else if (key === "logs-dir") args.logsDir = value;
    else if (key === "artifact-name") args.artifactName = value;
    else if (key === "paperclip-version") args.paperclipVersion = value;
    else throw new Error(`unknown argument: --${key}`);
  }

  return args;
}

function runSmallCommand(command) {
  return new Promise((resolveCommand) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (status) => {
      resolveCommand(status === 0 ? output.trim() : "");
    });
  });
}

function sanitizeLogName(name) {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "command";
}

function extractErrorHead(logPath) {
  if (!existsSync(logPath)) return "";
  const content = readFileSync(logPath, "utf8");
  if (!content.trim()) return "";

  const lines = content.split(/\r?\n/);
  const interestingIndex = lines.findIndex((line) =>
    /\b(FAIL|Failed|failed|Error|AssertionError|TypeError|ReferenceError|SyntaxError)\b/.test(line),
  );
  const start = interestingIndex >= 0 ? Math.max(0, interestingIndex - 8) : Math.max(0, lines.length - 80);
  return lines.slice(start, start + 120).join("\n").slice(0, 12000);
}

function firstFailureLine(errorHead) {
  return (
    errorHead
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /\b(FAIL|Failed|failed|Error|AssertionError|TypeError|ReferenceError|SyntaxError)\b/.test(line)) ||
    errorHead.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ||
    ""
  );
}

async function runCommand({ name, command, env = {} }, logsDir) {
  mkdirSync(logsDir, { recursive: true });
  const logPath = resolve(logsDir, `${sanitizeLogName(name)}.log`);
  const logStream = createWriteStream(logPath, { flags: "w" });

  console.log(`::group::${name}`);
  console.log(`$ ${command}`);

  const startedAt = new Date().toISOString();
  const status = await new Promise((resolveStatus) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });
    child.on("close", (exitCode) => {
      resolveStatus(exitCode ?? 1);
    });
  });
  const finishedAt = new Date().toISOString();
  logStream.end();

  console.log(`::endgroup::`);

  const result = {
    name,
    command,
    exitCode: status,
    logPath,
    startedAt,
    finishedAt,
  };
  if (status !== 0) {
    result.errorHead = extractErrorHead(logPath);
    result.firstFailure = firstFailureLine(result.errorHead);
  }
  return result;
}

function coreCommands() {
  return [
    { name: "typecheck", command: "pnpm -r typecheck" },
    { name: "vitest", command: "pnpm test:run" },
    { name: "build", command: "pnpm build" },
  ];
}

function browserCommands() {
  return [
    ...coreCommands(),
    { name: "playwright-install", command: "npx playwright install --with-deps chromium" },
    {
      name: "e2e",
      command: "pnpm run test:e2e",
      env: {
        PAPERCLIP_E2E_SKIP_LLM: "true",
        AGENTDASH_DEEP_INTERVIEW_ASSESS: "true",
        AGENTDASH_ALLOW_MULTI_COMPANY: "true",
        AGENTDASH_RATE_LIMIT_DISABLED: "true",
        AGENTDASH_ADAPTER_ENV_BYPASS: "true",
      },
    },
  ];
}

function releaseSmokeCommands({ paperclipVersion, logsDir }) {
  const metadataFile = resolve(logsDir, "../release-smoke.env");
  const dataDir = resolve(logsDir, "../release-smoke-data");
  const dockerLogPath = resolve(logsDir, "docker-onboard-smoke.log");
  const command = [
    "set -euo pipefail",
    `metadata_file=${JSON.stringify(metadataFile)}`,
    `docker_log_path=${JSON.stringify(dockerLogPath)}`,
    `HOST_PORT="\${HOST_PORT:-3232}" DATA_DIR=${JSON.stringify(dataDir)} PAPERCLIPAI_VERSION=${JSON.stringify(paperclipVersion)} SMOKE_DETACH=true SMOKE_METADATA_FILE="$metadata_file" ./scripts/docker-onboard-smoke.sh`,
    "set -a",
    "source \"$metadata_file\"",
    "set +a",
    "cleanup_smoke() {",
    "  if [ -n \"${SMOKE_CONTAINER_NAME:-}\" ]; then",
    "    docker logs \"$SMOKE_CONTAINER_NAME\" >\"$docker_log_path\" 2>&1 || true",
    "    docker rm -f \"$SMOKE_CONTAINER_NAME\" >/dev/null 2>&1 || true",
    "  fi",
    "}",
    "trap cleanup_smoke EXIT",
    "PAPERCLIP_RELEASE_SMOKE_BASE_URL=\"$SMOKE_BASE_URL\" PAPERCLIP_RELEASE_SMOKE_EMAIL=\"$SMOKE_ADMIN_EMAIL\" PAPERCLIP_RELEASE_SMOKE_PASSWORD=\"$SMOKE_ADMIN_PASSWORD\" pnpm run test:release-smoke",
  ].join("\n");

  return [
    { name: "playwright-install", command: "npx playwright install --with-deps chromium" },
    { name: "release-smoke", command },
  ];
}

function fullCommands() {
  return [
    ...browserCommands(),
    {
      name: "openclaw-smoke-preflight",
      command: "bash -n scripts/smoke/openclaw-join.sh scripts/smoke/openclaw-gateway-e2e.sh",
    },
    {
      name: "openclaw-smoke",
      command:
        'if [ "${AGENTDASH_RUN_OPENCLAW_SMOKE:-false}" = "true" ]; then pnpm run smoke:openclaw-join && pnpm run smoke:openclaw-gateway-e2e; else echo "Skipping OpenClaw smoke; set AGENTDASH_RUN_OPENCLAW_SMOKE=true on a prepared target runner to enable it."; fi',
    },
  ];
}

function commandsForProfile(profile, options) {
  if (profile === "core") return coreCommands();
  if (profile === "browser") return browserCommands();
  if (profile === "release-smoke") return releaseSmokeCommands(options);
  if (profile === "full") return fullCommands();
  throw new Error(`unsupported profile: ${profile}`);
}

async function collectMetadata(args) {
  const [commit, nodeVersion, pnpmVersion, osDescription] = await Promise.all([
    runSmallCommand("git rev-parse HEAD"),
    runSmallCommand("node --version"),
    runSmallCommand("pnpm --version"),
    runSmallCommand("uname -a"),
  ]);

  return {
    profile: args.profile,
    requestedRef: args.requestedRef,
    commit,
    nodeVersion,
    pnpmVersion,
    osDescription,
    runnerName: process.env.RUNNER_NAME || "",
    runnerOs: process.env.RUNNER_OS || process.platform,
    runnerArch: process.env.RUNNER_ARCH || process.arch,
    workflowRunUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "",
    repository: process.env.GITHUB_REPOSITORY || "",
    artifactName: args.artifactName,
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summaryPath = resolve(repoRoot, args.summary);
  const logsDir = resolve(repoRoot, args.logsDir);
  mkdirSync(dirname(summaryPath), { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const metadata = await collectMetadata(args);
  const commands = commandsForProfile(args.profile, { ...args, logsDir });
  const results = [];
  let failure = null;

  for (const command of commands) {
    const result = await runCommand(command, logsDir);
    results.push(result);
    if (result.exitCode !== 0) {
      failure = {
        commandName: result.name,
        command: result.command,
        exitCode: result.exitCode,
        logPath: result.logPath,
        firstFailure: result.firstFailure || "",
        errorHead: result.errorHead || "",
      };
      break;
    }
  }

  const summary = {
    ...metadata,
    conclusion: failure ? "failure" : "success",
    commands: results,
    failure,
  };

  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Target test summary written to ${summaryPath}`);
  if (failure) {
    console.log(`Target test profile failed at ${failure.commandName}`);
  } else {
    console.log(`Target test profile ${args.profile} passed`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
