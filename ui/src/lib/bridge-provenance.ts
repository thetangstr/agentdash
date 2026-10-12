import type { ActivityEvent } from "@paperclipai/shared";

/**
 * "via bridge (<endpoint label>)": what a person sent from their own Claude
 * or Codex through the AgentDash bridge, rather than from this page.
 *
 * The comment, document revision, answer and attachment rows carry no
 * provenance of their own; the server records it on the activity row written
 * with each (`channel`, `bridgeEndpointId`, `bridgeEndpointLabel`). So the
 * page reads it back from the issue's activity, which it loads anyway.
 *
 * Two channels: `bridge_work` (a send-back, a request or a close-out from the
 * person's own session) and `bridge_inbox` (an answer to an agent's question
 * from the inbox tools). Older `bridge_inbox` rows have no label.
 */

export type BridgeChannel = "bridge_work" | "bridge_inbox";

export interface BridgeVia {
  channel: BridgeChannel;
  endpointLabel: string | null;
}

export interface BridgeProvenance {
  comments: Map<string, BridgeVia>;
  /** Keyed by `documentRevisionKey(key, revisionNumber)`. */
  documentRevisions: Map<string, BridgeVia>;
  interactions: Map<string, BridgeVia>;
  attachments: Map<string, BridgeVia>;
}

const LABEL_MAX = 60;

const asString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The provenance in one activity row's details, or null when it was not sent through the bridge. */
export function bridgeViaFromDetails(details: Record<string, unknown> | null | undefined): BridgeVia | null {
  if (!details) return null;
  const channel = details.channel;
  if (channel !== "bridge_work" && channel !== "bridge_inbox") return null;
  const label = asString(details.bridgeEndpointLabel) ?? asString(details.endpointLabel);
  return { channel, endpointLabel: label };
}

/** "via bridge (laptop)", or "via bridge" when the row predates labels. */
export function viaBridgeText(via: BridgeVia): string {
  if (!via.endpointLabel) return "via bridge";
  const label = via.endpointLabel.length > LABEL_MAX ? `${via.endpointLabel.slice(0, LABEL_MAX - 1)}…` : via.endpointLabel;
  return `via bridge (${label})`;
}

export function documentRevisionKey(key: string, revisionNumber: number | null | undefined) {
  return `${key}#${revisionNumber ?? ""}`;
}

/**
 * Everything on an issue that a person sent through the bridge, by id.
 * Only rows the server wrote as a person count: a hand-posted activity row
 * (origin "manual") or one by an agent cannot put a badge on anything.
 */
export function collectBridgeProvenance(activity: readonly ActivityEvent[] | null | undefined): BridgeProvenance {
  const provenance: BridgeProvenance = {
    comments: new Map(),
    documentRevisions: new Map(),
    interactions: new Map(),
    attachments: new Map(),
  };
  for (const event of activity ?? []) {
    if (event.actorType !== "user") continue;
    if (event.origin === "manual" || event.details?.origin === "manual") continue;
    const via = bridgeViaFromDetails(event.details);
    if (!via) continue;
    const details = event.details ?? {};
    switch (event.action) {
      case "issue.comment_added": {
        const id = asString(details.commentId);
        if (id) provenance.comments.set(id, via);
        break;
      }
      case "issue.document_created":
      case "issue.document_updated": {
        const key = asString(details.key);
        const revision = typeof details.revisionNumber === "number" ? details.revisionNumber : null;
        if (key && revision !== null) provenance.documentRevisions.set(documentRevisionKey(key, revision), via);
        break;
      }
      case "issue.thread_interaction_answered": {
        const id = asString(details.interactionId);
        if (id) provenance.interactions.set(id, via);
        break;
      }
      case "issue.attachment_added": {
        const id = asString(details.attachmentId);
        if (id) provenance.attachments.set(id, via);
        break;
      }
      default:
        break;
    }
  }
  return provenance;
}

export const EMPTY_BRIDGE_PROVENANCE: BridgeProvenance = collectBridgeProvenance([]);
