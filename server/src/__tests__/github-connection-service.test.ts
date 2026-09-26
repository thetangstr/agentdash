// AgentDash (GH #782): repo parsing and GitHub error mapping (no database).
import { describe, expect, it } from "vitest";
import {
  assertFineGrainedToken,
  githubApiBaseUrl,
  parseGitHubRepo,
  repoKeyFromCredentialPath,
  verifyGitHubToken,
} from "../services/github-connection.js";

const TOKEN = "github_pat_11UNIT000000000000000000_unitTestTokenValue0123456789abcdef";

describe("parseGitHubRepo", () => {
  it.each([
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/Acme/App/", "acme/app"],
    ["github.com/acme/app", "acme/app"],
    ["git@github.com:acme/app.git", "acme/app"],
    ["ssh://git@github.com/acme/app.git", "acme/app"],
    ["acme/app", "acme/app"],
    ["acme/my.repo_name-2", "acme/my.repo_name-2"],
  ])("accepts %s", (input, key) => {
    const ref = parseGitHubRepo(input);
    expect(ref?.key).toBe(key);
    expect(ref?.url.startsWith("https://github.com/")).toBe(true);
    expect(ref?.url.endsWith(".git")).toBe(false);
  });

  it.each([
    "https://gitlab.com/acme/app",
    "https://user:secret@github.com/acme/app",
    `https://x-access-token:${TOKEN}@github.com/acme/app`,
    "https://github.com/acme",
    "https://github.com/acme/app/tree/main",
    "https://github.com/acme/app?x=1",
    "https://evil.com/github.com/acme/app",
    "acme/..",
    "",
    42,
  ])("refuses %s", (input) => {
    expect(parseGitHubRepo(input)).toBeNull();
  });

  it("normalises git's credential path", () => {
    expect(repoKeyFromCredentialPath("Acme/App.git")).toBe("acme/app");
    expect(repoKeyFromCredentialPath("/acme/app")).toBe("acme/app");
    expect(repoKeyFromCredentialPath("acme")).toBeNull();
    expect(repoKeyFromCredentialPath(null)).toBeNull();
  });
});

describe("token checks", () => {
  it("accepts fine-grained tokens only", () => {
    expect(assertFineGrainedToken(`  ${TOKEN} `)).toBe(TOKEN);
    expect(() => assertFineGrainedToken("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toThrow(/fine-grained/);
    expect(() => assertFineGrainedToken("")).toThrow(/githubToken required/);
    expect(() => assertFineGrainedToken(`${TOKEN}\nX=1`)).toThrow(/fine-grained/);
  });

  it("reads the API base from AGENTDASH_GITHUB_API_URL", () => {
    expect(githubApiBaseUrl({})).toBe("https://api.github.com");
    expect(githubApiBaseUrl({ AGENTDASH_GITHUB_API_URL: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });

  const repo = parseGitHubRepo("acme/app")!;
  const respond = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as never;

  it("maps GitHub's answers to plain errors that never quote the token", async () => {
    const cases: Array<[typeof fetch, RegExp, number]> = [
      [respond(401), /rejected this token/, 422],
      [respond(404), /cannot see acme\/app/, 422],
      [respond(403, {}, { "x-ratelimit-remaining": "0" }), /rate-limiting/, 502],
      [respond(200, { archived: true, permissions: { push: true } }), /archived/, 422],
      [respond(200, { permissions: { push: false } }), /Contents: Read and write/, 422],
      [respond(500), /HTTP 500/, 502],
      [(async () => { throw new Error(`boom ${TOKEN}`); }) as never, /Could not reach GitHub/, 502],
    ];
    for (const [fetchImpl, message, status] of cases) {
      const error = await verifyGitHubToken(repo, TOKEN, { fetch: fetchImpl, env: {} }).catch((e) => e);
      expect(error.message).toMatch(message);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain(TOKEN);
    }
  });
});
