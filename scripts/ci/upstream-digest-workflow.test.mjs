/**
 * Regression coverage for AGE-29.
 *
 * `.github/workflows/upstream-digest.yml` shipped (2026-05-10, #212) with the
 * shell heredoc that builds the PR body (`BODY="$(cat <<EOF` … `EOF` … `)"`)
 * sitting at column 0 inside a `run: |` block. Column 0 ends a block scalar,
 * so the YAML scanner died at the first heredoc body line ("could not find
 * expected ':'"), GitHub recorded a failed zero-job run on every push, and the
 * daily digest never ran once.
 *
 * The invariant this test pins: inside every `run: |` / `run: >` block scalar
 * in the workflow, every non-blank line is either indented deeper than the
 * `run:` key or is a line that legitimately *terminates* the scalar (a YAML
 * key or sequence entry). Prose, heredoc bodies, and heredoc terminators at
 * column 0 are exactly the failure shape that broke the file for four months,
 * and this test fails on them with the offending line number.
 *
 * Runs without a YAML library (none is a root dependency) by block-scalar
 * scanning; each extracted script is additionally handed to `bash -n` when a
 * bash binary exists (it does on CI's ubuntu runners), after stubbing
 * `${{ ... }}` expressions.
 *
 * Run: node --test scripts/ci/upstream-digest-workflow.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WORKFLOW = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "workflows",
  "upstream-digest.yml",
);

const RUN_SCALAR_RE = /^(\s*)(?:- )?(?:run|shell-script):\s*[|>][-+\d]*\s*$/;
// A line that may legitimately terminate a block scalar: a `key:` or a
// `- ` sequence entry at the scalar's own indentation or shallower.
const YAML_STRUCTURE_RE = /^(\s*)(?:- )?([A-Za-z0-9_.-]+|'[^']*'|"[^"]*"):\s*(#.*)?$/;
const YAML_SEQ_RE = /^(\s*)-\s+\S/;

/** Scan a workflow file; return { blocks, leaks } where each block is the
 * extracted script text and each leak is { line, text } at/below column 1
 * inside a block scalar without being valid structure. */
export function scanWorkflowBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  const leaks = [];
  let inBlock = null; // { indent, content: [] }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (inBlock) {
      if (line.trim() === "") {
        inBlock.content.push("");
        continue;
      }
      if (inBlock.indent === null) {
        // First non-empty line fixes the scalar's base indentation.
        inBlock.indent = line.length - line.trimStart().length;
      }
      const indent = line.length - line.trimStart().length;
      if (indent >= inBlock.indent) {
        // GitHub strips exactly the block scalar's base indentation; keep any
        // extra so relative indentation (and shell heredocs) survive.
        inBlock.content.push(line.slice(inBlock.indent));
        continue;
      }
      // At or left of the block's indentation: only real YAML structure may
      // appear here. Anything else leaked out of the scalar.
      if (YAML_STRUCTURE_RE.test(line) || YAML_SEQ_RE.test(line)) {
        blocks.push(inBlock.content.join("\n"));
        inBlock = null;
        // fall through to normal handling of this line
      } else {
        leaks.push({ line: i + 1, text: line });
        inBlock.content.push(line);
        continue;
      }
    }

    const match = line.match(RUN_SCALAR_RE);
    if (match) {
      inBlock = {
        // YAML auto-detects a block scalar's indentation from its first
        // non-empty content line — not from the `run:` key's column.
        indent: null,
        content: [],
        declaredAt: i + 1,
      };
    }
  }
  if (inBlock) blocks.push(inBlock.content.join("\n"));
  return { blocks, leaks };
}

test("upstream-digest.yml keeps every run: block scalar indented (AGE-29)", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const { blocks, leaks } = scanWorkflowBlocks(text);

  assert.deepEqual(
    leaks,
    [],
    leaks
      .map((l) => `line ${l.line} leaks out of a run: block scalar: ${l.text}`)
      .join("\n"),
  );
  assert.ok(blocks.length >= 3, "expected at least 3 run: scripts in the workflow");
});

test("upstream-digest.yml keeps the daily 09:00 UTC schedule and workflow_dispatch", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  assert.match(text, /workflow_dispatch:\s*$/m, "workflow_dispatch trigger missing");
  assert.match(text, /cron:\s*["']?0 9 \* \* \*["']?/, "daily 09:00 UTC cron missing");
});

test("every extracted run: script is valid bash", () => {
  const bash = spawnSync("bash", ["--version"]);
  if (bash.error || bash.status !== 0) return; // no bash here; CI has it

  const text = readFileSync(WORKFLOW, "utf8");
  const { blocks } = scanWorkflowBlocks(text);
  for (let i = 0; i < blocks.length; i += 1) {
    // Stub GitHub Actions expressions so bash -n sees a plain script.
    const stubbed = blocks[i].replace(/\$\{\{[^}]*\}\}/g, "STUBBED_EXPR");
    const result = spawnSync("bash", ["-n"], { input: stubbed });
    assert.equal(
      result.status,
      0,
      `run: block #${i + 1} fails bash -n:\n${result.stderr?.toString() ?? ""}`,
    );
  }
});

test("PR-body heredoc survives block-scalar stripping byte-for-byte", () => {
  // The fix re-indents the heredoc into the block scalar; GitHub strips the
  // block's base indent uniformly, so bash must receive the BODY line, the
  // body lines, EOF and )" all back at column 0 or deeper in the script.
  const text = readFileSync(WORKFLOW, "utf8");
  const { blocks } = scanWorkflowBlocks(text);
  const prScript = blocks.find((b) => b.includes("BODY=\"$(cat <<EOF"));
  assert.ok(prScript, "PR-body heredoc script not found in workflow");

  const prLines = prScript.split("\n");
  const bodyLine = prLines.find((l) => l.trim().startsWith("BODY="));
  assert.match(
    bodyLine.trim(),
    /^BODY="\$\(cat <<EOF$/,
    "BODY heredoc opener malformed",
  );

  const eof = prLines.indexOf("EOF");
  const closer = prLines[eof + 1];
  assert.equal(closer, ')"', "heredoc terminator (EOF / \\\") not intact in script");
  assert.ok(eof > prLines.indexOf(bodyLine), "EOF must follow the body");
});
