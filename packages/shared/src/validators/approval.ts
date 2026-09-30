import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

/**
 * AgentDash-MK: the connectors a `connector_send` can actually be executed
 * through once a steward approves it. Only providers with an executor belong
 * here — listing one without an executor is how an approved send ends up
 * "delivered" by nothing.
 */
export const CONNECTOR_SEND_PROVIDERS = ["hubspot"] as const;
export type ConnectorSendProvider = (typeof CONNECTOR_SEND_PROVIDERS)[number];

/** The CRM objects the HubSpot executor writes. */
export const HUBSPOT_WRITE_OBJECT_TYPES = ["contacts", "companies", "deals"] as const;
export type HubspotWriteObjectType = (typeof HUBSPOT_WRITE_OBJECT_TYPES)[number];

export const HUBSPOT_WRITE_OPERATIONS = ["create", "update"] as const;

/**
 * What an agent is told when it tries to reach a person in Teams through
 * `connector_send`. No connector executes a Teams send, so the request would be
 * approved and then deliver nothing. These are the paths that do reach a
 * person: the steward inbox (read on the steward's own machine through the
 * `agentdash-inbox` harness tools) and the steward webhook, which posts that
 * inbox into the steward's Teams channel. Both carry approvals waiting on the
 * steward and blocked issues, never free text.
 */
export const CONNECTOR_SEND_TEAMS_GUIDANCE =
  "connector_send cannot send Teams messages: no connector executes a Teams send, so an approved " +
  "request would deliver nothing. To reach a person, write the message as a comment on the issue and " +
  "set the issue to blocked, or open a request_board_approval linked to it. A blocked issue or an open " +
  "approval appears in your steward's inbox (the accountable human's, if you have no steward), which reaches them on their own machine (the agentdash-inbox " +
  "harness tools) and in Teams through their steward webhook if they registered one (\"Get told in Teams\" " +
  "on their My Agent page). To reach someone other than your steward, name them in the comment and ask " +
  "your steward to relay it.";

export type ConnectorSendPayloadProblem =
  | "teams_not_supported"
  | "provider_missing"
  | "provider_unsupported"
  | "object_type_invalid"
  | "operation_invalid"
  | "object_id_required"
  | "properties_invalid";

export type ConnectorSendPayloadCheck =
  | { ok: true; provider: ConnectorSendProvider }
  | { ok: false; problem: ConnectorSendPayloadProblem; message: string };

const SUPPORTED_SHAPE =
  `Supported: provider ${CONNECTOR_SEND_PROVIDERS.map((p) => `"${p}"`).join(", ")} with ` +
  `objectType ${HUBSPOT_WRITE_OBJECT_TYPES.join("|")}, operation ${HUBSPOT_WRITE_OPERATIONS.join("|")} ` +
  `(update needs objectId) and a properties object. Prefer POST /api/companies/:companyId/hubspot/:objectType/write, ` +
  `which files the approval for you.`;

/** "teams", "msteams", "ms-teams", "microsoft_teams", "Microsoft Teams" — not any substring. */
function namesTeams(value: unknown): boolean {
  return typeof value === "string" && /^\s*(ms|microsoft)?[\s_-]*teams\s*$/i.test(value);
}

/**
 * Whether a `connector_send` payload names something an executor can run.
 *
 * `createApprovalSchema.payload` stays an open record — every other approval
 * type carries its own shape — so this check is applied by the routes that
 * create or resubmit a `connector_send`, and again by the executor, which must
 * never guess a provider for a payload that did not name one.
 */
export function checkConnectorSendPayload(payload: unknown): ConnectorSendPayloadCheck {
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  if (namesTeams(record.channel) || namesTeams(record.provider)) {
    return { ok: false, problem: "teams_not_supported", message: CONNECTOR_SEND_TEAMS_GUIDANCE };
  }

  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  if (!provider) {
    return {
      ok: false,
      problem: "provider_missing",
      message: `connector_send needs a provider naming the connector that will perform the send. ${SUPPORTED_SHAPE}`,
    };
  }
  if (!(CONNECTOR_SEND_PROVIDERS as readonly string[]).includes(provider)) {
    return {
      ok: false,
      problem: "provider_unsupported",
      message: `connector_send provider ${JSON.stringify(provider.slice(0, 40))} has no executor, so an approved send would deliver nothing. ${SUPPORTED_SHAPE}`,
    };
  }

  // Only HubSpot has an executor today, so its fields are the whole contract.
  if (!(HUBSPOT_WRITE_OBJECT_TYPES as readonly unknown[]).includes(record.objectType)) {
    return {
      ok: false,
      problem: "object_type_invalid",
      message: `connector_send objectType must be one of ${HUBSPOT_WRITE_OBJECT_TYPES.join(", ")}. ${SUPPORTED_SHAPE}`,
    };
  }
  if (!(HUBSPOT_WRITE_OPERATIONS as readonly unknown[]).includes(record.operation)) {
    return {
      ok: false,
      problem: "operation_invalid",
      message: `connector_send operation must be one of ${HUBSPOT_WRITE_OPERATIONS.join(", ")}. ${SUPPORTED_SHAPE}`,
    };
  }
  if (
    record.operation === "update" &&
    (typeof record.objectId !== "string" || record.objectId.trim().length === 0)
  ) {
    return {
      ok: false,
      problem: "object_id_required",
      message: "connector_send operation \"update\" needs the objectId of the record to update.",
    };
  }
  const properties = record.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return {
      ok: false,
      problem: "properties_invalid",
      message: `connector_send needs a properties object holding the fields to write. ${SUPPORTED_SHAPE}`,
    };
  }

  return { ok: true, provider: provider as ConnectorSendProvider };
}

// `bridge_inbox` is a decision taken from a steward inbox on the person's own
// machine. It is its own channel rather than "web" because the audit record
// should not claim a laptop decision came from the board. `assistant` is the
// same distinction for the assistant MCP surface (GH #679): a decision taken
// through a person's assistant records itself as one, never as "web".
export const APPROVAL_DECISION_CHANNELS = [
  "web",
  "telegram",
  "teams",
  "whatsapp",
  "bridge_inbox",
  "assistant",
] as const;
export type ApprovalDecisionChannel = (typeof APPROVAL_DECISION_CHANNELS)[number];

/**
 * Decision metadata is OPTIONAL here on purpose.
 *
 * The plan specifies these as required, but making them required in the schema
 * would break every existing default-profile caller (web UI, CLI, agents) the
 * moment this ships, which contradicts the harder constraint that
 * default-profile behavior must not change. `agentdash_mk` companies require
 * them instead — enforced in the approval-authority service, which is the only
 * layer that knows the company's product profile.
 */
const decisionMetadataShape = {
  revision: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
  channel: z.enum(APPROVAL_DECISION_CHANNELS).optional(),
};

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  ...decisionMetadataShape,
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

/**
 * Emergency override is a distinct action, not a flag on the ordinary decision:
 * it demands an explicit reason and is surfaced and audited as exceptional.
 */
export const overrideApprovalSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  overrideReason: z.string().trim().min(1).max(2000),
  decisionNote: multilineTextSchema.optional().nullable(),
  ...decisionMetadataShape,
});

export type OverrideApproval = z.infer<typeof overrideApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
