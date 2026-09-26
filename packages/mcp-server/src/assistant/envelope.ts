import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import { PaperclipApiError } from "../client.js";
import type { JsonSchema } from "../schema.js";
import { redactAssistantValue } from "./redact.js";

/**
 * AgentDash assistant MCP (M1, GH #676, spec §5): the output contract every
 * assistant tool returns.
 *
 * Two MCP forms, always together:
 *
 * - `content[0].text` — a relayable summary of at most SUMMARY_LIMIT
 *   characters. Plain sentences, names not ids, most important fact first,
 *   ending with the one most useful link. A voice assistant reads it aloud.
 * - `structuredContent` — the machine form, under a declared `outputSchema`,
 *   carrying `status`, the same `summary`, tool-specific `data`, clarification
 *   `candidates`, `links`, `truncated` and `asOf`.
 */

export const SUMMARY_LIMIT = 600;
export const CANDIDATE_LIMIT = 5;
export const LIST_DEFAULT_LIMIT = 10;
export const LIST_MAX_LIMIT = 25;
export const FREE_TEXT_LIMIT = 280;

export interface AssistantCandidate {
  label: string;
  ref: string;
  link?: string;
}

export interface AssistantEnvelope {
  status: "ok" | "needs_clarification" | "refused" | "not_found";
  summary: string;
  data?: Record<string, unknown>;
  candidates?: AssistantCandidate[];
  links?: { primary?: string; [key: string]: string | undefined };
  truncated: boolean;
  asOf: string;
}

/** Hard clip with an ellipsis so a bounded field can never overflow. */
export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function clampLimit(raw: number | undefined, fallback = LIST_DEFAULT_LIMIT): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(raw)));
}

/**
 * Clip the summary body without ever severing the closing link — every tool
 * ends its summary with `links.primary`, and a mid-URL cut leaves the person
 * nothing to open.
 */
function clipSummary(summary: string, primaryLink: string | undefined): string {
  if (summary.length <= SUMMARY_LIMIT) return summary;
  if (primaryLink && summary.endsWith(primaryLink)) {
    const body = summary.slice(0, summary.length - primaryLink.length).trimEnd();
    return `${clip(body, SUMMARY_LIMIT - primaryLink.length - 1)} ${primaryLink}`;
  }
  return clip(summary, SUMMARY_LIMIT);
}

function buildEnvelope(input: {
  status: AssistantEnvelope["status"];
  summary: string;
  data?: Record<string, unknown>;
  candidates?: AssistantCandidate[];
  links?: AssistantEnvelope["links"];
  truncated?: boolean;
}): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  const structured: AssistantEnvelope = {
    status: input.status,
    summary: clipSummary(input.summary, input.links?.primary),
    ...(input.data ? { data: input.data } : {}),
    ...(input.candidates && input.candidates.length > 0
      ? { candidates: input.candidates.slice(0, CANDIDATE_LIMIT) }
      : {}),
    ...(input.links ? { links: input.links } : {}),
    truncated: input.truncated ?? false,
    asOf: new Date().toISOString(),
  };
  return {
    content: [{ type: "text", text: structured.summary }],
    structuredContent: structured as unknown as Record<string, unknown>,
  };
}

export const ok = (input: Omit<Parameters<typeof buildEnvelope>[0], "status">) =>
  buildEnvelope({ ...input, status: "ok" });
export const needsClarification = (input: Omit<Parameters<typeof buildEnvelope>[0], "status">) =>
  buildEnvelope({ ...input, status: "needs_clarification" });
export const notFound = (input: Omit<Parameters<typeof buildEnvelope>[0], "status">) =>
  buildEnvelope({ ...input, status: "not_found" });
export const refused = (input: Omit<Parameters<typeof buildEnvelope>[0], "status">) =>
  buildEnvelope({ ...input, status: "refused" });

/** The declared output schema — one shape for every assistant tool (§5). */
export function assistantOutputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok", "needs_clarification", "refused", "not_found"] },
      summary: { type: "string" },
      data: { type: "object" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            ref: { type: "string" },
            link: { type: "string" },
          },
          required: ["label", "ref"],
        },
      },
      links: { type: "object" },
      truncated: { type: "boolean" },
      asOf: { type: "string", format: "date-time" },
    },
    required: ["status", "summary", "truncated", "asOf"],
  };
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * GH #678 (spec §7.1): the work class — immediate, reversible mutations.
 * `readOnlyHint: false` is what annotation-aware clients use to gate a
 * write; `destructiveHint` marks the one tool (update_work_item) whose
 * effect needs care, so a client can add its own confirm affordance.
 */
export const WORK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const DESTRUCTIVE_WORK_ANNOTATIONS = {
  ...WORK_ANNOTATIONS,
  destructiveHint: true,
} as const;

/**
 * Map a known upstream refusal to a relayable sentence. The body's `error`
 * CODE is safe to read (it is the field the server itself exposes to clients)
 * — anything else in the body stays out of the transcript.
 */
function refusalMessage(error: PaperclipApiError): string | null {
  const body = error.body;
  const code =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : null;
  if (error.status === 403 && code === "insufficient_scope") {
    const required =
      body && typeof body === "object" && "required_scope" in body && typeof body.required_scope === "string"
        ? body.required_scope
        : "agentdash:work";
    if (required === "agentdash:decide") {
      // GH #679: decisions are opt-in at consent. The person can grant it by
      // reconnecting — saying so is the honest answer, not retrying.
      return "This assistant connection cannot take decisions — that needs the agentdash:decide scope, which the person grants when they connect.";
    }
    return `This assistant connection does not have permission to change work — it needs the ${required} scope, granted when the person connects.`;
  }
  if (error.status === 429 && code === "assistant_write_rate_limited") {
    const retry =
      body && typeof body === "object" && "retryAfterSeconds" in body && typeof body.retryAfterSeconds === "number"
        ? Math.ceil(body.retryAfterSeconds / 60)
        : null;
    return `This connection has hit its hourly write limit — changes are capped at 30 per hour (10 new tasks) so a runaway assistant cannot spend freely. ${retry ? `Try again in about ${retry} minute${retry === 1 ? "" : "s"}.` : "Try again a bit later."}`;
  }
  return null;
}

/**
 * `makeTool` for the assistant surface: zod-validates input, returns the §5
 * envelope as `content` + `structuredContent`, and carries `readOnlyHint`.
 */
export function makeAssistantTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent: Record<string, unknown>;
  }>,
  options: { annotations?: Record<string, unknown> } = {},
): ToolDefinition {
  return {
    name,
    description,
    schema,
    annotations: { ...(options.annotations ?? READ_ONLY_ANNOTATIONS) },
    outputSchema: assistantOutputSchema(),
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return await execute(parsed);
      } catch (error) {
        // The assistant surface never echoes an upstream error body — an API
        // error's `body` is whatever the server happened to return and can
        // carry internals a person-facing transcript must not record. The
        // known refusal codes get a relayable sentence; everything else is a
        // fixed generic refusal (GH #745 review): no method, path, id, or
        // raw Error.message, because any of those can carry a route, a UUID
        // or a stack fragment into the transcript.
        const refusal =
          error instanceof PaperclipApiError ? refusalMessage(error) : null;
        const summary = refusal
          ? clip(redactAssistantValue(refusal) as string, SUMMARY_LIMIT)
          : error instanceof z.ZodError
            ? "That request wasn't formed correctly — a required field was missing or invalid. Nothing was changed."
            : "Something went wrong reaching AgentDash — the change may not have gone through; check the item before retrying.";
        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            status: "refused",
            summary,
            truncated: false,
            asOf: new Date().toISOString(),
          } as Record<string, unknown>,
          isError: true,
        };
      }
    },
  };
}
