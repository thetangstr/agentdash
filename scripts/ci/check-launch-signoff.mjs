#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_CHECK_CONTEXTS = ["policy", "verify", "e2e", "launch-signoff", "audit", "drift", "check"];
const REQUIRED_CODEOWNER_PATTERNS = [
  ".github/**",
  "scripts/ci/**",
  "scripts/deploy/**",
  "docker/docker-compose.production.yml",
  "docker/launchd/**",
  "doc/MAC-MINI-DEPLOYMENT.md",
  "doc/VPS-DEPLOYMENT.md",
];
const REQUIRED_SCRIPT_TESTS = [
  "scripts/ci/check-launch-signoff.test.mjs",
  "scripts/deploy/agentdash-ota-update.test.mjs",
  "scripts/deploy/agentdash-mac-mini-launchd.test.mjs",
  "scripts/deploy/agentdash-mac-mini-source-launchd.test.mjs",
  "scripts/agent-harness-smoke.test.mjs",
  "scripts/msp-mac-mini-readiness.test.mjs",
  "scripts/msp-partner-access-proof.test.mjs",
];

function readOptional(rootDir, relativePath) {
  const filePath = path.join(rootDir, relativePath);
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

function hasLinePattern(text, pattern) {
  return text.split(/\r?\n/).some((line) => line.trim().startsWith(pattern));
}

function requireFile(rootDir, relativePath, errors) {
  if (!existsSync(path.join(rootDir, relativePath))) {
    errors.push(`Missing required launch-signoff file: ${relativePath}`);
  }
}

function validatePrWorkflow(rootDir, errors) {
  const workflow = readOptional(rootDir, ".github/workflows/pr.yml");
  if (!workflow) {
    errors.push("Missing .github/workflows/pr.yml");
    return;
  }
  if (!/^\s{2}launch-signoff:\s*$/m.test(workflow)) {
    errors.push("PR workflow must define a launch-signoff job.");
  }
  if (!/run:\s*pnpm run test:launch-signoff\b/.test(workflow)) {
    errors.push("launch-signoff job must run `pnpm run test:launch-signoff`.");
  }
  if (!/^\s{4}needs:\s*\[policy\]\s*$/m.test(workflow) && !/^\s{4}needs:\s*\n\s+-\s+policy\s*$/m.test(workflow)) {
    errors.push("launch-signoff job must depend on policy so PR metadata checks run first.");
  }
}

function validatePackageScript(rootDir, errors) {
  const raw = readOptional(rootDir, "package.json");
  if (!raw) {
    errors.push("Missing package.json");
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    errors.push("package.json is not valid JSON.");
    return;
  }
  const script = pkg.scripts?.["test:launch-signoff"];
  if (typeof script !== "string" || !script.includes("check-launch-signoff.mjs")) {
    errors.push("package.json must define test:launch-signoff using scripts/ci/check-launch-signoff.mjs.");
  }
  for (const required of REQUIRED_SCRIPT_TESTS) {
    if (typeof script !== "string" || !script.includes(required)) {
      errors.push(`test:launch-signoff must include ${required}.`);
    }
  }
}

function validateBranchProtectionDoc(rootDir, errors) {
  const doc = readOptional(rootDir, "doc/BRANCH-PROTECTION.md");
  if (!doc) {
    errors.push("Missing doc/BRANCH-PROTECTION.md");
    return;
  }
  for (const context of REQUIRED_CHECK_CONTEXTS) {
    if (!new RegExp(`\\b${context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(doc)) {
      errors.push(`Branch protection docs must list required check context: ${context}`);
    }
  }
  for (const phrase of [
    "Require a pull request before merging",
    "Do not allow bypassing",
    "allow_force_pushes",
    "allow_deletions",
  ]) {
    if (!doc.includes(phrase)) errors.push(`Branch protection docs must mention: ${phrase}`);
  }
}

function validateCodeowners(rootDir, errors) {
  const codeowners = readOptional(rootDir, ".github/CODEOWNERS");
  if (!codeowners) {
    errors.push("Missing .github/CODEOWNERS");
    return;
  }
  for (const pattern of REQUIRED_CODEOWNER_PATTERNS) {
    if (!hasLinePattern(codeowners, pattern)) {
      errors.push(`CODEOWNERS must protect ${pattern}.`);
    }
  }
}

function validateLaunchArtifacts(rootDir, errors) {
  for (const file of [
    "docker/docker-compose.production.yml",
    "scripts/deploy/agentdash-ota-update.mjs",
    "scripts/deploy/agentdash-mac-mini-launchd.mjs",
    "scripts/deploy/agentdash-mac-mini-source-launchd.mjs",
    "scripts/agent-harness-smoke.mjs",
    "scripts/msp-mac-mini-readiness.mjs",
    "scripts/msp-partner-access-proof.mjs",
    "doc/MAC-MINI-DEPLOYMENT.md",
    "doc/VPS-DEPLOYMENT.md",
  ]) {
    requireFile(rootDir, file, errors);
  }

  const compose = readOptional(rootDir, "docker/docker-compose.production.yml") ?? "";
  if (!compose.includes("${AGENTDASH_IMAGE:?")) {
    errors.push("Production compose must require AGENTDASH_IMAGE instead of a floating image tag.");
  }

  const macMini = readOptional(rootDir, "doc/MAC-MINI-DEPLOYMENT.md") ?? "";
  for (const marker of [
    "scripts/msp-mac-mini-readiness.sh",
    "scripts/msp-partner-access-proof.sh",
    "scripts/agent-harness-smoke.sh",
    "agentdash-rollback.sh",
  ]) {
    if (!macMini.includes(marker)) errors.push(`Mac mini deployment docs must include ${marker}.`);
  }

  const vps = readOptional(rootDir, "doc/VPS-DEPLOYMENT.md") ?? "";
  for (const marker of ["agentdash-ota-update.mjs", "deploy receipt", "rollback"]) {
    if (!vps.includes(marker)) errors.push(`VPS deployment docs must include ${marker}.`);
  }
}

export function validateLaunchSignoffPolicy({ rootDir = process.cwd() } = {}) {
  const errors = [];
  validatePrWorkflow(rootDir, errors);
  validatePackageScript(rootDir, errors);
  validateBranchProtectionDoc(rootDir, errors);
  validateCodeowners(rootDir, errors);
  validateLaunchArtifacts(rootDir, errors);
  return { errors };
}

function main() {
  const result = validateLaunchSignoffPolicy();
  if (result.errors.length === 0) {
    process.stdout.write("Launch signoff policy check passed.\n");
    return;
  }
  process.stderr.write([
    "Launch signoff policy check FAILED.",
    "",
    ...result.errors.map((error) => `- ${error}`),
    "",
  ].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
