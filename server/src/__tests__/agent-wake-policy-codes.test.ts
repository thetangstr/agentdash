// AgentDash (wake policy): the refusal reason strings are a stable contract
// with external verifiers (doc/AGENT-WAKE-POLICY.md, "Stable contract"). A
// skipped wake whose reason is one of these, with runId null, is counted as a
// refused wake, never as foreign work. This test pins the exact set so a new
// code cannot be added — or an old one renamed — without updating the
// contract and the verifiers deliberately.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_WAKE_POLICY_REFUSAL_CODES } from "@paperclipai/shared";
import { WAKE_POLICY_REFUSAL, WAKE_PAYLOAD_REQUESTED_BY_CREDENTIAL_KEY } from "../services/agent-wake-policy.js";

const STABLE_REFUSAL_CODES = [
  "travel_pairing.wake_source",
  "travel_pairing.not_issue_assignment",
  "travel_pairing.not_board_key",
  "travel_pairing.no_environment",
  "travel_pairing.environment_mismatch",
];

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function productionSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : productionSources(full);
    return entry.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

describe("wake policy refusal codes (stable contract)", () => {
  it("the shared constant is exactly the documented set", () => {
    expect([...AGENT_WAKE_POLICY_REFUSAL_CODES].sort()).toEqual([...STABLE_REFUSAL_CODES].sort());
  });

  it("the server's refusal map uses exactly the same set", () => {
    expect(Object.values(WAKE_POLICY_REFUSAL).sort()).toEqual([...STABLE_REFUSAL_CODES].sort());
  });

  it("no server source writes a travel_pairing.* code outside the set", () => {
    const found = new Set<string>();
    for (const file of productionSources(serverSrc)) {
      for (const match of fs.readFileSync(file, "utf8").matchAll(/["'`](travel_pairing\.[a-z_]+)["'`]/g)) {
        found.add(match[1]!);
      }
    }
    for (const code of found) expect(STABLE_REFUSAL_CODES).toContain(code);
    expect(found.size).toBeGreaterThan(0);
  });

  it("the disclosed payload key is stable", () => {
    expect(WAKE_PAYLOAD_REQUESTED_BY_CREDENTIAL_KEY).toBe("requestedVia");
  });
});
