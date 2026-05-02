import { describe, it, expect, vi } from "vitest";
import { heartbeatDigest } from "../services/heartbeat-digest.js";

describe("heartbeatDigest.run", () => {
  it("sends one email per user with at least one activity in the last 24h", async () => {
    const email = { send: vi.fn().mockResolvedValue(undefined) };
    const activity = {
      listSince: vi.fn(async (uid: string) =>
        uid === "u1" ? [{ agentName: "Reese", summary: "sent 14 drafts" }] : [],
      ),
    };
    const users = {
      listForDigest: vi.fn().mockResolvedValue([
        { id: "u1", email: "alice@acme.com", timezone: "America/Los_Angeles" },
        { id: "u2", email: "bob@acme.com", timezone: "America/New_York" },
      ]),
    };
    await heartbeatDigest({ email, activity, users } as any).run();
    expect(email.send).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alice@acme.com",
        subject: expect.stringContaining("Reese"),
      }),
    );
  });

  it("skips users with no activity in the window", async () => {
    const email = { send: vi.fn() };
    const activity = { listSince: vi.fn().mockResolvedValue([]) };
    const users = {
      listForDigest: vi.fn().mockResolvedValue([{ id: "u1", email: "a@x.com" }]),
    };
    await heartbeatDigest({ email, activity, users } as any).run();
    expect(email.send).not.toHaveBeenCalled();
  });
});
