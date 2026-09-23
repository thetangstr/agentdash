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
    summary: clip(input.summary, SUMMARY_LIMIT),
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
): ToolDefinition {
  return {
    name,
    description,
    schema,
    annotations: { ...READ_ONLY_ANNOTATIONS },
    outputSchema: assistantOutputSchema(),
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return await execute(parsed);
      } catch (error) {
        // The assistant surface never echoes an upstream error body — an API
        // error's `body` is whatever the server happened to return and can
        // carry internals a person-facing transcript must not record. The
        // message alone is the honest answer; isError keeps MCP semantics.
        const message =
          error instanceof PaperclipApiError
            ? `AgentDash answered ${error.status} for ${error.method} ${error.path}.`
            : error instanceof Error
              ? error.message
              : String(error);
        const safe = redactAssistantValue(message) as string;
        const summary = clip(`Something went wrong reaching AgentDash: ${safe}`, SUMMARY_LIMIT);
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
