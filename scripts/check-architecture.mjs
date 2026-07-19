#!/usr/bin/env node
/**
 * check-architecture.mjs
 *
 * Mechanical enforcement of AgentDash's architectural "golden rules" — the
 * invariants that are documented in prose (CLAUDE.md / AGENTS.md) but otherwise
 * rely on reviewers remembering them. Each rule writes a remediation message
 * that injects the fix, so when an agent (or human) trips a rule, the correction
 * lands directly in context. This is the "custom lints with remediation" pillar
 * of the loop-engineering harness (see loops/ARCHITECTURE.md).
 *
 * Add a rule: push a { id, severity, run(root) -> Finding[] } onto RULES.
 *   - severity 'error' → process exits 1 (fails CI / blocks the gate)
 *   - severity 'warn'  → reported, but exit 0 (legacy surface, fix going forward)
 *
 * Usage: node scripts/check-architecture.mjs   (or: pnpm check:architecture)
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Recursively list files under `dir`, skipping the usual noise. */
export function walk(dir, { skip = /node_modules|\.git|dist|build|\.next/ } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (skip.test(full)) continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, { skip }));
    else out.push(full);
  }
  return out;
}

// ───────────────────────── Rule 1: schema export (error) ─────────────────────────
// CLAUDE.md: "New tables MUST be exported from packages/db/src/schema/index.ts".
// A table defined in a schema file but never re-exported from index.ts is invisible
// to Drizzle's migration generation and to every consumer of the schema barrel.
export function checkSchemaExports(root) {
  const schemaDir = join(root, "packages/db/src/schema");
  const indexPath = join(schemaDir, "index.ts");
  if (!existsSync(indexPath)) return [];
  const index = readFileSync(indexPath, "utf8");

  const findings = [];
  for (const file of walk(schemaDir)) {
    if (extname(file) !== ".ts") continue;
    const base = file.slice(schemaDir.length + 1);
    if (base === "index.ts") continue;
    const src = readFileSync(file, "utf8");
    if (!/\bpgTable\s*\(/.test(src)) continue; // only files that actually define tables

    // index.ts imports compiled paths: ./<name>.js
    const stem = base.replace(/\.ts$/, "");
    const referenced =
      index.includes(`./${stem}.js`) || index.includes(`./${stem}"`) || index.includes(`./${stem}'`);
    if (!referenced) {
      findings.push({
        file: relative(root, file),
        message:
          `defines a pgTable but is not re-exported from packages/db/src/schema/index.ts. ` +
          `Add: export { <tableConst> } from "./${stem}.js";`,
      });
    }
  }
  return findings;
}

// ───────────────────────── Rule 2: localStorage branding (warn) ─────────────────────────
// CLAUDE.md branding: localStorage keys must be namespaced `agentdash.*`. Legacy
// `paperclip:*` keys are inherited from upstream — flagged as warnings so new code
// uses the right namespace without breaking the build on the legacy surface.
const LS_RE = /localStorage\.(?:get|set|remove)Item\(\s*['"`]([^'"`]+)['"`]/g;
export function checkLocalStorageBranding(root) {
  const uiDir = join(root, "ui/src");
  const findings = [];
  const seen = new Set();
  for (const file of walk(uiDir)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    let m;
    while ((m = LS_RE.exec(src)) !== null) {
      const key = m[1];
      if (key.startsWith("agentdash.")) continue;
      // de-dupe on key+file so a repeated key in one file reports once
      const dedupe = `${file}::${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      findings.push({
        file: relative(root, file),
        message:
          `localStorage key "${key}" is not namespaced "agentdash.*" (branding rule). ` +
          `Rename to "agentdash.${key.replace(/^paperclip[:.]/, "")}".`,
      });
    }
  }
  return findings;
}

export const RULES = [
  { id: "schema-export", severity: "error", run: checkSchemaExports },
  { id: "localstorage-branding", severity: "warn", run: checkLocalStorageBranding },
];

export function runRules(root = REPO_ROOT, rules = RULES) {
  return rules.map((rule) => ({ ...rule, findings: rule.run(root) }));
}

function main() {
  const results = runRules();
  let errorCount = 0;
  let warnCount = 0;

  for (const { id, severity, findings } of results) {
    if (findings.length === 0) {
      console.log(`✓ ${id}: ok`);
      continue;
    }
    const label = severity === "error" ? "✗" : "⚠";
    console.log(`${label} ${id}: ${findings.length} finding(s) [${severity}]`);
    for (const f of findings) {
      console.log(`    ${f.file}\n      → ${f.message}`);
      if (severity === "error") errorCount++;
      else warnCount++;
    }
  }

  console.log(
    `\nArchitecture check: ${errorCount} error(s), ${warnCount} warning(s).`
  );
  if (errorCount > 0) {
    console.log("Fix the errors above (each message includes the remediation).");
    process.exit(1);
  }
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
