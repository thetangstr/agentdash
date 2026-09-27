import { z } from "zod";
import type { PaperclipApiClient } from "../client.js";
import { PaperclipApiError } from "../client.js";
import type { AssistantContext } from "./context.js";
import type { ToolDefinition } from "../tools.js";
import {
  clip,
  DESTRUCTIVE_WORK_ANNOTATIONS,
  FREE_TEXT_LIMIT,
  makeAssistantTool,
  needsClarification,
  notFound,
  ok,
  refused,
  WORK_ANNOTATIONS,
} from "./envelope.js";
import { redactAssistantValue } from "./redact.js";
import { refInput, unresolved } from "./lookups.js";
import { resolveProjectRef } from "./resolve.js";

/**
 * AgentDash assistant MCP (M4, GH #679, spec §4.2 tools 15–17 and §7): the
 * gated class — decisions and hires. Nothing here changes state on its own:
 * `prepare_*` mints a single-use 15-minute handle server-side and returns
 * the exact read-back to say to the person; `confirm_action` spends the
 * handle only after they agree. The server re-resolves the person's
 * authority at confirm — a refusal here is a real answer, never a retry.
 */

const DECISIONS_ENDPOINT = (companyId: string) =>
  `/companies/${companyId}/assistant/actions`;

interface PendingDecisionRow {
  approvalId: string;
  kind: string;
  summary?: string | null;
  askedBy?: string | null;
  canDecide?: boolean;
}

interface PrepareDecisionResponse {
  ok: boolean;
  readBack?: string;
  handle?: string;
  expiresAt?: string;
  effects?: string[];
  approval?: { id: string; type: string; revision: number };
  code?: string;
  reason?: string;
}

interface PrepareHireResponse {
  ok: boolean;
  readBack?: string;
  handle?: string;
  expiresAt?: string;
  wouldNeedApproval?: boolean;
  effects?: string[];
  hire?: { name: string; role: string; adapterType: string };
  code?: string;
  reason?: string;
}

interface ConfirmResponse {
  ok: boolean;
  outcome?: string;
  kind?: string;
  approvalId?: string;
  agentId?: string;
  tapReturned?: boolean;
  links?: Record<string, string>;
  code?: string;
  reason?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The server's refusal `reason` is written for the person — a plain sentence
 * the route composed for exactly this transcript. Relay it (clipped), the
 * same way `refusalMessage` relays the mapped codes.
 */
function refusalFrom(error: PaperclipApiError) {
  const body = error.body;
  // A scope refusal carries `error`/`required_scope`, not `reason` — the same
  // mapping the shared envelope applies, kept here so this surface names the
  // scope the person can actually grant.
  const code =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : null;
  if (error.status === 403 && code === "insufficient_scope") {
    return refused({
      summary:
        "This assistant connection cannot take decisions — that needs the agentdash:decide scope, which the person grants when they connect.",
    });
  }
  const reason =
    body && typeof body === "object" && "reason" in body && typeof body.reason === "string"
      ? body.reason
      : null;
  return refused({
    summary: reason
      ? clip(redactAssistantValue(reason) as string, FREE_TEXT_LIMIT + 320)
      : "That action was refused — nothing was decided or filed.",
  });
}

/**
 * Resolve the `approval` argument: a UUID goes straight through; anything
 * else is matched against the pending-decision summaries — never guessed.
 */
async function resolveApprovalRef(
  client: PaperclipApiClient,
  ctx: AssistantContext,
  raw: string,
): Promise<
  | { approvalId: string }
  | { failure: ReturnType<typeof notFound> | ReturnType<typeof needsClarification> }
> {
  const ref = raw.trim();
  if (UUID_RE.test(ref)) return { approvalId: ref };

  const rows = await client
    .requestJson<{ decisions?: PendingDecisionRow[] }>(
      "GET",
      `/companies/${ctx.companyId}/assistant/pending-decisions`,
    )
    .then((res) => (Array.isArray(res?.decisions) ? res.decisions : []))
    .catch(() => [] as PendingDecisionRow[]);

  const needle = ref.toLowerCase();
  const matches = rows.filter((row) =>
    [row.kind, row.summary ?? "", row.askedBy ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
  if (matches.length === 1) return { approvalId: matches[0]!.approvalId };
  if (matches.length === 0) {
    return {
      failure: notFound({
        summary: "I couldn't find a pending decision matching that. Ask me what's waiting on you first. Nothing was prepared.",
      }),
    };
  }
  return {
    failure: needsClarification({
      summary: "That could be a few of the pending decisions — which one did you mean?",
      candidates: await Promise.all(
        matches.slice(0, 5).map(async (row) => ({
          label: clip(row.summary ?? row.kind, 80),
          ref: row.approvalId,
          link: await ctx.approvalLink(row.approvalId),
        })),
      ),
    }),
  };
}

export function assistantGatedTools(client: PaperclipApiClient, ctx: AssistantContext): ToolDefinition[] {
  const companyId = () => ctx.companyId;

  const prepareDecision = makeAssistantTool(
    "prepare_decision",
    "AgentDash: get ready to approve, reject, or send back a pending decision. Returns the exact sentence to read the person and a one-time handle — nothing happens until confirm_action.",
    z.object({
      approval: refInput("The pending decision").describe("Which pending decision — its id or what it is about"),
      decision: z.enum(["approve", "reject", "request_changes"]).describe("What the person wants to do with it"),
      note: z.string().max(1000).optional().describe("An optional note attached to the decision"),
    }),
    async ({ approval, decision, note }) => {
      const resolved = await resolveApprovalRef(client, ctx, approval);
      if ("failure" in resolved) return resolved.failure;

      let result: PrepareDecisionResponse;
      try {
        result = await client.requestJson<PrepareDecisionResponse>(
          "POST",
          `${DECISIONS_ENDPOINT(companyId())}/prepare-decision`,
          {
            body: {
              approvalId: resolved.approvalId,
              decision,
              ...(note ? { note } : {}),
            },
          },
        );
      } catch (error) {
        if (error instanceof PaperclipApiError) return refusalFrom(error);
        throw error;
      }

      const readBack = result.readBack ?? "The action is prepared.";
      return ok({
        summary: `${readBack} Say yes to confirm — this offer expires in 15 minutes.`,
        data: redactAssistantValue({
          readBack,
          handle: result.handle,
          expiresAt: result.expiresAt,
          effects: result.effects ?? [],
          approval: result.approval,
          pendingConfirmation: true,
        }),
      });
    },
    { annotations: { ...WORK_ANNOTATIONS } },
  );

  const requestHire = makeAssistantTool(
    "request_hire",
    "AgentDash: get ready to ask for a new agent — a role and why. Returns a read-back and a one-time handle; nothing is filed until confirm_action.",
    z.object({
      role: z.string().min(1).max(120).describe("What kind of agent — designer, QA, whatever the person asked for"),
      reason: z.string().min(1).max(1000).describe("Why they are needed — the approver reads this"),
      project: refInput("A project").optional().describe("The project the hire is for"),
      nameHint: z.string().min(1).max(120).optional().describe("A name for the agent, if the person gave one"),
    }),
    async ({ role, reason, project, nameHint }) => {
      let projectId: string | null = null;
      if (project) {
        const resolution = await resolveProjectRef(client, companyId(), project);
        const unresolvedResult = await unresolved(resolution, "project", (ref) => ctx.projectLink(ref));
        if (unresolvedResult) return unresolvedResult;
        projectId = (resolution as { value: { id: string } }).value.id;
      }

      let result: PrepareHireResponse;
      try {
        result = await client.requestJson<PrepareHireResponse>(
          "POST",
          `${DECISIONS_ENDPOINT(companyId())}/prepare-hire`,
          {
            body: {
              role,
              reason,
              ...(nameHint ? { name: nameHint } : {}),
              ...(projectId ? { projectId } : {}),
            },
          },
        );
      } catch (error) {
        if (error instanceof PaperclipApiError) return refusalFrom(error);
        throw error;
      }

      const readBack = result.readBack ?? "The hire request is prepared.";
      return ok({
        summary: `${readBack} Say yes to confirm — this offer expires in 15 minutes.`,
        data: redactAssistantValue({
          readBack,
          handle: result.handle,
          expiresAt: result.expiresAt,
          wouldNeedApproval: result.wouldNeedApproval === true,
          effects: result.effects ?? [],
          hire: result.hire,
          pendingConfirmation: true,
        }),
      });
    },
    { annotations: { ...WORK_ANNOTATIONS } },
  );

  const confirmAction = makeAssistantTool(
    "confirm_action",
    "AgentDash: carry out an action the person has just agreed to, using the handle from prepare_decision or request_hire. Call it ONLY after they hear the read-back and say yes. The handle works once.",
    z.object({
      handle: z.string().min(1).max(200).describe("The handle prepare_decision or request_hire returned"),
      personSaid: z
        .string()
        .max(280)
        .optional()
        .describe("What the person said, in their words — recorded in the audit trail"),
    }),
    async ({ handle, personSaid }) => {
      let result: ConfirmResponse;
      try {
        result = await client.requestJson<ConfirmResponse>(
          "POST",
          `${DECISIONS_ENDPOINT(companyId())}/confirm`,
          {
            body: {
              handle,
              ...(personSaid ? { personSaid } : {}),
            },
          },
        );
      } catch (error) {
        if (error instanceof PaperclipApiError) return refusalFrom(error);
        throw error;
      }

      const outcome = result.outcome ?? "Done.";
      const primary =
        result.links?.approval ?? result.links?.agent ?? result.links?.newAgent ?? undefined;
      return ok({
        summary: primary ? `${outcome} ${primary}` : outcome,
        data: redactAssistantValue({
          ok: true,
          outcome,
          kind: result.kind,
          approvalId: result.approvalId ?? null,
          agentId: result.agentId ?? null,
          tapReturned: result.tapReturned === true,
        }),
        ...(primary || Object.keys(result.links ?? {}).length > 0
          ? { links: { ...(result.links ?? {}), ...(primary ? { primary } : {}) } }
          : {}),
      });
    },
    // Spec §7.2: the annotation-aware client's own confirm affordance sits on
    // top of ours — we never rely on it, but it is marked destructive so the
    // client can add its gate.
    { annotations: { ...DESTRUCTIVE_WORK_ANNOTATIONS } },
  );

  return [prepareDecision, requestHire, confirmAction];
}
