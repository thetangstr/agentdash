// @vitest-environment node
// Verifies that InviteLanding no longer gates any adapters with "coming soon" copy.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "../InviteLanding.tsx"), "utf-8");

describe("InviteLanding adapter availability", () => {
  it("renders every adapter without a 'coming soon' overlay — no coming soon string in source", () => {
    // The old gating produced: {!ENABLED_INVITE_ADAPTERS.has(type) ? " (Coming soon)" : ""}
    // After the fix, this string must not appear.
    expect(source.toLowerCase()).not.toContain("coming soon");
  });

  it("no adapter option is disabled via ENABLED_INVITE_ADAPTERS gating", () => {
    // The old code had: disabled={!ENABLED_INVITE_ADAPTERS.has(type)}
    // After the fix, that disabled attribute must be removed.
    expect(source).not.toContain("ENABLED_INVITE_ADAPTERS");
  });
});
