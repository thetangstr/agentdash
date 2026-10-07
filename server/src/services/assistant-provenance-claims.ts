// AgentDash (GH #828): assistant provenance is server-stamped, never caller-claimed.
// (The digest-side provenance model lives in ./assistant-provenance.ts.)
//
// `metadata.source === "assistant_hire_request"` is written by the gated-action
// hire path (services/assistant-gated-actions.ts) and read back by the digest
// (services/assistant-digest.ts) to render a request as assistant-made. Any
// route that copies caller JSON into an approval payload must refuse the tag
// unless the caller is the assistant grant itself.
import { forbidden } from "../errors.js";

export const ASSISTANT_HIRE_REQUEST_SOURCE = "assistant_hire_request";

function metadataSource(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return (metadata as { source?: unknown }).source;
}

/** Refuses `metadata.source = "assistant_hire_request"` from anything but an assistant grant. */
export function assertNoAssistantProvenanceClaim(
  actor: { source?: string } | undefined,
  metadata: unknown,
) {
  if (metadataSource(metadata) === ASSISTANT_HIRE_REQUEST_SOURCE && actor?.source !== "assistant_grant") {
    throw forbidden(
      `The "${ASSISTANT_HIRE_REQUEST_SOURCE}" source tag may only be set by an assistant grant`,
    );
  }
}

/** Same check for an approval payload, whose provenance lives at `payload.metadata`. */
export function assertNoAssistantProvenanceClaimInPayload(
  actor: { source?: string } | undefined,
  payload: unknown,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  assertNoAssistantProvenanceClaim(actor, (payload as { metadata?: unknown }).metadata);
}
