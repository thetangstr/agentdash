import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { pairOwnerWithNewAgent } from "./onboarding-steward";

const input = { companyId: "company-1", agentId: "agent-1", userId: "user-1" };

describe("pairOwnerWithNewAgent", () => {
  it("makes the creating user the steward of the wizard's agent", async () => {
    const api = {
      getAgentStewardship: vi.fn(async () => ({ stewardship: null })),
      pair: vi.fn(async () => ({})),
    };
    await expect(pairOwnerWithNewAgent(api, input)).resolves.toBe("paired");
    expect(api.pair).toHaveBeenCalledWith("company-1", "agent-1", "user-1");
  });

  it("does not try again when the agent already has a steward", async () => {
    const api = {
      getAgentStewardship: vi.fn(async () => ({ stewardship: { userId: "user-1" } })),
      pair: vi.fn(async () => ({})),
    };
    await expect(pairOwnerWithNewAgent(api, input)).resolves.toBe("already_paired");
    expect(api.pair).not.toHaveBeenCalled();
  });

  it("reports, rather than throws, the owner already stewarding another agent", async () => {
    const api = {
      getAgentStewardship: vi.fn(async () => ({ stewardship: null })),
      pair: vi.fn(async () => {
        throw new ApiError("User already stewards an agent", 409, null);
      }),
    };
    await expect(pairOwnerWithNewAgent(api, input)).resolves.toBe("owner_has_agent");
  });

  it("does not fail the launch when the server's capability gate refuses", async () => {
    const api = {
      getAgentStewardship: vi.fn(async () => ({ stewardship: null })),
      pair: vi.fn(async () => {
        throw new ApiError("Company not found", 404, null);
      }),
    };
    await expect(pairOwnerWithNewAgent(api, input)).resolves.toBe("refused_by_gate");
  });

  it("lets any other failure stop the launch loudly", async () => {
    const api = {
      getAgentStewardship: vi.fn(async () => ({ stewardship: null })),
      pair: vi.fn(async () => {
        throw new ApiError("Forbidden", 403, null);
      }),
    };
    await expect(pairOwnerWithNewAgent(api, input)).rejects.toThrow("Forbidden");
  });
});
