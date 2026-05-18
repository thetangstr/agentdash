import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpError } from "../errors.js";

const anthropicLLM = vi.hoisted(() => vi.fn(async () => "anthropic fallback"));

vi.mock("../services/anthropic-llm.js", () => ({
  anthropicLLM,
}));

import { dispatchLLM } from "../services/dispatch-llm.js";

const originalAdapter = process.env.AGENTDASH_DEFAULT_ADAPTER;
const originalSkipLLM = process.env.PAPERCLIP_E2E_SKIP_LLM;

describe("dispatchLLM", () => {
  beforeEach(() => {
    anthropicLLM.mockClear();
    delete process.env.PAPERCLIP_E2E_SKIP_LLM;
  });

  afterEach(() => {
    if (originalAdapter === undefined) {
      delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    } else {
      process.env.AGENTDASH_DEFAULT_ADAPTER = originalAdapter;
    }

    if (originalSkipLLM === undefined) {
      delete process.env.PAPERCLIP_E2E_SKIP_LLM;
    } else {
      process.env.PAPERCLIP_E2E_SKIP_LLM = originalSkipLLM;
    }
  });

  it("rejects unsupported CoS chat adapters instead of silently using claude_api", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "codex_local";

    await expect(
      dispatchLLM({
        system: "You are a Chief of Staff.",
        messages: [{ role: "user", content: "Draft a rollout plan." }],
      }),
    ).rejects.toMatchObject({
      status: 501,
      message: expect.stringContaining("codex_local"),
    } satisfies Partial<HttpError>);

    expect(anthropicLLM).not.toHaveBeenCalled();
  });

  it("returns a CoS goals trailer in skip-LLM mode for the goals prompt", async () => {
    process.env.PAPERCLIP_E2E_SKIP_LLM = "true";

    const reply = await dispatchLLM({
      system:
        'You are the Chief of Staff for AgentDash. Your reply MUST end with a fenced JSON block like { "captured": {}, "phase_decision": "advance_to_plan" }.',
      messages: [
        {
          role: "user",
          content:
            "Short-term: launch onboarding in 90 days. Long-term: autonomous customer onboarding. Constraint: tiny team.",
        },
      ],
    });

    expect(reply).toContain("```json");
    expect(reply).toContain('"captured"');
    expect(reply).toContain('"advance_to_plan"');
  });

  it("returns a valid CoS plan trailer in skip-LLM mode for the plan prompt", async () => {
    process.env.PAPERCLIP_E2E_SKIP_LLM = "true";

    const reply = await dispatchLLM({
      system:
        'You are the Chief of Staff for AgentDash. Goals captured: {"shortTerm":"launch"}. Your reply MUST end with a fenced JSON block containing { "phase_decision": "stay_in_plan", "plan": {} }.',
      messages: [{ role: "user", content: "Please propose the team." }],
    });

    expect(reply).toContain("```json");
    expect(reply).toContain('"plan"');
    expect(reply).toContain('"adapterType": "codex_local"');
  });

  it("returns a visibly revised plan in skip-LLM mode for the revision prompt", async () => {
    process.env.PAPERCLIP_E2E_SKIP_LLM = "true";

    const reply = await dispatchLLM({
      system:
        "You are the Chief of Staff for AgentDash. The user reviewed a plan you proposed and wants to revise it. Apply their feedback as a DELTA on the prior plan.",
      messages: [
        { role: "user", content: "PRIOR PLAN (JSON): {}" },
        {
          role: "user",
          content:
            "USER FEEDBACK: Replace support with a pilot onboarding coordinator.",
        },
      ],
    });

    expect(reply).toContain("Updated based on your feedback");
    expect(reply).toContain("Piper");
    expect(reply).toContain('"role": "pilot_onboarding_coordinator"');
  });

  it("keys deep-interview skip-LLM responses by engine round instead of global call order", async () => {
    process.env.PAPERCLIP_E2E_SKIP_LLM = "true";

    await dispatchLLM({
      system:
        'You are the Chief of Staff for AgentDash. Goals captured: {"shortTerm":"launch"}. Your reply MUST end with a fenced JSON block containing { "phase_decision": "stay_in_plan", "plan": {} }.',
      messages: [{ role: "user", content: "Please propose the team." }],
    });

    const round0 = await dispatchLLM({
      system: [
        "Deep Interview",
        "[Scope]",
        "cos_onboarding",
        "[Round] 0",
        "[Task]",
        "Ask ONE question that targets the weakest dimension.",
        '"ambiguity_score"',
      ].join("\n"),
      messages: [{ role: "user", content: "We want AI agents to help operations." }],
    });

    expect(round0).toContain("What's your primary goal for this rollout?");
    expect(round0).toContain('"ambiguity_score": 0.75');

    const round1 = await dispatchLLM({
      system: [
        "Deep Interview",
        "[Scope]",
        "cos_onboarding",
        "[Round] 1",
        "[Task]",
        "Ask ONE question that targets the weakest dimension.",
        '"ambiguity_score"',
      ].join("\n"),
      messages: [{ role: "user", content: "Launch onboarding automation." }],
    });

    expect(round1).toContain("What constraints matter most to you?");
    expect(round1).toContain('"ambiguity_score": 0.45');

    const round2 = await dispatchLLM({
      system: [
        "Deep Interview",
        "[Scope]",
        "cos_onboarding",
        "[Round] 2",
        "[Task]",
        "Ask ONE question that targets the weakest dimension.",
        '"ambiguity_score"',
      ].join("\n"),
      messages: [{ role: "user", content: "Tiny team and 90 days." }],
    });

    expect(round2).toContain("How will you know this succeeded?");
    expect(round2).toContain('"ambiguity_score": 0.12');
  });
});
