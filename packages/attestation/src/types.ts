export const ATTESTATION_MANIFEST_VERSION = 1 as const;

export interface ActivityEntryInput {
  id: string;
  createdAt: Date | string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId: string;
  details: Record<string, unknown> | null;
}

export interface ManifestEntry {
  id: string;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId: string;
  detailsHash: string;
}

export interface Manifest {
  v: typeof ATTESTATION_MANIFEST_VERSION;
  companyId: string;
  prevPayloadHash: string | null;
  count: number;
  entries: ManifestEntry[];
}

export interface VerifiedTime {
  /** ISO-8601 timestamp from the anchor service. */
  time: string;
  /** Optional block height / equivalent monotonic counter, if the adapter provides one. */
  blockHeight?: string | null;
  /** Raw adapter response (opaque). */
  raw?: unknown;
}

export interface AnchorMetadata {
  companyId: string;
  manifestSha256: string;
  batchStartActivityId: string;
  batchEndActivityId: string;
  batchActivityCount: number;
  prevAnchorId: string | null;
}

export interface AnchorResult {
  /** Identifier returned by the external anchor service. */
  externalLogId: string;
  /** Optional anchor-side block height. */
  externalBlockHeight?: string | null;
  /** Optional anchor-side timestamp (ISO-8601). */
  externalAnchoredAt?: string | null;
  /** Raw adapter response (opaque). */
  raw?: unknown;
}

export type VerificationResult =
  | { ok: true; externalLogId: string; details?: Record<string, unknown> }
  | { ok: false; reason: string; details?: Record<string, unknown> };

export interface AnchorAdapter {
  readonly name: string;
  getVerifiedTime(): Promise<VerifiedTime>;
  anchorBatch(payloadHash: string, metadata: AnchorMetadata): Promise<AnchorResult>;
  verifyAnchor(externalLogId: string, expectedPayloadHash: string): Promise<VerificationResult>;
}
