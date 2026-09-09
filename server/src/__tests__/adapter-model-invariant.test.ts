// AGE-113: the adapter/model invariant helpers.
//
// The invariant: automatic recovery may retry, pause, block, or escalate, but
// it may not change an agent's adapter or model. Only a human with
// agent-configuration authority may. This module is the classification the
// enforcement points share; these tests pin its semantics.
import { describe, expect, it } from "vitest";
import {
  adapterModelActorKind,
  mayChangeAdapterOrModel,
} from "../lib/adapter-model-invariant.js";

describe("mayChangeAdapterOrModel", () => {
  it("allows board-authenticated humans", () => {
    expect(mayChangeAdapterOrModel("board")).toBe(true);
  });

  it("allows the system actor — internal flows that persist a human's choice", () => {
    // Onboarding a human completed, hire approvals a human approved: these
    // write the configured adapter/model but never invent one.
    expect(mayChangeAdapterOrModel("system")).toBe(true);
  });

  it("refuses agent-authenticated callers, including the CEO agent", () => {
    expect(mayChangeAdapterOrModel("agent")).toBe(false);
  });

  it("refuses unauthenticated and unknown actor kinds", () => {
    expect(mayChangeAdapterOrModel("none")).toBe(false);
    expect(mayChangeAdapterOrModel(null)).toBe(false);
    expect(mayChangeAdapterOrModel(undefined)).toBe(false);
    expect(mayChangeAdapterOrModel("root")).toBe(false);
  });
});

describe("adapterModelActorKind", () => {
  it("classifies humans and automatic actors distinctly", () => {
    expect(adapterModelActorKind("board")).toBe("human");
    expect(adapterModelActorKind("system")).toBe("human");
    expect(adapterModelActorKind("agent")).toBe("automatic");
    expect(adapterModelActorKind("none")).toBe("automatic");
  });
});
