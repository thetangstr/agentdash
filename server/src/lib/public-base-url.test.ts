import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalUrl, configuredPublicBaseUrl, publicBaseUrlOr } from "./public-base-url.js";

const ENV_KEYS = [
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "PAPERCLIP_CANONICAL_ORIGIN",
  "PAPERCLIP_ORIGINS",
] as const;

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

  // AgentDash (#547)
  it("prefers a declared PAPERCLIP_CANONICAL_ORIGIN over every older variable", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "http://mkmini.local:3102";
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "http://ignored.example:3102";
    process.env.PAPERCLIP_CANONICAL_ORIGIN = "https://agents.example/";
    expect(configuredPublicBaseUrl()).toBe("https://agents.example");
    expect(approvalUrl("a-1")).toBe("https://agents.example/approvals/a-1");
  });

  it("falls back to the first PAPERCLIP_ORIGINS entry only when nothing else names an address", () => {
    process.env.PAPERCLIP_ORIGINS = "https://first.example, http://second.example:3102";
    expect(configuredPublicBaseUrl()).toBe("https://first.example");
    process.env.PAPERCLIP_PUBLIC_URL = "http://mkmini.local:3102";
    expect(configuredPublicBaseUrl()).toBe("http://mkmini.local:3102");
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

// AgentDash (launch lane D): links read outside any request.
describe("publicBaseUrlOr", () => {
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

  it("prefers the feature's own override, trimmed of trailing slashes", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://acme.agentdash.cloud";
    expect(publicBaseUrlOr("https://billing.example.test/")).toBe("https://billing.example.test");
  });

  it("falls back to the configured public URL, then to the given default", () => {
    expect(publicBaseUrlOr(undefined, "http://localhost:3100")).toBe("http://localhost:3100");
    expect(publicBaseUrlOr("  ")).toBe("");
    process.env.PAPERCLIP_PUBLIC_URL = "https://acme.agentdash.cloud";
    expect(publicBaseUrlOr(undefined, "http://localhost:3100")).toBe("https://acme.agentdash.cloud");
  });
});
