import { describe, it, expect, vi } from "vitest";
import { makeClockchainClient, normalizeReceipt } from "./clockchain-client.js";

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
  it("prefers structuredContent when present", async () => {
    const client = makeClockchainClient({ callTool: async () => ({ structuredContent: { eventHash: "h1" }, content: [] }) });
    expect((await client.attest("attest_action", {})).eventHash).toBe("h1");
  });
  it("returns {} when result has no parseable text", async () => {
    const client = makeClockchainClient({ callTool: async () => ({ content: [] }) });
    expect(await client.attest("log_action", {})).toEqual({});
  });
  it("throws on a tool-level error instead of swallowing it", async () => {
    const client = makeClockchainClient({ callTool: async () => ({ isError: true, content: [{ type: "text", text: "agent_id required" }] }) });
    await expect(client.attest("attest_action", {})).rejects.toThrow(/agent_id required/);
  });
});

describe("normalizeReceipt", () => {
  it("maps the clockchain.receipt/v1 nested anchor shape", () => {
    const raw = {
      eventHash: "64040dd9",
      anchor: { ledgerId: "1e1bb9c1", blockHeight: "3933930", recordedAt: "16-06-2026 06:11:39 UTC" },
    };
    const n = normalizeReceipt(raw);
    expect(n.eventHash).toBe("64040dd9");
    expect(n.ledgerId).toBe("1e1bb9c1");
    expect(n.blockHeight).toBe("3933930");
    expect(n.clockchainTime).toBe("16-06-2026 06:11:39 UTC");
  });
  it("falls back to flat top-level keys", () => {
    const n = normalizeReceipt({ ledgerId: "l1", blockHeight: "5", clockchainTime: "t" });
    expect(n.ledgerId).toBe("l1");
    expect(n.blockHeight).toBe("5");
    expect(n.clockchainTime).toBe("t");
  });
  it("returns {} for junk", () => {
    expect(normalizeReceipt(null)).toEqual({});
    expect(normalizeReceipt("nope")).toEqual({});
  });
});
