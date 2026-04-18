#!/usr/bin/env node
// Render a markdown QA report from a Playwright JSON report.
//
// Usage:
//   node scripts/qa/phase1-report.mjs <playwright-json> <output-md> [label]

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [jsonPath, outPath, label] = process.argv.slice(2);
if (!jsonPath || !outPath) {
  console.error("usage: phase1-report.mjs <playwright-json> <output-md> [label]");
  process.exit(2);
}

const data = JSON.parse(readFileSync(resolve(jsonPath), "utf8"));
const runLabel = label ?? "Phase-1 CUJs";

function walkSuites(suite, path = []) {
  const out = [];
  const here = suite.title ? [...path, suite.title] : path;
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const latest = t.results?.[t.results.length - 1];
      out.push({
        file: suite.file ?? spec.file ?? "",
        path: here,
        title: spec.title,
        status: latest?.status ?? t.status ?? "unknown",
        durationMs: latest?.duration ?? 0,
        error: latest?.errors?.[0]?.message ?? latest?.error?.message ?? null,
      });
    }
  }
  for (const s of suite.suites ?? []) out.push(...walkSuites(s, here));
  return out;
}

const rows = [];
for (const s of data.suites ?? []) rows.push(...walkSuites(s));

const byFile = new Map();
for (const r of rows) {
  const key = r.file || r.path[0] || "(unknown)";
  if (!byFile.has(key)) byFile.set(key, []);
  byFile.get(key).push(r);
}

const startedAt = new Date(data.stats?.startTime ?? Date.now()).toISOString();
const duration = (data.stats?.duration ?? 0) / 1000;
const passed = rows.filter((r) => r.status === "passed").length;
const failed = rows.filter((r) => r.status === "failed" || r.status === "timedOut").length;
const skipped = rows.filter((r) => r.status === "skipped").length;

const lines = [];
lines.push(`# ${runLabel} — QA Report`);
lines.push("");
lines.push(`- **Run started:** ${startedAt}`);
lines.push(`- **Duration:** ${duration.toFixed(1)}s`);
lines.push(`- **Total:** ${rows.length} | **Passed:** ${passed} | **Failed:** ${failed} | **Skipped:** ${skipped}`);
lines.push("");

const overall = failed === 0 ? "PASS" : "FAIL";
lines.push(`**Overall:** ${overall}`);
lines.push("");

const cujMap = {
  "cuj-a-sales-pipeline.spec.ts": "CUJ-A: Sales Pipeline",
  "cuj-b-agent-governance.spec.ts": "CUJ-B: Agent Governance",
  "cuj-c-productivity.spec.ts": "CUJ-C: Productivity",
  "cuj-d-adapter-onboarding.spec.ts": "CUJ-D: Adapter Onboarding",
  "cuj-e-entitlements.spec.ts": "CUJ-E: Entitlements",
};

for (const [file, items] of byFile) {
  const niceFile = file.split("/").pop() ?? file;
  const heading = cujMap[niceFile] ?? niceFile;
  const passCount = items.filter((i) => i.status === "passed").length;
  const failCount = items.filter((i) => i.status === "failed" || i.status === "timedOut").length;
  const skipCount = items.filter((i) => i.status === "skipped").length;
  lines.push(`## ${heading}`);
  lines.push("");
  lines.push(`Path: \`${file}\``);
  lines.push("");
  lines.push(`- Passed: ${passCount} | Failed: ${failCount} | Skipped: ${skipCount}`);
  lines.push("");
  for (const item of items) {
    const icon = item.status === "passed" ? "✅"
      : item.status === "failed" || item.status === "timedOut" ? "❌"
      : item.status === "skipped" ? "⏭️" : "❓";
    const parent = item.path.slice(1).join(" › ");
    const fullTitle = parent ? `${parent} › ${item.title}` : item.title;
    lines.push(`- ${icon} **${fullTitle}** — ${item.status} (${item.durationMs}ms)`);
    if (item.error) {
      const errPreview = item.error.split("\n").slice(0, 3).join("\n    ").slice(0, 500);
      lines.push(`    \`\`\``);
      lines.push(`    ${errPreview}`);
      lines.push(`    \`\`\``);
    }
  }
  lines.push("");
}

writeFileSync(resolve(outPath), lines.join("\n"));
console.log(`Wrote ${outPath}`);
process.exit(failed === 0 ? 0 : 1);
