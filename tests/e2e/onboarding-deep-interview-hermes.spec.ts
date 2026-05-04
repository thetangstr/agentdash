// AgentDash (Phase G): Hermes informational E2E spec.
//
// INFORMATIONAL ONLY — skipped in CI unless PAPERCLIP_E2E_HERMES=true.
// When enabled, runs the happy-path interview against the local hermes adapter
// (hermes_local, not stubbed) and records the token-budget metric.
//
// Phase G acceptance gate #5: tokens_in_hermes <= 0.30 * tokens_in_claude_api
//
// The hard assertion lives in the UNIT test at
//   server/src/__tests__/deep-interview-prompts.test.ts
// (the "Phase G: token-budget hard gate" describe block).
//
// This file asserts the same ratio at runtime if both adapter budget entries
// were collected during the run. If only one adapter was used (the hermes run
// doesn't also drive a claude_api turn), the ratio check is skipped with a
// documented note — the unit-level gate is the CI blocker.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { chrisCtoPersona } from "./personas/chris-cto";

const HERMES_ENABLED = process.env.PAPERCLIP_E2E_HERMES === "true";
const TOKEN_BUDGET_FILE = process.env.AGENTDASH_TOKEN_BUDGET_FILE ?? "/tmp/agentdash-token-budget.json";

const RUN_ID = Date.now();
const persona = {
  ...chrisCtoPersona,
  email: `chris-hermes-${RUN_ID}@biggerco.test`,
  companyName: `BiggerCo-Hermes-${RUN_ID}`,
};

test.describe("Hermes informational — deep-interview token budget", () => {
  test.skip(!HERMES_ENABLED, "Set PAPERCLIP_E2E_HERMES=true to run this spec against hermes_local");

  test("hermes_local prompt bytes ≤ 0.30 × claude_api prompt bytes (informational)", async ({ page }) => {
    const baseUrl = `http://127.0.0.1:${process.env.PAPERCLIP_E2E_PORT ?? 3199}`;

    // Reset token-budget file before this run so we only capture fresh entries.
    try { fs.writeFileSync(TOKEN_BUDGET_FILE, "[]", "utf8"); } catch { /* ignore */ }

    // Get the company (local_trusted mode provides one).
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json() as Array<{ id: string; name: string }>;
    expect(companies.length).toBeGreaterThan(0);
    const companyId = companies[0]!.id;

    // Drive one interview turn (sufficient to collect prompt bytes for one adapter).
    const t0 = await page.request.post(`${baseUrl}/api/companies/${companyId}/assess`, {
      data: { description: persona.interviewAnswers[0] },
    });
    expect(t0.ok(), `assess turn 0 failed: ${t0.status()}`).toBe(true);

    // Read token-budget sidecar file.
    let entries: Array<{ adapter: string; bytes: number; ts: number }> = [];
    try {
      if (fs.existsSync(TOKEN_BUDGET_FILE)) {
        entries = JSON.parse(fs.readFileSync(TOKEN_BUDGET_FILE, "utf8"));
      }
    } catch {
      console.warn("[hermes-spec] could not read token-budget file — skipping ratio check");
    }

    const hermesEntries = entries.filter((e) => e.adapter === "hermes_local");
    const claudeEntries = entries.filter((e) => e.adapter === "claude_api");

    if (hermesEntries.length === 0 || claudeEntries.length === 0) {
      console.info(
        "[hermes-spec] Only one adapter observed in this run — ratio check skipped. " +
        "The unit-level gate in deep-interview-prompts.test.ts is the CI blocker. " +
        `hermes entries: ${hermesEntries.length}, claude entries: ${claudeEntries.length}`
      );
      // Non-blocking: this is informational. Pass.
      return;
    }

    const avgHermesBytes = hermesEntries.reduce((s, e) => s + e.bytes, 0) / hermesEntries.length;
    const avgClaudeBytes = claudeEntries.reduce((s, e) => s + e.bytes, 0) / claudeEntries.length;
    const ratio = avgHermesBytes / avgClaudeBytes;

    console.info(
      `[hermes-spec] token-budget ratio: ${ratio.toFixed(4)} ` +
      `(hermes avg ${Math.round(avgHermesBytes)} bytes / claude avg ${Math.round(avgClaudeBytes)} bytes)`
    );

    // Phase G acceptance gate #5 (hard assertion at runtime).
    expect(
      ratio,
      `hermes prompt bytes (avg ${Math.round(avgHermesBytes)}) must be ≤ 30% of ` +
      `claude_api prompt bytes (avg ${Math.round(avgClaudeBytes)})`
    ).toBeLessThanOrEqual(0.30);
  });
});
