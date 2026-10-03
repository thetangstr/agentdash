import { describe, expect, it } from "vitest";
import { hermesStatusHasConfiguredCredentials } from "../adapters/registry.js";

function buildStatus(opts: {
  apiKeyProviders?: string[];
  authProviders?: string[];
  apiKeys?: string[];
}): string {
  return [
    "Hermes v0.3.0",
    ...(opts.apiKeys ? ["", "API Keys", ...opts.apiKeys] : []),
    "",
    "Auth Providers",
    ...(opts.authProviders ?? []),
    "",
    "API-Key Providers",
    ...(opts.apiKeyProviders ?? []),
    "",
    "Terminal Backend",
    "  shell: bash",
  ].join("\n");
}

describe("hermesStatusHasConfiguredCredentials", () => {
  it("returns true when an API-key provider is configured", () => {
    const status = buildStatus({
      apiKeyProviders: ["  openai: configured (env: OPENAI_API_KEY)"],
    });
    expect(hermesStatusHasConfiguredCredentials(status)).toBe(true);
  });

  it("returns false when API-key providers are all not-configured", () => {
    const status = buildStatus({
      apiKeyProviders: ["  openai: not configured"],
    });
    expect(hermesStatusHasConfiguredCredentials(status)).toBe(false);
  });

  it("returns true when an auth provider is logged in", () => {
    const status = buildStatus({
      authProviders: ["  anthropic: logged in"],
    });
    expect(hermesStatusHasConfiguredCredentials(status)).toBe(true);
  });

  it("returns false when auth providers are not logged in", () => {
    const status = buildStatus({
      authProviders: ["  anthropic: not logged in"],
    });
    expect(hermesStatusHasConfiguredCredentials(status)).toBe(false);
  });

  it("returns false for empty/unparseable output", () => {
    expect(hermesStatusHasConfiguredCredentials("")).toBe(false);
    expect(hermesStatusHasConfiguredCredentials("Hermes v0.3.0")).toBe(false);
  });

  it("recognises an env-file API key in the 'API Keys' section of status --full", () => {
    // `hermes status --full` lists the profile's raw keys with a checkmark —
    // a set key means Hermes can reach that provider even when the
    // "API-Key Providers" section reports nothing.
    const status = buildStatus({
      apiKeys: ["  OpenAI        ✗ (not set)", "  Kimi          ✓ sk-x...xxxx"],
    });
    expect(hermesStatusHasConfiguredCredentials(status)).toBe(true);
  });

  it("returns false when every API Keys row is unset", () => {
    const status = buildStatus({
      apiKeys: ["  OpenAI        ✗ (not set)", "  Anthropic     ✗ (not set)"],
    });
    expect(hermesStatusHasConfiguredCredentials(status)).toBe(false);
  });

  it("ignores tool keys — a set GitHub/Tavily key cannot drive an agent run", () => {
    const status = buildStatus({
      apiKeys: [
        "  GitHub        ✓ gh_x...xxxx",
        "  Tavily        ✓ tv_x...xxxx",
        "  Firecrawl     ✓ fc_x...xxxx",
        "  OpenAI        ✗ (not set)",
        "  Anthropic     ✗ (not set)",
      ],
    });
    expect(hermesStatusHasConfiguredCredentials(status)).toBe(false);
  });

  it("still counts an LLM key beside tool keys", () => {
    const status = buildStatus({
      apiKeys: [
        "  GitHub        ✓ gh_x...xxxx",
        "  Z.AI / GLM    ✓ configured",
        "  Tavily        ✗ (not set)",
      ],
    });
    expect(hermesStatusHasConfiguredCredentials(status)).toBe(true);
  });

  it("distinguishes 'configured' from 'not configured' on the same line", () => {
    expect(
      hermesStatusHasConfiguredCredentials(
        buildStatus({ apiKeyProviders: ["  fireworks: not configured"] }),
      ),
    ).toBe(false);

    expect(
      hermesStatusHasConfiguredCredentials(
        buildStatus({ apiKeyProviders: ["  fireworks: configured"] }),
      ),
    ).toBe(true);
  });
});
