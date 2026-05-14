import { createHash } from "node:crypto";
import type {
  AnchorAdapter,
  AnchorMetadata,
  AnchorResult,
  VerificationResult,
  VerifiedTime,
} from "../types.js";

/**
 * Default adapter used when attestation is enabled but no external anchor is
 * configured. It records a synthetic, deterministic "log id" derived from the
 * payload hash so verification can still round-trip locally during dev/CI.
 *
 * Not suitable for any external trust claim — it provides no third-party
 * verifiability whatsoever.
 */
export function createNoopAdapter(): AnchorAdapter {
  return {
    name: "noop",
    async getVerifiedTime(): Promise<VerifiedTime> {
      return { time: new Date().toISOString(), blockHeight: null };
    },
    async anchorBatch(payloadHash: string, _metadata: AnchorMetadata): Promise<AnchorResult> {
      const externalLogId = "noop:" + createHash("sha256").update(payloadHash).digest("hex").slice(0, 32);
      return {
        externalLogId,
        externalBlockHeight: null,
        externalAnchoredAt: new Date().toISOString(),
      };
    },
    async verifyAnchor(externalLogId: string, expectedPayloadHash: string): Promise<VerificationResult> {
      const expected = "noop:" + createHash("sha256").update(expectedPayloadHash).digest("hex").slice(0, 32);
      if (expected !== externalLogId) {
        return { ok: false, reason: "noop_adapter_id_mismatch" };
      }
      return { ok: true, externalLogId };
    },
  };
}
