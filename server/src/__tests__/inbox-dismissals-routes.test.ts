// AgentDash: the dismissal store also holds per-person Home card dismissals
// (`home:` keys), so the optional "Connect GitHub" card stays hidden for that
// person in that company across browsers.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDismiss = vi.hoisted(() => vi.fn());
const mockList = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  inboxDismissalService: () => ({ dismiss: mockDismiss, list: mockList }),
  logActivity: mockLogActivity,
}));

const { inboxDismissalRoutes } = await import("../routes/inbox-dismissals.js");
const { errorHandler } = await import("../middleware/index.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
    };
    next();
  });
  a.use("/api", inboxDismissalRoutes({} as never));
  a.use(errorHandler);
  return a;
}

describe("inbox dismissal routes", () => {
  beforeEach(() => {
    mockDismiss.mockReset();
    mockList.mockReset();
    mockLogActivity.mockReset();
    mockDismiss.mockImplementation(async (companyId: string, userId: string, itemKey: string, dismissedAt: Date) => ({
      id: "d1",
      companyId,
      userId,
      itemKey,
      dismissedAt,
      createdAt: dismissedAt,
      updatedAt: dismissedAt,
    }));
  });

  it("stores a Home card dismissal for this person in this company", async () => {
    const res = await request(app())
      .post("/api/companies/company-1/inbox-dismissals")
      .send({ itemKey: "home:connect-github" });
    expect(res.status).toBe(201);
    expect(mockDismiss).toHaveBeenCalledWith("company-1", "user-1", "home:connect-github", expect.any(Date));
  });

  it("still rejects keys it does not know", async () => {
    const res = await request(app())
      .post("/api/companies/company-1/inbox-dismissals")
      .send({ itemKey: "anything:else" });
    expect(res.status).toBe(400);
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});
