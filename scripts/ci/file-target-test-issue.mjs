#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export function normalizeFailureText(value) {
  return String(value || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g, "<timestamp>")
    .replace(/\b\d+ms\b/g, "<duration>")
    .replace(/\b\d+\.\d+s\b/g, "<duration>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

export function selectFailure(summary) {
  const failedCommand =
    summary.failure ||
    summary.commands?.find((command) => Number(command.exitCode || 0) !== 0) ||
    summary.failedCommand ||
    null;

  if (!failedCommand) return null;

  return {
    commandName: failedCommand.commandName || failedCommand.name || "unknown",
    command: failedCommand.command || "",
    exitCode: Number(failedCommand.exitCode || 1),
    firstFailure: failedCommand.firstFailure || "",
    errorHead: failedCommand.errorHead || failedCommand.error || "",
    logPath: failedCommand.logPath || "",
  };
}

export function computeFailureSignature(summary) {
  const failure = selectFailure(summary);
  if (!failure) return "";

  const signatureInput = [
    summary.profile || "unknown-profile",
    failure.commandName,
    failure.command,
    normalizeFailureText(failure.firstFailure || failure.errorHead),
  ].join("\n");

  return createHash("sha256").update(signatureInput).digest("hex").slice(0, 16);
}

export function inferAreaLabel(summary, failure = selectFailure(summary)) {
  const text = `${failure?.commandName || ""} ${failure?.command || ""} ${failure?.firstFailure || ""}`.toLowerCase();
  if (text.includes("playwright") || text.includes("e2e")) return "e2e";
  if (text.includes("openclaw") || text.includes("adapter")) return "adapter";
  if (text.includes("server")) return "server";
  if (text.includes("ui")) return "ui";
  if (text.includes("release")) return "release";
  return "ci";
}

export function buildIssueTitle(summary, failure = selectFailure(summary)) {
  const ref = summary.requestedRef || summary.commit?.slice(0, 12) || "unknown ref";
  const command = failure?.commandName || "target test";
  return `Target-machine test failed: ${command} on ${ref}`;
}

export function buildIssueBody(summary, signature) {
  const failure = selectFailure(summary);
  if (!failure) {
    throw new Error("cannot build issue body for a passing summary");
  }

  const commit = summary.commit || "unknown";
  const ref = summary.requestedRef || "unknown";
  const artifactText = summary.artifactName
    ? `Artifact: \`${summary.artifactName}\`${summary.workflowRunUrl ? ` in ${summary.workflowRunUrl}` : ""}`
    : summary.workflowRunUrl || "No artifact URL recorded";

  return `<!-- target-machine-test-signature:${signature} -->
## Target-machine test failure

Ref: \`${ref}\`
Commit: \`${commit}\`
Machine: \`${summary.osDescription || `${summary.runnerOs || "unknown"}/${summary.runnerArch || "unknown"}`}\`
Runner: \`${summary.runnerName || "unknown"}\`
Node: \`${summary.nodeVersion || "unknown"}\`
pnpm: \`${summary.pnpmVersion || "unknown"}\`
Profile: \`${summary.profile || "unknown"}\`
Command: \`${failure.command || failure.commandName}\`
Exit code: \`${failure.exitCode}\`

## Failure Summary

${failure.firstFailure || "The target-machine test profile failed. See the evidence below."}

## Reproduction

\`\`\`sh
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
git checkout ${ref}
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
${failure.command || "# run the failed command from the target summary"}
\`\`\`

## Evidence

- First failing test or step: ${failure.firstFailure || "unknown"}
- Failed log path: \`${failure.logPath || "unknown"}\`
- ${artifactText}

\`\`\`text
${(failure.errorHead || failure.firstFailure || "No failure excerpt captured.").slice(0, 6000)}
\`\`\`

## Triage

Likely owner area: \`${inferAreaLabel(summary, failure)}\`
Failure signature: \`${signature}\`
Blocking merge/release: \`yes until triaged\`
`;
}

function parseArgs(argv) {
  const args = {
    summary: "",
    repo: process.env.GITHUB_REPOSITORY || "",
    token: process.env.GITHUB_TOKEN || "",
    dryRun: false,
    output: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
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
    if (key === "summary") args.summary = value;
    else if (key === "repo") args.repo = value;
    else if (key === "token") args.token = value;
    else if (key === "output") args.output = value;
    else throw new Error(`unknown argument: --${key}`);
  }

  if (!args.summary) throw new Error("--summary is required");
  return args;
}

async function githubRequest({ method = "GET", path, token, body }) {
  const response = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = json?.message || text || `${method} ${path} failed`;
    const error = new Error(message);
    error.status = response.status;
    error.response = json;
    throw error;
  }
  return json;
}

async function findExistingIssue({ repo, token, signature }) {
  const query = encodeURIComponent(`repo:${repo} is:issue is:open target-machine-test-signature:${signature}`);
  const result = await githubRequest({
    path: `/search/issues?q=${query}&per_page=10`,
    token,
  });
  return result.items?.[0] || null;
}

async function createIssue({ repo, token, title, body, labels }) {
  try {
    return await githubRequest({
      method: "POST",
      path: `/repos/${repo}/issues`,
      token,
      body: { title, body, labels },
    });
  } catch (error) {
    if (error.status !== 422 || !labels.length) throw error;
    return githubRequest({
      method: "POST",
      path: `/repos/${repo}/issues`,
      token,
      body: { title, body },
    });
  }
}

async function commentOnIssue({ repo, token, issueNumber, body }) {
  return githubRequest({
    method: "POST",
    path: `/repos/${repo}/issues/${issueNumber}/comments`,
    token,
    body: { body },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = JSON.parse(readFileSync(args.summary, "utf8"));
  const failure = selectFailure(summary);

  if (summary.conclusion !== "failure" || !failure) {
    const result = { action: "none", reason: "summary did not contain a failure" };
    if (args.output) writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const signature = computeFailureSignature(summary);
  const title = buildIssueTitle(summary, failure);
  const body = buildIssueBody(summary, signature);
  const labels = [...new Set(["target-machine-test", "ci", "bug", inferAreaLabel(summary, failure)])];

  if (args.dryRun) {
    const result = { action: "dry-run", signature, title, body, labels };
    if (args.output) writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!args.repo) throw new Error("GITHUB_REPOSITORY or --repo is required");
  if (!args.token) throw new Error("GITHUB_TOKEN or --token is required");

  const existingIssue = await findExistingIssue({ repo: args.repo, token: args.token, signature });
  if (existingIssue) {
    const comment = [
      `Another target-machine test run hit this failure signature.`,
      ``,
      `Ref: \`${summary.requestedRef || "unknown"}\``,
      `Commit: \`${summary.commit || "unknown"}\``,
      `Profile: \`${summary.profile || "unknown"}\``,
      `Command: \`${failure.command || failure.commandName}\``,
      summary.workflowRunUrl ? `Workflow run: ${summary.workflowRunUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const createdComment = await commentOnIssue({
      repo: args.repo,
      token: args.token,
      issueNumber: existingIssue.number,
      body: comment,
    });
    const result = {
      action: "comment",
      signature,
      issueNumber: existingIssue.number,
      issueUrl: existingIssue.html_url,
      commentUrl: createdComment.html_url,
    };
    if (args.output) writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const issue = await createIssue({ repo: args.repo, token: args.token, title, body, labels });
  const result = {
    action: "create",
    signature,
    issueNumber: issue.number,
    issueUrl: issue.html_url,
  };
  if (args.output) writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
