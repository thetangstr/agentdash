#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const DEFAULT_REQUIRED_ENVIRONMENTS = ["npm-canary", "npm-stable"];
const DEFAULT_PROTECTED_BRANCH = "main";
const DEFAULT_REQUIRED_BRANCH_CHECKS = ["audit", "drift", "check", "policy", "e2e", "verify", "config-audit"];
const DEFAULT_TARGET_RUNNER_VARIABLE = "AGENTDASH_TARGET_RUNNER_LABELS";
const DEFAULT_LAUNCH_SMOKE_URL_VARIABLE = "AGENTDASH_LAUNCH_SMOKE_BASE_URL";
const DEFAULT_LAUNCH_SMOKE_BILLING_VARIABLE = "AGENTDASH_LAUNCH_SMOKE_BILLING";
const DEFAULT_LAUNCH_SMOKE_EXPECT_LLM_VARIABLE = "AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM";

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "",
    output: "",
    allowGitHubHostedTarget: false,
    useActionsVarsContext: false,
    targetRunnerVariable: DEFAULT_TARGET_RUNNER_VARIABLE,
    launchSmokeUrlVariable: DEFAULT_LAUNCH_SMOKE_URL_VARIABLE,
    launchSmokeBillingVariable: DEFAULT_LAUNCH_SMOKE_BILLING_VARIABLE,
    launchSmokeExpectLlmVariable: DEFAULT_LAUNCH_SMOKE_EXPECT_LLM_VARIABLE,
    protectedBranch: DEFAULT_PROTECTED_BRANCH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-github-hosted-target") {
      args.allowGitHubHostedTarget = true;
      continue;
    }
    if (arg === "--use-actions-vars-context") {
      args.useActionsVarsContext = true;
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
    else if (key === "protected-branch") args.protectedBranch = value;
    else if (key === "target-runner-variable") args.targetRunnerVariable = value;
    else if (key === "launch-smoke-url-variable") args.launchSmokeUrlVariable = value;
    else if (key === "launch-smoke-billing-variable") args.launchSmokeBillingVariable = value;
    else if (key === "launch-smoke-expect-llm-variable") args.launchSmokeExpectLlmVariable = value;
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

function isLocalLaunchSmokeUrl(url) {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname.endsWith(".localhost")
  );
}

function runnerHasLabels(runner, labels) {
  const runnerLabels = new Set((runner.labels || []).map((label) => String(label).toLowerCase()));
  return labels.every((label) => runnerLabels.has(String(label).toLowerCase()));
}

function requirement(id, status, message, evidence = {}) {
  return { id, status, message, evidence };
}

function hasRequiredReviewerProtection(environment) {
  return (environment?.protection_rules || []).some((rule) => rule?.type === "required_reviewers");
}

function getRequiredStatusChecks(branchProtection) {
  const requiredStatusChecks = branchProtection?.required_status_checks || branchProtection?.protection?.required_status_checks;
  if (!requiredStatusChecks) return [];
  const contexts = Array.isArray(requiredStatusChecks.contexts) ? requiredStatusChecks.contexts : [];
  const checks = Array.isArray(requiredStatusChecks.checks) ? requiredStatusChecks.checks.map((check) => check.context) : [];
  return Array.from(new Set([...contexts, ...checks].filter(Boolean)));
}

function booleanProtectionValue(value) {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "enabled" in value) return Boolean(value.enabled);
  return false;
}

function auditBranchProtectionRequirements({ requirements, branchProtection, branchProtectionError, protectedBranch, requiredBranchChecks }) {
  if (branchProtectionError) {
    requirements.push(
      requirement("branch-protection-readable", "fail", `Could not inspect ${protectedBranch} branch protection.`, {
        branch: protectedBranch,
        branchProtectionError,
      }),
    );
    return;
  }

  if (!branchProtection) {
    return;
  }

  if (branchProtection.protected === false || branchProtection.protection?.enabled === false) {
    requirements.push(
      requirement("branch-protection-readable", "fail", `${protectedBranch} branch protection is not enabled.`, {
        branch: protectedBranch,
      }),
    );
    return;
  }

  requirements.push(
    requirement("branch-protection-readable", "pass", `${protectedBranch} branch protection is readable.`, {
      branch: protectedBranch,
    }),
  );

  const statusChecks = branchProtection.required_status_checks || branchProtection.protection?.required_status_checks;
  const configuredChecks = getRequiredStatusChecks(branchProtection);
  const missingChecks = requiredBranchChecks.filter((check) => !configuredChecks.includes(check));
  if (statusChecks?.strict === false || missingChecks.length > 0) {
    requirements.push(
      requirement("branch-protection-required-checks", "fail", `${protectedBranch} branch protection is missing required checks.`, {
        branch: protectedBranch,
        strict: statusChecks?.strict,
        requiredChecks: requiredBranchChecks,
        configuredChecks,
        missingChecks,
      }),
    );
  } else {
    requirements.push(
      requirement("branch-protection-required-checks", "pass", `${protectedBranch} requires production readiness status checks.`, {
        branch: protectedBranch,
        strict: statusChecks?.strict,
        enforcementLevel: statusChecks?.enforcement_level,
        requiredChecks: configuredChecks,
      }),
    );
  }

  if (branchProtection.enforce_admins !== undefined && booleanProtectionValue(branchProtection.enforce_admins)) {
    requirements.push(requirement("branch-protection-admins", "pass", `${protectedBranch} branch protection applies to admins.`, { branch: protectedBranch }));
  } else if (branchProtection.enforce_admins !== undefined) {
    requirements.push(requirement("branch-protection-admins", "fail", `${protectedBranch} branch protection does not apply to admins.`, { branch: protectedBranch }));
  }

  if (branchProtection.required_linear_history !== undefined && booleanProtectionValue(branchProtection.required_linear_history)) {
    requirements.push(requirement("branch-protection-linear-history", "pass", `${protectedBranch} requires linear history.`, { branch: protectedBranch }));
  } else if (branchProtection.required_linear_history !== undefined) {
    requirements.push(requirement("branch-protection-linear-history", "fail", `${protectedBranch} does not require linear history.`, { branch: protectedBranch }));
  }

  if (
    branchProtection.allow_force_pushes !== undefined &&
    branchProtection.allow_deletions !== undefined &&
    (booleanProtectionValue(branchProtection.allow_force_pushes) || booleanProtectionValue(branchProtection.allow_deletions))
  ) {
    requirements.push(
      requirement("branch-protection-no-history-rewrite", "fail", `${protectedBranch} allows force pushes or deletion.`, {
        branch: protectedBranch,
        allowForcePushes: booleanProtectionValue(branchProtection.allow_force_pushes),
        allowDeletions: booleanProtectionValue(branchProtection.allow_deletions),
      }),
    );
  } else if (branchProtection.allow_force_pushes !== undefined && branchProtection.allow_deletions !== undefined) {
    requirements.push(
      requirement("branch-protection-no-history-rewrite", "pass", `${protectedBranch} blocks force pushes and deletion.`, {
        branch: protectedBranch,
      }),
    );
  }
}

function requireTrueVariable({ requirements, variables, variableInventoryError, variableContextProvided, name, id, failureMessage }) {
  if (variableInventoryError && !variableContextProvided) {
    requirements.push(
      requirement(id, "fail", `Could not verify repository variable ${name} because repository Actions variables are not readable.`, {
        variable: name,
      }),
    );
    return;
  }

  const variable = variables.find((item) => item.name === name);
  if (!variable) {
    requirements.push(requirement(id, "fail", failureMessage, { variable: name }));
    return;
  }

  if (String(variable.value || "").trim().toLowerCase() !== "true") {
    requirements.push(
      requirement(id, "fail", `Repository variable ${name} must be set to "true" for production launch smoke.`, {
        variable: name,
        value: variable.value,
      }),
    );
    return;
  }

  requirements.push(requirement(id, "pass", `Repository variable ${name} is enabled.`, { variable: name }));
}

export function auditProductionReadinessConfig(input, options = {}) {
  const variables = Array.isArray(input.variables) ? input.variables : [];
  const runners = Array.isArray(input.runners) ? input.runners : [];
  const environments = Array.isArray(input.environments) ? input.environments : [];
  const variableInventoryError = input.variableInventoryError || "";
  const variableContextProvided = Boolean(input.variableContextProvided);
  const runnerInventoryError = input.runnerInventoryError || "";
  const environmentInventoryError = input.environmentInventoryError || "";
  const branchProtection = input.branchProtection || null;
  const branchProtectionError = input.branchProtectionError || "";
  const protectedBranch = options.protectedBranch || DEFAULT_PROTECTED_BRANCH;
  const requiredBranchChecks = options.requiredBranchChecks || DEFAULT_REQUIRED_BRANCH_CHECKS;
  const targetRunnerVariable = options.targetRunnerVariable || DEFAULT_TARGET_RUNNER_VARIABLE;
  const launchSmokeUrlVariable = options.launchSmokeUrlVariable || DEFAULT_LAUNCH_SMOKE_URL_VARIABLE;
  const launchSmokeBillingVariable = options.launchSmokeBillingVariable || DEFAULT_LAUNCH_SMOKE_BILLING_VARIABLE;
  const launchSmokeExpectLlmVariable = options.launchSmokeExpectLlmVariable || DEFAULT_LAUNCH_SMOKE_EXPECT_LLM_VARIABLE;
  const allowGitHubHostedTarget = Boolean(options.allowGitHubHostedTarget);
  const requiredEnvironments = options.requiredEnvironments || DEFAULT_REQUIRED_ENVIRONMENTS;

  const requirements = [];
  const targetVariable = variables.find((variable) => variable.name === targetRunnerVariable);
  const targetLabels = parseRunnerLabels(targetVariable?.value || "");

  if (variableInventoryError && !variableContextProvided) {
    requirements.push(
      requirement("repository-variables-readable", "fail", "Could not inspect repository Actions variables.", {
        variableInventoryError,
      }),
    );
    requirements.push(
      requirement(
        "target-runner-variable",
        "fail",
        `Could not verify repository variable ${targetRunnerVariable} because repository Actions variables are not readable.`,
        { variable: targetRunnerVariable },
      ),
    );
  } else if (!targetVariable) {
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

  if (variableInventoryError && !variableContextProvided) {
    requirements.push(
      requirement(
        "target-runner-available",
        "fail",
        "Could not match a target runner because the configured target labels are not readable.",
        {},
      ),
    );
  } else if (targetLabels.length > 0 && !isGitHubHostedLabelSet(targetLabels)) {
    const matchingRunners = runnerInventoryError ? [] : runners.filter((runner) => runnerHasLabels(runner, targetLabels));
    if (runnerInventoryError) {
      requirements.push(
        requirement("target-runner-available", "fail", "Could not inspect self-hosted target runner inventory.", {
          labels: targetLabels,
          runnerInventoryError,
        }),
      );
    } else if (matchingRunners.length === 0) {
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

  if (environmentInventoryError) {
    requirements.push(
      requirement("release-environment", "fail", "Could not inspect GitHub release environments.", {
        requiredEnvironments,
        environmentInventoryError,
      }),
    );
  } else {
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

    const stableEnvironment = environments.find((item) => item.name === "npm-stable");
    if (stableEnvironment) {
      if (hasRequiredReviewerProtection(stableEnvironment)) {
        requirements.push(
          requirement("stable-release-environment-protected", "pass", "Stable npm release environment requires reviewer approval.", {
            environment: "npm-stable",
            protectionRuleTypes: (stableEnvironment.protection_rules || []).map((rule) => rule.type),
          }),
        );
      } else {
        requirements.push(
          requirement(
            "stable-release-environment-protected",
            "fail",
            "Release environment npm-stable exists but does not require reviewer approval for stable publishes.",
            {
              environment: "npm-stable",
              protectionRuleCount: stableEnvironment.protection_rules?.length || 0,
              protectionRuleTypes: (stableEnvironment.protection_rules || []).map((rule) => rule.type),
            },
          ),
        );
      }
    }
  }

  auditBranchProtectionRequirements({
    requirements,
    branchProtection,
    branchProtectionError,
    protectedBranch,
    requiredBranchChecks,
  });

  const launchSmokeVariable = variables.find((variable) => variable.name === launchSmokeUrlVariable);
  if (variableInventoryError && !variableContextProvided) {
    requirements.push(
      requirement(
        "launch-smoke-url-variable",
        "fail",
        `Could not verify repository variable ${launchSmokeUrlVariable} because repository Actions variables are not readable.`,
        { variable: launchSmokeUrlVariable },
      ),
    );
  } else if (!launchSmokeVariable) {
    requirements.push(
      requirement(
        "launch-smoke-url-variable",
        "fail",
        `Repository variable ${launchSmokeUrlVariable} is missing; deployed launch smoke cannot run on the production-readiness workflow.`,
        { variable: launchSmokeUrlVariable },
      ),
    );
  } else {
    try {
      const launchSmokeUrl = new URL(String(launchSmokeVariable.value || "").trim());
      if (launchSmokeUrl.protocol !== "https:") {
        requirements.push(
          requirement("launch-smoke-url-variable", "fail", `Repository variable ${launchSmokeUrlVariable} must be an https URL.`, {
            variable: launchSmokeUrlVariable,
            value: launchSmokeVariable.value,
          }),
        );
      } else if (isLocalLaunchSmokeUrl(launchSmokeUrl)) {
        requirements.push(
          requirement(
            "launch-smoke-url-variable",
            "fail",
            `Repository variable ${launchSmokeUrlVariable} points at a local URL, not a deployed launch target.`,
            { variable: launchSmokeUrlVariable, value: launchSmokeVariable.value },
          ),
        );
      } else {
        requirements.push(
          requirement("launch-smoke-url-variable", "pass", `Repository variable ${launchSmokeUrlVariable} is configured.`, {
            variable: launchSmokeUrlVariable,
            origin: launchSmokeUrl.origin,
          }),
        );
      }
    } catch {
      requirements.push(
        requirement("launch-smoke-url-variable", "fail", `Repository variable ${launchSmokeUrlVariable} is not a valid URL.`, {
          variable: launchSmokeUrlVariable,
          value: launchSmokeVariable.value,
        }),
      );
    }
  }

  requireTrueVariable({
    requirements,
    variables,
    variableInventoryError,
    variableContextProvided,
    name: launchSmokeBillingVariable,
    id: "launch-smoke-billing-required",
    failureMessage: `Repository variable ${launchSmokeBillingVariable} is missing; deployed launch smoke will not require Stripe Checkout session creation.`,
  });

  requireTrueVariable({
    requirements,
    variables,
    variableInventoryError,
    variableContextProvided,
    name: launchSmokeExpectLlmVariable,
    id: "launch-smoke-llm-required",
    failureMessage: `Repository variable ${launchSmokeExpectLlmVariable} is missing; deployed launch smoke will not require a real CoS/LLM reply.`,
  });

  const manualChecks = [
    "Confirm npm trusted publishing is configured for every public package published by scripts/release.sh.",
    "Confirm the stable release workflow is manually approved before running dry_run=false.",
    "Confirm production deployment secrets and service credentials are configured in the cloud host, not only in GitHub Actions.",
    "Confirm the launch-smoke artifacts show Stripe Checkout session creation and a non-stub CoS/LLM reply before public launch.",
    "Confirm Stripe webhook delivery and plan-tier transition separately with Stripe dashboard or database evidence.",
    "After this PR lands, enable CODEOWNERS review if the team wants release-infrastructure changes to require owner review.",
    "If GitHub Actions cannot inspect release environments or self-hosted runners with GITHUB_TOKEN, configure PRODUCTION_READINESS_AUDIT_TOKEN with read access to those repository settings.",
  ];

  const failed = requirements.filter((item) => item.status === "fail");
  return {
    conclusion: failed.length > 0 ? "failure" : "success",
    checkedAt: input.checkedAt || new Date().toISOString(),
    repository: input.repository || "",
    requirements,
    manualChecks,
    observations: {
      repositoryVariableCount: variables.length,
      variableInventoryError: variableInventoryError || null,
      variableContextProvided,
      selfHostedRunnerCount: runnerInventoryError ? null : runners.length,
      runnerInventoryError: runnerInventoryError || null,
      environmentInventoryError: environmentInventoryError || null,
      branchProtectionError: branchProtectionError || null,
      branchProtectionRequiredChecks: branchProtection ? getRequiredStatusChecks(branchProtection) : [],
      launchSmokeUrlConfigured: Boolean(launchSmokeVariable),
      launchSmokeBillingRequired: variables.some(
        (variable) => variable.name === launchSmokeBillingVariable && String(variable.value || "").trim().toLowerCase() === "true",
      ),
      launchSmokeLlmRequired: variables.some(
        (variable) => variable.name === launchSmokeExpectLlmVariable && String(variable.value || "").trim().toLowerCase() === "true",
      ),
    },
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function summarizeEvidence(evidence) {
  const entries = Object.entries(evidence || {}).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}: ${Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("; ");
}

function buildNextActions(result) {
  const failedIds = new Set(result.requirements.filter((item) => item.status === "fail").map((item) => item.id));
  const actions = [];
  const repo = result.repository || "OWNER/REPO";

  if (failedIds.has("target-runner-variable")) {
    actions.push(
      `Set \`${DEFAULT_TARGET_RUNNER_VARIABLE}\` to the real target runner labels: \`gh variable set ${DEFAULT_TARGET_RUNNER_VARIABLE} --repo ${repo} --body '["self-hosted","agentdash-target"]'\`.`,
    );
  }
  if (failedIds.has("target-runner-available")) {
    actions.push(
      "Register and start a self-hosted target runner with the configured labels, then rerun this workflow.",
    );
  }
  if (failedIds.has("launch-smoke-url-variable")) {
    actions.push(
      `Set \`${DEFAULT_LAUNCH_SMOKE_URL_VARIABLE}\` to the deployed HTTPS origin: \`gh variable set ${DEFAULT_LAUNCH_SMOKE_URL_VARIABLE} --repo ${repo} --body 'https://your-domain.com'\`.`,
    );
    actions.push(
      "For one-off deployed smoke before variables are finalized, rerun this workflow manually with `launch_smoke_base_url`.",
    );
  }
  if (failedIds.has("launch-smoke-billing-required")) {
    actions.push(
      `Require Stripe Checkout session creation in deployed smoke: \`gh variable set ${DEFAULT_LAUNCH_SMOKE_BILLING_VARIABLE} --repo ${repo} --body 'true'\`.`,
    );
  }
  if (failedIds.has("launch-smoke-llm-required")) {
    actions.push(
      `Require a real CoS/LLM reply in deployed smoke: \`gh variable set ${DEFAULT_LAUNCH_SMOKE_EXPECT_LLM_VARIABLE} --repo ${repo} --body 'true'\`.`,
    );
  }
  if (failedIds.has("release-environment")) {
    actions.push("Create or repair the `npm-canary` and `npm-stable` GitHub release environments.");
  }
  if (failedIds.has("stable-release-environment-protected")) {
    actions.push(
      "Configure `npm-stable` in GitHub Settings -> Environments with required reviewers before stable publishes.",
    );
  }
  if (failedIds.has("branch-protection-readable")) {
    actions.push("Enable or repair `main` branch protection so production readiness can inspect required checks and history controls.");
  }
  if (failedIds.has("branch-protection-required-checks")) {
    actions.push("Require the always-running production readiness checks on `main`: `audit`, `drift`, `check`, `policy`, `e2e`, `verify`, and `config-audit`.");
  }
  if (failedIds.has("branch-protection-admins")) {
    actions.push("Enable branch protection enforcement for admins on `main`.");
  }
  if (failedIds.has("branch-protection-linear-history")) {
    actions.push("Require linear history on `main`.");
  }
  if (failedIds.has("branch-protection-no-history-rewrite")) {
    actions.push("Disable force pushes and branch deletion on `main`.");
  }
  if (
    result.observations?.runnerInventoryError ||
    result.observations?.environmentInventoryError ||
    result.observations?.branchProtectionError ||
    (result.observations?.variableInventoryError && !result.observations?.variableContextProvided)
  ) {
    actions.push(
      "If `GITHUB_TOKEN` cannot read required repository settings, configure `PRODUCTION_READINESS_AUDIT_TOKEN` with narrow read access and rerun the workflow.",
    );
  }
  if (actions.length === 0 && result.conclusion === "success") {
    actions.push("All automated config requirements passed. Continue with deployed launch smoke, canary smoke, and stable release smoke.");
  }
  return actions;
}

export function renderProductionReadinessSummary(result) {
  const failed = result.requirements.filter((item) => item.status === "fail");
  const conclusionLabel = result.conclusion === "success" ? "PASS" : "FAIL";
  const lines = [
    "# Production Readiness Config Audit",
    "",
    `**Conclusion:** ${conclusionLabel}`,
    "",
    `- Repository: \`${result.repository || "unknown"}\``,
    `- Checked at: \`${result.checkedAt}\``,
    "",
    "## Requirements",
    "",
    "| Status | Requirement | Evidence |",
    "| --- | --- | --- |",
  ];

  for (const item of result.requirements) {
    const status = item.status === "pass" ? "PASS" : "FAIL";
    lines.push(`| ${status} | ${markdownCell(item.message)} | ${markdownCell(summarizeEvidence(item.evidence))} |`);
  }

  lines.push("", "## Next Actions", "");
  for (const action of buildNextActions(result)) {
    lines.push(`- ${action}`);
  }

  if (failed.length > 0) {
    lines.push("", "## Failed Requirement IDs", "");
    for (const item of failed) {
      lines.push(`- \`${item.id}\``);
    }
  }

  if (result.manualChecks.length > 0) {
    lines.push("", "## Manual Checks Still Required", "");
    for (const check of result.manualChecks) {
      lines.push(`- ${check}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function mergeVariables(apiVariables, contextVariables) {
  const byName = new Map();
  for (const variable of apiVariables || []) {
    byName.set(variable.name, variable);
  }
  for (const variable of contextVariables || []) {
    byName.set(variable.name, variable);
  }
  return Array.from(byName.values());
}

function variablesFromActionsContext(options = {}) {
  if (!options.useActionsVarsContext) return [];
  const variableNames = [
    options.targetRunnerVariable || DEFAULT_TARGET_RUNNER_VARIABLE,
    options.launchSmokeUrlVariable || DEFAULT_LAUNCH_SMOKE_URL_VARIABLE,
    options.launchSmokeBillingVariable || DEFAULT_LAUNCH_SMOKE_BILLING_VARIABLE,
    options.launchSmokeExpectLlmVariable || DEFAULT_LAUNCH_SMOKE_EXPECT_LLM_VARIABLE,
  ];
  return variableNames.flatMap((name) => {
    const value = process.env[name];
    return value && value.trim() ? [{ name, value }] : [];
  });
}

async function collectGitHubConfig(repo, options = {}) {
  const runnersJq = "{runners: [.runners[] | {name: .name, status: .status, busy: .busy, labels: [.labels[].name]}]}";
  const environmentsJq = "{environments: [.environments[] | {name: .name, protection_rules: .protection_rules}]}";
  const branchProtectionJq = "{protected: .protected, protection: .protection}";
  const protectedBranch = options.protectedBranch || DEFAULT_PROTECTED_BRANCH;
  const [variablesResult, environmentsResult, branchProtectionResult] = await Promise.all([
    runGhJson(`gh variable list --repo ${shellQuote(repo)} --json name,value,updatedAt`)
      .then((variables) => ({ variables: variables || [], error: "" }))
      .catch((error) => ({ variables: [], error: error.message })),
    runGhJson(`gh api ${shellQuote(`repos/${repo}/environments`)} --jq ${shellQuote(environmentsJq)}`)
      .then((result) => ({ environments: result?.environments || [], error: "" }))
      .catch((error) => ({ environments: [], error: error.message })),
    runGhJson(`gh api ${shellQuote(`repos/${repo}/branches/${protectedBranch}`)} --jq ${shellQuote(branchProtectionJq)}`)
      .then((branchProtection) => ({ branchProtection, error: "" }))
      .catch((error) => ({ branchProtection: null, error: error.message })),
  ]);
  const contextVariables = variablesFromActionsContext(options);
  const variables = mergeVariables(variablesResult.variables || [], contextVariables);
  const targetVariable = variables.find(
    (variable) => variable.name === (options.targetRunnerVariable || DEFAULT_TARGET_RUNNER_VARIABLE),
  );
  const targetLabels = parseRunnerLabels(targetVariable?.value || "");
  let runnersResult = { runners: [] };
  let runnerInventoryError = "";

  if (targetLabels.length > 0 && !isGitHubHostedLabelSet(targetLabels)) {
    try {
      runnersResult = await runGhJson(`gh api ${shellQuote(`repos/${repo}/actions/runners`)} --jq ${shellQuote(runnersJq)}`);
    } catch (error) {
      runnerInventoryError = error.message;
    }
  }

  return {
    repository: repo,
    variables,
    variableInventoryError: variablesResult.error,
    variableContextProvided: Boolean(options.useActionsVarsContext),
    runners: runnersResult?.runners || [],
    environments: environmentsResult.environments || [],
    branchProtection: branchProtectionResult.branchProtection || null,
    runnerInventoryError,
    environmentInventoryError: environmentsResult.error,
    branchProtectionError: branchProtectionResult.error,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await collectGitHubConfig(args.repo, {
    targetRunnerVariable: args.targetRunnerVariable,
    launchSmokeUrlVariable: args.launchSmokeUrlVariable,
    launchSmokeBillingVariable: args.launchSmokeBillingVariable,
    launchSmokeExpectLlmVariable: args.launchSmokeExpectLlmVariable,
    useActionsVarsContext: args.useActionsVarsContext,
    protectedBranch: args.protectedBranch,
  });
  const result = auditProductionReadinessConfig(config, {
    allowGitHubHostedTarget: args.allowGitHubHostedTarget,
    protectedBranch: args.protectedBranch,
    targetRunnerVariable: args.targetRunnerVariable,
    launchSmokeUrlVariable: args.launchSmokeUrlVariable,
    launchSmokeBillingVariable: args.launchSmokeBillingVariable,
    launchSmokeExpectLlmVariable: args.launchSmokeExpectLlmVariable,
  });

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    writeFileSync(args.output, json);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderProductionReadinessSummary(result));
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
