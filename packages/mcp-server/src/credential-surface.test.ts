import { describe, expect, it } from "vitest";

import { isControlPlaneCredential } from "./config.js";
import { PaperclipApiClient } from "./client.js";
import { buildToolSurface } from "./index.js";

/**
 * A steward connects their own Claude Code with a bridge endpoint token, which
 * authenticates five tools. Advertising the whole control plane to it is not
 * harmless: the session sees a large toolset, picks a plausible tool, and gets
 * a 403 that reads like a broken instance rather than the wrong credential.
 */
describe("credential classification", () => {
  it.each([
    ["pcp_abc123", "agent key"],
    ["pcp_board_abc123", "board key"],
    ["pcp_cli_auth_abc123", "cli auth key"],
    ["pcp_claim_abc123", "claim key"],
    ["pcp_invite_abc123", "invite token"],
  ])("treats %s (%s) as control plane", (key) => {
    expect(isControlPlaneCredential(key)).toBe(true);
  });

  it("treats an unprefixed bridge endpoint token as not control plane", () => {
    // What `randomBytes(32).toString("base64url")` actually looks like.
    expect(isControlPlaneCredential("Zr8kQ2xVb1nT7yFhLmP4wCdG9sJuXe0aRtYiOpNkQvE")).toBe(false);
  });

  /** A fresh install has no key and bootstraps one through the signup tools. */
  it("keeps the full surface for an empty key", () => {
    expect(isControlPlaneCredential("")).toBe(true);
    expect(isControlPlaneCredential("   ")).toBe(true);
  });
});

describe("advertised tool surface", () => {
  const surfaceFor = (apiKey: string) =>
    buildToolSurface(
      new PaperclipApiClient({
        apiUrl: "http://instance.test/api",
        apiKey,
        companyId: null,
        agentId: null,
        runId: null,
      }),
      { apiUrl: "http://instance.test/api", apiKey, companyId: null, agentId: null, runId: null },
    ).map((tool) => tool.name);

  const BRIDGE_TOOLS = [
    "bridge_next_task",
    "bridge_submit_result",
    "inbox_sync",
    "inbox_ack",
    "inbox_decide",
  ];

  it("offers a bridge endpoint token exactly the tools it can use", () => {
    const surface = surfaceFor("Zr8kQ2xVb1nT7yFhLmP4wCdG9sJuXe0aRtYiOpNkQvE");
    expect([...surface].sort()).toEqual([...BRIDGE_TOOLS].sort());
  });

  it("still offers the full control plane to an API credential", () => {
    const surface = surfaceFor("pcp_abc123");
    // The whole point: far more than the bridge subset, and the bridge tools too.
    expect(surface.length).toBeGreaterThan(BRIDGE_TOOLS.length * 4);
    for (const name of BRIDGE_TOOLS) expect(surface).toContain(name);
    expect(surface).toContain("whoami");
  });

  it("does not shrink the surface for a fresh install with no key yet", () => {
    expect(surfaceFor("").length).toBeGreaterThan(BRIDGE_TOOLS.length * 4);
  });
});
