import { describe, expect, it } from "vitest";
import { hermesStatusHasConfiguredCredentials } from "../adapters/registry.js";

function buildStatus(opts: {
  apiKeyProviders?: string[];
  authProviders?: string[];
}): string {
  return [
    "Hermes v0.3.0",
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
