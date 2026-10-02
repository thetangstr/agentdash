// AgentDash: the per-run evidence record (spike R8). One record per run per
// company proves what the verifier needs: which image booted, which agent
// config ran, which prompt bytes ran, the egress allow-list in force, the
// run's log hash and timestamps, and that no other run or wake happened in
// the window.
//
// The guest contributes the raw material (driver.guestEvidence): the event
// log it actually recorded. The control plane adds everything it owns —
// image digest, config revision+digest, rendered prompt hash, environment id
// — and seals the bundle by hashing it. Verification = recompute the hashes.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SandboxDriver } from "./lifecycle/driver.js";

export const runEvidenceSchema = z
  .object({
    evidenceVersion: z.literal(1),
    companyId: z.string(),
    runId: z.string(),
    /** sha256:… digest of the image the sandbox booted (R1). */
    imageDigest: z.string(),
    /** e.g. "ec2:i-…/us-east-1" or "localvm:<id>". */
    environmentId: z.string(),
    agentConfig: z.object({
      revision: z.string().nullable(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    /** sha256 of the fully-rendered agent prompt actually run. */
    renderedPromptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** sha256 of the egress spec in force for the run (R3 -> R8). */
    egressSpecSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /**
     * sha256 of `nft list table` as read in the guest at evidence time — the
     * ruleset ACTUALLY loaded, not just the spec that should have been.
     * null when the driver runs somewhere nftables cannot (dev mode).
     */
    egressRulesetSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    signerPublicKeyPem: z.string(),
    run: z.object({
      startedAt: z.string(),
      endedAt: z.string(),
      /** sha256 of the run's log bytes (empty log still hashes). */
      logSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    /**
     * Proof that no other run or wake happened inside the window: the guest
     * event log hash plus the (expected-empty) list of foreign events. A
     * verifier recomputes the hash over the disclosed log. Scope note: the
     * guest event log records CONTROL operations (lifecycle calls reaching
     * sandbox-ctl); the agent's own traffic and signerd socket requests are
     * not in it — closing that gap is part of the verifier-schema open
     * question in SPIKE.md.
     */
    exclusivity: z.object({
      windowStart: z.string(),
      windowEnd: z.string(),
      foreignRuns: z.array(z.string()),
      foreignWakes: z.array(z.string()),
      eventLogSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    generatedAt: z.string(),
  })
  .strict();
export type RunEvidence = z.infer<typeof runEvidenceSchema>;

/** sha256 over the canonical record — the value a verifier pins. */
export function evidenceDigest(evidence: RunEvidence): string {
  const canonical = JSON.stringify(runEvidenceSchema.parse(evidence));
  return createHash("sha256").update(canonical).digest("hex");
}

export async function generateRunEvidence(
  driver: SandboxDriver,
  input: {
    companyId: string;
    runId: string;
    agentConfigRevision: string | null;
    agentConfigSha256: string;
    renderedPromptSha256: string;
    egressSpecSha256: string;
    now?: Date;
  },
): Promise<RunEvidence> {
  const guest = await driver.guestEvidence({ runId: input.runId });
  const env = driver.environment();
  return runEvidenceSchema.parse({
    evidenceVersion: 1,
    companyId: input.companyId,
    runId: input.runId,
    imageDigest: env.imageDigest,
    environmentId: env.environmentId,
    agentConfig: { revision: input.agentConfigRevision, sha256: input.agentConfigSha256 },
    renderedPromptSha256: input.renderedPromptSha256,
    egressSpecSha256: input.egressSpecSha256,
    egressRulesetSha256: guest.egressRulesetSha256,
    signerPublicKeyPem: guest.signerPublicKeyPem,
    run: {
      startedAt: guest.window.start,
      endedAt: guest.window.end,
      logSha256: guest.logSha256,
    },
    exclusivity: {
      windowStart: guest.window.start,
      windowEnd: guest.window.end,
      foreignRuns: guest.foreignEvents.filter((e) => e.kind === "run").map((e) => e.runId ?? e.at),
      foreignWakes: guest.foreignEvents.filter((e) => e.kind === "wake").map((e) => e.op),
      eventLogSha256: guest.eventLogSha256,
    },
    generatedAt: (input.now ?? new Date()).toISOString(),
  });
}
