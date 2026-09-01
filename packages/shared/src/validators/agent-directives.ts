import { z } from "zod";
import { agentGovernancePolicySchema } from "./agent-governance.js";
import { AGENT_DIRECTIVES_MAX_LENGTH } from "../types/agent-directives.js";

/**
 * A directives push. Free text by design — the whole point is that a steward
 * can say things a structured policy cannot express. Length is the only
 * constraint, because there is nothing here to validate against: directives
 * grant nothing, so an unrecognized phrase cannot widen anything.
 */
export const pushAgentDirectivesSchema = z
  .object({
    directives: z.string().trim().min(1).max(AGENT_DIRECTIVES_MAX_LENGTH),
  })
  .strict();

export type PushAgentDirectives = z.infer<typeof pushAgentDirectivesSchema>;

/**
 * A harness ceiling push.
 *
 * `revision` is optional here, unlike the web steward-request envelope. The
 * harness is an unattended writer with no screen to reload; requiring it to
 * carry a revision it never read would push every tool call into a
 * read-then-write dance that still races. Omitting it means "apply to whatever
 * is current" — the update statement is still guarded by the revision the
 * server read a moment earlier, so a concurrent write is a 409 rather than a
 * silent overwrite. Supply it when the caller genuinely has one.
 */
export const pushHarnessAgentPolicySchema = z
  .object({
    policy: agentGovernancePolicySchema,
    revision: z.number().int().positive().optional(),
  })
  .strict();

export type PushHarnessAgentPolicy = z.infer<typeof pushHarnessAgentPolicySchema>;
