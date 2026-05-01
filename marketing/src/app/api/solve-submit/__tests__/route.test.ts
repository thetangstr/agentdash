// AgentDash: /api/solve-submit — handler tests (AGE-104).
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the durability + notification side effects so the test doesn't try to
// hit Vercel Blob, Resend, or Slack. The handler must still return 200 when
// persistSubmission resolves and 500 when it throws.
const persistMock = vi.fn();
const sendMock = vi.fn();
const slackMock = vi.fn();

vi.mock("@/lib/solve-store", () => ({
  persistSubmission: (...args: unknown[]) => persistMock(...args),
  sendNotificationEmails: (...args: unknown[]) => sendMock(...args),
  notifySlack: (...args: unknown[]) => slackMock(...args),
}));

import { POST } from "../route";
import { _resetRateLimitForTests } from "@/lib/rate-limit";

const VALID_BODY = {
  name: "Maya Founder",
  email: "maya@mkthink.example",
  company: "MKthink",
  role: "COO",
  companySize: "51-200",
  problem:
    "Review all of our old SharePoint documents and identify the best ones to give new hires.",
  dataSources: ["SharePoint"],
  successSignal: "COO accepts at least 80% of recommendations.",
  urgency: "this-month",
};

function makeReq(body: unknown, ip: string = "10.0.0.1"): Request {
  return new Request("http://localhost/api/solve-submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      "user-agent": "vitest",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/solve-submit", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    persistMock.mockReset();
    sendMock.mockReset();
    slackMock.mockReset();
    persistMock.mockResolvedValue({
      destination: "vercel-blob",
      url: "https://blob.test/123",
    });
    sendMock.mockResolvedValue({ ops: true, confirmation: true });
    slackMock.mockResolvedValue(true);
  });

  it("returns 200 and persists when payload is valid", async () => {
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe("string");
    expect(body.archive).toBe("vercel-blob");
    expect(persistMock).toHaveBeenCalledTimes(1);
    const persisted = persistMock.mock.calls[0][0];
    expect(persisted.email).toBe("maya@mkthink.example");
    expect(persisted.problem).toMatch(/SharePoint/);
    expect(persisted.id).toBeTruthy();
    expect(persisted.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(persisted.ipAddress).toBe("10.0.0.1");
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await POST(makeReq("not-json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_json");
  });

  it("rejects validation errors with 400 and a list of issues", async () => {
    const res = await POST(
      makeReq({ ...VALID_BODY, email: "not-an-email", problem: "too short" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("validation_failed");
    const paths = (body.issues as Array<{ path: string }>).map((i) => i.path);
    expect(paths).toContain("email");
    expect(paths).toContain("problem");
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("returns 500 when persistence fails (data must not be silently lost)", async () => {
    persistMock.mockRejectedValue(new Error("blob and fs both down"));
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("storage_unavailable");
  });

  it("returns success even if email/slack throw (best-effort)", async () => {
    sendMock.mockRejectedValue(new Error("resend down"));
    slackMock.mockRejectedValue(new Error("slack down"));
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rate-limits at 5 hits per IP per hour", async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await POST(makeReq(VALID_BODY, "10.0.0.99"));
      expect(ok.status).toBe(200);
    }
    const blocked = await POST(makeReq(VALID_BODY, "10.0.0.99"));
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error).toBe("rate_limited");
  });
});
