import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockchainEnabled, clockchainService } from "../services/clockchain.ts";

const OLD = { ...process.env };
beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { process.env = { ...OLD }; });

describe("clockchainService — flag gating", () => {
  it("is disabled and degrades gracefully when the flag is off", async () => {
    delete process.env.AGENTDASH_ATTESTATION_ENABLED;
    expect(clockchainEnabled()).toBe(false);
    const svc = clockchainService();
    const res = await svc.delegateAuthority({ parentDid: "did:a", childDid: "did:b", scope: [], until: "2030-01-01T00:00:00Z" });
    expect(res.anchored).toBe(false);
    expect(res.ledgerId).toBeUndefined();
    const entry = await svc.getLogEntry("led_x");
    expect(entry).toEqual({ found: false, anchored: false });
  });
});

describe("clockchainService — flag on (mocked fetch)", () => {
  beforeEach(() => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
  });

  it("anchors and maps ledgerId/blockHeight from a delegate_authority result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ledgerId: "led_123", blockHeight: 314159 }) }] } }),
      { status: 200 },
    ) as any);
    const res = await clockchainService().delegateAuthority({ parentDid: "did:a", childDid: "did:b", scope: ["x"], until: "2030-01-01T00:00:00Z" });
    expect(res).toEqual({ anchored: true, ledgerId: "led_123", blockHeight: 314159 });
  });

  it("degrades to not-found when the gateway errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const v = await clockchainService().getLogEntry("led_err");
    expect(v).toEqual({ found: false, anchored: false });
  });

  it("parses an SSE-framed (text/event-stream) delegate_authority result", async () => {
    const payload = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ledgerId: "led_sse", blockHeight: 42 }) }] } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      `data: ${JSON.stringify(payload)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ) as any);
    const res = await clockchainService().delegateAuthority({ parentDid: "did:a", childDid: "did:b", scope: ["x"], until: "2030-01-01T00:00:00Z" });
    expect(res).toEqual({ anchored: true, ledgerId: "led_sse", blockHeight: 42 });
  });

  it("degrades to not-found when fetch aborts (timeout)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("aborted", "AbortError"));
    const v = await clockchainService().getLogEntry("led_abort");
    expect(v).toEqual({ found: false, anchored: false });
  });
});

describe("identity wrappers", () => {
  it("degrades gracefully when the flag is off", async () => {
    delete process.env.AGENTDASH_ATTESTATION_ENABLED;
    const svc = clockchainService();
    const minted = await svc.mintIdentity({ agentId: "a" });
    expect(minted).toEqual({ minted: false });
    const resolved = await svc.resolveAgent("did:x");
    expect(resolved).toEqual({ found: false });
  });

  it("mints and maps did/ledgerId from a mint_identity result", async () => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ did: "did:cc:vega", ledgerId: "led_1" }) }] } }),
      { status: 200 },
    ) as any);
    const res = await clockchainService().mintIdentity({ agentId: "a" });
    expect(res).toEqual({ minted: true, did: "did:cc:vega", ledgerId: "led_1" });
  });

  it("degrades to minted:false when the gateway errors", async () => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const res = await clockchainService().mintIdentity({ agentId: "a" });
    expect(res).toEqual({ minted: false });
  });
});

describe("KYA + attest wrappers", () => {
  it("degrades gracefully when the flag is off", async () => {
    delete process.env.AGENTDASH_ATTESTATION_ENABLED;
    const svc = clockchainService();
    const verdict = await svc.verifyIdentityAt({ did: "did:x", at: "2026-07-16T00:00:00Z" });
    expect(verdict).toEqual({ status: "unavailable" });
    const attested = await svc.attestAction({ agentDid: "did:a", action: "x" });
    expect(attested).toEqual({ attested: false });
  });

  it("reports valid when the gateway confirms identity validity at the timestamp", async () => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ valid: true }) }] } }),
      { status: 200 },
    ) as any);
    const verdict = await clockchainService().verifyIdentityAt({ did: "did:x", at: "2026-07-16T00:00:00Z" });
    expect(verdict).toEqual({ status: "valid" });
  });

  it("reports invalid when the gateway says the identity is not valid", async () => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ valid: false }) }] } }),
      { status: 200 },
    ) as any);
    const verdict = await clockchainService().verifyIdentityAt({ did: "did:x", at: "2026-07-16T00:00:00Z" });
    expect(verdict).toEqual({ status: "invalid" });
  });

  it("attests and maps ledgerId/blockHeight/status from an attest_action result", async () => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ledgerId: "led_a", blockHeight: 9, status: "anchored" }) }] } }),
      { status: 200 },
    ) as any);
    const res = await clockchainService().attestAction({ agentDid: "did:a", action: "x" });
    // CLO-137: attestAction also returns the raw gateway `receipt` so callers can
    // re-verify it off-chain (verifyReceipt / the ZK permission-proof flow).
    expect(res).toEqual({
      attested: true,
      ledgerId: "led_a",
      blockHeight: 9,
      status: "anchored",
      receipt: { ledgerId: "led_a", blockHeight: 9, status: "anchored" },
    });
  });

  it("sends allow_degraded on writes only when CLOCKCHAIN_ALLOW_DEGRADED=true", async () => {
    const argsOf = async (allow: string) => {
      process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
      process.env.CLOCKCHAIN_MCP_KEY = "test-key";
      process.env.CLOCKCHAIN_ALLOW_DEGRADED = allow;
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ledgerId: "led_a", blockHeight: 1, status: "anchored" }) }] } }),
        { status: 200 },
      ) as any);
      await clockchainService().attestAction({ agentDid: "did:a", action: "x" });
      const body = JSON.parse((spy.mock.calls[0][1] as any).body);
      return body.params.arguments;
    };
    expect((await argsOf("true")).allow_degraded).toBe(true);
    expect((await argsOf("false")).allow_degraded).toBeUndefined();
  });


  it("degrades to unavailable/attested:false when the gateway errors", async () => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const verdict = await clockchainService().verifyIdentityAt({ did: "did:x", at: "2026-07-16T00:00:00Z" });
    expect(verdict).toEqual({ status: "unavailable" });
    const attested = await clockchainService().attestAction({ agentDid: "did:a", action: "x" });
    expect(attested).toEqual({ attested: false });
  });
});
