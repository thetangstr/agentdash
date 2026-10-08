import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
vi.mock("../services/hermes-provider-setup.js", () => ({ configuredProviderKeysSync: () => [] }));
vi.mock("../services/redact-secrets.js", () => ({ knownKeysFromEnv: () => ["fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls"] }));
import { workspaceOperationService } from "../services/workspace-operations.js";
import { getWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";

const SECRET = "fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls";
describe("workspace operation legacy log reads", () => {
  let base: string;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "workspace-redaction-"));
    vi.stubEnv("WORKSPACE_OPERATION_LOG_BASE_PATH", base);
  });
  afterAll(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });

  it("yields, keeps escaped records parseable, and pages using raw bytes without exposing raw metadata", async () => {
    const store = getWorkspaceOperationLogStore();
    const handle = await store.begin({ companyId: "synthetic", operationId: "synthetic" });
    const entries = Array.from({ length: 5000 }, (_, seq) => ({
      seq, ts: "t", stream: "stdout", chunk: `ordinary ✓ 日本語 ${seq} ${SECRET} API_KEY="ab\\cd\\\"ef-secret-123"\n`,
    }));
    const bytes = Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(join(base, handle.logRef), bytes);
    const row = { id: "synthetic", companyId: "synthetic", logStore: handle.store, logRef: handle.logRef };
    const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }) } as unknown as Db;
    const service = workspaceOperationService(db);
    let offset = 0;
    const records: Array<{ seq: number; chunk: string }> = [];
    let pages = 0;
    let yielded = false;
    setImmediate(() => { yielded = true; });
    for (;;) {
      const result = await service.readLog("synthetic", { offset, limitBytes: 512_000 });
      expect(result).not.toHaveProperty("buffer");
      expect(result).not.toHaveProperty("verifiedBytes");
      expect(result.content).not.toContain(SECRET);
      expect(result.content).not.toContain("ef-secret-123");
      records.push(...result.content.trim().split("\n").map((line) => JSON.parse(line)));
      pages++;
      if (result.nextOffset === undefined) break;
      expect(result.nextOffset).toBeGreaterThan(offset);
      expect(bytes[result.nextOffset - 1]).toBe(10);
      offset = result.nextOffset;
    }
    expect(yielded).toBe(true);
    expect(pages).toBeGreaterThan(2);
    expect(records.map((record) => record.seq)).toEqual(entries.map((entry) => entry.seq));
    expect(records[0].chunk).toContain("ordinary ✓ 日本語");
  });
});
