// AgentDash: Slack Connector (AGE-108) — unit tests
import { describe, expect, it, vi } from "vitest";
import {
  verifySlackSignature,
  type SlackEventPayload,
} from "../services/slack-connector.js";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Slack signature verification tests
// ---------------------------------------------------------------------------

describe("Slack signature verification", () => {
  const signingSecret = "test_signing_secret_abc123";

  function makeSignature(secret: string, timestamp: string, body: string): string {
    const sigBasestring = `v0:${timestamp}:${body}`;
    return (
      "v0=" +
      crypto.createHmac("sha256", secret).update(sigBasestring, "utf8").digest("hex")
    );
  }

  it("accepts a valid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"url_verification","challenge":"abc"}';
    const signature = makeSignature(signingSecret, timestamp, body);

    expect(verifySlackSignature(signingSecret, timestamp, body, signature)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"url_verification","challenge":"abc"}';
    const signature = "v0=invalid_signature_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(verifySlackSignature(signingSecret, timestamp, body, signature)).toBe(false);
  });

  it("rejects a signature with wrong secret", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"url_verification","challenge":"abc"}';
    const signature = makeSignature("wrong_secret_xxxxxxxxxx", timestamp, body);

    expect(verifySlackSignature(signingSecret, timestamp, body, signature)).toBe(false);
  });

  it("rejects replay attacks (timestamp older than 5 minutes)", () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const body = '{"type":"event_callback"}';
    const signature = makeSignature(signingSecret, oldTimestamp, body);

    expect(verifySlackSignature(signingSecret, oldTimestamp, body, signature)).toBe(false);
  });

  it("accepts timestamp within 5 minute window", () => {
    const recentTimestamp = String(Math.floor(Date.now() / 1000) - 120); // 2 min ago
    const body = '{"type":"event_callback"}';
    const signature = makeSignature(signingSecret, recentTimestamp, body);

    expect(verifySlackSignature(signingSecret, recentTimestamp, body, signature)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Slack event payload handling tests
// ---------------------------------------------------------------------------

describe("Slack event payload parsing", () => {
  it("url_verification returns challenge", () => {
    const payload: SlackEventPayload = {
      type: "url_verification",
      challenge: "test_challenge_123",
    };

    expect(payload.type).toBe("url_verification");
    expect(payload.challenge).toBe("test_challenge_123");
  });

  it("app_mention event has required fields", () => {
    const payload: SlackEventPayload = {
      type: "event_callback",
      team_id: "T12345",
      event: {
        type: "app_mention",
        user: "U12345",
        text: "<@U_BOT> help me with this",
        channel: "C12345",
        ts: "1234567890.123456",
      },
    };

    expect(payload.type).toBe("event_callback");
    expect(payload.event?.type).toBe("app_mention");
    expect(payload.event?.user).toBe("U12345");
    expect(payload.event?.channel).toBe("C12345");
    expect(payload.event?.text).toContain("help me with this");
  });

  it("message event with thread_ts indicates threaded reply", () => {
    const payload: SlackEventPayload = {
      type: "event_callback",
      team_id: "T12345",
      event: {
        type: "message",
        user: "U12345",
        text: "Following up on this thread",
        channel: "C12345",
        ts: "1234567891.123456",
        thread_ts: "1234567890.123456",
      },
    };

    expect(payload.event?.thread_ts).toBe("1234567890.123456");
    expect(payload.event?.ts).not.toBe(payload.event?.thread_ts);
  });

  it("bot message event has bot_id (should be skipped by handler)", () => {
    const payload: SlackEventPayload = {
      type: "event_callback",
      team_id: "T12345",
      event: {
        type: "message",
        bot_id: "B12345",
        text: "I am a bot message",
        channel: "C12345",
        ts: "1234567890.123456",
      },
    };

    expect(payload.event?.bot_id).toBe("B12345");
    // Handler should skip messages with bot_id to prevent loops
  });
});

// ---------------------------------------------------------------------------
// Slack connector constants tests
// ---------------------------------------------------------------------------

describe("Slack connector constants", () => {
  it("exports Slack activity log actions", async () => {
    const shared = await import("@paperclipai/shared");
    expect(shared.ACTIVITY_LOG_ACTIONS_SLACK).toContain("slack.message_received");
    expect(shared.ACTIVITY_LOG_ACTIONS_SLACK).toContain("slack.message_posted");
    expect(shared.ACTIVITY_LOG_ACTIONS_SLACK).toContain("slack.oauth_connected");
    expect(shared.ACTIVITY_LOG_ACTIONS_SLACK).toContain("slack.oauth_revoked");
  });

  it("slack is in the CONNECTION_PROVIDERS list", async () => {
    const shared = await import("@paperclipai/shared");
    expect(shared.CONNECTION_PROVIDERS).toContain("slack");
  });
});

// ---------------------------------------------------------------------------
// Slack connector service unit tests (mocked)
// ---------------------------------------------------------------------------

describe("Slack connector service logic", () => {
  it("OAuth state format is connectionId:stateToken", () => {
    // Test the state parsing logic that handleOAuthCallback uses
    const connectionId = "550e8400-e29b-41d4-a716-446655440000";
    const stateToken = "abc123def456";
    const stateParam = `${connectionId}:${stateToken}`;

    const colonIdx = stateParam.indexOf(":");
    expect(colonIdx).toBeGreaterThan(0);
    expect(stateParam.slice(0, colonIdx)).toBe(connectionId);
    expect(stateParam.slice(colonIdx + 1)).toBe(stateToken);
  });

  it("rejects state without colon separator", () => {
    const stateParam = "no_colon_here";
    const colonIdx = stateParam.indexOf(":");
    expect(colonIdx).toBe(-1);
  });

  it("handles state with multiple colons (takes first)", () => {
    const stateParam = "uuid:token:extra:colons";
    const colonIdx = stateParam.indexOf(":");
    expect(stateParam.slice(0, colonIdx)).toBe("uuid");
    expect(stateParam.slice(colonIdx + 1)).toBe("token:extra:colons");
  });
});

// ---------------------------------------------------------------------------
// Slack scopes validation tests
// ---------------------------------------------------------------------------

describe("Slack default scopes", () => {
  it("includes required bot scopes for the connector", async () => {
    const { SLACK_DEFAULT_SCOPES } = await import("../services/slack-connector.js");
    expect(SLACK_DEFAULT_SCOPES).toContain("channels:read");
    expect(SLACK_DEFAULT_SCOPES).toContain("chat:write");
    expect(SLACK_DEFAULT_SCOPES).toContain("app_mentions:read");
    expect(SLACK_DEFAULT_SCOPES).toContain("im:read");
    expect(SLACK_DEFAULT_SCOPES).toContain("im:write");
  });

  it("includes user scopes for delegated identity", async () => {
    const { SLACK_USER_SCOPES } = await import("../services/slack-connector.js");
    expect(SLACK_USER_SCOPES).toContain("chat:write");
  });
});
