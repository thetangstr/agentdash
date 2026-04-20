import { describe, expect, it, vi } from "vitest";
import { StubBillingProvider, type BillingLogger } from "./index.js";

function makeLogger(): BillingLogger & { calls: Array<[string, Record<string, unknown> | undefined]> } {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    calls,
    info: (message, meta) => {
      calls.push([message, meta]);
    },
  };
}

describe("StubBillingProvider", () => {
  it("createCheckoutSession returns stubbed result and logs", async () => {
    const logger = makeLogger();
    const provider = new StubBillingProvider(logger);

    const result = await provider.createCheckoutSession({
      companyId: "company-1",
      targetTier: "pro",
    });

    expect(result).toEqual({
      status: "stubbed",
      reason: "billing provider not configured",
    });
    expect(logger.calls).toEqual([
      [
        "createCheckoutSession",
        { companyId: "company-1", targetTier: "pro" },
      ],
    ]);
  });

  it("cancelSubscription returns stubbed result and logs", async () => {
    const logger = makeLogger();
    const provider = new StubBillingProvider(logger);

    const result = await provider.cancelSubscription({ companyId: "company-1" });

    expect(result).toEqual({
      status: "stubbed",
      reason: "billing provider not configured",
    });
    expect(logger.calls).toEqual([
      ["cancelSubscription", { companyId: "company-1" }],
    ]);
  });

  it("syncEntitlement resolves void and logs", async () => {
    const logger = makeLogger();
    const provider = new StubBillingProvider(logger);

    await expect(
      provider.syncEntitlement({ companyId: "company-1", tier: "enterprise" }),
    ).resolves.toBeUndefined();

    expect(logger.calls).toEqual([
      [
        "syncEntitlement",
        { companyId: "company-1", tier: "enterprise" },
      ],
    ]);
  });

  it("uses default logger when none provided", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = new StubBillingProvider();

    await provider.syncEntitlement({ companyId: "company-1", tier: "free" });

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
