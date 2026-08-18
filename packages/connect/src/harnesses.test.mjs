import { describe, expect, it } from "vitest";
import {
  envVarNameFor,
  mcpEndpointFor,
  normalizeInstanceUrl,
  readCodexServer,
  removeClaudeConfig,
  removeCodexToml,
  upsertClaudeConfig,
  upsertCodexToml,
} from "./harnesses.mjs";

describe("normalizeInstanceUrl", () => {
  it("accepts what people actually paste", () => {
    // Every one of these is something a person copies out of a browser bar or
    // a chat message, and all of them mean the same instance.
    expect(normalizeInstanceUrl("http://mkmini.local:3103")).toBe("http://mkmini.local:3103");
    expect(normalizeInstanceUrl("http://mkmini.local:3103/")).toBe("http://mkmini.local:3103");
    expect(normalizeInstanceUrl("  http://mkmini.local:3103//  ")).toBe("http://mkmini.local:3103");
    expect(normalizeInstanceUrl("mkmini.local:3103")).toBe("http://mkmini.local:3103");
  });

  it("tolerates a link that already points at the API or the endpoint", () => {
    // The connect panel shows the MCP endpoint, so people paste the endpoint.
    expect(normalizeInstanceUrl("http://mkmini.local:3103/api")).toBe("http://mkmini.local:3103");
    expect(normalizeInstanceUrl("http://mkmini.local:3103/api/mcp")).toBe("http://mkmini.local:3103");
  });

  it("does not silently invent a URL from nothing", () => {
    expect(() => normalizeInstanceUrl("")).toThrow(/required/i);
    expect(() => normalizeInstanceUrl("   ")).toThrow(/required/i);
  });

  it("builds the endpoint exactly once", () => {
    expect(mcpEndpointFor("http://mkmini.local:3103/api/mcp")).toBe("http://mkmini.local:3103/api/mcp");
    expect(mcpEndpointFor("https://agentdash.cloud")).toBe("https://agentdash.cloud/api/mcp");
  });
});

describe("envVarNameFor", () => {
  it("produces a legal shell identifier from any server name", () => {
    expect(envVarNameFor("agentdash")).toBe("AGENTDASH_KEY_AGENTDASH");
    expect(envVarNameFor("my-agent.two")).toBe("AGENTDASH_KEY_MY_AGENT_TWO");
    expect(envVarNameFor("--")).toBe("AGENTDASH_KEY_DEFAULT");
  });
});

describe("claude config", () => {
  it("writes the shape Claude Code itself writes", () => {
    const next = upsertClaudeConfig({}, "agentdash", { url: "http://x/api/mcp", key: "pcp_abc" });
    expect(next.mcpServers.agentdash).toEqual({
      type: "http",
      url: "http://x/api/mcp",
      headers: { Authorization: "Bearer pcp_abc" },
    });
  });

  it("leaves other servers and unrelated settings alone", () => {
    const before = { numStartups: 4, mcpServers: { other: { type: "stdio", command: "x" } } };
    const after = upsertClaudeConfig(before, "agentdash", { url: "http://x/api/mcp", key: "k" });
    expect(after.numStartups).toBe(4);
    expect(after.mcpServers.other).toEqual({ type: "stdio", command: "x" });
    // The caller's object must not be mutated -- it gets written back to disk.
    expect(before.mcpServers.agentdash).toBeUndefined();
  });

  it("replaces rather than duplicates on a re-run", () => {
    let config = upsertClaudeConfig({}, "agentdash", { url: "http://old/api/mcp", key: "old" });
    config = upsertClaudeConfig(config, "agentdash", { url: "http://new/api/mcp", key: "new" });
    expect(Object.keys(config.mcpServers)).toEqual(["agentdash"]);
    expect(config.mcpServers.agentdash.url).toBe("http://new/api/mcp");
    expect(config.mcpServers.agentdash.headers.Authorization).toBe("Bearer new");
  });

  it("removes only its own entry", () => {
    const config = { mcpServers: { agentdash: { type: "http" }, other: { type: "stdio" } } };
    const after = removeClaudeConfig(config, "agentdash");
    expect(Object.keys(after.mcpServers)).toEqual(["other"]);
  });

  it("removing something that was never there is not an error", () => {
    expect(() => removeClaudeConfig({}, "agentdash")).not.toThrow();
    expect(() => removeClaudeConfig(null, "agentdash")).not.toThrow();
  });
});

describe("codex config.toml", () => {
  const existing = [
    '[projects."/Users/x/repo"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");

  it("appends without disturbing what is already in the file", () => {
    const next = upsertCodexToml(existing, "agentdash", {
      url: "http://mkmini.local:3103/api/mcp",
      envVar: "AGENTDASH_KEY_AGENTDASH",
    });
    expect(next).toContain('[projects."/Users/x/repo"]');
    expect(next).toContain('trust_level = "trusted"');
    expect(next).toContain("[mcp_servers.agentdash]");
    expect(next).toContain('bearer_token_env_var = "AGENTDASH_KEY_AGENTDASH"');
    // The secret itself must never reach this file.
    expect(next).not.toMatch(/pcp_/);
  });

  it("replaces its own block on re-run instead of stacking duplicates", () => {
    let text = upsertCodexToml(existing, "agentdash", { url: "http://old/api/mcp", envVar: "A" });
    text = upsertCodexToml(text, "agentdash", { url: "http://new/api/mcp", envVar: "B" });
    expect(text.match(/\[mcp_servers\.agentdash\]/g)).toHaveLength(1);
    expect(readCodexServer(text, "agentdash")).toEqual({ url: "http://new/api/mcp", envVar: "B" });
  });

  it("keeps a neighbouring server's block intact when removing ours", () => {
    // The block boundary is the next table header; getting this wrong would
    // silently delete somebody else's MCP server.
    let text = upsertCodexToml(existing, "agentdash", { url: "http://a/api/mcp", envVar: "A" });
    text = upsertCodexToml(text, "other", { url: "http://b/api/mcp", envVar: "B" });
    const after = removeCodexToml(text, "agentdash");
    expect(after).not.toContain("[mcp_servers.agentdash]");
    expect(readCodexServer(after, "other")).toEqual({ url: "http://b/api/mcp", envVar: "B" });
    expect(after).toContain('[projects."/Users/x/repo"]');
  });

  it("does not accumulate blank lines across add/remove cycles", () => {
    let text = existing;
    for (let i = 0; i < 3; i += 1) {
      text = upsertCodexToml(text, "agentdash", { url: "http://a/api/mcp", envVar: "A" });
      text = removeCodexToml(text, "agentdash");
    }
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("handles an empty or missing file", () => {
    const next = upsertCodexToml("", "agentdash", { url: "http://a/api/mcp", envVar: "A" });
    expect(readCodexServer(next, "agentdash")).toEqual({ url: "http://a/api/mcp", envVar: "A" });
    // Removing from a file with no such block leaves it byte-for-byte alone,
    // rather than writing a newline into a file we had no business touching.
    expect(removeCodexToml("", "agentdash")).toBe("");
    expect(removeCodexToml(existing, "agentdash")).toBe(existing);
  });

  it("reports nothing for a server that is not configured", () => {
    expect(readCodexServer(existing, "agentdash")).toBeNull();
  });
});
