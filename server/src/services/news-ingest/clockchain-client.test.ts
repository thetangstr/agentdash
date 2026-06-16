import { describe, it, expect, vi } from "vitest";
import { makeClockchainClient } from "./clockchain-client.js";

describe("clockchain client", () => {
  it("calls a tool and parses the JSON text result", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ledgerId: "abc", blockHeight: "100" }) }],
    });
    const client = makeClockchainClient({ callTool });
    const out = await client.attest("attest_action", { action: "log", data: { a: 1 } });
    expect(callTool).toHaveBeenCalledWith({ name: "attest_action", arguments: { action: "log", data: { a: 1 } } });
    expect(out.ledgerId).toBe("abc");
    expect(out.blockHeight).toBe("100");
  });
  it("returns {} when result has no parseable text", async () => {
    const client = makeClockchainClient({ callTool: async () => ({ content: [] }) });
    expect(await client.attest("log_action", {})).toEqual({});
  });
});
