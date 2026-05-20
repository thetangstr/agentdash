export {
  ATTESTATION_MANIFEST_VERSION,
  type ActivityEntryInput,
  type AnchorAdapter,
  type AnchorMetadata,
  type AnchorResult,
  type Manifest,
  type ManifestEntry,
  type VerificationResult,
  type VerifiedTime,
} from "./types.js";

export {
  buildManifest,
  canonicalize,
  hashDetails,
  sha256Hex,
  type BuildManifestInput,
  type BuildManifestResult,
} from "./manifest.js";

export { createNoopAdapter } from "./adapters/noop.js";
export { createClockchainAdapter, type ClockchainAdapterOptions } from "./adapters/clockchain.js";
