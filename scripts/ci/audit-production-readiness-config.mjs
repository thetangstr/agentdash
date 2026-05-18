#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const DEFAULT_REQUIRED_ENVIRONMENTS = ["npm-canary", "npm-stable"];
const DEFAULT_TARGET_RUNNER_VARIABLE = "AGENTDASH_TARGET_RUNNER_LABELS";

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "",
    output: "",
    allowGitHubHostedTarget: false,
    targetRunnerVariable: DEFAULT_TARGET_RUNNER_VARIABLE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-github-hosted-target") {
      args.allowGitHubHostedTarget = true;
      continue;
    }
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
    else if (key === "output") args.output = value;
    else if (key === "target-runner-variable") args.targetRunnerVariable = value;
    else throw new Error(`unknown argument: --${key}`);
  }

  if (!args.repo) {
    throw new Error("--repo or GITHUB_REPOSITORY is required");
  }

  return args;
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function parseRunnerLabels(value) {
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

function isGitHubHostedLabelSet(labels) {
  return labels.length === 1 && /^(ubuntu|macos|windows)-/.test(labels[0]);
}

function runnerHasLabels(runner, labels) {
  const runnerLabels = new Set((runner.labels || []).map((label) => String(label).toLowerCase()));
  return labels.every((label) => runnerLabels.has(String(label).toLowerCase()));
}

function requirement(id, status, message, evidence = {}) {
  return { id, status, message, evidence };
}

export function auditProductionReadinessConfig(input, options = {}) {
  const variables = Array.isArray(input.variables) ? input.variables : [];
  const secrets = Array.isArray(input.secrets) ? input.secrets : [];
  const runners = Array.isArray(input.runners) ? input.runners : [];
  const environments = Array.isArray(input.environments) ? input.environments : [];
  const targetRunnerVariable = options.targetRunnerVariable || DEFAULT_TARGET_RUNNER_VARIABLE;
  const allowGitHubHostedTarget = Boolean(options.allowGitHubHostedTarget);
  const requiredEnvironments = options.requiredEnvironments || DEFAULT_REQUIRED_ENVIRONMENTS;

  const requirements = [];
  const targetVariable = variables.find((variable) => variable.name === targetRunnerVariable);
  const targetLabels = parseRunnerLabels(targetVariable?.value || "");

  if (!targetVariable) {
    requirements.push(
      requirement(
        "target-runner-variable",
        "fail",
        `Repository variable ${targetRunnerVariable} is missing; scheduled target-machine tests will use the GitHub-hosted fallback.`,
        { variable: targetRunnerVariable },
      ),
    );
  } else if (targetLabels.length === 0) {
    requirements.push(
      requirement(
        "target-runner-variable",
        "fail",
        `Repository variable ${targetRunnerVariable} is not a JSON array of runner labels.`,
        { variable: targetRunnerVariable, value: targetVariable.value },
      ),
    );
  } else if (isGitHubHostedLabelSet(targetLabels) && !allowGitHubHostedTarget) {
    requirements.push(
      requirement(
        "target-runner-variable",
        "fail",
        `Repository variable ${targetRunnerVariable} points at ${JSON.stringify(
          targetLabels,
        )}, which is not real target-machine coverage.`,
        { variable: targetRunnerVariable, labels: targetLabels },
      ),
    );
  } else {
    requirements.push(
      requirement("target-runner-variable", "pass", `Repository variable ${targetRunnerVariable} is configured.`, {
        variable: targetRunnerVariable,
        labels: targetLabels,
      }),
    );
  }

  if (targetLabels.length > 0 && !isGitHubHostedLabelSet(targetLabels)) {
    const matchingRunners = runners.filter((runner) => runnerHasLabels(runner, targetLabels));
    if (matchingRunners.length === 0) {
      requirements.push(
        requirement("target-runner-available", "fail", "No self-hosted runner currently advertises the configured target labels.", {
          labels: targetLabels,
          runnerCount: runners.length,
        }),
      );
    } else if (matchingRunners.some((runner) => runner.status === "online" && !runner.busy)) {
      requirements.push(
        requirement("target-runner-available", "pass", "A matching self-hosted target runner is online and idle.", {
          labels: targetLabels,
          matchingRunners: matchingRunners.map((runner) => runner.name),
        }),
      );
    } else {
      requirements.push(
        requirement("target-runner-available", "fail", "Matching self-hosted target runners exist but none is online and idle.", {
          labels: targetLabels,
          matchingRunners: matchingRunners.map((runner) => ({
            name: runner.name,
            status: runner.status,
            busy: runner.busy,
          })),
        }),
      );
    }
  } else if (targetLabels.length === 0) {
    requirements.push(
      requirement("target-runner-available", "fail", "No target runner labels are configured, and no target runner can be matched.", {
        runnerCount: runners.length,
      }),
    );
  } else if (allowGitHubHostedTarget) {
    requirements.push(
      requirement("target-runner-available", "pass", "GitHub-hosted target validation is explicitly allowed for this audit.", {
        labels: targetLabels,
      }),
    );
  }

  const environmentNames = new Set(environments.map((environment) => environment.name));
  for (const environmentName of requiredEnvironments) {
    if (environmentNames.has(environmentName)) {
      const environment = environments.find((item) => item.name === environmentName);
      requirements.push(
        requirement("release-environment", "pass", `Release environment ${environmentName} exists.`, {
          environment: environmentName,
          protectionRuleCount: environment?.protection_rules?.length || 0,
        }),
      );
    } else {
      requirements.push(
        requirement("release-environment", "fail", `Release environment ${environmentName} is missing.`, {
          environment: environmentName,
        }),
      );
    }
  }

  const manualChecks = [
    "Confirm npm trusted publishing is configured for every public package published by scripts/release.sh.",
    "Confirm the stable release workflow is manually approved before running dry_run=false.",
    "Confirm production deployment secrets and service credentials are configured in the cloud host, not only in GitHub Actions.",
  ];

  const failed = requirements.filter((item) => item.status === "fail");
  return {
    conclusion: failed.length > 0 ? "failure" : "success",
    checkedAt: input.checkedAt || new Date().toISOString(),
    repository: input.repository || "",
    requirements,
    manualChecks,
    observations: {
      repositorySecretCount: secrets.length,
      repositoryVariableCount: variables.length,
      selfHostedRunnerCount: runners.length,
    },
  };
}

async function collectGitHubConfig(repo) {
  const runnersJq = "{runners: [.runners[] | {name: .name, status: .status, busy: .busy, labels: [.labels[].name]}]}";
  const environmentsJq = "{environments: [.environments[] | {name: .name, protection_rules: .protection_rules}]}";
  const [variables, secrets, runnersResult, environmentsResult] = await Promise.all([
    runGhJson(`gh variable list --repo ${shellQuote(repo)} --json name,value,updatedAt`),
    runGhJson(`gh secret list --repo ${shellQuote(repo)} --json name,updatedAt`),
    runGhJson(`gh api ${shellQuote(`repos/${repo}/actions/runners`)} --jq ${shellQuote(runnersJq)}`),
    runGhJson(`gh api ${shellQuote(`repos/${repo}/environments`)} --jq ${shellQuote(environmentsJq)}`),
  ]);

  return {
    repository: repo,
    variables: variables || [],
    secrets: secrets || [],
    runners: runnersResult?.runners || [],
    environments: environmentsResult?.environments || [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await collectGitHubConfig(args.repo);
  const result = auditProductionReadinessConfig(config, {
    allowGitHubHostedTarget: args.allowGitHubHostedTarget,
    targetRunnerVariable: args.targetRunnerVariable,
  });

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    writeFileSync(args.output, json);
  }
  process.stdout.write(json);
  if (result.conclusion !== "success") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
