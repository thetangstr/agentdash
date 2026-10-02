// AgentDash: request/response schemas for the per-run sandbox lifecycle API
// (spike R4). Five operations, all idempotent, all audited; `clear` is always
// callable. These are wire contracts — they will sit behind an HTTP surface
// in the picker service; the spike exercises them at the service boundary.
import { z } from "zod";

const idem = z.string().min(8).max(128);
const id = z.string().min(1).max(128);

export const openHandshakeRequest = z
  .object({
    companyId: id,
    idempotencyKey: idem,
    side: z.enum(["buyer", "seller"]),
    /** Let the picker pin a session id (e.g. the Clockchain invitation's). */
    sessionId: id.optional(),
  })
  .strict();
export type OpenHandshakeRequest = z.infer<typeof openHandshakeRequest>;

export const openHandshakeResponse = z
  .object({
    sessionId: id,
    side: z.enum(["buyer", "seller"]),
    state: z.literal("open"),
    openedAt: z.string(),
  })
  .strict();
export type OpenHandshakeResponse = z.infer<typeof openHandshakeResponse>;

export const listHandshakesRequest = z.object({ companyId: id }).strict();
export type ListHandshakesRequest = z.infer<typeof listHandshakesRequest>;

export const handshakeSession = z
  .object({
    sessionId: id,
    side: z.enum(["buyer", "seller"]),
    state: z.enum(["open", "closed"]),
    openedAt: z.string(),
  })
  .strict();
export const listHandshakesResponse = z.object({ sessions: z.array(handshakeSession) }).strict();
export type ListHandshakesResponse = z.infer<typeof listHandshakesResponse>;

export const applyRunConfigRequest = z
  .object({
    companyId: id,
    idempotencyKey: idem,
    runId: id,
    sessionId: id,
    agentConfigRevision: z.string().max(256).optional(),
  })
  .strict();
export type ApplyRunConfigRequest = z.infer<typeof applyRunConfigRequest>;

export const applyRunConfigResponse = z
  .object({
    runId: id,
    sessionId: id,
    /** PEM SPKI of the session key the signer minted inside the sandbox. */
    signerPublicKeyPem: z.string(),
    adapterPublicKeyPem: z.string(),
    /** base64 SPKI DER — sink tokens are sealed to this key (R6). */
    forwarderSealingPublicKeyB64: z.string(),
  })
  .strict();
export type ApplyRunConfigResponse = z.infer<typeof applyRunConfigResponse>;

export const installSinkTokenRequest = z
  .object({
    companyId: id,
    idempotencyKey: idem,
    runId: id,
    /**
     * Ciphertext only, base64 — minted by the sink operator, sealed to the
     * forwarder key returned by applyRunConfig. AgentDash never sees the
     * plaintext ingest token (R6).
     */
    sealedTokenB64: z.string().min(1).max(8192),
  })
  .strict();
export type InstallSinkTokenRequest = z.infer<typeof installSinkTokenRequest>;

export const installSinkTokenResponse = z
  .object({ runId: id, installed: z.literal(true), tokenDigest: z.string() })
  .strict();
export type InstallSinkTokenResponse = z.infer<typeof installSinkTokenResponse>;

export const clearRequest = z
  .object({
    companyId: id,
    idempotencyKey: idem,
    runId: id.optional(),
  })
  .strict();
export type ClearRequest = z.infer<typeof clearRequest>;

export const clearResponse = z.object({ cleared: z.literal(true), clearedAt: z.string() }).strict();
export type ClearResponse = z.infer<typeof clearResponse>;

/**
 * Every lifecycle call appends one audit record (R4). The request is hashed,
 * not stored — sealed tokens and config bodies never land in the audit trail.
 */
export const sandboxAuditRecord = z
  .object({
    auditId: z.string(),
    at: z.string(),
    companyId: id,
    operation: z.enum([
      "openHandshake",
      "listHandshakeSessions",
      "applyRunConfig",
      "installSinkToken",
      "clear",
    ]),
    idempotencyKey: z.string().nullable(),
    requestSha256: z.string(),
    outcome: z.enum(["ok", "error", "replayed"]),
    errorCode: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();
export type SandboxAuditRecord = z.infer<typeof sandboxAuditRecord>;
