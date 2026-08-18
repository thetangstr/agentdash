import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { __systemPromptForTest } from "../services/cos-interview.js";

/**
 * The CoS interview must run on INTERVIEW.md, not on a stub.
 *
 * This file exists because it did not. `systemPrompt()` called bare
 * `require("node:fs")`; the server runs as ESM, so that threw ReferenceError on
 * the first call, a bare `catch` swallowed it, and every interview ran on a
 * 160-character fallback instead of the 1.1KB of guidance in INTERVIEW.md.
 * Nothing surfaced it — the stub is a plausible instruction, so the model kept
 * asking plausible questions while missing the rules that decide when an
 * interview has enough to propose an agent.
 *
 * Three existing tests exercised this module and all passed against the broken
 * code, because they asserted on returned state and never on the prompt. The
 * assertion below is deliberately about the CONTENT that reaches the model.
 */
describe("CoS interview system prompt", () => {
  const assetPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../onboarding-assets/default/INTERVIEW.md",
  );

  it("is the real INTERVIEW.md asset, byte for byte", () => {
    expect(__systemPromptForTest()).toBe(readFileSync(assetPath, "utf8"));
  });

  it("is substantial, not a one-line stub", () => {
    // The stub that shipped for months was 160 chars. Any regression that
    // reintroduces a swallowed-error fallback fails here rather than silently
    // degrading the interview.
    expect(__systemPromptForTest().length).toBeGreaterThan(1000);
  });

  it("carries the crystallization rules the stub omitted", () => {
    // These are the instructions whose absence would make an interview wander
    // without ever deciding it has enough to propose an agent.
    const prompt = __systemPromptForTest();
    expect(prompt).toContain("bottleneck");
    expect(prompt).toMatch(/propose/i);
  });
});
