// AgentDash: Slack Connector actions — "easier way" integration test.
//
// Same pattern as the Gmail test: mock the SDK seam (@slack/web-api) and the
// connectors service (fixture token + acting-as resolution), then run the real
// slack-connector logic. Proves autonomy gating end-to-end without real OAuth,
// a Slack workspace, or network: draft_only never calls Slack, full does.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const slackPostMessage = vi.fn();
  const state = {
    token: null as Record<string, unknown> | null,
    acting: null as Record<string, unknown> | null,
    actions: [] as unknown[][],
  };
  const fakeConnSvc = {
    getDecryptedToken: vi.fn(async () => state.token),
    resolveActingAs: vi.fn(async () => state.acting),
    logConnectorAction: vi.fn(async (...args: unknown[]) => {
      state.actions.push(args);
    }),
  };
  return { slackPostMessage, state, fakeConnSvc };
});

vi.mock("@slack/web-api", () => ({
  // The connector does `new WebClient(token).chat.postMessage(...)`.
  WebClient: class {
    chat = { postMessage: h.slackPostMessage };
  },
}));

vi.mock("../services/connectors.js", () => ({
  connectorService: () => h.fakeConnSvc,
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

import { slackConnectorService } from "../services/slack-connector.js";

function svc() {
  return slackConnectorService({} as never);
}

const sendInput = {
  channel: "C123",
  text: "Deploy finished ✅",
  companyId: "company-1",
  agentId: "agent-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.actions = [];
  h.state.token = { accessToken: "xoxb-fixture-token" };
  h.state.acting = {
    ok: true,
    resolution: { effectiveAutonomy: "full", sendIdentity: "service" },
  };
});

describe("Slack connector postMessage (mocked WebClient + fixture token)", () => {
  it("posts to Slack when autonomy is full and logs a send action", async () => {
    h.slackPostMessage.mockResolvedValue({ ok: true, ts: "171.99", channel: "C123" });

    const result = await svc().postMessage("conn-1", sendInput);

    expect(result).toMatchObject({ posted: true, messageTs: "171.99", channel: "C123" });
    expect(h.slackPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", text: "Deploy finished ✅" }),
    );
    const [, , action] = h.state.actions[0];
    expect(action).toBe("connection.send");
  });

  it("returns a draft and does NOT call Slack when autonomy is draft_only", async () => {
    h.state.acting = {
      ok: true,
      resolution: { effectiveAutonomy: "draft_only", sendIdentity: "service" },
    };

    const result = await svc().postMessage("conn-1", sendInput);

    expect(result).toMatchObject({ posted: false, autonomy: "draft_only" });
    expect((result as { draft?: unknown }).draft).toMatchObject({ channel: "C123" });
    expect(h.slackPostMessage).not.toHaveBeenCalled();
    const [, , action] = h.state.actions[0];
    expect(action).toBe("connection.draft");
  });

  it("returns blocked and does NOT call Slack when acting-as is blocked", async () => {
    h.state.acting = { ok: false, blocked: { reason: "send_blocked" } };

    const result = await svc().postMessage("conn-1", sendInput);

    expect(result).toMatchObject({ posted: false, blocked: { reason: "send_blocked" } });
    expect(h.slackPostMessage).not.toHaveBeenCalled();
  });

  it("throws when the connection has no token (revoked/missing)", async () => {
    h.state.token = null;
    await expect(svc().postMessage("conn-1", sendInput)).rejects.toThrow(
      /not found or revoked/,
    );
    expect(h.slackPostMessage).not.toHaveBeenCalled();
  });
});
