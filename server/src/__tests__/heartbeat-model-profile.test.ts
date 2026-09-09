import { describe, expect, it } from "vitest";
import type { AdapterModelProfileDefinition } from "../adapters/index.js";
import {
  enrichWakeContextSnapshot,
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
} from "../services/heartbeat.ts";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });

  it("drops the payload model profile when an agent requested the wake (AGE-113)", () => {
    const payload: Record<string, unknown> = { modelProfile: "cheap", issueId: "issue-1" };
    const { contextSnapshot } = enrichWakeContextSnapshot({
      contextSnapshot: {},
      reason: "issue_assigned",
      source: "assignment",
      triggerDetail: "manual",
      payload,
      requestedByActorType: "agent",
    });

    // The profile must not reach the run context…
    expect(contextSnapshot.modelProfile).toBeUndefined();
    expect(contextSnapshot.paperclipModelProfile).toBeUndefined();
    // …and the rest of the payload must pass untouched.
    expect(payload.issueId).toBe("issue-1");
  });

  it("keeps the payload model profile when a human requested the wake (AGE-113)", () => {
    const { contextSnapshot } = enrichWakeContextSnapshot({
      contextSnapshot: {},
      reason: "issue_assigned",
      source: "assignment",
      triggerDetail: "manual",
      payload: { modelProfile: "cheap" },
      requestedByActorType: "user",
    });

    expect(contextSnapshot.modelProfile).toBe("cheap");
  });

  it("keeps the payload model profile when no actor type is given (internal wakes)", () => {
    // Timer/automation wakes never carry a profile; the default must not
    // strip anything they do carry.
    const { contextSnapshot } = enrichWakeContextSnapshot({
      contextSnapshot: {},
      reason: "timer",
      source: "timer",
      triggerDetail: "system",
      payload: { modelProfile: "cheap" },
      requestedByActorType: null,
    });

    expect(contextSnapshot.modelProfile).toBe("cheap");
  });
});
