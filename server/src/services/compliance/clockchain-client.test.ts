import { describe, it, expect, vi } from "vitest";
import {
  makeClockchainClient,
  normalizeReceipt,
} from "./clockchain-client.js";
import {
  attestAgentAction,
  completeAgentAttestation,
  verifyAgentReceipt,
} from "./agent-attestation.js";

describe("compliance/clockchain-client — shared client", () => {
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

describe("compliance/clockchain-client — normalizeReceipt", () => {
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

describe("compliance/agent-attestation — typed adoption surface", () => {
  function makeMockClient(responses: Record<string, Record<string, unknown>>) {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    return {
      calls,
      client: makeClockchainClient({
        callTool: async (req) => {
          calls.push(req);
          // Return the queued response for this tool if present; otherwise
          // return a generic empty success so individual tests can still assert
          // that the call was made (even if the response shape doesn't matter).
          const result = responses[req.name];
          if (result) return { content: [{ type: "text", text: JSON.stringify(result) }] };
          return { content: [{ type: "text", text: JSON.stringify({ eventHash: "default" }) }] };
        },
      }),
    };
  }

  it("submits with wait=false by default (hot-path safe)", async () => {
    const { client, calls } = makeMockClient({});
    await attestAgentAction(client, {
      agentId: "leah.compliance",
      action: "approval.sign",
      inputs: { issueId: "MER-7", decision: "adopt" },
      outputs: { receiptId: "r-1" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("attest_action");
    expect(calls[0].arguments.wait).toBe(false);
  });

  it("passes wait=true when the caller needs confirmed receipt (cold path)", async () => {
    const { client, calls } = makeMockClient({});
    await attestAgentAction(client, {
      agentId: "billing", action: "billing.disburse",
      inputs: { amount: 100 }, outputs: { txId: "tx-1" },
      wait: true, waitMs: 5000,
    });
    expect(calls[0].arguments.wait).toBe(true);
    expect(calls[0].arguments.wait_ms).toBe(5000);
  });

  it("derives a stable idempotency key from payload (safe retries)", async () => {
    const { client, calls } = makeMockClient({});
    const req = {
      agentId: "billing", action: "billing.disburse",
      inputs: { amount: 100, to: "vendor-A" }, outputs: { txId: "tx-1" },
    };
    await attestAgentAction(client, req);
    await attestAgentAction(client, req);
    const k1 = calls[0].arguments.idempotency_key;
    const k2 = calls[1].arguments.idempotency_key;
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different payloads → different idempotency keys", async () => {
    const { client, calls } = makeMockClient({});
    await attestAgentAction(client, {
      agentId: "billing", action: "billing.disburse",
      inputs: { amount: 100 }, outputs: {},
    });
    await attestAgentAction(client, {
      agentId: "billing", action: "billing.disburse",
      inputs: { amount: 200 }, outputs: {},
    });
    expect(calls[0].arguments.idempotency_key).not.toBe(calls[1].arguments.idempotency_key);
  });

  it("honors an explicit idempotency key override", async () => {
    const { client, calls } = makeMockClient({});
    await attestAgentAction(client, {
      agentId: "billing", action: "billing.disburse",
      inputs: { amount: 100 }, outputs: {},
      idempotencyKey: "retry-token-abc",
    });
    expect(calls[0].arguments.idempotency_key).toBe("retry-token-abc");
  });

  it("flags confirmed=true when anchor.blockHeight is populated", async () => {
    const { client } = makeMockClient({
      attest_action: {
        eventHash: "abc123",
        anchor: { ledgerId: "L1", blockHeight: "4477946", recordedAt: "22-06-2026 16:54:00 UTC" },
      },
    });
    const r = await attestAgentAction(client, {
      agentId: "leah", action: "test", inputs: {}, outputs: {},
    });
    expect(r.confirmed).toBe(true);
    expect(r.normalized.eventHash).toBe("abc123");
    expect(r.normalized.ledgerId).toBe("L1");
    expect(r.normalized.blockHeight).toBe("4477946");
  });

  it("flags confirmed=false when blockHeight is null/pending", async () => {
    const { client } = makeMockClient({
      attest_action: {
        eventHash: "abc123",
        anchor: { ledgerId: "L1", blockHeight: null, confirmed: false },
      },
    });
    const r = await attestAgentAction(client, {
      agentId: "leah", action: "test", inputs: {}, outputs: {},
    });
    expect(r.confirmed).toBe(false);
    expect(r.normalized.ledgerId).toBe("L1");
    expect(r.normalized.blockHeight).toBeUndefined();
  });

  it("surfaces tool-level errors instead of swallowing them", async () => {
    const client = makeClockchainClient({
      callTool: async () => ({ isError: true, content: [{ type: "text", text: "logging budget exhausted" }] }),
    });
    await expect(attestAgentAction(client, {
      agentId: "leah", action: "test", inputs: {}, outputs: {},
    })).rejects.toThrow(/logging budget/);
  });

  it("completeAgentAttestation re-polls with the same idempotency key", async () => {
    const { client, calls } = makeMockClient({
      complete_attestation: {
        eventHash: "abc", anchor: { ledgerId: "L1", blockHeight: "4477946" },
      },
    });
    const pending = await attestAgentAction(client, {
      agentId: "leah", action: "test", inputs: { a: 1 }, outputs: {},
    });
    const completed = await completeAgentAttestation(client, pending);
    expect(completed.confirmed).toBe(true);
    expect(completed.normalized.eventHash).toBe("abc");
    expect(completed.normalized.ledgerId).toBe("L1");
    expect(completed.normalized.blockHeight).toBe("4477946");
    const pollCall = calls.find((c) => c.name === "complete_attestation");
    expect(pollCall).toBeDefined();
    // Poll re-passes the original pending receipt verbatim (the server
    // re-derives the event hash and matches against the on-chain block).
    expect((pollCall!.arguments.receipt as Record<string, unknown>)).toEqual(pending.raw);
  });

  it("verifyAgentReceipt routes to the verify_receipt tool (keyless third-party check)", async () => {
    const { client, calls } = makeMockClient({
      verify_receipt: { match: true, verifiedAgainst: "on-chain-block" },
    });
    const r = await verifyAgentReceipt(client, {
      raw: { eventHash: "abc", anchor: { ledgerId: "L1", blockHeight: "4477946" } },
      normalized: {}, confirmed: true, idempotencyKey: "k",
    });
    expect(r.match).toBe(true);
    expect(calls.find((c) => c.name === "verify_receipt")).toBeDefined();
  });
});