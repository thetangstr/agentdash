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

  // Closes #225: renderBody now produces a real email — greeting, context
  // line, per-agent bullet list, and a "Open in AgentDash" CTA. The old
  // body collapsed everything into one-line slop.
  describe("body rendering (#225)", () => {
    async function runWith(opts: {
      user: { id: string; email: string; name?: string | null };
      activity: Array<{ agentName: string; summary: string }>;
      publicBaseUrl?: string;
    }) {
      const captured: Array<{ to: string; subject: string; body: string }> = [];
      const email = {
        send: vi.fn(async (msg: { to: string; subject: string; body: string }) => {
          captured.push(msg);
        }),
      };
      const activity = { listSince: vi.fn(async () => opts.activity) };
      const users = { listForDigest: vi.fn().mockResolvedValue([opts.user]) };
      await heartbeatDigest({
        email,
        activity,
        users,
        publicBaseUrl: opts.publicBaseUrl,
      } as any).run();
      return captured[0]!;
    }

    it("greets by first name when authUsers.name is set", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "ada@acme.com", name: "Ada Lovelace" },
        activity: [{ agentName: "Reese", summary: "sent 14 drafts" }],
      });
      expect(msg.body).toContain("Hi Ada,");
    });

    it("falls back to capitalized email local-part when name is missing", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "ada.lovelace@acme.com" },
        activity: [{ agentName: "Reese", summary: "sent 14 drafts" }],
      });
      expect(msg.body).toContain("Hi Ada,");
    });

    it("falls back to \"there\" when email is empty", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "" },
        activity: [{ agentName: "Reese", summary: "sent 14 drafts" }],
      });
      expect(msg.body).toContain("Hi there,");
    });

    it("reports the activity count in the context line", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "ada@acme.com", name: "Ada" },
        activity: [
          { agentName: "Reese", summary: "drafted email" },
          { agentName: "Mira", summary: "triaged 3 items" },
        ],
      });
      expect(msg.body).toContain("your team did 2 things");
    });

    it("uses singular \"thing\" when the activity count is 1", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "ada@acme.com", name: "Ada" },
        activity: [{ agentName: "Reese", summary: "drafted email" }],
      });
      expect(msg.body).toContain("your team did 1 thing:");
    });

    it("renders one bullet per agent activity", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "ada@acme.com", name: "Ada" },
        activity: [
          { agentName: "Reese", summary: "drafted email" },
          { agentName: "Mira", summary: "triaged 3 items" },
        ],
      });
      expect(msg.body).toContain("• Reese: drafted email");
      expect(msg.body).toContain("• Mira: triaged 3 items");
    });

    it("includes the \"Open in AgentDash\" CTA with absolute URL when publicBaseUrl set", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "ada@acme.com", name: "Ada" },
        activity: [{ agentName: "Reese", summary: "drafted email" }],
        publicBaseUrl: "https://agentdash.example.com",
      });
      expect(msg.body).toContain("Open in AgentDash → https://agentdash.example.com/cos");
    });

    it("falls back to a relative /cos CTA when publicBaseUrl is unset", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "ada@acme.com", name: "Ada" },
        activity: [{ agentName: "Reese", summary: "drafted email" }],
      });
      expect(msg.body).toContain("Open in AgentDash → /cos");
    });

    it("does NOT render the body as one-line slop (regression guard)", async () => {
      const msg = await runWith({
        user: { id: "u1", email: "ada@acme.com", name: "Ada" },
        activity: [
          { agentName: "Reese", summary: "drafted email" },
          { agentName: "Mira", summary: "triaged 3 items" },
        ],
      });
      // The OLD body was `Reese: drafted email\nMira: triaged 3 items` —
      // no greeting, no CTA. Assert all three new pieces are present so
      // a regression to the old renderer would fail at least one of these.
      expect(msg.body).toContain("Hi ");
      expect(msg.body).toContain("your team did");
      expect(msg.body).toContain("Open in AgentDash");
    });
  });
});
