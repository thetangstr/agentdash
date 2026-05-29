#!/usr/bin/env node
/**
 * Enforces AgentDash PR description discipline.
 *
 * This check deliberately stays lightweight so it can run in the policy job
 * before dependency install, typecheck, build, or browser tests.
 *
 * Inputs (env):
 *   PR_BODY  pull request body / description
 *
 * Inputs (CLI flags, override env):
 *   --body <string>  validate this body instead of PR_BODY
 *   --body-file <path>  read the body from a local file
 *
 * Exit codes:
 *   0 - pass
 *   1 - fail (missing or placeholder PR metadata)
 *   2 - usage / internal error
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REQUIRED_SECTIONS = [
  "Thinking Path",
  "What Changed",
  "Verification",
  "Risks",
  "AgentDash Review",
  "Model Used",
  "Checklist",
];

const AGENTDASH_REVIEW_FIELDS = [
  "Upstream impact",
  "Agent-facing prompt surfaces",
  "AgentDash-owned subsystem",
];

const PLACEHOLDER_PATTERNS = [
  /\[(?![ xX]\])[^\]\n]+\](?!\()/,
  /\bTBD\b/i,
  /\bTODO\b/i,
  /This pull request \.\.\./i,
  /The benefit is \.\.\./i,
];

const EMPTY_VALUE_PATTERNS = [
  /^-$/,
  /^n\/?a$/i,
  /^none$/i,
  /^not applicable$/i,
  /^tbd$/i,
  /^todo$/i,
];

function parseArgs(argv) {
  const args = { body: null, bodyFile: null };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--body") {
      args.body = value ?? "";
      i += 1;
    } else if (flag === "--body-file") {
      args.bodyFile = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: check-pr-process.mjs [--body <s>] [--body-file <path>]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function sectionPattern(title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+${escaped}\\s*$`, "gim");
}

function collectSections(body) {
  const sections = new Map();
  const headingRe = /^##\s+(.+?)\s*$/gim;
  const headings = [...body.matchAll(headingRe)].map((match) => ({
    title: match[1].trim(),
    index: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));

  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    const next = headings[i + 1];
    sections.set(heading.title.toLowerCase(), {
      title: heading.title,
      content: body.slice(heading.end, next?.index ?? body.length),
    });
  }

  return sections;
}

function normalizedMeaningfulLines(content) {
  return stripHtmlComments(content)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !EMPTY_VALUE_PATTERNS.some((re) => re.test(line)));
}

function hasPlaceholder(content) {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(stripHtmlComments(content)));
}

function hasRequiredSection(body, title) {
  return sectionPattern(title).test(body);
}

function sectionContent(sections, title) {
  return sections.get(title.toLowerCase())?.content ?? "";
}

function validateRequiredSections(body, sections, errors) {
  for (const title of REQUIRED_SECTIONS) {
    if (!hasRequiredSection(body, title)) {
      errors.push(`Missing required section: ${title}`);
      continue;
    }

    const content = sectionContent(sections, title);
    const lines = normalizedMeaningfulLines(content);
    if (lines.length === 0) {
      errors.push(
        `${title} must include non-placeholder content; a bare '-' is not enough.`,
      );
    }

    if (hasPlaceholder(content)) {
      errors.push(`${title} still contains template placeholder text.`);
    }
  }
}

function validateThinkingPath(content, errors) {
  const quoteBullets = normalizedMeaningfulLines(content).filter((line) =>
    /^>\s*-\s+\S/.test(line),
  );
  if (quoteBullets.length < 3) {
    errors.push(
      "Thinking Path must include at least three blockquoted bullet steps.",
    );
  }
}

function validateAgentDashReview(content, errors) {
  const clean = stripHtmlComments(content);
  for (const field of AGENTDASH_REVIEW_FIELDS) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = clean.match(
      new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`, "i"),
    );
    if (!match) {
      errors.push(`AgentDash Review is missing '${field}'.`);
      continue;
    }

    const value = match[1].trim().replace(/^[-:]\s*/, "");
    if (
      value.length === 0 ||
      EMPTY_VALUE_PATTERNS.some((re) => re.test(value))
    ) {
      errors.push(`AgentDash Review '${field}' must include a short reason.`);
    }
  }
}

function validateModelUsed(content, errors) {
  const clean = stripHtmlComments(content).trim();
  const lines = normalizedMeaningfulLines(clean);
  if (lines.length === 0) return;
  if (/None\s+(?:\u2014|-)\s+human-authored/i.test(clean)) return;
  if (/\bProvider\s*:/i.test(clean) && /\bModel\s*:/i.test(clean)) return;
  errors.push(
    "Model Used must either say 'None - human-authored' or include Provider and Model details.",
  );
}

export function validatePullRequestBody(body) {
  const errors = [];
  if (!body || body.trim().length === 0) {
    return { errors: ["Pull request body is empty. Use the PR template."] };
  }

  const sections = collectSections(body);
  validateRequiredSections(body, sections, errors);

  if (hasRequiredSection(body, "Thinking Path")) {
    validateThinkingPath(sectionContent(sections, "Thinking Path"), errors);
  }

  if (hasRequiredSection(body, "AgentDash Review")) {
    validateAgentDashReview(sectionContent(sections, "AgentDash Review"), errors);
  }

  if (hasRequiredSection(body, "Model Used")) {
    validateModelUsed(sectionContent(sections, "Model Used"), errors);
  }

  return { errors };
}

function main() {
  const args = parseArgs(process.argv);
  const body =
    args.body ??
    (args.bodyFile ? readFileSync(args.bodyFile, "utf8") : process.env.PR_BODY);

  const result = validatePullRequestBody(body ?? "");

  if (result.errors.length === 0) {
    process.stdout.write("PR process check passed.\n");
    process.exit(0);
  }

  process.stderr.write(
    [
      "PR process check FAILED.",
      "",
      ...result.errors.map((error) => `- ${error}`),
      "",
      "Fill out .github/PULL_REQUEST_TEMPLATE.md completely before requesting review.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
