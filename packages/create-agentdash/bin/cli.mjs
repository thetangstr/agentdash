#!/usr/bin/env node
// create-agentdash — npx-friendly AgentDash bootstrapper.
//
// What it does:
//   1. Pre-flight: git, node ≥ 20, pnpm
//   2. git clone the public AgentDash repo to a target dir
//   3. pnpm install (workspace deps)
//   4. pnpm install-cli (symlinks `agentdash` onto PATH)
//   5. Tells you to run `agentdash setup`
//
// This file ships in the published `create-agentdash` npm package and
// is invoked by `npx create-agentdash [target-dir]`.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const REPO_URL = process.env.AGENTDASH_REPO_URL ?? "https://github.com/thetangstr/agentdash.git";
const DEFAULT_TARGET = resolve(homedir(), "agentdash");

function log(msg) {
  process.stdout.write(`agentdash: ${msg}\n`);
}
function err(msg) {
  process.stderr.write(`agentdash: ${msg}\n`);
}

function bail(msg, exitCode = 1) {
  err(msg);
  process.exit(exitCode);
}

function requireCmd(cmd, hint) {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    bail(`\`${cmd}\` is required but not found. ${hint}`);
  }
}

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 20) {
    bail(`Node ${process.version} is too old — AgentDash requires Node 20+.`);
  }
}

function runStep(label, cmd, args, opts = {}) {
  log(label);
  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", rejectStep);
    child.on("exit", (code) => {
      if (code === 0) resolveStep();
      else rejectStep(new Error(`${cmd} ${args.join(" ")} exited ${code ?? "?"}`));
    });
  });
}

async function main() {
  // Argv: [node, cli.mjs, ...userArgs]
  const userArgs = process.argv.slice(2);
  const targetArg = userArgs.find((arg) => !arg.startsWith("-"));
  const targetDir = resolve(targetArg ?? DEFAULT_TARGET);

  checkNodeVersion();
  requireCmd("git", "Install with your OS package manager (e.g. `brew install git`).");
  requireCmd("pnpm", "Install with `npm install -g pnpm` or `corepack enable && corepack prepare pnpm@latest --activate`.");

  // 1. Clone
  if (existsSync(targetDir)) {
    if (!existsSync(`${targetDir}/.git`)) {
      bail(`${targetDir} exists but isn't a git repo. Pick a different path or remove it.`);
    }
    await runStep(`updating existing checkout at ${targetDir}…`, "git", ["-C", targetDir, "pull", "--ff-only"]);
  } else {
    await runStep(`cloning into ${targetDir}…`, "git", ["clone", REPO_URL, targetDir]);
  }

  // 2. pnpm install
  await runStep("installing workspace dependencies (pnpm install)…", "pnpm", ["install", "--silent"], { cwd: targetDir });

  // 3. pnpm install-cli — puts `agentdash` on PATH
  await runStep("linking the CLI onto your PATH…", "pnpm", ["install-cli"], { cwd: targetDir });

  // 4. Done
  process.stdout.write(`
──────────────────────────────────────────────────
✓ AgentDash installed at ${targetDir}

Next:
  agentdash setup       (2 prompts: pick adapter + your email)

Then:
  cd ${targetDir} && pnpm dev
  open http://localhost:3100/cos

If \`agentdash\` isn't on your PATH yet, the install-cli step above
already printed the \`export PATH=…\` line you need to add to your
shell rc.

Docs: ${REPO_URL.replace(/\.git$/, "")}
──────────────────────────────────────────────────
`);
}

main().catch((error) => {
  err(error?.message ?? String(error));
  process.exit(1);
});
