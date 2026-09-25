// AgentDash (security): archive cleanup of a runtime-created `local_fs`
// execution workspace must only ever recursively delete paths strictly inside
// the runtime-managed workspace roots. Every fixture lives under a fresh tmp
// dir created by this test; nothing outside it is touched.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupExecutionWorkspaceArtifacts } from "../services/workspace-runtime.ts";

let sandbox: string;
let instanceRoot: string;
let managedWorkspacesRoot: string;
let outsideDir: string;
const savedEnv = {
  home: process.env.PAPERCLIP_HOME,
  instance: process.env.PAPERCLIP_INSTANCE_ID,
};

async function makeDirWithSentinel(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "sentinel.txt"), "keep me");
}

async function exists(p: string) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function runtimeLocalWorkspace(workspacePath: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    companyId: "company-1",
    cwd: workspacePath,
    providerType: "local_fs",
    providerRef: workspacePath,
    branchName: null,
    repoUrl: null,
    baseRef: null,
    projectId: null,
    projectWorkspaceId: null,
    sourceIssueId: null,
    metadata: { createdByRuntime: true },
    ...overrides,
  };
}

describe("cleanupExecutionWorkspaceArtifacts local_fs deletion confinement", () => {
  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agentdash-cleanup-confinement-"));
    process.env.PAPERCLIP_HOME = path.join(sandbox, "paperclip-home");
    delete process.env.PAPERCLIP_INSTANCE_ID;
    instanceRoot = path.join(sandbox, "paperclip-home", "instances", "default");
    managedWorkspacesRoot = path.join(instanceRoot, "workspaces");
    await fs.mkdir(managedWorkspacesRoot, { recursive: true });
    outsideDir = path.join(sandbox, "outside", "victim");
    await makeDirWithSentinel(outsideDir);
  });

  afterEach(async () => {
    if (savedEnv.home === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = savedEnv.home;
    if (savedEnv.instance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = savedEnv.instance;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("still removes a runtime-created workspace inside the managed root", async () => {
    const workspacePath = path.join(managedWorkspacesRoot, "agent-1", "exec-ws");
    await makeDirWithSentinel(workspacePath);

    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: runtimeLocalWorkspace(workspacePath),
    });

    expect(await exists(workspacePath)).toBe(false);
    expect(result.cleaned).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("removes a runtime-created workspace inside the owning company's managed projects root", async () => {
    const workspacePath = path.join(instanceRoot, "projects", "company-1", "project-1", "scratch");
    await makeDirWithSentinel(workspacePath);

    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: runtimeLocalWorkspace(workspacePath),
    });

    expect(await exists(workspacePath)).toBe(false);
    expect(result.cleaned).toBe(true);
  });

  it("refuses an arbitrary path outside the managed roots", async () => {
    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: runtimeLocalWorkspace(outsideDir),
    });

    expect(await exists(path.join(outsideDir, "sentinel.txt"))).toBe(true);
    expect(result.cleaned).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/Refusing to remove/);
  });

  it("refuses another company's managed projects directory", async () => {
    const otherCompanyDir = path.join(instanceRoot, "projects", "company-2", "project-9", "_default");
    await makeDirWithSentinel(otherCompanyDir);

    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: runtimeLocalWorkspace(otherCompanyDir),
    });

    expect(await exists(path.join(otherCompanyDir, "sentinel.txt"))).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Refusing to remove/);
  });

  it("refuses a `..` traversal that starts inside the managed root", async () => {
    const traversal = `${managedWorkspacesRoot}${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}outside${path.sep}victim`;
    expect(path.resolve(traversal)).toBe(path.resolve(outsideDir));

    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: runtimeLocalWorkspace(traversal),
    });

    expect(await exists(path.join(outsideDir, "sentinel.txt"))).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Refusing to remove/);
  });

  it("refuses a workspace path that is a symlink pointing outside the managed root", async () => {
    const linkPath = path.join(managedWorkspacesRoot, "agent-1", "escape-link");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(outsideDir, linkPath, "dir");

    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: runtimeLocalWorkspace(linkPath),
    });

    expect(await exists(path.join(outsideDir, "sentinel.txt"))).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Refusing to remove/);
  });

  it("refuses a path whose parent directory is a symlink escaping the managed root", async () => {
    const parentLink = path.join(managedWorkspacesRoot, "agent-evil");
    await fs.symlink(path.dirname(outsideDir), parentLink, "dir");
    const viaParentLink = path.join(parentLink, "victim");

    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: runtimeLocalWorkspace(viaParentLink),
    });

    expect(await exists(path.join(outsideDir, "sentinel.txt"))).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Refusing to remove/);
  });

  it("refuses the managed root itself", async () => {
    const siblingWorkspace = path.join(managedWorkspacesRoot, "agent-2");
    await makeDirWithSentinel(siblingWorkspace);

    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: runtimeLocalWorkspace(managedWorkspacesRoot),
    });

    expect(await exists(path.join(siblingWorkspace, "sentinel.txt"))).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Refusing to remove/);
  });
});
