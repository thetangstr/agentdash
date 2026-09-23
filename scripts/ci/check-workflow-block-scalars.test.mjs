import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkWorkflowsDir, findDedentedBlockScalarLines } from "./check-workflow-block-scalars.mjs";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/**
 * `.github/workflows/upstream-digest.yml` was invalid YAML from the day it was
 * added (2026-05-10) until 2026-09-01: a shell heredoc inside `run: |` sat at
 * column 1, the block scalar ended there, and GitHub recorded a zero-job failed
 * run on every push while the daily digest never ran once. Nothing gated on it,
 * so nobody noticed. These pin the shape of that defect.
 */

const GOOD = `
jobs:
  digest:
    steps:
      - name: Build body
        run: |
          BODY="$(cat <<EOF
          ## Heading — \${DATE}

          \${NOTE}
          EOF
          )"
          echo "$BODY"

      - name: Folded
        run: >
          echo one
          echo two
      - name: Next
        run: echo done
`;

const HEREDOC_AT_COLUMN_ONE = `
jobs:
  digest:
    steps:
      - name: Build body
        run: |
          BODY="$(cat <<EOF
## Heading — \${DATE}

\${NOTE}

**Summary:** \${SUMMARY}
EOF
)"
          echo "$BODY"
      - name: Next
        run: echo done
`;

const PARTIAL_DEDENT = `
steps:
  - name: Script
    run: |
      if true; then
        echo yes
    fi
      echo after
  - name: Next
    run: echo done
`;

test("a correctly indented heredoc and a folded scalar produce no findings", () => {
  assert.deepEqual(findDedentedBlockScalarLines(GOOD), []);
});

test("a heredoc left at column 1 is reported at the first escaped non-comment line", () => {
  const findings = findDedentedBlockScalarLines(HEREDOC_AT_COLUMN_ONE);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].text, "${NOTE}");
  assert.equal(findings[0].expectedIndent, 10);
});

test("a line dedented inside the block but still right of the key is reported", () => {
  const findings = findDedentedBlockScalarLines(PARTIAL_DEDENT);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].text.trim(), "fi");
});

test("every workflow in .github/workflows keeps its block scalars intact", () => {
  const findings = checkWorkflowsDir(path.join(REPO_ROOT, ".github", "workflows"));
  assert.deepEqual(
    findings.map((f) => `${path.relative(REPO_ROOT, f.file)}:${f.line}`),
    [],
    "escaped block-scalar content found; the workflow would be invalid YAML",
  );
});
