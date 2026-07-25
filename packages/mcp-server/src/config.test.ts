import { describe, expect, it } from "vitest";
import { normalizeApiUrl, readConfigFromEnv } from "./config.js";

describe("normalizeApiUrl", () => {
  it("appends /api when missing", () => {
    expect(normalizeApiUrl("http://localhost:3100")).toBe("http://localhost:3100/api");
  });

  it("keeps an existing /api suffix and strips trailing slashes", () => {
    expect(normalizeApiUrl("http://localhost:3100/api/")).toBe("http://localhost:3100/api");
  });
});

describe("readConfigFromEnv aliases", () => {
  const base = {
    PAPERCLIP_API_URL: undefined,
    PAPERCLIP_API_KEY: undefined,
    PAPERCLIP_COMPANY_ID: undefined,
    PAPERCLIP_AGENT_ID: undefined,
    PAPERCLIP_RUN_ID: undefined,
    AGENTDASH_API_URL: undefined,
    AGENTDASH_API_KEY: undefined,
    AGENTDASH_COMPANY_ID: undefined,
  } as NodeJS.ProcessEnv;

  it("reads canonical PAPERCLIP_* variables", () => {
    const config = readConfigFromEnv({
      ...base,
      PAPERCLIP_API_URL: "http://localhost:3100",
      PAPERCLIP_API_KEY: "pk-1",
      PAPERCLIP_COMPANY_ID: "co-1",
    });
    expect(config.apiUrl).toBe("http://localhost:3100/api");
    expect(config.apiKey).toBe("pk-1");
    expect(config.companyId).toBe("co-1");
  });

  it("accepts AGENTDASH_* aliases when PAPERCLIP_* are unset", () => {
    const config = readConfigFromEnv({
      ...base,
      AGENTDASH_API_URL: "https://dash.example.com",
      AGENTDASH_API_KEY: "ak-2",
      AGENTDASH_COMPANY_ID: "co-2",
    });
    expect(config.apiUrl).toBe("https://dash.example.com/api");
    expect(config.apiKey).toBe("ak-2");
    expect(config.companyId).toBe("co-2");
  });

  it("prefers PAPERCLIP_* over AGENTDASH_* when both are set", () => {
    const config = readConfigFromEnv({
      ...base,
      PAPERCLIP_API_URL: "http://canonical:3100",
      AGENTDASH_API_URL: "http://alias:3100",
      PAPERCLIP_API_KEY: "canonical-key",
      AGENTDASH_API_KEY: "alias-key",
      PAPERCLIP_COMPANY_ID: "canonical-co",
      AGENTDASH_COMPANY_ID: "alias-co",
    });
    expect(config.apiUrl).toBe("http://canonical:3100/api");
    expect(config.apiKey).toBe("canonical-key");
    expect(config.companyId).toBe("canonical-co");
  });

  it("falls through to the alias when the canonical var is empty/whitespace", () => {
    const config = readConfigFromEnv({
      ...base,
      PAPERCLIP_API_URL: "   ",
      AGENTDASH_API_URL: "http://alias:3100",
      PAPERCLIP_API_KEY: "",
      AGENTDASH_API_KEY: "alias-key",
    });
    expect(config.apiUrl).toBe("http://alias:3100/api");
    expect(config.apiKey).toBe("alias-key");
  });

  it("throws when neither canonical nor alias URL is set", () => {
    expect(() => readConfigFromEnv({ ...base, PAPERCLIP_API_KEY: "k" })).toThrow(
      /PAPERCLIP_API_URL/,
    );
  });

  // AgentDash (MCP-native signup): the key is optional — a fresh install has
  // none yet; agentdash_sign_up mints one and upgrades the session in place.
  it("returns an empty apiKey when neither canonical nor alias key is set", () => {
    const config = readConfigFromEnv({ ...base, PAPERCLIP_API_URL: "http://localhost:3100" });
    expect(config.apiKey).toBe("");
  });
});
