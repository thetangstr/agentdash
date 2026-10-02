// AgentDash: the signer daemon's signing policy (spike R2). The same JSON
// document is validated here (control plane / evidence) and enforced inside
// the sandbox by cloud/sandbox/signerd.mjs — the daemon cannot import this
// file, so the check is deliberately tiny and duplicated; keep them in sync.
import { z } from "zod";

export const signerPolicySchema = z
  .object({
    maxPayloadBytes: z.number().int().positive().max(1 << 20),
    /**
     * artifactType -> which key scope may sign it.
     *   "session" — the per-handshake-session key minted by `init`
     *   "company" — the sandbox's long-term company key (file key in the
     *               prototype, a KMS key in Phase 1)
     * There is deliberately no "principal" scope: the family principal's key
     * never enters the sandbox; mandates arrive pre-signed.
     */
    artifactTypes: z.record(
      z.string().min(1),
      z.object({ key: z.enum(["session", "company"]) }).strict(),
    ),
  })
  .strict();

export type SignerPolicy = z.infer<typeof signerPolicySchema>;

export interface SignRequest {
  artifactType: string;
  payloadBytes: number;
}

export type SignPolicyVerdict =
  | { ok: true; keyScope: "session" | "company" }
  | { ok: false; code: "policy_denied" | "payload_too_large"; message: string };

/** Mirror of checkSignRequest() in cloud/sandbox/signerd.mjs. */
export function checkSignRequest(policy: SignerPolicy, req: SignRequest): SignPolicyVerdict {
  const t = policy.artifactTypes[req.artifactType];
  if (!t) {
    return { ok: false, code: "policy_denied", message: `artifactType ${req.artifactType} not in policy` };
  }
  if (req.payloadBytes > policy.maxPayloadBytes) {
    return { ok: false, code: "payload_too_large", message: `${req.payloadBytes}B exceeds maxPayloadBytes` };
  }
  return { ok: true, keyScope: t.key };
}
