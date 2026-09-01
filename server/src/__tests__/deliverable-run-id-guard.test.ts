import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A malformed run id is "not found", not "internal server error".
 *
 * Found in production by the agent, not by this suite. On its first real board
 * pack the Chief of Staff called the assemble endpoint with the run slug it had
 * been given — `board-pack-week-1` — and got `500 Internal server error`,
 * because the raw path segment went straight into a query against a uuid
 * column. It worked around the failure and reported it inside the deliverable
 * ("Deliverable-runs assemble endpoint returned 500 this cycle"), which is the
 * only reason anyone found out.
 *
 * The discriminating assertion is not the status code on its own — it is that
 * the service is never reached for a malformed id, and still is for a
 * well-formed one. A guard that rejected everything would also turn the 500
 * into a 404, and would break the endpoint.
 */

const runs = vi.hoisted(() => ({
  getRun: vi.fn(),
  deliverableForRun: vi.fn(),
  assemble: vi.fn(),
  collect: vi.fn(),
  detail: vi.fn(),
  openRun: vi.fn(),
}));

vi.mock("../services/deliverable-runs.js", () => ({ deliverableRunService: () => runs }));
vi.mock("../services/deliverables.js", () => ({ deliverableService: () => ({}) }));
vi.mock("../services/deliverable-checks.js", () => ({ deliverableCheckService: () => ({}) }));
vi.mock("../services/deliverable-review.js", () => ({ deliverableReviewService: () => ({}) }));
vi.mock("../services/deliverable-record.js", () => ({ deliverableRecordService: () => ({}) }));
vi.mock("../services/companies.js", () => ({
  requireProductProfile: (company: unknown) => company,
}));
vi.mock("./authz.js", () => ({ assertCompanyAccess: vi.fn() }));

const { deliverableRoutes } = await import("../routes/deliverables.js");

const COMPANY = "a1a5bc48-58fa-4e3c-84e1-2f8b1e03f855";
const RUN_UUID = "8b27f30b-07e3-4045-9af4-e12b7468d882";

/** Minimal db stub: only `requireProfileCompany`'s query shape is exercised. */
const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        then: (cb: (rows: unknown[]) => unknown) =>
          cb([{ id: COMPANY, productProfile: "agentdash_mk" }]),
      }),
    }),
  }),
} as never;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", deliverableRoutes(db));
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describe("deliverable run id guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runs.getRun.mockResolvedValue({ id: RUN_UUID, companyId: COMPANY });
    runs.assemble.mockResolvedValue({ ok: true });
  });

  it("answers 404 for the run slug that produced a 500 in production", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY}/deliverable-runs/board-pack-week-1/assemble`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Deliverable run not found" });
    // The point of the guard: the malformed id never reaches the query.
    expect(runs.getRun).not.toHaveBeenCalled();
  });

  it("still routes a well-formed run id through to the service", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY}/deliverable-runs/${RUN_UUID}/assemble`)
      .send({});

    expect(runs.getRun).toHaveBeenCalledWith(COMPANY, RUN_UUID);
    expect(res.status).toBe(200);
  });

  it("guards every :runId route, not just assemble", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${COMPANY}/deliverable-runs/board-pack-week-1`)
      .send();

    expect(res.status).toBe(404);
    expect(runs.detail).not.toHaveBeenCalled();
  });
});
