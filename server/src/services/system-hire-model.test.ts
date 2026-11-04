import { describe, expect, it } from "vitest";
import { resolveSystemHireModel } from "./system-hire-model.js";

const peer = {
  id: "peer", companyId: "company", status: "idle", role: "engineer",
  adapterType: "codex_local", adapterConfig: { model: "pinned-model", provider: "provider" },
};
const input = { companyId: "company", adapterType: "codex_local", role: "reviewer", peers: [peer], env: {} };

describe("system hire model selection", () => {
  it.each(["paused", "error", "pending_approval", "terminated"])("does not inherit from a %s peer", (status) => {
    expect(resolveSystemHireModel({ ...input, peers: [{ ...peer, status }] }).selection?.source).toBe("host_default");
  });

  it.each([
    { companyId: "other-company" }, { adapterType: "claude_local" }, { adapterConfig: { model: "   " } },
  ])("does not borrow a different company, adapter or blank model: %j", (change) => {
    expect(resolveSystemHireModel({ ...input, peers: [{ ...peer, ...change }] }).adapterConfig).toEqual({});
  });

  it("inherits only the model and provider, preferring the Chief of Staff deterministically", () => {
    const chief = { ...peer, id: "chief", role: "chief_of_staff", adapterConfig: { model: " chief-model ", provider: " provider ", env: { KEY: "private" }, command: "private" } };
    for (const peers of [[peer, chief], [chief, peer]]) {
      expect(resolveSystemHireModel({ ...input, peers })).toEqual({
        adapterConfig: { model: "chief-model", provider: "provider" },
        selection: { source: "company_agent", model: "chief-model", agentId: "chief" },
      });
    }
  });

  it("prefers a company model over the configured interview model", () => {
    expect(resolveSystemHireModel({ ...input, env: { AGENTDASH_DEFAULT_ADAPTER: "codex_local", AGENTDASH_CODEX_CHAT_MODEL: "interview" } }).adapterConfig.model).toBe("pinned-model");
  });

  it("uses the configured Codex interview model when no same-adapter peer exists", () => {
    expect(resolveSystemHireModel({ ...input, peers: [], env: { AGENTDASH_DEFAULT_ADAPTER: "codex_local", AGENTDASH_CODEX_CHAT_MODEL: " interview " } })).toEqual({
      adapterConfig: { model: "interview" }, selection: { source: "instance_default", model: "interview" },
    });
  });

  it("uses the same built-in Codex model as the interview only for that selected adapter", () => {
    expect(resolveSystemHireModel({ ...input, peers: [], env: { AGENTDASH_DEFAULT_ADAPTER: "codex_local" } })).toEqual({
      adapterConfig: { model: "gpt-5.6-terra" }, selection: { source: "interview_model", model: "gpt-5.6-terra" },
    });
    const fallback = resolveSystemHireModel({ ...input, peers: [], env: { AGENTDASH_DEFAULT_ADAPTER: "openai_compat", OPENAI_COMPAT_MODEL: "api-model" } });
    expect(fallback.adapterConfig).toEqual({});
    expect(fallback.selection?.warning).toContain("host's Codex default");
  });

  it("preserves opted-in Hermes role tiers rather than inheriting a leadership model", () => {
    expect(resolveSystemHireModel({ ...input, adapterType: "hermes_local", role: "engineer", peers: [{ ...peer, adapterType: "hermes_local" }], env: {
      AGENTDASH_HERMES_MODEL_TIERS: "on", AGENTDASH_HERMES_ROOT: "/tmp/agentdash-1122-no-provider",
      AGENTDASH_HERMES_LOW_MODEL: "worker-model", AGENTDASH_HERMES_LOW_PROVIDER: "worker-provider",
    } })).toEqual({ adapterConfig: {}, selection: { source: "model_tier", model: "worker-model" } });
  });

  it("leaves adapters without model selection alone", () => {
    expect(resolveSystemHireModel({ ...input, adapterType: "process" })).toEqual({ adapterConfig: {}, selection: null });
  });
});
