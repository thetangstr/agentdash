#!/usr/bin/env bash
# Run Phase-1 CUJ end-to-end specs and write a markdown QA report.
#
# Covers the five CUJs promoted from "manual only" in doc/CUJ-STATUS.md:
#   CUJ-A Sales Pipeline, CUJ-B Agent Governance, CUJ-C Productivity,
#   CUJ-D Adapter Onboarding, CUJ-E Entitlements.
#
# Requires: dev server already running at localhost:3101 (or pass PORT env).
# Output: test-results/cuj-phase1-<timestamp>.md
set -euo pipefail

cd "$(dirname "$0")/../.."

PORT="${PAPERCLIP_E2E_PORT:-3101}"
TS="$(date +%Y%m%dT%H%M%S)"
REPO_ROOT="$(pwd)"
JSON_OUT="${REPO_ROOT}/test-results/cuj-phase1-${TS}.json"
MD_OUT="${REPO_ROOT}/test-results/cuj-phase1-${TS}.md"

mkdir -p "${REPO_ROOT}/test-results"

echo "==> Running Phase-1 CUJ specs against http://localhost:${PORT}"

# Playwright JSON reporter is configured via env to avoid editing the config.
# The phase1 config pins list+json reporters; JSON goes to PLAYWRIGHT_JSON_OUTPUT_NAME,
# list stays on stdout for interactive visibility.
set +e
PAPERCLIP_E2E_PORT="${PORT}" \
PLAYWRIGHT_JSON_OUTPUT_NAME="${JSON_OUT}" \
npx playwright test --config scripts/qa/phase1-playwright.config.ts \
  tests/e2e/cuj-a-sales-pipeline.spec.ts \
  tests/e2e/cuj-b-agent-governance.spec.ts \
  tests/e2e/cuj-c-productivity.spec.ts \
  tests/e2e/cuj-d-adapter-onboarding.spec.ts \
  tests/e2e/cuj-e-entitlements.spec.ts
STATUS=$?
set -e

echo "==> Rendering report to ${MD_OUT}"
node scripts/qa/phase1-report.mjs "${JSON_OUT}" "${MD_OUT}" "Phase-1 CUJs"

echo ""
echo "==> Report: ${MD_OUT}"
echo "==> JSON:   ${JSON_OUT}"
exit "${STATUS}"
