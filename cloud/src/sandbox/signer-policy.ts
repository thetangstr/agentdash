// AgentDash: the signer daemon's signing policy (spike R2). The same JSON
// document is validated here (control plane / evidence) and enforced inside
// the sandbox by cloud/sandbox/signerd.mjs — the daemon cannot import this
// file, so the check is deliberately tiny and duplicated; keep them in sync.
//
// Domain separation: signerd never signs raw payload bytes. It signs
//   "agentdash-sandbox-sign/v1\n" ++ artifactType ++ "\n" ++ payload
// (taggedPayload() in signerd.mjs). Verifiers must reconstruct the tagged
// bytes; the artifact type a signature claims is thereby bound into it.
import { z } from "zod";

/** Payload contract enforced before signing, per artifact type. */
export const payloadFormat = z.enum(["bytes", "utf8", "json-object"]);
export type PayloadFormat = z.infer<typeof payloadFormat>;

export const signerPolicySchema = z
  .object({
    maxPayloadBytes: z.number().int().positive().max(1 << 20),
    /**
     * artifactType -> signing rule.
     *   key           "session" — the per-handshake-session key minted by `init`
     *                 "company" — the sandbox's long-term company key (file key
     *                             in the prototype, a KMS key in Phase 1).
     *                 There is deliberately no "principal" scope: the family
     *                 principal's key never enters the sandbox; mandates
     *                 arrive pre-signed.
     *   payloadFormat what the payload must look like before it may be
     *                 signed ("bytes" = anything; "json-object" = a JSON
     *                 object; "utf8" = valid UTF-8).
     */
    artifactTypes: z.record(
      z.string().min(1),
      z
        .object({
          key: z.enum(["session", "company"]),
          payloadFormat: payloadFormat.default("bytes"),
        })
        .strict(),
    ),
  })
  .strict();

export type SignerPolicy = z.infer<typeof signerPolicySchema>;

export interface SignRequest {
  artifactType: string;
  payloadBytes: number;
  /** When supplied, the payload format check runs too (mirrors the daemon). */
  payload?: Buffer;
}

export type SignPolicyVerdict =
  | { ok: true; keyScope: "session" | "company"; payloadFormat: PayloadFormat }
  | { ok: false; code: "policy_denied" | "bad_policy" | "payload_too_large" | "invalid_payload"; message: string };

export function payloadFormatOk(format: PayloadFormat | undefined, bytes: Buffer): boolean {
  switch (format ?? "bytes") {
    case "bytes":
      return true;
    case "utf8":
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
    case "json-object":
      try {
        const v: unknown = JSON.parse(bytes.toString("utf8"));
        return typeof v === "object" && v !== null && !Array.isArray(v);
      } catch {
        return false;
      }
  }
}

/** Mirror of checkSignRequest() in cloud/sandbox/signerd.mjs. */
export function checkSignRequest(policy: SignerPolicy, req: SignRequest): SignPolicyVerdict {
  const types = policy.artifactTypes;
  // Own-property lookup — Object.prototype members ("constructor",
  // "__proto__", "toString", …) are NOT policy entries.
  if (!Object.hasOwn(types, req.artifactType)) {
    return { ok: false, code: "policy_denied", message: `artifactType ${req.artifactType} not in policy` };
  }
  const t = types[req.artifactType]!;
  if (t.key !== "session" && t.key !== "company") {
    return { ok: false, code: "bad_policy", message: `policy entry for ${req.artifactType} has no valid key scope` };
  }
  if (req.payloadBytes > policy.maxPayloadBytes) {
    return { ok: false, code: "payload_too_large", message: `${req.payloadBytes}B exceeds maxPayloadBytes` };
  }
  if (req.payload !== undefined && !payloadFormatOk(t.payloadFormat, req.payload)) {
    return {
      ok: false,
      code: "invalid_payload",
      message: `payload does not match format ${t.payloadFormat} for ${req.artifactType}`,
    };
  }
  return { ok: true, keyScope: t.key, payloadFormat: t.payloadFormat };
}
