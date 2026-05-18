import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const tsxCli = path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs");
const cliEntry = path.join(repoRoot, "cli/src/index.ts");
const createAgentdashEntry = path.join(repoRoot, "packages/create-agentdash/bin/cli.mjs");

function runNode(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

describe("AgentDash CLI command surface", () => {
  it("brands the source CLI as agentdash in top-level help", () => {
    const help = runNode([tsxCli, cliEntry, "--help"]);

    expect(help).toContain("Usage: agentdash");
    expect(help).toContain("AgentDash CLI");
    expect(help).not.toContain("Usage: paperclipai");
  });

  it("describes setup as adapter plus safe defaults, not an email prompt", () => {
    const help = runNode([tsxCli, cliEntry, "setup", "--help"]);

    expect(help).toContain("Usage: agentdash setup");
    expect(help).toContain("pick adapter + safe local defaults");
    expect(help).not.toContain("founding user email");
    expect(help).not.toContain("requires --email");
  });

  it("publishes the agentdash package with a legacy paperclipai bin alias", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "cli/package.json"), "utf8"),
    ) as { name?: string; bin?: Record<string, string> };

    expect(packageJson.name).toBe("agentdash");
    expect(packageJson.bin?.agentdash).toBe("./dist/index.js");
    expect(packageJson.bin?.paperclipai).toBe("./dist/index.js");
  });
});

describe("create-agentdash bootstrapper", () => {
  it("prints help without cloning or installing", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "create-agentdash-help-"));
    const help = runNode([createAgentdashEntry, "--help"], {
      env: {
        HOME: tempHome,
        AGENTDASH_REPO_URL: "file:///definitely/not/a/repo",
      },
    });

    expect(help).toContain("Usage: create-agentdash");
    expect(help).toContain("agentdash setup");
    expect(fs.existsSync(path.join(tempHome, "agentdash"))).toBe(false);
  });
});
