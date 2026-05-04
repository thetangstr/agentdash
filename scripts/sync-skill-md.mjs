#!/usr/bin/env node
// scripts/sync-skill-md.mjs
//
// Regenerates packages/shared/src/deep-interview-skill.ts from the upstream
// OMC `deep-interview/SKILL.md` corpus. Pinned upstream version is set via
// `OMC_SKILL_VERSION` (default `4.13.5`) — never "latest." The script reads
// the source from one of two places, in priority order:
//
//   1. ~/.claude/plugins/cache/omc/oh-my-claudecode/<OMC_SKILL_VERSION>/skills/deep-interview/SKILL.md
//      (developer's local OMC install)
//   2. scripts/fixtures/skill-md-<OMC_SKILL_VERSION>.md
//      (checked-in fixture — used by CI in environments without OMC)
//
// Either source is acceptable; the fixture is the contract for clean envs.
//
// The generated TS file exports two pinned constants:
//   - SKILL_MD_FULL    — verbatim contents of the source SKILL.md
//   - SKILL_MD_SUMMARY — the "Methodology Summary" section, sliced from
//                         the source if a recognizable heading is found,
//                         otherwise loaded from
//                         `scripts/skill-md-summary-fallback.md`.
//
// The script is idempotent: running twice with the same source produces
// byte-identical output. CI guards drift via:
//   pnpm sync-skill-md && git diff --exit-code packages/shared/src/deep-interview-skill.ts
//
// To regenerate locally after bumping OMC_SKILL_VERSION:
//   OMC_SKILL_VERSION=4.13.6 pnpm sync-skill-md
//
// To regenerate from the checked-in fixture (CI-equivalent path):
//   AGENTDASH_SKILL_MD_USE_FIXTURE=1 pnpm sync-skill-md

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const OMC_SKILL_VERSION = process.env.OMC_SKILL_VERSION ?? "4.13.5";
const USE_FIXTURE_ONLY = process.env.AGENTDASH_SKILL_MD_USE_FIXTURE === "1";

const HOME_CACHE_PATH = resolve(
  homedir(),
  ".claude/plugins/cache/omc/oh-my-claudecode",
  OMC_SKILL_VERSION,
  "skills/deep-interview/SKILL.md",
);
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  "scripts/fixtures",
  `skill-md-${OMC_SKILL_VERSION}.md`,
);
const FALLBACK_SUMMARY_PATH = resolve(
  REPO_ROOT,
  "scripts/skill-md-summary-fallback.md",
);
const OUTPUT_PATH = resolve(
  REPO_ROOT,
  "packages/shared/src/deep-interview-skill.ts",
);

function loadSkillMd() {
  // Both source paths must produce byte-identical output so the CI guard
  // (`git diff --exit-code`) works regardless of which environment ran the
  // sync. The `pickedFrom` label is logged but NOT embedded in the generated
  // file — the file only records the pinned version and a content
  // fingerprint, both of which are stable across source paths.
  if (!USE_FIXTURE_ONLY && existsSync(HOME_CACHE_PATH)) {
    return {
      contents: readFileSync(HOME_CACHE_PATH, "utf8"),
      pickedFrom: `OMC cache (${HOME_CACHE_PATH})`,
    };
  }
  if (existsSync(FIXTURE_PATH)) {
    return {
      contents: readFileSync(FIXTURE_PATH, "utf8"),
      pickedFrom: `checked-in fixture (${FIXTURE_PATH})`,
    };
  }
  console.error(
    `[sync-skill-md] FATAL: cannot find SKILL.md for OMC ${OMC_SKILL_VERSION}.`,
  );
  console.error(`  Tried OMC cache: ${HOME_CACHE_PATH}`);
  console.error(`  Tried fixture:   ${FIXTURE_PATH}`);
  console.error(
    `  Either install OMC ${OMC_SKILL_VERSION} or commit the fixture file at the path above.`,
  );
  process.exit(1);
}

/**
 * Try to slice a "Methodology Summary"-shaped section out of the upstream
 * SKILL.md. The OMC corpus has historically had its methodology distributed
 * across several sections; we look for any of the recognizable headings and
 * extract from the first match through the next top-level (`## `) heading
 * or end-of-file. If no heading matches, return null and let the caller
 * fall back to the hand-curated summary file.
 */
function trySliceSummary(skillMd) {
  const SUMMARY_HEADING_PATTERNS = [
    /^## Methodology Summary\b.*$/m,
    /^## Methodology\b.*$/m,
    /^## Summary\b.*$/m,
  ];
  for (const pattern of SUMMARY_HEADING_PATTERNS) {
    const match = pattern.exec(skillMd);
    if (!match) continue;
    const start = match.index;
    // Find the next top-level (`## `) heading after the match, or fall back
    // to end-of-file. We deliberately avoid `### ` so the slice stays whole.
    const afterStart = start + match[0].length;
    const nextHeadingMatch = /^## (?!#)/m.exec(skillMd.slice(afterStart));
    const end = nextHeadingMatch
      ? afterStart + nextHeadingMatch.index
      : skillMd.length;
    return skillMd.slice(start, end).trimEnd() + "\n";
  }
  return null;
}

function loadSummary(skillMd) {
  const sliced = trySliceSummary(skillMd);
  if (sliced) {
    return { contents: sliced, pickedFrom: "sliced-from-skill-md" };
  }
  if (!existsSync(FALLBACK_SUMMARY_PATH)) {
    console.error(
      `[sync-skill-md] FATAL: upstream SKILL.md has no recognizable summary heading and the fallback file is missing.`,
    );
    console.error(`  Expected fallback at: ${FALLBACK_SUMMARY_PATH}`);
    process.exit(1);
  }
  return {
    contents: readFileSync(FALLBACK_SUMMARY_PATH, "utf8"),
    pickedFrom: `fallback (${FALLBACK_SUMMARY_PATH})`,
  };
}

/**
 * Render a string as a JS template literal. We use template literals (not
 * single/double-quoted strings) to keep the generated file readable, but
 * we have to escape backticks, `${`, and stray backslashes.
 */
function toTemplateLiteral(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/**
 * Compute a short content fingerprint we embed in the generated file. The
 * fingerprint is byte-stable across source paths (OMC cache vs. checked-in
 * fixture) — it's a property of the content, not the filesystem location —
 * so the CI drift guard works regardless of which path the script read from.
 */
async function fingerprint(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function renderGeneratedFile({
  skillMd,
  summary,
  skillMdFingerprint,
  summaryFingerprint,
  summarySliced,
}) {
  const summarySourceTag = summarySliced
    ? "sliced-from-skill-md"
    : "hand-curated-fallback";
  const header = `// AUTO-GENERATED by scripts/sync-skill-md.mjs — DO NOT EDIT BY HAND.
//
// Pinned upstream OMC version: ${OMC_SKILL_VERSION}
// SKILL.md sha256/16:           ${skillMdFingerprint}
// Summary sha256/16:            ${summaryFingerprint}
// Summary source:               ${summarySourceTag}
//
// The fingerprints above are content hashes, not filesystem paths, so this
// file is byte-identical whether the sync script read from a developer's
// local OMC install or from the checked-in fixture at
// scripts/fixtures/skill-md-<version>.md.
//
// To regenerate after bumping OMC_SKILL_VERSION or touching the fallback:
//   pnpm sync-skill-md
//
// CI guards drift with:
//   pnpm sync-skill-md && git diff --exit-code packages/shared/src/deep-interview-skill.ts
//
// See docs/superpowers/plans/2026-05-04-onboarding-redesign-deep-interview-plan.md
// (Phase A) for the design rationale.

export const SKILL_MD_SOURCE_VERSION = ${JSON.stringify(OMC_SKILL_VERSION)} as const;

export const SKILL_MD_FULL: string = \`${toTemplateLiteral(skillMd)}\`;

export const SKILL_MD_SUMMARY: string = \`${toTemplateLiteral(summary)}\`;
`;
  return header;
}

async function main() {
  const { contents: skillMd, pickedFrom: skillPickedFrom } = loadSkillMd();
  const { contents: summary, pickedFrom: summaryPickedFrom } =
    loadSummary(skillMd);
  const summarySliced = summaryPickedFrom === "sliced-from-skill-md";
  const [skillMdFingerprint, summaryFingerprint] = await Promise.all([
    fingerprint(skillMd),
    fingerprint(summary),
  ]);
  const rendered = renderGeneratedFile({
    skillMd,
    summary,
    skillMdFingerprint,
    summaryFingerprint,
    summarySliced,
  });
  writeFileSync(OUTPUT_PATH, rendered, "utf8");
  console.log(`[sync-skill-md] wrote ${OUTPUT_PATH}`);
  console.log(
    `  full    : ${skillMd.length} chars (sha256/16 ${skillMdFingerprint}) from ${skillPickedFrom}`,
  );
  console.log(
    `  summary : ${summary.length} chars (sha256/16 ${summaryFingerprint}) from ${summaryPickedFrom}`,
  );
}

main();
