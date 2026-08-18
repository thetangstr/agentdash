// AgentDash: user-filed bug reports and feature requests -> GitHub issues.
//
// The product needs a way for any signed-in person to file a report without
// a GitHub account of their own, and for that report to land in the same
// queue the team already works from. So the server holds one credential and
// files on the reporter's behalf, stamping who actually reported it into the
// issue body.
//
// Env:
//   AGENTDASH_GITHUB_ISSUES_REPO      — "owner/repo". Unset disables the feature.
//   AGENTDASH_GITHUB_ISSUES_TOKEN     — token with Issues:write on that repo. Unset disables.
//   AGENTDASH_GITHUB_ISSUES_HOSTNAME  — optional, for GitHub Enterprise. Defaults to github.com.
//
// Both must be present or the feature reports itself disabled and the UI
// hides the button — a button that always errors is worse than no button.

import { serviceUnavailable, unprocessable } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

export const MAX_REPORT_TITLE_LENGTH = 160;
export const MAX_REPORT_DESCRIPTION_LENGTH = 8000;

/** Label applied to everything filed through this route, so the team can
 *  separate user-filed reports from their own backlog with one filter. */
export const USER_REPORT_LABEL = "user-report";

export const ISSUE_REPORT_KINDS = ["bug", "feature"] as const;
export type IssueReportKind = (typeof ISSUE_REPORT_KINDS)[number];

const KIND_LABEL: Record<IssueReportKind, string> = {
  bug: "bug",
  feature: "enhancement",
};

const KIND_TITLE_PREFIX: Record<IssueReportKind, string> = {
  bug: "[Bug]",
  feature: "[Feature]",
};

export interface GitHubIssuesConfig {
  hostname: string;
  owner: string;
  repo: string;
  token: string;
}

export interface IssueReportContext {
  reporterName?: string | null;
  reporterEmail?: string | null;
  companyName?: string | null;
  instanceName?: string | null;
  pageUrl?: string | null;
  appVersion?: string | null;
}

export interface CreatedIssueReport {
  number: number;
  url: string;
}

/**
 * Returns null when the feature isn't configured. Callers treat null as
 * "disabled", never as an error — an instance with no GitHub credential is a
 * perfectly valid deployment.
 */
export function resolveGitHubIssuesConfig(
  env: NodeJS.ProcessEnv = process.env,
): GitHubIssuesConfig | null {
  const repoSpec = env.AGENTDASH_GITHUB_ISSUES_REPO?.trim();
  const token = env.AGENTDASH_GITHUB_ISSUES_TOKEN?.trim();
  if (!repoSpec || !token) return null;

  const parts = repoSpec.split("/").filter(Boolean);
  if (parts.length !== 2) {
    // Misconfiguration, not a user error. Log once and stay disabled rather
    // than throwing on every request or filing into a guessed repo.
    logger.warn(
      { repoSpec },
      "[issue-reports] AGENTDASH_GITHUB_ISSUES_REPO must be in owner/repo form — feature disabled",
    );
    return null;
  }

  return {
    hostname: env.AGENTDASH_GITHUB_ISSUES_HOSTNAME?.trim() || "github.com",
    owner: parts[0] as string,
    repo: parts[1] as string,
    token,
  };
}

function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function buildIssueTitle(kind: IssueReportKind, title: string): string {
  // Redact before clamping: a truncated secret is still a leaked secret.
  return clamp(`${KIND_TITLE_PREFIX[kind]} ${redactSensitiveText(title)}`, MAX_REPORT_TITLE_LENGTH);
}

/**
 * The reporter's words first, provenance after a rule. Provenance goes in the
 * body rather than the title so the title stays readable in a list view, and
 * the reporter's identity is recorded because "who hit this" is the first
 * question anyone asks about a bug report.
 */
export function buildIssueBody(description: string, context: IssueReportContext): string {
  const body = clamp(redactSensitiveText(description), MAX_REPORT_DESCRIPTION_LENGTH);

  const reporter = [context.reporterName, context.reporterEmail && `<${context.reporterEmail}>`]
    .filter(Boolean)
    .join(" ");

  const facts: Array<[string, string | null | undefined]> = [
    ["Reported by", reporter || "unknown"],
    ["Company", context.companyName],
    ["Instance", context.instanceName],
    ["Page", context.pageUrl],
    ["Version", context.appVersion],
  ];

  const provenance = facts
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `- ${label}: ${redactSensitiveText(value)}`)
    .join("\n");

  return `${body}\n\n---\n\nFiled from AgentDash.\n\n${provenance}\n`;
}

interface CreateIssueInput {
  config: GitHubIssuesConfig;
  kind: IssueReportKind;
  title: string;
  description: string;
  context: IssueReportContext;
}

async function postIssue(
  config: GitHubIssuesConfig,
  payload: Record<string, unknown>,
): Promise<Response> {
  const base = gitHubApiBase(config.hostname);
  return ghFetch(`${base}/repos/${config.owner}/${config.repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "AgentDash",
    },
    body: JSON.stringify(payload),
  });
}

export async function createIssueReport(input: CreateIssueInput): Promise<CreatedIssueReport> {
  const { config, kind } = input;
  const title = buildIssueTitle(kind, input.title);
  const body = buildIssueBody(input.description, input.context);
  const labels = [USER_REPORT_LABEL, KIND_LABEL[kind]];

  let res = await postIssue(config, { title, body, labels });

  // A repo that doesn't have these labels rejects the create with 422. The
  // report itself is worth more than its labels, so retry unlabelled rather
  // than lose what the person typed.
  if (res.status === 422) {
    logger.warn(
      { owner: config.owner, repo: config.repo, labels },
      "[issue-reports] GitHub rejected the labelled create — retrying without labels",
    );
    res = await postIssue(config, { title, body });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    logger.warn(
      { status: res.status, detail: detail.slice(0, 240), owner: config.owner, repo: config.repo },
      "[issue-reports] GitHub refused the issue create",
    );
    if (res.status === 401 || res.status === 403) {
      throw serviceUnavailable("Issue reporting is misconfigured — the GitHub credential was rejected.");
    }
    if (res.status === 404) {
      throw serviceUnavailable("Issue reporting is misconfigured — the target repository was not found.");
    }
    throw unprocessable("GitHub could not create the issue. Please try again.");
  }

  const json = (await res.json().catch(() => ({}))) as { number?: number; html_url?: string };
  if (typeof json.number !== "number" || typeof json.html_url !== "string") {
    throw unprocessable("GitHub accepted the report but returned an unexpected response.");
  }

  logger.info(
    { number: json.number, owner: config.owner, repo: config.repo, kind },
    "[issue-reports] filed",
  );
  return { number: json.number, url: json.html_url };
}
