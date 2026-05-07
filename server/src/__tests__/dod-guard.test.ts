// Phase H2 — DoD-guard unit tests with per-tenant feature-flag gating.
import { describe, expect, it, vi } from "vitest";

import { dodGuardService } from "../services/dod-guard.ts";
import type { FeatureFlagsService } from "../services/feature-flags.ts";

interface IssueFix {
  id: string;
  companyId: string;
  status: string;
  definitionOfDone: unknown;
}
interface ProjectFix extends IssueFix {}
interface GoalFix {
  id: string;
  companyId: string;
  status: string;
  metricDefinition: unknown;
}

function makeDb(rows: unknown[]) {
  // The guard issues exactly one select per call; return the queued row.
  const queue = [...rows];
  const select = vi.fn(() => {
    const result = queue.shift() ?? [];
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  });
  return { select } as any;
}

function makeFlags(enabled: boolean): FeatureFlagsService {
  return {
    isEnabled: vi.fn().mockResolvedValue(enabled),
    set: vi.fn(),
    get: vi.fn(),
    listForCompany: vi.fn().mockResolvedValue([]),
  } as unknown as FeatureFlagsService;
}

const C = "11111111-1111-1111-1111-111111111111";
const E = "22222222-2222-2222-2222-222222222222";

describe("dodGuardService.assertDoDOrThrow", () => {
  it("is a no-op when the per-tenant flag is OFF (regression guard)", async () => {
    // db.select should never be called when flag is off.
    const db = { select: vi.fn() } as any;
    const flags = makeFlags(false);
    const svc = dodGuardService(db, flags);

    await expect(
      svc.assertDoDOrThrow(C, "issue", E, "in_progress", "backlog"),
    ).resolves.toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("blocks issue leaving backlog without DoD when flag is ON", async () => {
    const db = makeDb([[{ id: E, companyId: C, status: "backlog", definitionOfDone: null }]]);
    const flags = makeFlags(true);
    const svc = dodGuardService(db, flags);

    await expect(
      svc.assertDoDOrThrow(C, "issue", E, "in_progress", "backlog"),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("allows issue leaving backlog WITH a valid DoD", async () => {
    const db = makeDb([
      [
        {
          id: E,
          companyId: C,
          status: "backlog",
          definitionOfDone: {
            summary: "ship it",
            criteria: [{ id: "c1", text: "do thing", done: false }],
          },
        },
      ],
    ]);
    const flags = makeFlags(true);
    const svc = dodGuardService(db, flags);

    await expect(
      svc.assertDoDOrThrow(C, "issue", E, "in_progress", "backlog"),
    ).resolves.toBeUndefined();
  });

  it("requires metricDefinition on Goal when flag is ON", async () => {
    const db = makeDb([[{ id: E, companyId: C, status: "backlog", metricDefinition: null }]]);
    const flags = makeFlags(true);
    const svc = dodGuardService(db, flags);

    await expect(
      svc.assertDoDOrThrow(C, "goal", E, "active", "backlog"),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("skips enforcement on transitions INTO backlog", async () => {
    const db = { select: vi.fn() } as any;
    const flags = makeFlags(true);
    const svc = dodGuardService(db, flags);

    await expect(
      svc.assertDoDOrThrow(C, "issue", E, "backlog", "in_progress"),
    ).resolves.toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
  });
});
