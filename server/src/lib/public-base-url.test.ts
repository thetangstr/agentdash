import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalUrl, configuredPublicBaseUrl } from "./public-base-url.js";

const ENV_KEYS = ["PAPERCLIP_PUBLIC_URL", "PAPERCLIP_AUTH_PUBLIC_BASE_URL"] as const;

describe("configuredPublicBaseUrl", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("is undefined when the instance advertises nothing", () => {
    expect(configuredPublicBaseUrl()).toBeUndefined();
  });

  it("prefers PAPERCLIP_PUBLIC_URL over the auth base URL", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "http://mkmini.local:3102";
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "http://ignored.example:3102";
    expect(configuredPublicBaseUrl()).toBe("http://mkmini.local:3102");
  });

  it("falls back to the auth base URL", () => {
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "https://board.example";
    expect(configuredPublicBaseUrl()).toBe("https://board.example");
  });

  it("strips trailing slashes so callers can append a path", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "http://mkmini.local:3102///";
    expect(configuredPublicBaseUrl()).toBe("http://mkmini.local:3102");
  });

  it("treats whitespace-only configuration as absent", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "   ";
    expect(configuredPublicBaseUrl()).toBeUndefined();
  });
});

describe("approvalUrl", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("builds an absolute link on the advertised address", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "http://mkmini.local:3102";
    expect(approvalUrl("b06bc212-3f55-46b0-b2e8-aad5f5207ed6")).toBe(
      "http://mkmini.local:3102/approvals/b06bc212-3f55-46b0-b2e8-aad5f5207ed6",
    );
  });

  it("never falls back to a loopback guess", () => {
    // The whole point of #539: a link that looks right and fails in the
    // reader's hands is worse than no link, because the sender cannot tell.
    expect(approvalUrl("b06bc212-3f55-46b0-b2e8-aad5f5207ed6")).toBeUndefined();
  });

  it("encodes the approval id", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://board.example";
    expect(approvalUrl("a/b?c")).toBe("https://board.example/approvals/a%2Fb%3Fc");
  });
});
