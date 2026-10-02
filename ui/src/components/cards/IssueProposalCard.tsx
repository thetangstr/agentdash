// AgentDash (scan 3, lane G): "Create this task?" — the CoS suggests a task;
// only the person whose message it answered can confirm it. Chat messages
// carry no author, so the confirm click is that person's own, explicit say-so.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../../api/auth";
import { ApiError } from "../../api/client";
import { conversationsApi, type IssueCreatedSummary } from "../../api/conversations";
import { queryKeys } from "../../lib/queryKeys";
import { useOptionalCompany } from "../../context/CompanyContext";
import { IssueCreatedCard } from "./IssueCreatedCard";

export interface IssueProposalCardPayload {
  status: "pending" | "creating" | "created" | "dismissed";
  title: string;
  description?: string | null;
  assigneeName?: string | null;
  requesterUserId?: string | null;
  issueId?: string | null;
  identifier?: string | null;
  issueStatus?: string | null;
  /** AgentDash (scan 4, lane N): the company's status for a new issue when the card was posted. */
  defaultStatus?: "backlog" | "todo" | null;
}

type View =
  | { kind: "pending" }
  | { kind: "created"; issue: IssueCreatedSummary }
  | { kind: "dismissed" };

function initialView(payload: IssueProposalCardPayload): View {
  if (payload.status === "created" && payload.issueId) {
    return {
      kind: "created",
      issue: {
        issueId: payload.issueId,
        identifier: payload.identifier ?? null,
        title: payload.title,
        assigneeName: payload.assigneeName ?? "",
        status: payload.issueStatus ?? "todo",
      },
    };
  }
  if (payload.status === "dismissed") return { kind: "dismissed" };
  return { kind: "pending" };
}

/**
 * AgentDash (scan 4, lane N): the confirm buttons. One primary action that
 * matches the company's default: with a backlog default, "Create" parks the
 * task and "Create and start" starts it now; otherwise "Create task" starts it.
 */
export function issueProposalActions(defaultStatus: string | null | undefined): Array<{
  kind: "create" | "start";
  label: string;
  primary: boolean;
}> {
  if (defaultStatus === "backlog") {
    return [
      { kind: "create", label: "Create", primary: true },
      { kind: "start", label: "Create and start", primary: false },
    ];
  }
  return [{ kind: "create", label: "Create task", primary: true }];
}

export function IssueProposalCard({
  payload,
  conversationId,
  messageId,
}: {
  payload: IssueProposalCardPayload | null | undefined;
  conversationId?: string;
  messageId?: string;
}) {
  const [localView, setView] = useState<View>(() => (payload ? initialView(payload) : { kind: "pending" }));
  const [busy, setBusy] = useState<null | "create" | "start" | "dismiss">(null);
  const [error, setError] = useState<string | null>(null);
  // AgentDash (scan 4, lane N): the company's current "start new issues right
  // away" setting picks the buttons; the value recorded on the card is the
  // fallback (no company context, or a company not loaded yet).
  const company = useOptionalCompany()?.selectedCompany ?? null;
  const liveDefaultStatus =
    company && typeof company.newIssuesStartAsTodo === "boolean"
      ? company.newIssuesStartAsTodo
        ? "todo"
        : "backlog"
      : null;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  if (!payload || typeof payload.title !== "string") return null;
  // A state the server pushed (message.updated: created or declined, possibly
  // by another tab) wins over this tab's own pending view.
  const pushed = initialView(payload);
  const view = pushed.kind !== "pending" ? pushed : localView;
  if (view.kind === "created") return <IssueCreatedCard payload={view.issue} />;

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  // Unknown session: show the buttons; the server decides.
  const isRequester = !currentUserId || !payload.requesterUserId || currentUserId === payload.requesterUserId;
  const canAct = view.kind === "pending" && payload.status === "pending" && Boolean(conversationId && messageId);

  async function act(kind: "create" | "start" | "dismiss") {
    if (!conversationId || !messageId || busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind !== "dismiss") {
        const result = await conversationsApi.confirmTaskProposal(conversationId, messageId, { start: kind === "start" });
        setView({ kind: "created", issue: result.issue });
      } else {
        await conversationsApi.dismissTaskProposal(conversationId, messageId);
        setView({ kind: "dismissed" });
      }
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  }
  const actions = issueProposalActions(liveDefaultStatus ?? payload.defaultStatus);

  return (
    <div
      className="w-full min-w-0 break-words rounded-lg border border-border-soft bg-surface-raised p-3 text-sm shadow-sm sm:p-4"
      data-testid="issue-proposal-card"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
        {view.kind === "dismissed" ? "Task not created" : "Create this task?"}
      </p>
      <p className="mt-1 font-medium text-text-primary">{payload.title}</p>
      {payload.description ? <p className="mt-1 text-text-secondary">{payload.description}</p> : null}
      {payload.assigneeName ? <p className="mt-1 text-text-secondary">For {payload.assigneeName}</p> : null}
      {canAct && isRequester ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              data-testid={`issue-proposal-${action.kind}`}
              className={
                action.primary
                  ? "min-h-11 rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent-600 disabled:opacity-50 sm:min-h-0"
                  : "min-h-11 rounded-md border border-border-soft px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-sunken disabled:opacity-50 sm:min-h-0"
              }
              onClick={() => void act(action.kind)}
              disabled={busy !== null}
            >
              {busy === action.kind ? "Creating…" : action.label}
            </button>
          ))}
          <button
            type="button"
            className="min-h-11 rounded-md border border-border-soft px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-sunken disabled:opacity-50 sm:min-h-0"
            onClick={() => void act("dismiss")}
            disabled={busy !== null}
          >
            Not now
          </button>
        </div>
      ) : null}
      {canAct && !isRequester ? (
        <p className="mt-2 text-xs text-text-tertiary">Waiting for the person who asked to confirm it.</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-text-secondary" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
