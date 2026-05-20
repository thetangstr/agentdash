import { describe, it, expect, vi } from "vitest";
import {
  attestationService,
  type ActivityRow,
  type AttestationStore,
  type LatestAnchorRow,
  type PendingAnchorInput,
} from "../services/attestation.js";
import { createNoopAdapter } from "@agentdash/attestation";

interface AnchorRow extends PendingAnchorInput {
  id: string;
  status: "pending" | "anchored" | "failed";
  externalLogId?: string | null;
  lastError?: string | null;
  createdAt: number;
}

function makeStore(initial: { companyIds: string[]; activity: Record<string, ActivityRow[]> }) {
  const anchors: AnchorRow[] = [];
  let nextId = 1;
  let inserted = 0;
  const store: AttestationStore = {
    async listCompanyIdsWithActivity() {
      return initial.companyIds;
    },
    async findLatestAnchor(companyId): Promise<LatestAnchorRow | null> {
      const candidates = anchors
        .filter((a) => a.companyId === companyId && a.status === "anchored")
        .sort((a, b) => b.createdAt - a.createdAt);
      const latest = candidates[0];
      return latest
        ? {
            id: latest.id,
            batchEndActivityId: latest.batchEndActivityId,
            manifestSha256: latest.manifestSha256,
          }
        : null;
    },
    async fetchNewActivity(companyId, afterActivityId, limit) {
      const rows = initial.activity[companyId] ?? [];
      if (afterActivityId === null) return rows.slice(0, limit);
      const idx = rows.findIndex((r) => r.id === afterActivityId);
      return idx === -1 ? rows.slice(0, limit) : rows.slice(idx + 1, idx + 1 + limit);
    },
    async insertPendingAnchor(input) {
      const id = `anchor-${nextId++}`;
      anchors.push({ ...input, id, status: "pending", createdAt: inserted++ });
      return { id };
    },
    async markAnchored(anchorId, result) {
      const row = anchors.find((a) => a.id === anchorId);
      if (!row) throw new Error(`unknown anchor ${anchorId}`);
      row.status = "anchored";
      row.externalLogId = result.externalLogId;
    },
    async markFailed(anchorId, errorMessage) {
      const row = anchors.find((a) => a.id === anchorId);
      if (!row) throw new Error(`unknown anchor ${anchorId}`);
      row.status = "failed";
      row.lastError = errorMessage;
    },
  };
  return { store, anchors };
}

function activity(id: string, action = "issue_created"): ActivityRow {
  return {
    id,
    createdAt: new Date(`2026-05-13T12:00:${id.padStart(2, "0")}.000Z`),
    action,
    entityType: "issue",
    entityId: `issue-${id}`,
    actorType: "user",
    actorId: "user-1",
    details: { id },
  };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} } as any;

describe("attestationService", () => {
  it("skips companies with no new activity", async () => {
    const { store, anchors } = makeStore({ companyIds: ["co-1"], activity: { "co-1": [] } });
    const svc = attestationService(store, createNoopAdapter(), { log: silentLogger });
    const summaries = await svc.run();
    expect(summaries[0]?.skipped).toBe(1);
    expect(anchors).toHaveLength(0);
  });

  it("anchors a single batch and marks it anchored", async () => {
    const { store, anchors } = makeStore({
      companyIds: ["co-1"],
      activity: { "co-1": [activity("1"), activity("2"), activity("3")] },
    });
    const svc = attestationService(store, createNoopAdapter(), { log: silentLogger });
    const summaries = await svc.run();
    expect(summaries[0]?.anchored).toBe(1);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.status).toBe("anchored");
    expect(anchors[0]!.batchStartActivityId).toBe("1");
    expect(anchors[0]!.batchEndActivityId).toBe("3");
    expect(anchors[0]!.batchActivityCount).toBe(3);
  });

  it("chains anchors: second run references the first via prevAnchorId", async () => {
    const rows = [activity("1"), activity("2"), activity("3"), activity("4")];
    const { store, anchors } = makeStore({ companyIds: ["co-1"], activity: { "co-1": rows } });
    const svc = attestationService(store, createNoopAdapter(), { batchLimit: 2, log: silentLogger });
    await svc.run();
    await svc.run();
    expect(anchors).toHaveLength(2);
    expect(anchors[0]!.prevAnchorId).toBeNull();
    expect(anchors[1]!.prevAnchorId).toBe(anchors[0]!.id);
    expect(anchors[1]!.prevPayloadHash).toBe(anchors[0]!.manifestSha256);
    expect(anchors[1]!.batchStartActivityId).toBe("3");
    expect(anchors[1]!.batchEndActivityId).toBe("4");
  });

  it("marks anchor failed when adapter throws and does not corrupt the chain", async () => {
    const { store, anchors } = makeStore({
      companyIds: ["co-1"],
      activity: { "co-1": [activity("1")] },
    });
    const badAdapter = {
      name: "bad",
      getVerifiedTime: vi.fn().mockResolvedValue({ time: "x" }),
      anchorBatch: vi.fn().mockRejectedValue(new Error("kaboom")),
      verifyAnchor: vi.fn().mockResolvedValue({ ok: false, reason: "" }),
    };
    const svc = attestationService(store, badAdapter as any, { log: silentLogger });
    const summaries = await svc.run();
    expect(summaries[0]?.failed).toBe(1);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.status).toBe("failed");
    expect(anchors[0]!.lastError).toContain("kaboom");
    // Next run still sees no anchored row → falls back to genesis (no prev)
    const next = await svc.run();
    expect(next[0]?.anchored).toBe(0);
  });

  it("does not anchor across companies", async () => {
    const { store, anchors } = makeStore({
      companyIds: ["co-1", "co-2"],
      activity: { "co-1": [activity("1")], "co-2": [activity("2"), activity("3")] },
    });
    const svc = attestationService(store, createNoopAdapter(), { log: silentLogger });
    await svc.run();
    expect(anchors).toHaveLength(2);
    expect(anchors[0]!.companyId).toBe("co-1");
    expect(anchors[1]!.companyId).toBe("co-2");
    expect(anchors[0]!.batchActivityCount).toBe(1);
    expect(anchors[1]!.batchActivityCount).toBe(2);
  });
});
