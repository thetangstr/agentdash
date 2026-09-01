// The missing half of escalation.
//
// An agent could reach a person's machine and that machine could reply, but the
// person could not. The no-endpoint fallback said so in its own comment — "a
// notice, not a decision surface" — so a fact only a steward knew aged out as
// `missing` however available they were. There was exactly one caller of
// `facts.answer`, and it required an agent key.
//
// These tests pin the authorization, because this route writes a figure into a
// board pack with a person's name attached to it.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const facts = vi.hoisted(() => ({
  answerAsSteward: vi.fn(),
  listForSteward: vi.fn(),
  ask: vi.fn(),
  answer: vi.fn(),
  decline: vi.fn(),
  escalate: vi.fn(),
  listForAgent: vi.fn(),
}));

vi.mock("../services/agent-fact-requests.js", () => ({
  agentFactRequestService: () => facts,
}));

const company = vi.hoisted(() => ({ id: "company-1", productProfile: "agentdash_mk" }));
vi.mock("../services/companies.js", () => ({
  requireProductProfile: vi.fn((c: unknown) => c),
}));

// The route builds `select().from().where()` and awaits that directly — there is
// no `.limit()` in the chain, so `where()` has to be the thenable.
const fakeDb = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([company]) }) }),
} as any;

const { agentFactRequestRoutes } = await import("../routes/agent-fact-requests.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function buildApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentFactRequestRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

const steward = {
  type: "board",
  userId: "user-priya",
  companyIds: ["company-1"],
  source: "session",
};

beforeEach(() => {
  vi.clearAllMocks();
  facts.answerAsSteward.mockResolvedValue({ id: "fact-1", status: "answered" });
  facts.listForSteward.mockResolvedValue([]);
});

describe("a steward answers their own agent's question", () => {
  it("accepts the answer and passes the session's user, not a body field", async () => {
    // The identity comes from the session. A userId in the body would let anyone
    // file an answer under a colleague's name.
    const res = await request(buildApp(steward))
      .post("/api/companies/company-1/me/fact-requests/fact-1/answer")
      .send({ answer: "Northgate schematic slipped a week; Riverside is on track." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(facts.answerAsSteward).toHaveBeenCalledWith("company-1", "fact-1", {
      userId: "user-priya",
      answer: "Northgate schematic slipped a week; Riverside is on track.",
    });
  });

  it("refuses a sourceKind in the body", async () => {
    // The service forces "human". Accepting a caller-chosen kind would let a
    // recollection be recorded as a connector reading, and the entire purpose of
    // the field is that a reader can tell those apart.
    const res = await request(buildApp(steward))
      .post("/api/companies/company-1/me/fact-requests/fact-1/answer")
      .send({ answer: "…", sourceKind: "connector" });

    expect(res.status).toBe(400);
    expect(facts.answerAsSteward).not.toHaveBeenCalled();
  });

  it("refuses an empty answer", async () => {
    const res = await request(buildApp(steward))
      .post("/api/companies/company-1/me/fact-requests/fact-1/answer")
      .send({ answer: "   " });

    expect(res.status).toBe(400);
    expect(facts.answerAsSteward).not.toHaveBeenCalled();
  });

  it("refuses an agent key on the human route", async () => {
    // An agent answering "as the steward" would put a person's name on a figure
    // the person never gave — worse than a missing fact, because it is a missing
    // fact wearing an attribution.
    const res = await request(
      buildApp({ type: "agent", agentId: "agent-1", companyId: "company-1" }),
    )
      .post("/api/companies/company-1/me/fact-requests/fact-1/answer")
      .send({ answer: "trust me" });

    expect(res.status).toBe(403);
    expect(facts.answerAsSteward).not.toHaveBeenCalled();
  });

  it("refuses someone who is not a member of the company", async () => {
    const res = await request(buildApp({ ...steward, companyIds: ["other-company"] }))
      .post("/api/companies/company-1/me/fact-requests/fact-1/answer")
      .send({ answer: "…" });

    expect(res.status).toBe(403);
    expect(facts.answerAsSteward).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await request(buildApp({ type: "none" }))
      .post("/api/companies/company-1/me/fact-requests/fact-1/answer")
      .send({ answer: "…" });

    expect(res.status).toBe(403);
  });
});

describe("what is waiting on me", () => {
  it("lists by session identity, with no id in the URL to tamper with", async () => {
    facts.listForSteward.mockResolvedValue([{ id: "fact-1", factKey: "delivery_status" }]);

    const res = await request(buildApp(steward)).get(
      "/api/companies/company-1/me/fact-requests",
    );

    expect(res.status).toBe(200);
    expect(res.body.factRequests).toHaveLength(1);
    expect(facts.listForSteward).toHaveBeenCalledWith("company-1", "user-priya");
  });

  it("does not let an agent read its steward's queue", async () => {
    const res = await request(
      buildApp({ type: "agent", agentId: "agent-1", companyId: "company-1" }),
    ).get("/api/companies/company-1/me/fact-requests");

    expect(res.status).toBe(403);
    expect(facts.listForSteward).not.toHaveBeenCalled();
  });
});
