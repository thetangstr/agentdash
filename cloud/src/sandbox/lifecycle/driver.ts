// AgentDash: the boundary between the lifecycle service and "a VM" (spike
// R4). The service owns schemas, idempotency and audit; the driver owns how
// an operation reaches the guest.
//
//   LocalVmDriver — the fake VM for tests/dev: runs the REAL in-guest agent
//                   (cloud/sandbox/sandbox-ctl.mjs) in a temp dir with a real
//                   signerd subprocess, so the guest-side contract is covered
//                   by tests, not assumed.
//   Ec2Driver     — Phase 1: maps each op to documented AWS calls (SSM
//                   SendCommand for guest ops, EC2 for instance lifecycle)
//                   through injected clients. Nothing in it constructs an
//                   AWS client, so it can never silently touch AWS.
import type {
  ApplyRunConfigResponse,
  ClearResponse,
  ListHandshakesResponse,
  OpenHandshakeResponse,
} from "./schemas.js";

export class SandboxOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxOpError";
  }
}

/** Raw material the guest emits for the R8 evidence record. */
export interface GuestEvidence {
  runId: string;
  sessionId: string;
  agentConfigRevision: string | null;
  signerPublicKeyPem: string;
  window: { start: string; end: string };
  logSha256: string;
  foreignEvents: Array<{ at: string; kind: string; runId: string | null; op: string }>;
  eventLogSha256: string;
}

export interface SandboxEnvironment {
  /** e.g. "ec2:i-0abc…" or "localvm:<id>" — recorded in evidence (R8). */
  environmentId: string;
  /** sha256:… digest of the pinned image the sandbox booted from (R1/R8). */
  imageDigest: string;
}

/** R9 health check result, as emitted by `sandbox-ctl.mjs health`. */
export interface SandboxHealth {
  ok: boolean;
  devMode?: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string | null }>;
}

export interface SandboxDriver {
  environment(): SandboxEnvironment;
  openHandshake(input: { side: "buyer" | "seller"; sessionId?: string }): Promise<OpenHandshakeResponse>;
  listHandshakes(): Promise<ListHandshakesResponse>;
  applyRunConfig(input: {
    runId: string;
    sessionId: string;
    agentConfigRevision?: string;
  }): Promise<ApplyRunConfigResponse>;
  installSinkToken(input: { runId: string; sealedTokenB64: string }): Promise<{ tokenDigest: string }>;
  clear(input: { runId?: string }): Promise<ClearResponse>;
  guestEvidence(input: { runId: string }): Promise<GuestEvidence>;
  health(): Promise<SandboxHealth>;
  dispose(): Promise<void>;
}
