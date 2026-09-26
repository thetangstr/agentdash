// AgentDash (GH #782): the two git credential paths, run against real `git`.
//
// - clone-time: the token is given to one git process in an env variable and
//   echoed back by a `-c` helper; nothing is persisted;
// - agent-time: the checkout's local config asks the control plane (here a
//   local HTTP server) with the run's key; the config file holds no secret and
//   overrides helpers inherited from global config.
import { execFile as execFileCallback } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_CREDENTIAL_HELPER,
  cloneCredentialEnv,
  cloneCredentialGitArgs,
  configureCheckoutCredentialHelper,
  createGitHubTokenStreamRedactor,
  formatGitCredentialResponse,
  parseGitCredentialRequest,
  redactGitHubTokens,
  redactGitHubTokensInValue,
} from "../services/git-credential-helper.js";

const execFile = promisify(execFileCallback);
const CANARY = "github_pat_11CANARYCANARY0123456789_abcdefghijklmnopqrstuvwxyzCANARY";

function gitFill(cwd: string, env: NodeJS.ProcessEnv, extraArgs: string[] = [], input = "protocol=https\nhost=github.com\npath=acme/app.git\n\n") {
  return new Promise<string>((resolve, reject) => {
    const child = execFileCallback("git", [...extraArgs, "credential", "fill"], { cwd, env, timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

describe("git credential helper", () => {
  let tmp: string;
  let baseEnv: NodeJS.ProcessEnv;
  let server: Server;
  let port = 0;
  const requests: Array<{ auth: string | undefined; runId: string | undefined; body: string; url: string | undefined }> = [];

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "git-credential-helper-"));
    // A global config with a helper that must NOT answer (a stale ~/.git-credentials, osxkeychain).
    const globalConfig = join(tmp, "global.gitconfig");
    await writeFile(globalConfig, `[credential]\n\thelper = "!f() { echo username=stale; echo password=STALE-GLOBAL; }; f"\n`);
    baseEnv = {
      PATH: process.env.PATH,
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_TERMINAL_PROMPT: "0",
    };
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({
          auth: req.headers.authorization,
          runId: req.headers["x-paperclip-run-id"] as string | undefined,
          body,
          url: req.url,
        });
        if (req.headers.authorization !== "Bearer run-key") {
          res.statusCode = 404;
          res.end("");
          return;
        }
        res.setHeader("content-type", "text/plain");
        res.end(formatGitCredentialResponse(CANARY));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmp, { recursive: true, force: true });
  });

  it("clone-time: one git process gets the token from its env, and the args carry no secret", async () => {
    const args = cloneCredentialGitArgs();
    expect(args.join(" ")).not.toContain(CANARY);
    const out = await gitFill(tmp, { ...baseEnv, ...cloneCredentialEnv(CANARY) }, args);
    expect(out).toContain("username=x-access-token");
    expect(out).toContain(`password=${CANARY}`);
    expect(out).not.toContain("STALE-GLOBAL");
  });

  it("agent-time: the checkout asks the control plane with the run key; its config holds no token", async () => {
    const repo = join(tmp, "checkout");
    await execFile("git", ["init", "-q", repo], { env: baseEnv });
    await configureCheckoutCredentialHelper(repo, (args, cwd) => execFile("git", args, { cwd, env: baseEnv }));
    // Idempotent: a second call leaves exactly one reset entry and one helper.
    await configureCheckoutCredentialHelper(repo, (args, cwd) => execFile("git", args, { cwd, env: baseEnv }));

    const config = await readFile(join(repo, ".git", "config"), "utf8");
    expect(config).not.toContain(CANARY);
    const helpers = (await execFile("git", ["config", "--local", "--get-all", "credential.https://github.com.helper"], { cwd: repo, env: baseEnv })).stdout
      .split("\n")
      .filter((line, index, all) => index < all.length - 1);
    expect(helpers).toEqual(["", AGENT_CREDENTIAL_HELPER]);

    requests.length = 0;
    const out = await gitFill(repo, {
      ...baseEnv,
      PAPERCLIP_API_URL: `http://127.0.0.1:${port}`,
      PAPERCLIP_API_KEY: "run-key",
      PAPERCLIP_RUN_ID: "run-123",
    });
    expect(out).toContain(`password=${CANARY}`);
    expect(out).not.toContain("STALE-GLOBAL");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ auth: "Bearer run-key", runId: "run-123", url: "/api/agent-git-credential" });
    expect(parseGitCredentialRequest(requests[0]!.body)).toEqual({ protocol: "https", host: "github.com", path: "acme/app.git" });
  });

  it("agent-time: a PAPERCLIP_API_URL ending in /api still reaches the right path", async () => {
    const repo = join(tmp, "checkout");
    requests.length = 0;
    await gitFill(repo, {
      ...baseEnv,
      PAPERCLIP_API_URL: `http://127.0.0.1:${port}/api/`,
      PAPERCLIP_API_KEY: "run-key",
      PAPERCLIP_RUN_ID: "run-123",
    });
    expect(requests[0]?.url).toBe("/api/agent-git-credential");
  });

  it("agent-time: no run key means no credential and no request, and the global helper stays silenced", async () => {
    const repo = join(tmp, "checkout");
    requests.length = 0;
    await expect(gitFill(repo, { ...baseEnv, PAPERCLIP_API_URL: `http://127.0.0.1:${port}` })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("agent-time: a refused request yields no credential", async () => {
    const repo = join(tmp, "checkout");
    await expect(
      gitFill(repo, { ...baseEnv, PAPERCLIP_API_URL: `http://127.0.0.1:${port}`, PAPERCLIP_API_KEY: "wrong" }),
    ).rejects.toThrow();
  });
});

describe("GitHub token redaction", () => {
  it("scrubs every GitHub token format and leaves other text alone", () => {
    const text = [
      `fine ${CANARY}`,
      "classic ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "app ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      "url https://x-access-token:github_pat_11AAAAAAAAAAAAAAAAAAAAAA_bbbbbbbbbb@github.com/acme/app",
      "not a token: github_pat_short ghp_short",
    ].join("\n");
    const out = redactGitHubTokens(text);
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("github_pat_11AAAAAAAAAAAAAAAAAAAAAA");
    expect(out).toContain("not a token: github_pat_short ghp_short");
  });

  it("deep-redacts plain objects and arrays", () => {
    const out = redactGitHubTokensInValue({ a: [CANARY, { b: `x ${CANARY}` }], n: 1, t: true });
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(out).toMatchObject({ n: 1, t: true });
  });
});

describe("streaming GitHub token redaction", () => {
  function run(chunks: string[]) {
    const redactor = createGitHubTokenStreamRedactor();
    const out = chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.flush();
    return out;
  }

  it("catches a token split at every possible boundary", () => {
    const text = `pushing with ${CANARY} now`;
    for (let cut = 1; cut < text.length; cut += 1) {
      const out = run([text.slice(0, cut), text.slice(cut)]);
      expect(out, `cut at ${cut}`).not.toContain(CANARY);
      expect(out).toContain("pushing with ");
      expect(out).toContain(" now");
    }
  });

  it("catches a token delivered one character at a time", () => {
    const text = `token=${CANARY}\n`;
    expect(run([...text])).not.toContain(CANARY.slice(11, 30));
  });

  it("passes ordinary text through unchanged, including words that start with g", () => {
    const chunks = ["running git status\n", "on branch main; go", "t it, ghost"];
    expect(run(chunks)).toBe(chunks.join(""));
  });
});
