// @vitest-environment node
// Verifies that the adapter dropdown in AgentConfigForm no longer shows
// "Coming soon" labels or disables options for shipped adapters.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "../AgentConfigForm.tsx"), "utf-8");

describe("AgentConfigForm adapter dropdown", () => {
  it("adapter dropdown has no 'coming soon' options", () => {
    // The old code rendered: <span>Coming soon</span> when item.comingSoon was true.
    // After the fix, no adapter has comingSoon set, so this span must not appear.
    expect(source).not.toContain("Coming soon");
  });

  it("adapter dropdown does not disable options based on comingSoon", () => {
    // The old code had: disabled={item.comingSoon} and opacity-40 cursor-not-allowed
    // These are gating patterns. After the fix, no disabled gating via comingSoon.
    expect(source).not.toContain("item.comingSoon");
  });
});
