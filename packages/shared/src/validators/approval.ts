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
export const CONNECTOR_SEND_PROVIDERS = ["hubspot", "microsoft"] as const;
export type ConnectorSendProvider = (typeof CONNECTOR_SEND_PROVIDERS)[number];

/** The CRM objects the HubSpot executor writes. */
export const HUBSPOT_WRITE_OBJECT_TYPES = ["contacts", "companies", "deals"] as const;
export type HubspotWriteObjectType = (typeof HUBSPOT_WRITE_OBJECT_TYPES)[number];

export const HUBSPOT_WRITE_OPERATIONS = ["create", "update"] as const;

/**
 * AgentDash (per-steward document access, slice 5): the only Microsoft write.
 * An enum of one so a later operation is additive, and so `update`, `replace`
 * and `delete` are refused by shape: an approved payload can never overwrite
 * or remove a document (D5, D15).
 */
export const MICROSOFT_DOCUMENT_WRITE_OPERATIONS = ["upload_new"] as const;
export type MicrosoftDocumentWriteOperation = (typeof MICROSOFT_DOCUMENT_WRITE_OPERATIONS)[number];

/** The steward reads this to decide; long enough for "what changed and why". */
export const MICROSOFT_PROPOSE_SUMMARY_MAX_CHARS = 2000;
const MICROSOFT_FILE_NAME_MAX_CHARS = 120;
const MICROSOFT_PATH_MAX_CHARS = 400;

export interface ProposedCopyFormat {
  /** Lower-case extension without the dot. */
  extension: string;
  /** Attachment content types this output can be made from. */
  accepts: string[];
  /**
   * The subset of `accepts` the executor converts rather than passes through.
   * D9: python-docx is not installed on the host, so an agent drafts Markdown
   * and the server renders it as a Word document.
   */
  convertFrom: string[];
  /** The content type the uploaded file is sent as. */
  uploadContentType: string;
}

const OOXML = "application/vnd.openxmlformats-officedocument";
const PROPOSED_COPY_FORMATS: readonly ProposedCopyFormat[] = Object.freeze([
  {
    extension: "docx",
    accepts: [`${OOXML}.wordprocessingml.document`, "text/markdown"],
    convertFrom: ["text/markdown"],
    uploadContentType: `${OOXML}.wordprocessingml.document`,
  },
  {
    extension: "pptx",
    accepts: [`${OOXML}.presentationml.presentation`],
    convertFrom: [],
    uploadContentType: `${OOXML}.presentationml.presentation`,
  },
  {
    extension: "xlsx",
    accepts: [`${OOXML}.spreadsheetml.sheet`],
    convertFrom: [],
    uploadContentType: `${OOXML}.spreadsheetml.sheet`,
  },
  { extension: "pdf", accepts: ["application/pdf"], convertFrom: [], uploadContentType: "application/pdf" },
  { extension: "md", accepts: ["text/markdown"], convertFrom: [], uploadContentType: "text/markdown" },
  { extension: "txt", accepts: ["text/plain"], convertFrom: [], uploadContentType: "text/plain" },
  { extension: "csv", accepts: ["text/csv"], convertFrom: [], uploadContentType: "text/csv" },
]);

/** Characters OneDrive refuses in a name, plus the ones Graph path syntax uses. */
const NAME_FORBIDDEN = /["*:<>?/\\|#%\u0000-\u001f\u007f]/;
/** Graph item and drive ids: letters, digits and `!._-`; nothing that is path or query syntax. */
const GRAPH_ID = /^[A-Za-z0-9!._-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function splitExtension(fileName: string): { stem: string; extension: string } | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot + 1).toLowerCase() };
}

/** The output format a proposed file name asks for, or null when it is not one AgentDash writes. */
export function proposedCopyFormatFor(fileName: string): ProposedCopyFormat | null {
  const parts = splitExtension(fileName.trim());
  if (!parts) return null;
  return PROPOSED_COPY_FORMATS.find((format) => format.extension === parts.extension) ?? null;
}

function isPlainName(value: string): boolean {
  if (value.length === 0 || value.length > MICROSOFT_FILE_NAME_MAX_CHARS) return false;
  if (value !== value.trim() || value.endsWith(".")) return false;
  if (value === "." || value === ".." || value.startsWith("~$")) return false;
  return !NAME_FORBIDDEN.test(value);
}

function isValidProposedFileName(value: unknown): value is string {
  if (typeof value !== "string" || !isPlainName(value)) return false;
  const parts = splitExtension(value);
  return parts !== null && parts.stem.trim().length > 0 && proposedCopyFormatFor(value) !== null;
}

/**
 * A folder path in the person's own OneDrive, relative to its root: segments
 * separated by `/`, no `.`/`..`, nothing Graph would read as syntax. `/` alone
 * names the root, which is still a destination the person chose (D10).
 */
function isValidFolderPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MICROSOFT_PATH_MAX_CHARS) return false;
  if (trimmed === "/") return true;
  const segments = trimmed.replace(/^\/+|\/+$/g, "").split("/");
  return segments.every((segment) => isPlainName(segment));
}

/**
 * The name a proposed copy is saved under: `<name> (proposed by <agent>).<ext>`
 * (D15). The agent's display name is reduced to characters OneDrive accepts so
 * it cannot add a folder, a Graph path separator or a second extension.
 */
export function proposedCopyFileName(fileName: string, agentName: string): string {
  const trimmed = fileName.trim();
  const parts = splitExtension(trimmed) ?? { stem: trimmed, extension: "" };
  const agent = agentName
    .replace(new RegExp(NAME_FORBIDDEN.source, "g"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  const label = agent.length > 0 ? agent : "an agent";
  const stem = parts.stem.trim();
  return parts.extension ? `${stem} (proposed by ${label}).${parts.extension}` : `${stem} (proposed by ${label})`;
}

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
  | "properties_invalid"
  | "target_invalid"
  | "file_name_invalid"
  | "attachment_id_invalid"
  | "summary_invalid"
  | "source_item_id_invalid";

export type ConnectorSendPayloadCheck =
  | { ok: true; provider: ConnectorSendProvider }
  | { ok: false; problem: ConnectorSendPayloadProblem; message: string };

const SUPPORTED_SHAPE =
  `Supported: provider "hubspot" with ` +
  `objectType ${HUBSPOT_WRITE_OBJECT_TYPES.join("|")}, operation ${HUBSPOT_WRITE_OPERATIONS.join("|")} ` +
  `(update needs objectId) and a properties object. Prefer POST /api/companies/:companyId/hubspot/:objectType/write, ` +
  `which files the approval for you. Provider "microsoft" (operation upload_new only) is filed by the ` +
  `documents_propose_upload tool (POST /api/companies/:companyId/documents/microsoft/propose).`;

const MICROSOFT_SHAPE =
  `A Microsoft connector_send is {provider: "microsoft", operation: "upload_new", target: {path} or ` +
  `{folderId} (optionally with driveId) in your steward's own OneDrive, fileName (a plain name ending in ` +
  `${PROPOSED_COPY_FORMATS.map((format) => `.${format.extension}`).join(", ")}), attachmentId (an issue ` +
  `attachment you uploaded), sourceItemId?, summary}. File it with documents_propose_upload.`;

function checkMicrosoftPayload(record: Record<string, unknown>): ConnectorSendPayloadCheck {
  if (!(MICROSOFT_DOCUMENT_WRITE_OPERATIONS as readonly unknown[]).includes(record.operation)) {
    return {
      ok: false,
      problem: "operation_invalid",
      message:
        `connector_send provider "microsoft" supports operation "upload_new" only: it saves a new proposed ` +
        `copy and never overwrites, edits in place or deletes a document. ${MICROSOFT_SHAPE}`,
    };
  }
  const target =
    typeof record.target === "object" && record.target !== null && !Array.isArray(record.target)
      ? (record.target as Record<string, unknown>)
      : null;
  const hasFolderId = target !== null && target.folderId !== undefined && target.folderId !== null;
  const hasPath = target !== null && target.path !== undefined && target.path !== null;
  const hasDriveId = target !== null && target.driveId !== undefined && target.driveId !== null;
  const targetOk =
    target !== null &&
    hasFolderId !== hasPath &&
    (!hasFolderId || (typeof target.folderId === "string" && GRAPH_ID.test(target.folderId))) &&
    (!hasPath || isValidFolderPath(target.path)) &&
    (!hasDriveId || (typeof target.driveId === "string" && GRAPH_ID.test(target.driveId)));
  if (!targetOk) {
    return {
      ok: false,
      problem: "target_invalid",
      message:
        `connector_send target must name exactly one destination folder in your steward's own OneDrive: ` +
        `{path: "Folder/Sub"} or {folderId}, optionally with driveId. There is no default folder; ask your ` +
        `steward where it should go. ${MICROSOFT_SHAPE}`,
    };
  }
  if (!isValidProposedFileName(record.fileName)) {
    return {
      ok: false,
      problem: "file_name_invalid",
      message: `connector_send fileName must be a plain file name with a supported extension. ${MICROSOFT_SHAPE}`,
    };
  }
  if (typeof record.attachmentId !== "string" || !UUID.test(record.attachmentId)) {
    return {
      ok: false,
      problem: "attachment_id_invalid",
      message: `connector_send attachmentId must be the id of an issue attachment you uploaded. ${MICROSOFT_SHAPE}`,
    };
  }
  if (
    record.sourceItemId !== undefined &&
    record.sourceItemId !== null &&
    (typeof record.sourceItemId !== "string" || !GRAPH_ID.test(record.sourceItemId))
  ) {
    return {
      ok: false,
      problem: "source_item_id_invalid",
      message: `connector_send sourceItemId must be the Microsoft item id of the original document. ${MICROSOFT_SHAPE}`,
    };
  }
  if (
    typeof record.summary !== "string" ||
    record.summary.trim().length === 0 ||
    record.summary.length > MICROSOFT_PROPOSE_SUMMARY_MAX_CHARS
  ) {
    return {
      ok: false,
      problem: "summary_invalid",
      message:
        `connector_send summary must say, in at most ${MICROSOFT_PROPOSE_SUMMARY_MAX_CHARS} characters, what ` +
        `the copy changes and why; your steward decides on it. ${MICROSOFT_SHAPE}`,
    };
  }
  return { ok: true, provider: "microsoft" };
}

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

  if (provider === "microsoft") return checkMicrosoftPayload(record);

  // HubSpot's fields are the rest of the contract.
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
