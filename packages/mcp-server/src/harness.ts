import { z } from "zod";
import type { PaperclipApiClient } from "./client.js";
import { makeTool, type ToolDefinition } from "./tools.js";

/**
 * AgentDash-MK: the harness→agent control channel.
 *
 * These tools let a human's local Claude act as the AUTHORITY over the
 * AgentDash agent it is paired with — not as a worker for it. That is the
 * opposite direction from `bridge.ts`, and the asymmetry is deliberate:
 * outbound (harness → agent) is unrestricted because the harness is trusted;
 * inbound (agent → harness) passes a gate because the agent lives in a shared
 * environment full of other agents' output.
 *
 * Two rules bound "unrestricted", and both are enforced server-side rather than
 * trusted to this file:
 *
 *   1. NARROWING ONLY. `agentdashNarrowAgentCeilings` writes the steward
 *      request, and the server clamps anything broader than the owner ceiling
 *      down to it. A compromised laptop can only make its agent more
 *      constrained than the org authorized — never less.
 *
 *   2. DIRECTIVES DO NOT GRANT. `agentdashPushAgentDirectives` writes free
 *      text that reaches the agent's context and shapes how it works. It cannot
 *      give the agent a provider, a data scope, or a budget. If you need the
 *      agent to be ABLE to do something new, that is a ceiling change (rule 1),
 *      or an owner-ceiling change that only an administrator can make. Writing
 *      "you may use HubSpot" into directives does nothing at all.
 *
 * These tools require the caller's own board credential and only work when the
 * caller is the agent's ACTIVE steward. An administrator who is not the steward
 * gets a 403 — directives carry the steward's provenance and nobody else may
 * put words in their agent's mouth. Outside the `agentdash_mk` profile every
 * route here 404s.
 */

const agentIdOptional = z.string().uuid().optional().nullable();
const companyIdOptional = z.string().uuid().optional().nullable();

const policyListSchema = z.array(z.string().trim().min(1)).min(1);

const narrowCeilingsSchema = z.object({
  companyId: companyIdOptional,
  agentId: agentIdOptional,
  permissions: policyListSchema,
  monthlyBudgetCents: z.number().int().nonnegative(),
  destructiveActions: z.enum(["blocked", "approval_required", "allowed"]),
  dataScopes: policyListSchema,
  providers: policyListSchema,
  minimumApproval: z.enum(["none", "steward"]),
  revision: z.number().int().positive().optional(),
});

function agentPath(client: PaperclipApiClient, companyId?: string | null, agentId?: string | null) {
  return `/companies/${client.resolveCompanyId(companyId)}/agents/${encodeURIComponent(
    client.resolveAgentId(agentId),
  )}`;
}

export function harnessTools(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool(
      "agentdashPushAgentDirectives",
      "AgentDash-MK: push free-text operating directives to the AgentDash agent you steward — its standing instructions, voice, and explicit don'ts. Append-only and versioned: this supersedes the previous version and keeps it readable. Directives shape HOW the agent works and CANNOT grant it capability; use agentdashNarrowAgentCeilings for what it may touch.",
      z.object({
        companyId: companyIdOptional,
        agentId: agentIdOptional,
        directives: z.string().min(1),
      }),
      async ({ companyId, agentId, directives }) =>
        client.requestJson("POST", `${agentPath(client, companyId, agentId)}/directives`, {
          body: { directives },
        }),
    ),

    makeTool(
      "agentdashGetAgentDirectives",
      "AgentDash-MK: read the directives currently in force for your paired agent plus every superseded version, each with the principal who pushed it and when.",
      z.object({ companyId: companyIdOptional, agentId: agentIdOptional }),
      async ({ companyId, agentId }) =>
        client.requestJson("GET", `${agentPath(client, companyId, agentId)}/directives`),
    ),

    makeTool(
      "agentdashNarrowAgentCeilings",
      "AgentDash-MK: set the structured ceilings (providers, dataScopes, permissions, budget, destructive actions, minimum approval) for the agent you steward. NARROWING ONLY — anything broader than the owner's ceiling is clamped down to it and reported in `clamped`, not accepted and not rejected. Send the full policy; omitted dimensions are not merged.",
      narrowCeilingsSchema,
      async ({ companyId, agentId, revision, ...policy }) =>
        client.requestJson("PUT", `${agentPath(client, companyId, agentId)}/governance/harness-request`, {
          body: revision === undefined ? { policy } : { policy, revision },
        }),
    ),

    makeTool(
      "agentdashGetAgentPolicy",
      "AgentDash-MK: read what actually applies to your paired agent — the owner ceiling, your steward request, and the effective policy that is their intersection. Start here when the agent says it cannot do something: the effective policy, not your request, is what the runtime enforces.",
      z.object({ companyId: companyIdOptional, agentId: agentIdOptional }),
      async ({ companyId, agentId }) =>
        client.requestJson("GET", `${agentPath(client, companyId, agentId)}/governance`),
    ),
  ];
}
