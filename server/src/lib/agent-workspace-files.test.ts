import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkspaceFileError,
  contentTypeForWorkspaceFile,
  resolveAgentWorkspaceFile,
} from "./agent-workspace-files.js";

/**
 * The workspace root is derived from PAPERCLIP_HOME, so pointing that at a temp
 * directory gives a real filesystem to test the containment checks against.
 * Symlink escapes cannot be tested any other way — they only exist on disk.
 */
const AGENT_ID = "9a3c8b89-96d0-4e65-a9e7-9ab6b6ecc0ed";
let home: string;
let workspace: string;
let outsideFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "agentdash-wsfiles-"));
  for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "test";

  // Mirror the real layout: <home>/instances/<instance>/workspaces/<agentId>
  workspace = path.join(home, "instances", "test", "workspaces", AGENT_ID);
  await fs.mkdir(path.join(workspace, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspace, "reports", "q3.md"), "# Q3\n", "utf8");

  // A secret the agent must not be able to reach by any spelling.
  outsideFile = path.join(home, "outside-the-workspace.txt");
  await fs.writeFile(outsideFile, "SECRET", "utf8");
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("resolveAgentWorkspaceFile", () => {
  it("resolves a file the agent actually wrote", async () => {
    const found = await resolveAgentWorkspaceFile(AGENT_ID, "reports/q3.md");
    expect(found.filename).toBe("q3.md");
    expect(found.relativePath).toBe(path.join("reports", "q3.md"));
    expect(found.byteSize).toBeGreaterThan(0);
    expect(found.absolutePath.startsWith(await fs.realpath(workspace))).toBe(true);
  });

  it("accepts a leading ./ without treating it as an escape", async () => {
    const found = await resolveAgentWorkspaceFile(AGENT_ID, "./reports/q3.md");
    expect(found.filename).toBe("q3.md");
  });

  it("refuses an absolute path", async () => {
    await expect(resolveAgentWorkspaceFile(AGENT_ID, outsideFile)).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("refuses traversal out of the workspace", async () => {
    await expect(
      resolveAgentWorkspaceFile(AGENT_ID, "../../../outside-the-workspace.txt"),
    ).rejects.toMatchObject({ code: "escapes_workspace" });
  });

  it("refuses traversal that dips through a real subdirectory first", async () => {
    await expect(
      resolveAgentWorkspaceFile(AGENT_ID, "reports/../../../../outside-the-workspace.txt"),
    ).rejects.toMatchObject({ code: "escapes_workspace" });
  });

  it("refuses another agent's workspace", async () => {
    const other = "11111111-2222-3333-4444-555555555555";
    await expect(
      resolveAgentWorkspaceFile(AGENT_ID, path.join("..", other, "reports", "q3.md")),
    ).rejects.toMatchObject({ code: "escapes_workspace" });
  });

  it("refuses a symlink pointing outside the workspace", async () => {
    // The check that only a filesystem test can cover: the path stays inside the
    // workspace as a string and leaves it once resolved.
    const link = path.join(workspace, "sneaky.txt");
    await fs.symlink(outsideFile, link);
    try {
      await expect(resolveAgentWorkspaceFile(AGENT_ID, "sneaky.txt")).rejects.toMatchObject({
        code: "escapes_workspace",
      });
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("refuses a null byte", async () => {
    await expect(resolveAgentWorkspaceFile(AGENT_ID, "reports/q3.md\0.png")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("refuses an empty path", async () => {
    await expect(resolveAgentWorkspaceFile(AGENT_ID, "   ")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("refuses a directory", async () => {
    await expect(resolveAgentWorkspaceFile(AGENT_ID, "reports")).rejects.toMatchObject({
      code: "not_a_file",
    });
  });

  it("reports a missing file as not_found rather than an escape", async () => {
    await expect(resolveAgentWorkspaceFile(AGENT_ID, "reports/nope.md")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a malformed agent id instead of widening the root", async () => {
    // A path segment here would let the caller climb out via the id itself.
    await expect(resolveAgentWorkspaceFile("../..", "reports/q3.md")).rejects.toBeInstanceOf(Error);
  });

  it("throws WorkspaceFileError, so callers can map codes to status", async () => {
    await expect(resolveAgentWorkspaceFile(AGENT_ID, "/etc/passwd")).rejects.toBeInstanceOf(
      WorkspaceFileError,
    );
  });
});

describe("contentTypeForWorkspaceFile", () => {
  it("maps known extensions", () => {
    expect(contentTypeForWorkspaceFile("q3.md")).toBe("text/markdown");
    expect(contentTypeForWorkspaceFile("data.CSV")).toBe("text/csv");
    expect(contentTypeForWorkspaceFile("deck.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });

  it("falls back to an opaque download for anything unrecognised", () => {
    expect(contentTypeForWorkspaceFile("mystery.bin")).toBe("application/octet-stream");
    expect(contentTypeForWorkspaceFile("no-extension")).toBe("application/octet-stream");
  });

  it("does not serve SVG as SVG", () => {
    // Script-bearing, and nothing sanitizes it on this path.
    expect(contentTypeForWorkspaceFile("diagram.svg")).toBe("application/octet-stream");
  });

  it("never lets a double extension pick the earlier type", () => {
    expect(contentTypeForWorkspaceFile("report.md.exe")).toBe("application/octet-stream");
  });
});
