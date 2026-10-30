import { z } from "zod";
import { AGENT_ICON_NAMES, AGENT_ROLES } from "../constants.js";
import { AGENT_SCENARIO_RECOMMENDATIONS } from "../types/agent-brief.js";
import {
  AGENT_PROFILE_RESPONSIBILITY_KEY_PATTERN,
  agentOperatingProfileV1Schema,
  agentProfileChangePayloadSchema,
  agentProfileProvenanceMapSchema,
  agentProfileSourceRefSchema,
  proposeAgentProfileRevisionSchema,
} from "./agent-profile.js";

/**
 * AgentDash: Agent Performance Management gate 5 (P5.1) — the brief, the
 * scenario manifest and unbound drafts (doc/plans/2026-10-29-apm-gate4-5-build-spec.md).
 */

const shortText = z.string().trim().max(200);
const longText = z.string().trim().max(4000);

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

/** `POST /api/companies/:companyId/agent-briefs`: the planning issue's title and the pasted Markdown brief. */
export const createAgentBriefSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    markdown: z.string().max(524288).refine((value) => value.trim().length > 0, { message: "the brief is empty" }),
  })
  .strict();
export type CreateAgentBrief = z.infer<typeof createAgentBriefSchema>;

/** `POST /api/companies/:companyId/agent-briefs/:issueId/submit`. */
export const submitAgentBriefSchema = z.object({}).strict();
export type SubmitAgentBrief = z.infer<typeof submitAgentBriefSchema>;

// ---------------------------------------------------------------------------
// Scenario manifest (issue document `scenario-manifest`)
// ---------------------------------------------------------------------------

/**
 * One scenario of the brief (discovery draft §2), as the planner read it.
 * Descriptive fields may be empty; a fact the brief does not give belongs in
 * `unknowns`, never guessed. The recommendation names what the work should
 * become, with the reason; it never creates a role by itself.
 */
export const agentScenarioSchema = z
  .object({
    key: z.string().min(1).max(80).regex(AGENT_PROFILE_RESPONSIBILITY_KEY_PATTERN, "use lowercase letters, digits, '-' and '_'"),
    title: shortText.min(1),
    stakeholders: longText,
    currentProcess: longText,
    removedOrNewWork: longText,
    triggerCadence: longText,
    inputsSources: longText,
    deliverable: longText,
    acceptanceNotes: longText,
    authorityNeeds: longText,
    escalation: longText,
    baselineMeasure: longText,
    unknowns: z.array(longText.min(1)).max(50),
    recommendation: z.enum(AGENT_SCENARIO_RECOMMENDATIONS),
    /** The existing agent that takes the work (`reuse`, `bounded_change`). */
    targetAgentId: z.string().uuid().optional(),
    /** The unbound draft for a new role (`new_role`), once one is written. */
    unboundProfileId: z.string().uuid().optional(),
    reason: longText.min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsTarget = value.recommendation === "reuse" || value.recommendation === "bounded_change";
    if (needsTarget && !value.targetAgentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetAgentId"], message: `a ${value.recommendation} recommendation must name targetAgentId` });
    }
    if (!needsTarget && value.targetAgentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetAgentId"], message: `targetAgentId does not apply to a ${value.recommendation} recommendation` });
    }
    if (value.recommendation !== "new_role" && value.unboundProfileId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unboundProfileId"], message: "unboundProfileId applies only to a new_role recommendation" });
    }
  });
export type AgentScenario = z.infer<typeof agentScenarioSchema>;

/** `AgentScenarioManifestV1`: the planner's reading of the brief, stored as JSON in the `scenario-manifest` document. */
export const agentScenarioManifestV1Schema = z
  .object({
    manifestVersion: z.literal(1),
    /** The `agent-work-brief` revision the scenarios were read from, so later brief edits are visible. */
    briefRevisionId: z.string().uuid().nullable().optional(),
    scenarios: z
      .array(agentScenarioSchema)
      .max(50)
      .refine((items) => new Set(items.map((item) => item.key)).size === items.length, { message: "scenario keys must be unique" }),
  })
  .strict();
export type AgentScenarioManifestV1 = z.infer<typeof agentScenarioManifestV1Schema>;

export interface AgentScenarioManifestIssue {
  path: string;
  message: string;
}

export type AgentScenarioManifestParse =
  | { ok: true; manifest: AgentScenarioManifestV1 }
  | { ok: false; issues: AgentScenarioManifestIssue[] };

const FENCED_JSON = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/;

/**
 * Parse a `scenario-manifest` document body: JSON text, or one fenced
 * ```json block (so the document still renders as Markdown). Pure.
 */
export function parseAgentScenarioManifestDocument(body: string): AgentScenarioManifestParse {
  const trimmed = body.trim();
  const fenced = FENCED_JSON.exec(trimmed);
  const text = fenced ? fenced[1]! : trimmed;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path: "", message: "the manifest must be JSON (optionally inside one ```json block)" }] };
  }
  const parsed = agentScenarioManifestV1Schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
  }
  return { ok: true, manifest: parsed.data };
}

// ---------------------------------------------------------------------------
// Unbound drafts
// ---------------------------------------------------------------------------

/** `POST /api/companies/:companyId/agent-profiles`: a new unbound profile and its first draft. */
export const createUnboundAgentProfileSchema = z
  .object({
    body: agentOperatingProfileV1Schema,
    provenance: agentProfileProvenanceMapSchema.optional(),
    sourceRefs: z.array(agentProfileSourceRefSchema).max(50).optional(),
  })
  .strict();
export type CreateUnboundAgentProfile = z.infer<typeof createUnboundAgentProfileSchema>;

/**
 * `POST .../agent-profiles/:profileId/revisions/:revisionId/propose`: files a
 * `hire_agent` approval. The new agent's name, title, summary and adapter
 * type come from the draft (`identity`, `runtime.adapterType`); these are the
 * remaining hire fields, validated with the draft by the hire validator.
 */
export const proposeUnboundAgentProfileSchema = proposeAgentProfileRevisionSchema
  .extend({
    role: z.enum(AGENT_ROLES).optional(),
    icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
    reportsTo: z.string().uuid().optional().nullable(),
    budgetMonthlyCents: z.number().int().nonnegative().optional(),
    /** The brief's planning issue, linked to the hire approval. */
    sourceIssueId: z.string().uuid().optional().nullable(),
  })
  .strict();
export type ProposeUnboundAgentProfile = z.infer<typeof proposeUnboundAgentProfileSchema>;

/** The profile fields on a `hire_agent` approval payload (`AgentProfileHireFields`). Server-written; read back through this. */
export const agentProfileHireFieldsSchema = z.object({
  profileId: z.string().uuid(),
  profileRevisionId: z.string().uuid(),
  profileRevisionNumber: z.number().int().positive(),
  profileBodyHash: z.string().regex(/^[0-9a-f]{64}$/),
  profileChange: agentProfileChangePayloadSchema,
});

/** True when a hire payload names a profile (whether or not it parses). */
export function hirePayloadNamesProfile(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return ["profileId", "profileRevisionId", "profileRevisionNumber", "profileBodyHash", "profileChange"].some((key) => key in record);
}
