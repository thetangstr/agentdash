import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyInboxMcpCodex, installUploadSkill, removeUploadSkill, uploadSkillPaths } from "./index.mjs";
import { readCodexServer } from "./harnesses.mjs";

/**
 * The upload skill rides along with the connection: installed for each harness
 * present, never over a skill of the same name the person wrote, and removed
 * by --remove.
 */

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "connect-skill-home-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the agentdash-upload skill", () => {
  it("installs for Claude Code and Codex when both are present", () => {
    const written = installUploadSkill({ home, harnesses: { claude: true, codex: true } });
    expect(written.map((w) => [w.harness, w.skipped])).toEqual([
      ["claude", false],
      ["codex", false],
    ]);
    for (const { file } of written) {
      const body = fs.readFileSync(file, "utf8");
      expect(body).toMatch(/^---\nname: agentdash-upload\n/);
      // The rules that matter, in the shipped text.
      expect(body).toMatch(/Never search the disk/);
      expect(body).toMatch(/Never re-create the file from the attachment content/);
      expect(body).toMatch(/upload_confirm/);
      // Instructions travel to another person's agent: written by the person, read back in full.
      expect(body).toMatch(/instructions are read\s+back in full/);
      expect(body).toMatch(/task_assignee_outside_organization/);
      // A lost answer is not "nothing happened".
      expect(body).toMatch(/may already be in\s+the folder/);
    }
    expect(written[0].file).toBe(path.join(home, ".claude", "skills", "agentdash-upload", "SKILL.md"));
  });

  it("installs only for the harnesses present", () => {
    expect(uploadSkillPaths({ home, harnesses: { claude: true, codex: false } }).map((p) => p.harness)).toEqual(["claude"]);
  });

  it("leaves a same-named skill the person wrote alone, and --remove does too", () => {
    const theirs = path.join(home, ".claude", "skills", "agentdash-upload", "SKILL.md");
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, "---\nname: something-else\n---\nmine");
    const written = installUploadSkill({ home, harnesses: { claude: true, codex: false } });
    expect(written[0].skipped).toBe(true);
    expect(removeUploadSkill({ home })).toEqual([]);
    expect(fs.readFileSync(theirs, "utf8")).toContain("mine");
  });

  it("removes what it installed", () => {
    installUploadSkill({ home, harnesses: { claude: true, codex: true } });
    expect(removeUploadSkill({ home }).map((r) => r.harness)).toEqual(["claude", "codex"]);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "agentdash-upload"))).toBe(false);
  });
});

describe("Codex inbox entry", () => {
  it("writes the stdio entry beside an existing remote entry", () => {
    const config = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, '[mcp_servers.agentdash]\nurl = "https://agentdash.example.test/api/mcp"\nbearer_token_env_var = "K"\n');
    const result = applyInboxMcpCodex({ serverName: "agentdash", instanceUrl: "https://agentdash.example.test", configPath: config });
    expect(result.name).toBe("agentdash-inbox");
    const text = fs.readFileSync(config, "utf8");
    expect(readCodexServer(text, "agentdash")).toEqual({ url: "https://agentdash.example.test/api/mcp", envVar: "K" });
    expect(readCodexServer(text, "agentdash-inbox")).toMatchObject({ args: expect.arrayContaining(["mcp", "--server", "https://agentdash.example.test"]) });
  });
});
