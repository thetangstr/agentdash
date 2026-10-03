import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../services/redact-secrets.js";
import { redactForDisplay } from "../services/redact-for-display.js";

describe("redactSecrets", () => {
  it.each([
    ['{"api_key":"abc123secretvalue","model":"glm"}', "abc123secretvalue"],
    ["api_key=abc123secretvalue&x=1", "abc123secretvalue"],
    ["x-api-key: abc123secretvalue", "abc123secretvalue"],
    ['{"Authorization": "Basic dXNlcjpwYXNz"}', "dXNlcjpwYXNz"],
    ["password = hunter2hunter2", "hunter2hunter2"],
    ["token: abc123secretvalue", "abc123secretvalue"],
    ["Authorization: Bearer abc123secretvalue", "abc123secretvalue"],
    ["clone with ghp_abcdefghij1234567890ABCDEFGHIJ1234", "ghp_abcdefghij1234567890ABCDEFGHIJ1234"],
    ["github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuv", "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuv"],
    ["bad key xai-abcdefghijklmnop1234", "xai-abcdefghijklmnop1234"],
    ["Incorrect API key provided: sk-proj-****abcd.", "abcd"],
    ["Incorrect API key provided: ****abcd", "abcd"],
  ])("scrubs %s", (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("***REDACTED***");
  });

  it("keeps the field name and leaves ordinary text and paths alone", () => {
    expect(redactSecrets('"api_key":"abcdef123456"')).toBe('"api_key":"***REDACTED***"');
    const plain = "hermes exited 1: HTTP 429: Insufficient balance (/Volumes/mac_studio_ssd/Projects/agentdash/.claude/worktrees/x/fake-hermes-chat.sh)";
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("scrubs known keys even when they look like nothing", () => {
    expect(redactSecrets("401 for plainkey-not-key-shaped", ["plainkey-not-key-shaped"])).toBe("401 for ***REDACTED***");
  });
});

describe("redactForDisplay", () => {
  const originals = { root: process.env.AGENTDASH_HERMES_ROOT, profiles: process.env.HERMES_PROFILES_DIR };
  let tmp = "";
  afterEach(() => {
    if (originals.root === undefined) delete process.env.AGENTDASH_HERMES_ROOT;
    else process.env.AGENTDASH_HERMES_ROOT = originals.root;
    if (originals.profiles === undefined) delete process.env.HERMES_PROFILES_DIR;
    else process.env.HERMES_PROFILES_DIR = originals.profiles;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("scrubs the provider key held in the Hermes template profile's .env", () => {
    tmp = mkdtempSync(join(tmpdir(), "redact-display-"));
    mkdirSync(join(tmp, "agentdash"), { recursive: true });
    writeFileSync(join(tmp, "agentdash", ".env"), "GLM_API_KEY=plainprofilekey-1234\nGLM_BASE_URL=https://api.z.ai/api/coding/paas/v4\n");
    process.env.HERMES_PROFILES_DIR = tmp;
    const out = redactForDisplay("Provider said no to plainprofilekey-1234 at https://api.z.ai/api/coding/paas/v4");
    expect(out).not.toContain("plainprofilekey-1234");
    expect(out).toContain("https://api.z.ai/api/coding/paas/v4");
  });
});
