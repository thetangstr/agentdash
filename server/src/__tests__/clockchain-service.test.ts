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
    const res = await svc.delegateAuthority({ parentDid: "did:a", childDid: "did:b", scope: {}, until: "2030-01-01T00:00:00Z" });
    expect(res.anchored).toBe(false);
    expect(res.ledgerId).toBeUndefined();
    const verdict = await svc.verifyDelegationAt({ parentDid: "did:a", childDid: "did:b", scope: {}, until: "2030-01-01T00:00:00Z", at: "2026-07-15T00:00:00Z" });
    expect(verdict.status).toBe("unavailable");
  });
});

describe("clockchainService — flag on (mocked fetch)", () => {
  beforeEach(() => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
  });

  it("anchors and maps ledgerId/blockHeight from a delegate_authority result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ledgerId: "led_123", blockHeight: 314159, scheme: "salted-v1" }) }] } }),
      { status: 200 },
    ) as any);
    const res = await clockchainService().delegateAuthority({ parentDid: "did:a", childDid: "did:b", scope: { x: 1 }, until: "2030-01-01T00:00:00Z" });
    expect(res).toEqual({ anchored: true, ledgerId: "led_123", blockHeight: 314159, scheme: "salted-v1" });
  });

  it("degrades to unavailable when the gateway errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const v = await clockchainService().verifyDelegationAt({ parentDid: "did:a", childDid: "did:b", scope: {}, until: "2030-01-01T00:00:00Z", at: "2026-07-15T00:00:00Z" });
    expect(v.status).toBe("unavailable");
  });
});
