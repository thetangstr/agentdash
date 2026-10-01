/**
 * AgentDash: UX-10 (GH #791) — the UI speaks people, for every company (one
 * UX, doc/plans/2026-09-30-one-ux.md). Operator vocabulary — "heartbeat",
 * "harness preflight", "board approval", "Company Settings", "in v1" — must
 * not come back on the surfaces this pass rewrote.
 *
 * Two layers: the shared copy tables and helpers are asserted directly, and a
 * source guard pins the exact retired phrases out of ui/src so a revert or a
 * copy-paste from an older page fails here rather than in review.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { help } from "../components/agent-config-primitives";
import { personFacingPreflightText } from "../components/AgentHarnessReadinessPanel";
import { getAgentCreateHarnessPreflightGate } from "./agent-harness-preflight";
import { settingsNavGroups } from "./settings-nav";

const UI_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const RETIRED_PHRASES = [
  "Run Heartbeat",
  "Heartbeat on interval",
  "Run heartbeat every",
  "Scheduler Heartbeats",
  "Timer Heartbeat",
  "\"Run preflight\"",
  "paused by board",
  "Require board approval for new hires",
  "approved by board",
  "Email confirmation is not required in v1",
  "Company Settings → Access",
  "No heartbeat schedule",
  "Assigned agent or board user",
  "Archive company",
];

describe("person-facing vocabulary (UX-10)", () => {
  it("keeps the retired operator phrases out of ui/src", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(UI_SRC)) {
      const text = readFileSync(file, "utf8");
      for (const phrase of RETIRED_PHRASES) {
        if (text.includes(phrase)) hits.push(`${path.relative(UI_SRC, file)}: ${phrase}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("agent configuration help never says heartbeat", () => {
    const offenders = Object.entries(help).filter(([, text]) => /heartbeat/i.test(text));
    expect(offenders).toEqual([]);
  });

  it("renders harness preflight wording as a setup check", () => {
    expect(personFacingPreflightText("Harness preflight failed")).toBe("Setup check failed");
    expect(personFacingPreflightText("Run preflight again before assigning work.")).toBe(
      "Run setup check again before assigning work.",
    );
    expect(personFacingPreflightText("Agent harness preflight is stale")).toBe("Agent setup check is stale");
    expect(personFacingPreflightText("Missing API key")).toBe("Missing API key");
  });

  it("create-agent gate messages are plain language", () => {
    const base = { currentConfigKey: "k", passedConfigKey: null, result: null, errorMessage: null };
    expect(getAgentCreateHarnessPreflightGate({ ...base, pending: true }).message).toBe(
      "The setup check is still running.",
    );
    const notPassed = getAgentCreateHarnessPreflightGate({
      ...base,
      pending: false,
      result: { status: "fail", checks: [] } as never,
    });
    expect(notPassed.message ?? "").not.toMatch(/preflight|heartbeat/i);
  });

  it("the Settings hub calls the scheduler page Schedules", () => {
    const labels = settingsNavGroups({ isInstanceAdmin: true }).flatMap((group) =>
      group.items.map((item) => item.label),
    );
    expect(labels).toContain("Schedules");
    expect(labels).not.toContain("Heartbeats");
  });
});
