#!/usr/bin/env node
// AgentDash CI guard: fail the PR if any tracked file contains leftover git
// merge-conflict markers. Added after PR #390 (Gmail connector) merged to main
// with unresolved `<<<<<<<` / `>>>>>>>` markers in server/src/app.ts, which
// broke typecheck + build for everyone. This is a fast, deterministic check in
// the (required) `policy` job — it does not depend on the flaky e2e gate.
//
// We match only the start/end marker shapes (`<<<<<<<` and `>>>>>>>` at line
// start, followed by a space or end-of-line). The middle `=======` divider is
// intentionally NOT matched on its own — a bare line of seven `=` is common in
// markdown/text and would false-positive. A real conflict always has the start
// and end markers, so matching those two is sufficient and safe.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MARKER_RE = /^(<{7}|>{7})(\s|$)/;
// Don't scan this checker itself (it documents the marker shapes above).
const SELF = "scripts/ci/check-conflict-markers.mjs";

function trackedFiles() {
  const out = execSync("git ls-files", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter(Boolean);
}

function isProbablyBinary(buf) {
  // Treat a NUL byte in the first 8KB as binary.
  const slice = buf.subarray(0, 8192);
  return slice.includes(0);
}

const offenders = [];
for (const file of trackedFiles()) {
  if (file === SELF) continue;
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue; // deleted/unreadable — skip
  }
  if (isProbablyBinary(buf)) continue;
  const lines = buf.toString("utf8").split("\n");
  lines.forEach((line, i) => {
    if (MARKER_RE.test(line)) {
      offenders.push(`${file}:${i + 1}: ${line.slice(0, 80)}`);
    }
  });
}

if (offenders.length > 0) {
  process.stderr.write(
    "Merge-conflict markers found in tracked files. Resolve them before merging:\n\n" +
      offenders.map((o) => `  - ${o}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

process.stdout.write("No merge-conflict markers found.\n");
