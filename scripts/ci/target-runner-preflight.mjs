#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const DEFAULT_FALLBACK_LABELS = ["ubuntu-latest"];

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "",
    requestedLabels: "",
    fallbackLabels: JSON.stringify(DEFAULT_FALLBACK_LABELS),
    output: "",
    githubOutput: "",
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
    if (key === "repo") args.repo = value;
    else if (key === "requested-labels") args.requestedLabels = value;
    else if (key === "fallback-labels") args.fallbackLabels = value;
    else if (key === "output") args.output = value;
    else if (key === "github-output") args.githubOutput = value;
    else throw new Error(`unknown argument: --${key}`);
  }

  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runGhJson(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `command failed: ${command}`));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (error) {
        reject(new Error(`failed to parse JSON from command: ${command}\n${error.message}`));
      }
    });
  });
}

export function parseRunnerLabels(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((label) => typeof label === "string" && label.trim()).map((label) => label.trim());
}

export function isGitHubHostedLabelSet(labels) {
  return labels.length === 1 && /^(ubuntu|macos|windows)-/.test(labels[0]);
}

function runnerHasLabels(runner, labels) {
  const runnerLabels = new Set((runner.labels || []).map((label) => String(label).toLowerCase()));
  return labels.every((label) => runnerLabels.has(String(label).toLowerCase()));
}

function failureResult({ runnerLabels, firstFailure, errorHead, evidence = {} }) {
  return {
    conclusion: "failure",
    runnerLabels,
    preflightFailed: true,
    failure: {
      commandName: "target-runner-preflight",
      command: "resolve target runner labels",
      exitCode: 1,
      firstFailure,
      errorHead: errorHead || firstFailure,
      logPath: "target-runner-preflight",
    },
    evidence,
  };
}

export function evaluateTargetRunnerPreflight(input = {}) {
  const requestedLabels = parseRunnerLabels(input.requestedLabels);
  const fallbackLabels = parseRunnerLabels(input.fallbackLabels) || DEFAULT_FALLBACK_LABELS;
  const runnerLabels = fallbackLabels.length > 0 ? fallbackLabels : DEFAULT_FALLBACK_LABELS;

  if (requestedLabels.length === 0) {
    return failureResult({
      runnerLabels,
      firstFailure: "Target runner labels are not a valid JSON array of strings.",
      errorHead: `Requested runner labels: ${input.requestedLabels || ""}`,
      evidence: { requestedLabels: input.requestedLabels || "" },
    });
  }

  if (isGitHubHostedLabelSet(requestedLabels)) {
    return {
      conclusion: "success",
      runnerLabels: requestedLabels,
      preflightFailed: false,
      failure: null,
      evidence: { requestedLabels, runnerMode: "github-hosted" },
    };
  }

  if (input.runnerInventoryError) {
    return failureResult({
      runnerLabels,
      firstFailure: "Could not inspect self-hosted target runner inventory.",
      errorHead: input.runnerInventoryError,
      evidence: { requestedLabels, runnerInventoryError: input.runnerInventoryError },
    });
  }

  const runners = Array.isArray(input.runners) ? input.runners : [];
  const matchingRunners = runners.filter((runner) => runnerHasLabels(runner, requestedLabels));
  const onlineRunners = matchingRunners.filter((runner) => runner.status === "online");

  if (matchingRunners.length === 0) {
    return failureResult({
      runnerLabels,
      firstFailure: `No self-hosted runner advertises labels ${JSON.stringify(requestedLabels)}.`,
      errorHead: `Configured labels: ${JSON.stringify(requestedLabels)}\nRegistered runner count: ${runners.length}`,
      evidence: { requestedLabels, runnerCount: runners.length },
    });
  }

  if (onlineRunners.length === 0) {
    return failureResult({
      runnerLabels,
      firstFailure: `Matching self-hosted runners exist for ${JSON.stringify(requestedLabels)} but none is online.`,
      errorHead: JSON.stringify(
        matchingRunners.map((runner) => ({ name: runner.name, status: runner.status, busy: runner.busy })),
        null,
        2,
      ),
      evidence: {
        requestedLabels,
        matchingRunners: matchingRunners.map((runner) => ({ name: runner.name, status: runner.status, busy: runner.busy })),
      },
    });
  }

  return {
    conclusion: "success",
    runnerLabels: requestedLabels,
    preflightFailed: false,
    failure: null,
    evidence: {
      requestedLabels,
      matchingRunners: matchingRunners.map((runner) => ({ name: runner.name, status: runner.status, busy: runner.busy })),
    },
  };
}

async function collectRunnerInventory(repo, requestedLabels) {
  if (isGitHubHostedLabelSet(requestedLabels)) return { runners: [], error: "" };
  if (!repo) return { runners: [], error: "--repo or GITHUB_REPOSITORY is required for self-hosted runner preflight" };

  const runnersJq = "{runners: [.runners[] | {name: .name, status: .status, busy: .busy, labels: [.labels[].name]}]}";
  try {
    const result = await runGhJson(`gh api ${shellQuote(`repos/${repo}/actions/runners`)} --jq ${shellQuote(runnersJq)}`);
    return { runners: result?.runners || [], error: "" };
  } catch (error) {
    return { runners: [], error: error.message };
  }
}

function appendGitHubOutput(path, name, value) {
  if (!path) return;
  const text = String(value ?? "");
  if (!text.includes("\n")) {
    appendFileSync(path, `${name}=${text}\n`);
    return;
  }
  const delimiter = `EOF_${name}_${Date.now()}`;
  appendFileSync(path, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestedLabels = parseRunnerLabels(args.requestedLabels);
  const inventory = await collectRunnerInventory(args.repo, requestedLabels);
  const result = evaluateTargetRunnerPreflight({
    requestedLabels: args.requestedLabels,
    fallbackLabels: args.fallbackLabels,
    runners: inventory.runners,
    runnerInventoryError: inventory.error,
  });

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) writeFileSync(args.output, json);
  appendGitHubOutput(args.githubOutput, "runner_labels", JSON.stringify(result.runnerLabels));
  appendGitHubOutput(args.githubOutput, "preflight_failed", String(result.preflightFailed));
  appendGitHubOutput(args.githubOutput, "preflight_first_failure", result.failure?.firstFailure || "");
  appendGitHubOutput(args.githubOutput, "preflight_error_head", result.failure?.errorHead || "");
  process.stdout.write(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
