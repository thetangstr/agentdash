import { createHash } from "node:crypto";
import {
  ATTESTATION_MANIFEST_VERSION,
  type ActivityEntryInput,
  type Manifest,
  type ManifestEntry,
} from "./types.js";

/**
 * Stable JSON stringifier — recursively sorts object keys so that two
 * structurally identical objects hash to the same value regardless of
 * insertion order. Arrays preserve order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + canonicalize(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashDetails(details: Record<string, unknown> | null): string {
  if (details === null || details === undefined) return sha256Hex("null");
  return sha256Hex(canonicalize(details));
}

function toIsoString(input: Date | string): string {
  if (input instanceof Date) return input.toISOString();
  // Accept already-ISO strings; normalize via Date round-trip so timezone forms unify.
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date input for manifest entry: ${input}`);
  }
  return d.toISOString();
}

export interface BuildManifestInput {
  companyId: string;
  prevPayloadHash: string | null;
  entries: ActivityEntryInput[];
}

export interface BuildManifestResult {
  manifest: Manifest;
  payloadHash: string;
  canonicalJson: string;
}

export function buildManifest(input: BuildManifestInput): BuildManifestResult {
  const entries: ManifestEntry[] = input.entries.map((e) => ({
    id: e.id,
    createdAt: toIsoString(e.createdAt),
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    actorType: e.actorType,
    actorId: e.actorId,
    detailsHash: hashDetails(e.details),
  }));
  const manifest: Manifest = {
    v: ATTESTATION_MANIFEST_VERSION,
    companyId: input.companyId,
    prevPayloadHash: input.prevPayloadHash,
    count: entries.length,
    entries,
  };
  const canonicalJson = canonicalize(manifest);
  const payloadHash = sha256Hex(canonicalJson);
  return { manifest, payloadHash, canonicalJson };
}
