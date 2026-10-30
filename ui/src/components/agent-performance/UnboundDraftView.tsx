import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentProfileRevisionDto, UnboundAgentProfileView } from "@paperclipai/shared";
import { unboundAgentProfileQueryKeys, unboundAgentProfilesApi } from "@/api/agent-profiles";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { ProfileBodyView } from "./ProfileBodyView";
import { Banner, isForbiddenError } from "./shared";
import { REVISION_STATE_TEXT, refusalText } from "./profile-shared";
import { HIRE_NEEDS_APPROVAL_TEXT } from "./brief-shared";
import { UnboundDraftEditor } from "./UnboundDraftEditor";
import type { ProfileAdapterOption } from "./ProfileDraftEditor";

// AgentDash: Agent Performance Management gate 5 (P5.2) — one draft profile
// for a role nobody holds yet (`/agents/drafts/:profileId`). It shows, in
// words: the open draft (the four-step editor, or read-only for people who
// can't edit it), a hire awaiting approval, a profile that now belongs to a
// hired agent, or no open draft after a rejection or withdrawal. Nothing on
// this page hires or starts an agent; only approving the hire does.

export const UNBOUND_RESTRICTED_TEXT =
  "Only company members and the performance manager can see draft profiles for new roles.";

export function UnboundDraftView({
  companyId,
  profileId,
  adapterOptions,
  briefIssueId = null,
}: {
  companyId: string;
  profileId: string;
  adapterOptions: ProfileAdapterOption[];
  /** The brief this draft was opened from; linked to the hire approval. */
  briefIssueId?: string | null;
}) {
  const queryClient = useQueryClient();
  const viewKey = unboundAgentProfileQueryKeys.view(companyId, profileId);
  const [announcement, setAnnouncement] = useState("");
  const [proposedApprovalId, setProposedApprovalId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const viewQuery = useQuery({
    queryKey: viewKey,
    queryFn: () => unboundAgentProfilesApi.get(companyId, profileId),
    retry: false,
  });
  const view = viewQuery.data ?? null;
  const pending = view?.pendingProposal ?? null;
  const pendingQuery = useQuery({
    queryKey: unboundAgentProfileQueryKeys.revision(companyId, profileId, pending?.id ?? "none"),
    queryFn: () => unboundAgentProfilesApi.revision(companyId, profileId, pending!.id),
    enabled: Boolean(pending && !view?.agentId),
    retry: false,
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: viewKey });
    void queryClient.invalidateQueries({ queryKey: unboundAgentProfileQueryKeys.list(companyId) });
  }

  function announce(text: string) {
    setAnnouncement(text);
    statusRef.current?.focus();
  }

  const withdraw = useMutation({
    mutationFn: (revisionId: string) => unboundAgentProfilesApi.withdraw(companyId, profileId, revisionId),
    onSuccess: (revision) => {
      setActionError(null);
      setProposedApprovalId(null);
      announce(`Hire request for revision ${revision.revisionNumber} withdrawn. Nobody was hired.`);
      refresh();
    },
    onError: (error) => setActionError(`${refusalText("withdraw the hire request", error)} Nothing changed.`),
  });

  const newDraft = useMutation({
    mutationFn: () => unboundAgentProfilesApi.createDraft(companyId, profileId),
    onSuccess: (revision) => {
      setActionError(null);
      announce(`Started draft revision ${revision.revisionNumber}. Nobody is hired until a hire is approved.`);
      refresh();
    },
    onError: (error) => setActionError(`${refusalText("start a new draft", error)} Nothing changed.`),
  });

  const status = (
    <p
      ref={statusRef}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      className={announcement ? "text-sm text-text-primary focus-visible:outline-none" : "sr-only"}
      data-testid="unbound-draft-status"
    >
      {announcement}
      {announcement && proposedApprovalId ? (
        <>
          {" "}
          <Link to={`/approvals/${proposedApprovalId}`} className="underline" data-testid="unbound-draft-approval-link">
            Open the hire request
          </Link>
        </>
      ) : null}
    </p>
  );

  if (viewQuery.error) {
    const error = viewQuery.error;
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="max-w-3xl space-y-2" data-testid="unbound-draft-view">
        {isForbiddenError(error) ? (
          <p className="text-sm text-text-secondary" data-testid="unbound-draft-restricted">
            {UNBOUND_RESTRICTED_TEXT}
          </p>
        ) : (
          <div role="alert" className="rounded-md border border-danger-500/30 px-3 py-2 text-sm" data-testid="unbound-draft-error">
            <p className="font-medium text-text-primary">{notFound ? "This draft profile doesn't exist in this company." : "Couldn't load this draft profile."}</p>
            {!notFound ? <p className="mt-1 text-text-secondary">{error instanceof Error ? error.message : "The server did not say why."}</p> : null}
          </div>
        )}
      </div>
    );
  }
  if (viewQuery.isLoading || !view) {
    return (
      <p role="status" className="text-sm text-text-secondary" data-testid="unbound-draft-loading">
        Loading the draft profile…
      </p>
    );
  }

  const latest = view.revisions[0] ?? null;
  const draft = view.latestDraft;
  const name = draft?.body.identity.name || pendingQuery.data?.body.identity.name || "";

  return (
    <div className="max-w-4xl space-y-6" data-testid="unbound-draft-view">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-text-primary">{name ? `Draft profile: ${name}` : "Draft profile for a new role"}</h1>
        <p className="text-sm text-text-secondary">For a role nobody holds yet. {HIRE_NEEDS_APPROVAL_TEXT}</p>
        {briefIssueId ? (
          <p className="text-sm">
            <Link to={`/agents/briefs/${briefIssueId}`} className="underline" data-testid="unbound-draft-brief-link">
              Back to the brief
            </Link>
          </p>
        ) : null}
      </header>
      {status}
      {actionError ? (
        <p role="alert" className="text-sm text-danger-500" data-testid="unbound-draft-action-error">
          {actionError}
        </p>
      ) : null}

      <ViewBody
        view={view}
        latest={latest}
        pendingRevision={pendingQuery.data ?? null}
        companyId={companyId}
        profileId={profileId}
        adapterOptions={adapterOptions}
        briefIssueId={briefIssueId}
        withdrawPending={withdraw.isPending}
        newDraftPending={newDraft.isPending}
        onWithdraw={(revisionId) => !withdraw.isPending && withdraw.mutate(revisionId)}
        onNewDraft={() => !newDraft.isPending && newDraft.mutate()}
        onSaved={(saved) => {
          queryClient.setQueryData<UnboundAgentProfileView>(viewKey, (current) => (current ? { ...current, latestDraft: saved } : current));
          void queryClient.invalidateQueries({ queryKey: unboundAgentProfileQueryKeys.list(companyId) });
        }}
        onProposed={(revisionNumber, approvalId) => {
          setActionError(null);
          setProposedApprovalId(approvalId);
          announce(`Hire requested for revision ${revisionNumber}. ${HIRE_NEEDS_APPROVAL_TEXT}`);
          refresh();
        }}
        onStale={refresh}
      />
    </div>
  );
}

function ViewBody({
  view,
  latest,
  pendingRevision,
  companyId,
  profileId,
  adapterOptions,
  briefIssueId,
  withdrawPending,
  newDraftPending,
  onWithdraw,
  onNewDraft,
  onSaved,
  onProposed,
  onStale,
}: {
  view: UnboundAgentProfileView;
  latest: UnboundAgentProfileView["revisions"][number] | null;
  pendingRevision: AgentProfileRevisionDto | null;
  companyId: string;
  profileId: string;
  adapterOptions: ProfileAdapterOption[];
  briefIssueId: string | null;
  withdrawPending: boolean;
  newDraftPending: boolean;
  onWithdraw: (revisionId: string) => void;
  onNewDraft: () => void;
  onSaved: (saved: AgentProfileRevisionDto) => void;
  onProposed: (revisionNumber: number, approvalId: string) => void;
  onStale: () => void;
}) {
  if (view.agentId) {
    return (
      <div data-testid="unbound-draft-bound">
        <Banner>
          <p>
            This profile belongs to a hired agent now. Read and change it on{" "}
            <Link to={`/agents/${view.agentId}/profile`} className="underline">
              the agent's Profile tab
            </Link>
            .
          </p>
        </Banner>
      </div>
    );
  }

  if (view.pendingProposal) {
    const pending = view.pendingProposal;
    return (
      <div className="space-y-4" data-testid="unbound-draft-pending">
        <Banner>
          <p>
            Hire requested for revision {pending.revisionNumber}. {HIRE_NEEDS_APPROVAL_TEXT}
            {view.hireApprovalId ? (
              <>
                {" "}
                <Link to={`/approvals/${view.hireApprovalId}`} className="underline" data-testid="unbound-draft-pending-approval-link">
                  Open the hire request
                </Link>
                .
              </>
            ) : null}
          </p>
        </Banner>
        {view.viewer.canWithdraw ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => onWithdraw(pending.id)}
            aria-disabled={withdrawPending}
            data-testid="unbound-draft-withdraw"
          >
            {withdrawPending ? "Withdrawing…" : `Withdraw the hire request for revision ${pending.revisionNumber}`}
          </Button>
        ) : null}
        {pendingRevision ? <ProfileBodyView body={pendingRevision.body} provenance={pendingRevision.provenance} testId="unbound-draft-pending-body" /> : null}
      </div>
    );
  }

  if (view.latestDraft && view.viewer.canEditDraft) {
    return (
      <UnboundDraftEditor
        key={view.latestDraft.id}
        companyId={companyId}
        profileId={profileId}
        draft={view.latestDraft}
        mayPropose={view.viewer.canPropose}
        adapterOptions={adapterOptions}
        sourceIssueId={briefIssueId}
        onSaved={onSaved}
        onProposed={(result) => onProposed(result.revision.revisionNumber, result.approvalId)}
        onStale={onStale}
      />
    );
  }

  if (view.latestDraft) {
    const draft = view.latestDraft;
    return (
      <section aria-labelledby="unbound-draft-readonly-heading" className="space-y-3" data-testid="unbound-draft-readonly">
        <h2 id="unbound-draft-readonly-heading" className="text-base font-semibold text-text-primary">
          Draft revision {draft.revisionNumber}
        </h2>
        <p className="text-sm text-text-secondary">
          Saved {formatDateTime(draft.updatedAt)}. Only an administrator who can create agents, or the performance manager, can
          change it. Nobody is hired until a hire is approved.
        </p>
        <ProfileBodyView body={draft.body} provenance={draft.provenance} testId="unbound-draft-readonly-body" />
      </section>
    );
  }

  return (
    <div className="space-y-3" data-testid="unbound-draft-closed">
      <p className="text-sm text-text-primary">
        {latest
          ? `No open draft. The newest revision (${latest.revisionNumber}) is ${REVISION_STATE_TEXT[latest.state].toLowerCase()}.`
          : "No open draft."}{" "}
        Nobody was hired.
      </p>
      {view.viewer.canEditDraft && latest ? (
        <Button type="button" onClick={onNewDraft} aria-disabled={newDraftPending} data-testid="unbound-draft-new">
          {newDraftPending ? "Starting…" : `Start a new draft from revision ${latest.revisionNumber}`}
        </Button>
      ) : null}
    </div>
  );
}
