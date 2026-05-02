import { describe, it, expect, vi } from "vitest";
import { cosProactive } from "../services/cos-proactive.js";

describe("cosProactive.onActivity", () => {
  it("posts an agent_status_v1 card authored by CoS for chat-worthy events", async () => {
    const conversations = {
      findByCompany: vi.fn().mockResolvedValue({ id: "conv1" }),
      postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    };
    const agents = { getById: vi.fn().mockResolvedValue({ id: "a1", name: "Reese" }) };
    const cosResolver = { findByCompany: vi.fn().mockResolvedValue({ id: "cos1" }) };
    const router = { classify: vi.fn().mockReturnValue({ chatWorthy: true, summary: "Drafted email", severity: "info" }) };

    await cosProactive({ conversations, agents, cosResolver, router } as any).onActivity({
      kind: "task_completed", agentId: "a1", companyId: "c1",
    });

    expect(conversations.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv1",
      authorKind: "agent",
      authorId: "cos1",
      cardKind: "agent_status_v1",
      cardPayload: expect.objectContaining({ agentId: "a1", agentName: "Reese", summary: "Drafted email", severity: "info" }),
    }));
  });

  it("does nothing for non-chat-worthy events", async () => {
    const conversations = { postMessage: vi.fn() };
    const router = { classify: vi.fn().mockReturnValue({ chatWorthy: false }) };
    await cosProactive({
      conversations, agents: {}, cosResolver: {}, router,
    } as any).onActivity({ kind: "heartbeat_tick", agentId: "a1", companyId: "c1" });
    expect(conversations.postMessage).not.toHaveBeenCalled();
  });

  it("skips if conversation, cos, or agent is missing", async () => {
    const conversations = {
      findByCompany: vi.fn().mockResolvedValue(null),
      postMessage: vi.fn(),
    };
    const agents = { getById: vi.fn().mockResolvedValue({ id: "a1", name: "Reese" }) };
    const cosResolver = { findByCompany: vi.fn().mockResolvedValue({ id: "cos1" }) };
    const router = { classify: vi.fn().mockReturnValue({ chatWorthy: true, summary: "x" }) };
    await cosProactive({ conversations, agents, cosResolver, router } as any).onActivity({
      kind: "task_completed", agentId: "a1", companyId: "c1",
    });
    expect(conversations.postMessage).not.toHaveBeenCalled();
  });
});
