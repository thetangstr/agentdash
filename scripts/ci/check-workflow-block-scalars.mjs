#!/usr/bin/env node
/**
 * Guard against the one YAML defect that silently disables a GitHub workflow:
 * a `run: |` (or `>`) block scalar whose body dedents to the left of its first
 * line. YAML ends the block there and tries to read what follows as mapping
 * keys; GitHub then records a zero-job failed run on every push and the workflow
 * never executes. `.github/workflows/upstream-digest.yml` shipped that way on
 * 2026-05-10 (a shell heredoc left at column 1) and was found on 2026-09-01.
 *
 * The repo has no YAML parser dependency and adding one would break the
 * frozen-lockfile installs in Docker and Vercel, so this is a targeted
 * structural check rather than a full parse:
 *
 *  1. Inside a block scalar, every non-blank line must be indented at least as
 *     far as the scalar's first line.
 *  2. The first non-blank, non-comment line after the scalar must be a YAML key
 *     or list item at or left of the scalar's key. Anything else (e.g. a shell
 *     variable or markdown line at column 1) is scalar content that escaped.
 *
 *   node scripts/ci/check-workflow-block-scalars.mjs            # check .github/workflows
 *   node scripts/ci/check-workflow-block-scalars.mjs <file...>  # check specific files
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCK_SCALAR_KEY = /^(\s*)(-\s+)?([A-Za-z_][\w.-]*):\s*[|>][+-]?\d?\s*(#.*)?$/;
const STRUCTURAL_LINE = /^\s*(-\s+)?(?:[A-Za-z_][\w.-]*|"[^"]*"|'[^']*'):(\s|$)|^\s*-(\s|$)|^---\s*$|^\.\.\.\s*$/;
const COMMENT_LINE = /^\s*#/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Returns { line, text, expectedIndent } for every line that is block-scalar
 * content but sits to the left of the scalar's body.
 */
export function findDedentedBlockScalarLines(source) {
  const lines = source.split("\n");
  const findings = [];
  let i = 0;
  while (i < lines.length) {
    const match = BLOCK_SCALAR_KEY.exec(lines[i]);
    if (!match) {
      i += 1;
      continue;
    }
    const keyIndent = match[1].length + (match[2] ? match[2].length : 0);
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j += 1;
    if (j >= lines.length || indentOf(lines[j]) <= keyIndent) {
      // Empty scalar; nothing to check.
      i = j;
      continue;
    }
    const bodyIndent = indentOf(lines[j]);
    let k = j;
    for (; k < lines.length; k += 1) {
      const text = lines[k];
      if (text.trim() === "") continue;
      const indent = indentOf(text);
      if (indent <= keyIndent) break; // the scalar ends here
      if (indent < bodyIndent) findings.push({ line: k + 1, text, expectedIndent: bodyIndent });
    }
    // Rule 2: what follows the scalar must be structure, not escaped content.
    let m = k;
    while (m < lines.length && (lines[m].trim() === "" || COMMENT_LINE.test(lines[m]))) m += 1;
    if (m < lines.length && !STRUCTURAL_LINE.test(lines[m])) {
      findings.push({ line: m + 1, text: lines[m], expectedIndent: bodyIndent });
      // Skip the rest of the escaped content so one defect is reported once.
      while (m < lines.length && !STRUCTURAL_LINE.test(lines[m])) m += 1;
    }
    i = Math.max(m, i + 1);
  }
  return findings;
}

export function checkWorkflowFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  return findDedentedBlockScalarLines(source).map((f) => ({ file: filePath, ...f }));
}

export function checkWorkflowsDir(dir) {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .flatMap((name) => checkWorkflowFile(path.join(dir, name)));
}

function main(argv) {
  const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const targets = argv.length > 0 ? argv : [path.join(repoRoot, ".github", "workflows")];
  const findings = targets.flatMap((target) =>
    /\.ya?ml$/.test(target) ? checkWorkflowFile(target) : checkWorkflowsDir(target),
  );
  if (findings.length === 0) {
    console.log("Workflow block scalars OK.");
    return 0;
  }
  for (const f of findings) {
    console.error(
      `${path.relative(repoRoot, f.file)}:${f.line}: block-scalar content escaped its block ` +
        `(expected at least ${f.expectedIndent} spaces of indent): ${f.text.trim().slice(0, 80)}`,
    );
  }
  console.error(`\n${findings.length} escaped block-scalar line(s). GitHub will treat the workflow as invalid and never run it.`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
