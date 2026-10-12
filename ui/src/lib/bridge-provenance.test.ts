import type { ActivityEvent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  bridgeViaFromDetails,
  collectBridgeProvenance,
  documentRevisionKey,
  viaBridgeText,
} from "./bridge-provenance";

function event(action: string, details: Record<string, unknown>, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: `evt-${Math.random()}`,
    companyId: "company-1",
    actorType: "user",
    actorId: "user-a",
    action,
    entityType: "issue",
    entityId: "issue-1",
    agentId: null,
    runId: null,
    details,
    origin: "server",
    createdAt: new Date("2026-10-12T00:00:00Z"),
    ...overrides,
  };
}

const work = { channel: "bridge_work", via: "bridge", bridgeEndpointId: "ep-1", bridgeEndpointLabel: "person-a-laptop" };

describe("bridge provenance", () => {
  it("reads the channel and the endpoint label from a row's details", () => {
    expect(bridgeViaFromDetails(work)).toEqual({ channel: "bridge_work", endpointLabel: "person-a-laptop" });
    // The request routes name it endpointLabel.
    expect(bridgeViaFromDetails({ channel: "bridge_work", endpointLabel: "desk" })).toEqual({
      channel: "bridge_work",
      endpointLabel: "desk",
    });
    // An inbox answer from before labels were recorded.
    expect(bridgeViaFromDetails({ channel: "bridge_inbox", bridgeEndpointId: "ep" })).toEqual({
      channel: "bridge_inbox",
      endpointLabel: null,
    });
    expect(bridgeViaFromDetails({ channel: "web" })).toBeNull();
    expect(bridgeViaFromDetails(null)).toBeNull();
  });

  it("says where it came from in a few words", () => {
    expect(viaBridgeText({ channel: "bridge_work", endpointLabel: "person-a-laptop" })).toBe("via bridge (person-a-laptop)");
    expect(viaBridgeText({ channel: "bridge_inbox", endpointLabel: null })).toBe("via bridge");
    expect(viaBridgeText({ channel: "bridge_work", endpointLabel: "x".repeat(200) })).toHaveLength("via bridge ()".length + 60);
  });

  it("indexes comments, document revisions, answers and attachments sent through the bridge", () => {
    const provenance = collectBridgeProvenance([
      event("issue.comment_added", { commentId: "c-1", ...work }),
      event("issue.comment_added", { commentId: "c-2" }),
      event("issue.document_updated", { key: "draft", revisionNumber: 3, ...work }),
      event("issue.document_created", { key: "notes", revisionNumber: 1, ...work }),
      event("issue.thread_interaction_answered", { interactionId: "q-1", channel: "bridge_inbox", bridgeEndpointLabel: "desk" }),
      event("issue.attachment_added", { attachmentId: "a-1", ...work }),
      event("issue.updated", { status: "todo", ...work }),
    ]);
    expect([...provenance.comments.keys()]).toEqual(["c-1"]);
    expect(provenance.documentRevisions.get(documentRevisionKey("draft", 3))).toEqual({
      channel: "bridge_work",
      endpointLabel: "person-a-laptop",
    });
    expect(provenance.documentRevisions.has(documentRevisionKey("draft", 2))).toBe(false);
    expect(provenance.documentRevisions.has(documentRevisionKey("notes", 1))).toBe(true);
    expect(provenance.interactions.get("q-1")).toEqual({ channel: "bridge_inbox", endpointLabel: "desk" });
    expect(provenance.attachments.has("a-1")).toBe(true);
  });

  it("never badges from a hand-posted row or one an agent wrote", () => {
    const provenance = collectBridgeProvenance([
      event("issue.comment_added", { commentId: "forged-1", ...work }, { origin: "manual" }),
      event("issue.comment_added", { commentId: "forged-2", ...work, origin: "manual" }, { origin: null }),
      event("issue.comment_added", { commentId: "agent-1", ...work }, { actorType: "agent", actorId: "agent-a" }),
    ]);
    expect(provenance.comments.size).toBe(0);
  });
});
