import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBillableCents,
  reportUsageToStripe,
  usagePricingFromEnv,
} from "../services/usage-billing.js";

const ENV_KEYS = [
  "AGENTDASH_USAGE_MARKUP",
  "AGENTDASH_USAGE_INPUT_CENTS_PER_MTOK",
  "AGENTDASH_USAGE_OUTPUT_CENTS_PER_MTOK",
] as const;

const ORIG = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

describe("usagePricingFromEnv", () => {
  beforeEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k]!;
    }
  });

  it("defaults to 1.5x markup and zero token prices", () => {
    expect(usagePricingFromEnv()).toEqual({
      markup: 1.5,
      inputCentsPerMTok: 0,
      outputCentsPerMTok: 0,
    });
  });

  it("reads overrides from env", () => {
    process.env.AGENTDASH_USAGE_MARKUP = "2";
    process.env.AGENTDASH_USAGE_INPUT_CENTS_PER_MTOK = "15";
    process.env.AGENTDASH_USAGE_OUTPUT_CENTS_PER_MTOK = "60";
    expect(usagePricingFromEnv()).toEqual({
      markup: 2,
      inputCentsPerMTok: 15,
      outputCentsPerMTok: 60,
    });
  });

  it("ignores a non-positive / invalid markup and falls back to 1.5", () => {
    process.env.AGENTDASH_USAGE_MARKUP = "0";
    expect(usagePricingFromEnv().markup).toBe(1.5);
    process.env.AGENTDASH_USAGE_MARKUP = "nonsense";
    expect(usagePricingFromEnv().markup).toBe(1.5);
  });
});

describe("computeBillableCents", () => {
  it("applies markup to provider COGS when token prices are unset", () => {
    const bill = computeBillableCents(
      { inputTokens: 1_000_000, outputTokens: 0, cogsCents: 100 },
      { markup: 1.5, inputCentsPerMTok: 0, outputCentsPerMTok: 0 },
    );
    expect(bill).toBe(150); // 100 * 1.5
  });

  it("uses the token-priced floor when it exceeds provider COGS (sub-cent calls)", () => {
    // Provider reported 0 cents (rounded down), but tokens are priced.
    const bill = computeBillableCents(
      { inputTokens: 2_000_000, outputTokens: 500_000, cogsCents: 0 },
      { markup: 2, inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
    );
    // tokenCogs = 2*15 + 0.5*60 = 30 + 30 = 60; *2 = 120
    expect(bill).toBe(120);
  });

  it("prefers provider COGS when it exceeds the token-priced floor", () => {
    const bill = computeBillableCents(
      { inputTokens: 1_000, outputTokens: 1_000, cogsCents: 500 },
      { markup: 1.2, inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
    );
    // tokenCogs is tiny; provider 500 wins; 500 * 1.2 = 600
    expect(bill).toBe(600);
  });

  it("rounds the billable amount up to whole cents", () => {
    const bill = computeBillableCents(
      { inputTokens: 0, outputTokens: 0, cogsCents: 7 },
      { markup: 1.5, inputCentsPerMTok: 0, outputCentsPerMTok: 0 },
    );
    expect(bill).toBe(11); // 7 * 1.5 = 10.5 -> ceil 11
  });

  it("returns 0 for no usage", () => {
    expect(
      computeBillableCents(
        { inputTokens: 0, outputTokens: 0, cogsCents: 0 },
        { markup: 1.5, inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
      ),
    ).toBe(0);
  });
});

describe("reportUsageToStripe", () => {
  it("no-ops and returns false when Stripe lacks the meter API", async () => {
    expect(
      await reportUsageToStripe(null, {
        customerId: "cus_1",
        meterEventName: "agentdash_usage",
        value: 100,
      }),
    ).toBe(false);
  });

  it("sends a meter event when configured", async () => {
    const create = vi.fn().mockResolvedValue({});
    const stripe = { billing: { meterEvents: { create } } };

    const ok = await reportUsageToStripe(stripe, {
      customerId: "cus_1",
      meterEventName: "agentdash_usage",
      value: 142.6,
    });

    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      event_name: "agentdash_usage",
      payload: { stripe_customer_id: "cus_1", value: "143" }, // rounded
    });
  });

  it("returns false (non-fatal) when the meter API throws", async () => {
    const create = vi.fn().mockRejectedValue(new Error("stripe down"));
    const stripe = { billing: { meterEvents: { create } } };
    expect(
      await reportUsageToStripe(stripe, {
        customerId: "cus_1",
        meterEventName: "agentdash_usage",
        value: 100,
      }),
    ).toBe(false);
  });
});
