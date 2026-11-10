import { describe, expect, it } from "vitest";
import {
  FREE_AGENT_CAP,
  FREE_HUMAN_CAP,
  exceededFreeTierCapacityAction,
  freeTierCapExceededPayload,
  type TierCapacityDeps,
} from "./tier-policy.js";

// Caps are operator-tunable via env (read at module load); the default is 1+1 so
// behavior is unchanged unless an operator opts in (launch recommendation 2+3).
describe("tier-policy free caps", () => {
  it("defaults to 1 human + 1 agent (no behavior change unless env-overridden)", () => {
    expect(FREE_HUMAN_CAP).toBe(1);
    expect(FREE_AGENT_CAP).toBe(1);
  });

  it("keeps the original cap messages at the default", () => {
    expect(freeTierCapExceededPayload("invite")).toEqual({
      code: "seat_cap_exceeded",
      message: "Free workspaces are limited to 1 user. Upgrade to Pro to invite teammates.",
    });
    expect(freeTierCapExceededPayload("hire")).toEqual({
      code: "agent_cap_exceeded",
      message: "Free workspaces include only the Chief of Staff. Upgrade to Pro to hire more agents.",
    });
  });

  it("blocks the invite/hire that would exceed the cap, allows up to it", async () => {
    const deps = (humans: number, agents: number): TierCapacityDeps => ({
      getCompany: async () => ({ planTier: "free" }),
      counts: { humans: async () => humans, agents: async () => agents },
    });
    // billing must be "enabled" for caps to apply
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    delete process.env.AGENTDASH_BILLING_DISABLED;
    try {
      // at cap (1 existing human) adding 1 more -> blocked
      expect(await exceededFreeTierCapacityAction(deps(1, 0), "c1", { humans: 1 })).toBe("invite");
      // under cap (0 existing) adding 1 -> allowed
      expect(await exceededFreeTierCapacityAction(deps(0, 0), "c1", { humans: 1 })).toBeNull();
      // agents: 1 existing + 1 -> blocked
      expect(await exceededFreeTierCapacityAction(deps(0, 1), "c1", { agents: 1 })).toBe("hire");
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it("pro tiers bypass caps", async () => {
    const deps: TierCapacityDeps = {
      getCompany: async () => ({ planTier: "pro_active" }),
      counts: { humans: async () => 99, agents: async () => 99 },
    };
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    try {
      expect(await exceededFreeTierCapacityAction(deps, "c1", { humans: 5, agents: 5 })).toBeNull();
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });
});
