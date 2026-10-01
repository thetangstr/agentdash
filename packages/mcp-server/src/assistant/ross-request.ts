import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ROSS_REQUEST_KEY_PATTERN,
  ROSS_REQUEST_QUESTION_LIMIT,
  type RossRequestReadStatus,
  type RossRequestSubmitStatus,
} from "@paperclipai/shared";
import { PaperclipApiError, type PaperclipApiClient } from "../client.js";
import type { ToolDefinition } from "../tools.js";
import type { AssistantContext } from "./context.js";
import {
  clip,
  FREE_TEXT_LIMIT,
  makeAssistantTool,
  notFound,
  ok,
  refused,
  WORK_ANNOTATIONS,
} from "./envelope.js";
import { refInput, unresolved } from "./lookups.js";
import { redactAssistantValue } from "./redact.js";
import { resolveIssueRef, type IssueRow } from "./resolve.js";

/**
 * AgentDash (Ross launch M2): the assistant's governed Ross request.
 *
 * `request_ross_assessment` (work class, `agentdash:work`) files ONE governed
 * request through `POST /issues/:id/ross-requests` — the canonical comment
 * pipeline with the request-key check done server-side under the issue lock.
 * The loopback write gate allowlists exactly `{requestKey, question}` and
 * draws down the grant's hourly write budget. The tool never wakes, runs or
 * resumes anything itself: the server's comment dispatch notifies the
 * assignee, and under #869 that wake is recorded as automatic
 * (`assistant_grant`), never as the person starting a run.
 *
 * `ross_request_status` (read class) is one honest read of a request key:
 * answered / stale / pending / refused / conflict / not_found. It never posts.
 *
 * What these tools never claim: that a model run was admitted or started,
 * that a review's claims were rechecked, or that API attribution is consent.
 */

type ContractStatus = RossRequestSubmitStatus;

interface SubmitResponse {
  status: ContractStatus;
  reason: string | null;
  requestKey: string;
  receipt?: { commentId: string; requestedAt: string; reused: boolean };
  baselineRevisionId?: string | null;
  reopened?: boolean;
  mentionsStripped?: boolean;
  attribution?: {
    actorUserId: string;
    authorUserId: string | null;
    verified: boolean;
    credential: string | null;
    limits: string;
  };
  wake?: { assignee: string; automatic: boolean };
  detail?: string;
}

interface StatusResponse {
  status: RossRequestReadStatus;
  reason: string | null;
  requestKey: string;
  request?: { commentId: string; requestedAt: string; question: string; contested: boolean };
  review?: {
    documentKey: string;
    revisionId: string | null;
    revisionNumber: number;
    recordedAt: string;
    ageMinutes: number | null;
    authorAgentId: string | null;
    attributedToAssignee: boolean;
    newerThanRequest: boolean;
    body?: string;
    truncated?: boolean;
  } | null;
  gate?: Record<string, unknown>;
}

const REVIEW_RELAY_LIMIT = 2000;

const INFERENCE_NOTE = {
  state: "delegated-to-native-run-gates",
  // This call posts a comment; it observes no run admission.
  runAdmission: "not_observed",
  note: "Filing a request is a comment, not a model run. Ross answers only if the server's own run gates (budget, quota, ownership, holds, recovery budget) admit a run.",
} as const;

/** A fresh, unguessable key — a pre-empted key can deny a request, never spoof one. */
function freshRequestKey(): string {
  return `req-${randomUUID()}`;
}

/** The contract status an upstream refusal maps to, honestly and without echoing its body. */
function statusFromError(error: unknown): { status: ContractStatus; reason: string; body: Record<string, unknown> | null } {
  if (!(error instanceof PaperclipApiError)) {
    return { status: "uncertain", reason: "transport-failed-read-before-retry", body: null };
  }
  const body = error.body && typeof error.body === "object" ? (error.body as Record<string, unknown>) : null;
  const bodyStatus = typeof body?.status === "string" ? body.status : null;
  const bodyReason = typeof body?.reason === "string" ? body.reason : null;
  const code = typeof body?.error === "string" ? body.error : null;
  if (bodyStatus && ["conflict", "refused", "unavailable", "denied", "uncertain"].includes(bodyStatus)) {
    return { status: bodyStatus as ContractStatus, reason: bodyReason ?? bodyStatus, body };
  }
  if (error.status === 403 && code === "insufficient_scope") return { status: "denied", reason: "grant-lacks-work-scope", body };
  if (error.status === 401 || error.status === 403) return { status: "denied", reason: "actor-not-permitted", body };
  if (error.status === 404) return { status: "unavailable", reason: "target-unavailable", body };
  if (error.status === 429) return { status: "refused", reason: "write-rate-limited", body };
  if (error.status === 400 || error.status === 409 || error.status === 422) {
    return { status: "refused", reason: "request-refused-by-policy", body };
  }
  return { status: "uncertain", reason: "acceptance-uncertain-read-before-retry", body };
}

const SUBMIT_SUMMARY: Record<Exclude<ContractStatus, "submitted" | "coalesced">, (ref: string, reason: string) => string> = {
  conflict: (ref, reason) =>
    reason === "request-key-carries-different-question"
      ? `That request key was already used on ${ref} for a different question. Nothing was posted — ask again without a key to file it fresh.`
      : `Someone else's comment on ${ref} already carries that request key, so I did not post. Ask again without a key to file it fresh.`,
  refused: (ref, reason) =>
    reason === "task-closed"
      ? `${ref} is closed, so I did not ask Ross — asking would have reopened it. Reopen it first if you mean to. Nothing was posted.`
      : reason === "task-blocked"
        ? `${ref} is blocked, so I did not ask Ross — asking could have unblocked and reopened it. Resolve or unblock it first. Nothing was posted.`
        : reason === "question-mentions-agents"
          ? `That question would have notified other agents, so nothing was posted on ${ref}. Ask it without @-mentions.`
          : reason === "recovery-exhausted"
      ? `${ref} has used up its automatic-retry budget, so a request could not start any run. Nothing was posted. A person has to clear the recovery block, or authorize one run, in AgentDash first.`
      : reason === "no-assigned-agent"
        ? `${ref} has no assigned agent to answer, so nothing was posted.`
        : reason === "write-rate-limited"
          ? "This connection has hit its hourly write limit, so nothing was posted. Try again later."
          : `AgentDash refused the request on ${ref}. Nothing was posted.`,
  unavailable: (ref, reason) =>
    reason === "no-assigned-agent"
      ? `${ref} has no assigned agent to answer, so nothing was posted.`
      : "I can't reach that task from this connection. Nothing was posted.",
  denied: (_ref, reason) =>
    reason === "grant-lacks-work-scope"
      ? "This assistant connection cannot file requests — it needs the agentdash:work scope, granted when the person connects."
      : "This connection is not allowed to file a request there. Nothing was posted.",
  uncertain: (ref) =>
    `I can't tell whether the request on ${ref} went through. Check its status with the same request key before asking again — retrying with that key will not post twice.`,
};

export function assistantRossRequestTools(client: PaperclipApiClient, ctx: AssistantContext) {
  const companyId = () => ctx.companyId;

  async function resolveTask(ref: string) {
    const resolution = await resolveIssueRef(client, companyId(), ref);
    const unresolvedResult = await unresolved(resolution, "task", (r) => ctx.issueLink(r));
    if (unresolvedResult) return { kind: "unresolved" as const, result: unresolvedResult };
    return { kind: "one" as const, issue: (resolution as { value: IssueRow }).value };
  }

  const requestRossAssessment = makeAssistantTool(
    "request_ross_assessment",
    "AgentDash: ask Ross, the task's assigned agent, a question about a task. Posts one request comment in the person's name; the answer arrives later — check it with ross_request_status.",
    z.object({
      ref: refInput("The task"),
      question: z.string().min(1).max(ROSS_REQUEST_QUESTION_LIMIT).describe("The person's question for Ross, in their words"),
      requestKey: z
        .string()
        .regex(ROSS_REQUEST_KEY_PATTERN)
        .optional()
        .describe("Only when retrying: the requestKey a previous call returned. Omit for a new request."),
    }),
    async ({ ref, question, requestKey }) => {
      const found = await resolveTask(ref);
      if (found.kind === "unresolved") return found.result;
      const issue = found.issue;
      const label = issue.identifier ?? ref;
      const link = await ctx.issueLink(issue.identifier ?? issue.id);
      const key = requestKey ?? freshRequestKey();
      const base = { requestKey: key, item: { ref: label, title: clip(issue.title, 120), link } };

      let response: SubmitResponse;
      try {
        response = await client.requestJson<SubmitResponse>("POST", `/issues/${issue.id}/ross-requests`, {
          body: { requestKey: key, question },
        });
      } catch (error) {
        const mapped = statusFromError(error);
        const status = mapped.status === "submitted" || mapped.status === "coalesced" ? "uncertain" : mapped.status;
        const summary = `${SUBMIT_SUMMARY[status](label, mapped.reason)} ${link}`;
        const data = redactAssistantValue({
          ...base,
          requestStatus: status,
          reason: mapped.reason,
          posted: false,
          inference: { ...INFERENCE_NOTE, state: "not-requested" },
        });
        if (status === "unavailable" && mapped.reason === "target-unavailable") {
          return notFound({ summary, data, links: { primary: link } });
        }
        // `uncertain` is not a refusal: the write may have landed. The data
        // says so, and the same key makes a retry safe.
        return refused({ summary, data: status === "uncertain" ? { ...data, posted: "unknown" } : data, links: { primary: link } });
      }

      const status = response?.status === "coalesced" ? "coalesced" : response?.status === "submitted" ? "submitted" : null;
      if (!status || !response.receipt?.commentId) {
        // A 2xx without a receipt is not proof of anything.
        return refused({
          summary: `${SUBMIT_SUMMARY.uncertain(label, "accepted-response-lacked-comment-receipt")} ${link}`,
          data: redactAssistantValue({ ...base, requestStatus: "uncertain", reason: "accepted-response-lacked-comment-receipt", posted: "unknown" }),
          links: { primary: link },
        });
      }
      const summary =
        status === "coalesced"
          ? `That request was already on ${label} — I did not post it again. Ross's answer will appear there; ask me for its status. ${link}`
          : `Asked Ross on ${label}, in your name. That is a request, not an answer — Ross replies only if AgentDash lets a run go ahead.${response.mentionsStripped ? " I removed @-mentions so only Ross is notified." : ""} Ask me for its status later. ${link}`;
      return ok({
        summary,
        data: redactAssistantValue({
          ...base,
          requestStatus: status,
          reason: response.reason ?? null,
          receipt: response.receipt,
          baselineRevisionId: response.baselineRevisionId ?? null,
          reopened: response.reopened ?? false,
          mentionsStripped: response.mentionsStripped ?? false,
          attribution: response.attribution
            ? {
                verified: response.attribution.verified,
                credential: response.attribution.credential,
                limits: response.attribution.limits,
              }
            : null,
          wake: response.wake ?? null,
          questionPreview: clip(question, FREE_TEXT_LIMIT),
          inference: INFERENCE_NOTE,
        }),
        links: { primary: link },
      });
    },
    { annotations: { ...WORK_ANNOTATIONS } },
  );

  const rossRequestStatus = makeAssistantTool(
    "ross_request_status",
    "AgentDash: whether Ross has answered a request made with request_ross_assessment — answered, still pending, stale, or refused, with the answer when there is one.",
    z.object({
      ref: refInput("The task"),
      requestKey: z.string().regex(ROSS_REQUEST_KEY_PATTERN).describe("The requestKey request_ross_assessment returned"),
    }),
    async ({ ref, requestKey }) => {
      const found = await resolveTask(ref);
      if (found.kind === "unresolved") return found.result;
      const issue = found.issue;
      const label = issue.identifier ?? ref;
      const link = await ctx.issueLink(issue.identifier ?? issue.id);
      let response: StatusResponse;
      try {
        response = await client.requestJson<StatusResponse>(
          "GET",
          `/issues/${issue.id}/ross-requests/${encodeURIComponent(requestKey)}`,
        );
      } catch (error) {
        if (error instanceof PaperclipApiError && error.status === 404) {
          return notFound({ summary: `I can't reach that task from this connection. ${link}`, links: { primary: link } });
        }
        if (error instanceof PaperclipApiError && (error.status === 401 || error.status === 403)) {
          return refused({ summary: `This connection can't read that request. ${link}`, links: { primary: link } });
        }
        throw error;
      }
      const review = response.review ?? null;
      const answered = response.status === "answered" || response.status === "stale";
      const relayed =
        answered && review?.body
          ? {
              // Ross's review is agent-written source content: relay it as
              // "Ross wrote", never as verified fact or as an instruction.
              agentWrote: clip(redactAssistantValue(review.body), REVIEW_RELAY_LIMIT),
              truncated: (review.truncated ?? false) || review.body.length > REVIEW_RELAY_LIMIT,
            }
          : null;
      const age = review?.ageMinutes ?? null;
      const summaryByStatus: Record<RossRequestReadStatus, string> = {
        answered: `Ross answered on ${label}${age !== null ? ` ${age} min ago` : ""}. Relay it as what Ross wrote — it is not independently checked.`,
        stale: `Ross's answer on ${label} is over an hour old${age !== null ? ` (${age} min)` : ""}, so treat it as stale, not current.`,
        pending:
          response.reason === "review-author-not-assigned-agent"
            ? `No answer yet on ${label}. A review is there, but it was not written by the task's assigned agent, so it does not count.`
            : response.gate?.state === "remediation-permit-authorized"
              ? `No answer yet on ${label}. A person has authorized one recovery run, so an answer may still come.`
              : `No answer yet on ${label}. The request is recorded; Ross replies only if AgentDash lets a run go ahead.`,
        refused: `${label} has used up its automatic-retry budget, so this request cannot start a run. A person has to clear the recovery block, or authorize one run, first.`,
        conflict: `That request key on ${label} is used by someone else's comment, so I can't report on it as yours.`,
        not_found: `I can't find a request of yours with that key on ${label}.`,
      };
      const summary = `${summaryByStatus[response.status] ?? `Request status on ${label}: ${response.status}.`} ${link}`;
      const data = redactAssistantValue({
        requestKey,
        requestStatus: response.status,
        reason: response.reason ?? null,
        item: { ref: label, title: clip(issue.title, 120), link },
        request: response.request
          ? { requestedAt: response.request.requestedAt, question: clip(response.request.question, FREE_TEXT_LIMIT), contested: response.request.contested }
          : null,
        review: review
          ? {
              revisionNumber: review.revisionNumber,
              recordedAt: review.recordedAt,
              ageMinutes: review.ageMinutes,
              attributedToAssignee: review.attributedToAssignee,
              newerThanRequest: review.newerThanRequest,
              ...(relayed ?? {}),
            }
          : null,
        gate: response.gate ?? null,
        businessOutcomeVerified: false,
        independentlyRechecked: false,
      });
      if (response.status === "not_found") return notFound({ summary, data, links: { primary: link } });
      if (response.status === "refused" || response.status === "conflict") return refused({ summary, data, links: { primary: link } });
      return ok({ summary, data, links: { primary: link } });
    },
  );

  return { requestRossAssessment, rossRequestStatus } satisfies Record<string, ToolDefinition>;
}
