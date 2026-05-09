/**
 * Tests for assessProjectService — focused on listProjectAssessments N+1 fix.
 *
 * The fix collapses per-row companyContext queries into a single batched
 * inArray query. This test suite verifies:
 *   1. The return shape is identical to the old implementation
 *   2. Only ONE additional select on companyContext is issued regardless of assessment count
 *   3. Missing input rows are handled gracefully (slug used as projectName)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- DB mock helpers -------------------------------------------------------

type SelectChain = {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function makeSelectChain(resolvedValue: unknown[]): SelectChain {
  const chain: SelectChain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockResolvedValue(resolvedValue);
  chain.limit.mockResolvedValue(resolvedValue.slice(0, 1));
  return chain;
}

// Build a minimal Drizzle-like db mock where each `.select()` call returns a
// pre-configured chain. We use a queue so successive select() calls resolve to
// different row sets.
function makeMockDb(selectResults: unknown[][]) {
  let callIdx = 0;
  const selectMock = vi.fn(() => {
    const rows = selectResults[callIdx] ?? [];
    callIdx++;
    return makeSelectChain(rows);
  });

  return {
    select: selectMock,
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
  } as any;
}

// ---- Subject under test ----------------------------------------------------

import { assessProjectService } from "../services/assess-project.js";

// ---- Tests -----------------------------------------------------------------

describe("assessProjectService.listProjectAssessments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ASSESS_MINIMAX_API_KEY = "test-key";
  });

  it("returns empty array when no project assessments exist", async () => {
    const db = makeMockDb([
      [], // first select: report rows
      [], // second select: input rows (batched)
    ]);
    const svc = assessProjectService(db);
    const result = await svc.listProjectAssessments("company-1");
    expect(result).toEqual([]);
  });

  it("returns correct shape for a single assessment", async () => {
    const reportRows = [
      {
        key: "project-assessment:my-project",
        value: "# Report",
        updatedAt: new Date("2026-01-15T10:00:00Z"),
        createdAt: new Date("2026-01-15T09:00:00Z"),
        companyId: "company-1",
        contextType: "agent_research",
      },
    ];
    const inputRows = [
      {
        key: "project-assessment-input:my-project",
        value: JSON.stringify({ projectName: "My Project", intake: { projectName: "My Project" } }),
        companyId: "company-1",
        contextType: "agent_research",
      },
    ];

    const db = makeMockDb([reportRows, inputRows]);
    const svc = assessProjectService(db);
    const result = await svc.listProjectAssessments("company-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slug: "my-project",
      projectName: "My Project",
      createdAt: "2026-01-15T10:00:00.000Z",
    });
  });

  it("issues exactly ONE companyContext select for input rows regardless of assessment count", async () => {
    // 5 assessment report rows
    const reportRows = Array.from({ length: 5 }, (_, i) => ({
      key: `project-assessment:project-${i}`,
      value: `# Report ${i}`,
      updatedAt: new Date(`2026-01-${String(i + 10).padStart(2, "0")}T10:00:00Z`),
      createdAt: new Date(`2026-01-${String(i + 10).padStart(2, "0")}T09:00:00Z`),
      companyId: "company-1",
      contextType: "agent_research",
    }));
    const inputRows = Array.from({ length: 5 }, (_, i) => ({
      key: `project-assessment-input:project-${i}`,
      value: JSON.stringify({ projectName: `Project ${i}` }),
      companyId: "company-1",
      contextType: "agent_research",
    }));

    const db = makeMockDb([reportRows, inputRows]);
    const svc = assessProjectService(db);
    const result = await svc.listProjectAssessments("company-1");

    // Result shape: 5 items
    expect(result).toHaveLength(5);

    // select() was called exactly TWICE: once for report rows, once for all input rows
    // (NOT once per assessment, which would be 6 total)
    expect(db.select).toHaveBeenCalledTimes(2);

    // Each item has correct shape
    for (let i = 0; i < 5; i++) {
      const item = result.find((r) => r.slug === `project-${i}`);
      expect(item).toBeDefined();
      expect(item?.projectName).toBe(`Project ${i}`);
      expect(item?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("falls back to slug as projectName when input row is missing", async () => {
    const reportRows = [
      {
        key: "project-assessment:orphan-slug",
        value: "# Report",
        updatedAt: new Date("2026-02-01T00:00:00Z"),
        createdAt: new Date("2026-02-01T00:00:00Z"),
        companyId: "company-1",
        contextType: "agent_research",
      },
    ];

    // No matching input row
    const db = makeMockDb([reportRows, []]);
    const svc = assessProjectService(db);
    const result = await svc.listProjectAssessments("company-1");

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("orphan-slug");
    expect(result[0].projectName).toBe("orphan-slug");
  });

  it("falls back to intake.projectName when top-level projectName is absent", async () => {
    const reportRows = [
      {
        key: "project-assessment:deep-name",
        value: "# Report",
        updatedAt: new Date("2026-03-01T00:00:00Z"),
        createdAt: new Date("2026-03-01T00:00:00Z"),
        companyId: "company-1",
        contextType: "agent_research",
      },
    ];
    const inputRows = [
      {
        key: "project-assessment-input:deep-name",
        value: JSON.stringify({ intake: { projectName: "Nested Name" } }),
        companyId: "company-1",
        contextType: "agent_research",
      },
    ];

    const db = makeMockDb([reportRows, inputRows]);
    const svc = assessProjectService(db);
    const result = await svc.listProjectAssessments("company-1");

    expect(result[0].projectName).toBe("Nested Name");
  });

  it("returns results sorted newest first", async () => {
    const reportRows = [
      {
        key: "project-assessment:older",
        value: "# Old",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        companyId: "company-1",
        contextType: "agent_research",
      },
      {
        key: "project-assessment:newer",
        value: "# New",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        createdAt: new Date("2026-06-01T00:00:00Z"),
        companyId: "company-1",
        contextType: "agent_research",
      },
    ];

    const db = makeMockDb([reportRows, []]);
    const svc = assessProjectService(db);
    const result = await svc.listProjectAssessments("company-1");

    expect(result[0].slug).toBe("newer");
    expect(result[1].slug).toBe("older");
  });
});
