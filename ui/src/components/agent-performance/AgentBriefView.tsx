import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_WORK_BRIEF_ORIGIN_KIND, type IssueDocument } from "@paperclipai/shared";
import { agentBriefQueryKeys, agentBriefsApi } from "@/api/agent-briefs";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { refusalText } from "./profile-shared";
import { ScenarioManifestView } from "./ScenarioManifestView";
import {
  BRIEF_SAVED_TEXT,
  BRIEF_SAVE_NO_WAKE_TEXT,
  BRIEF_SUBMIT_TEXT,
  briefIsUnsent,
  isAlreadySubmittedError,
  isNoPerformanceManagerError,
} from "./brief-shared";

// AgentDash: Agent Performance Management gate 5 (P5.2) — the brief page
// (`/agents/briefs/:issueId`): the brief (a revisioned issue document), the
// step that sends it to the planner, and the planner's scenario manifest.
// Saving or editing the brief wakes no one. Sending it assigns the
// performance manager, the normal assignment wake. With no performance
// manager the server answers 409 and the page says where to set one.

export const NO_PERFORMANCE_MANAGER_TEXT =
  "This company has no performance manager to plan the brief. An administrator can choose one in Company settings, under Performance manager; otherwise the company's Chief of Staff plans it.";

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function AgentBriefView({
  companyId,
  issueId,
  justSaved = false,
}: {
  companyId: string;
  issueId: string;
  /** Opened right after "Save brief": announce that it was saved and that nobody was woken. */
  justSaved?: boolean;
}) {
  const uid = useId();
  const queryClient = useQueryClient();
  const [announcement, setAnnouncement] = useState("");
  const [submitProblem, setSubmitProblem] = useState<{ text: string; noManager: boolean } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const issueQuery = useQuery({
    queryKey: agentBriefQueryKeys.issue(issueId),
    queryFn: () => agentBriefsApi.issue(issueId),
    retry: false,
  });
  const briefQuery = useQuery({
    queryKey: agentBriefQueryKeys.brief(issueId),
    queryFn: () => agentBriefsApi.brief(issueId),
    retry: false,
  });
  const revisionsQuery = useQuery({
    queryKey: agentBriefQueryKeys.briefRevisions(issueId),
    queryFn: () => agentBriefsApi.briefRevisions(issueId),
    retry: false,
  });
  const manifestQuery = useQuery({
    queryKey: agentBriefQueryKeys.manifest(issueId),
    queryFn: async (): Promise<IssueDocument | null> => {
      try {
        return await agentBriefsApi.manifest(issueId);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    retry: false,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    retry: false,
  });
  const issue = issueQuery.data ?? null;
  const unsent = issue ? briefIsUnsent(issue) : false;
  const managerQuery = useQuery({
    queryKey: agentBriefQueryKeys.performanceManager(companyId),
    queryFn: () => agentBriefsApi.performanceManager(companyId),
    enabled: unsent,
    retry: false,
  });

  const announcedSave = useRef(false);
  const briefLoaded = Boolean(issue && issue.originKind === AGENT_WORK_BRIEF_ORIGIN_KIND);
  useEffect(() => {
    if (!justSaved || !briefLoaded || announcedSave.current) return;
    announcedSave.current = true;
    // Set once the page is there, so the live region announces it; the new page's heading takes focus.
    setAnnouncement(`${BRIEF_SAVED_TEXT} Saving doesn't wake anyone.`);
    headingRef.current?.focus();
  }, [justSaved, briefLoaded]);

  const submit = useMutation({
    mutationFn: () => agentBriefsApi.submit(companyId, issueId),
    onSuccess: (result) => {
      setSubmitProblem(null);
      const planner = (agentsQuery.data ?? []).find((agent) => agent.id === result.assigneeAgentId)?.name ?? managerQuery.data?.effective?.name;
      setAnnouncement(`Sent to the planner${planner ? `, ${planner}` : ""}. Its plan will appear below.`);
      void queryClient.invalidateQueries({ queryKey: agentBriefQueryKeys.issue(issueId) });
      void queryClient.invalidateQueries({ queryKey: agentBriefQueryKeys.list(companyId) });
    },
    onError: (error) => {
      setAnnouncement("");
      if (isNoPerformanceManagerError(error)) {
        setSubmitProblem({ text: `${NO_PERFORMANCE_MANAGER_TEXT} Your brief is saved; nothing was sent.`, noManager: true });
        return;
      }
      if (isAlreadySubmittedError(error)) {
        setSubmitProblem({ text: "This brief was already sent to the planner.", noManager: false });
        void queryClient.invalidateQueries({ queryKey: agentBriefQueryKeys.issue(issueId) });
        return;
      }
      setSubmitProblem({ text: `${refusalText("send the brief to the planner", error)} Your brief is saved; nothing was sent.`, noManager: false });
    },
  });

  if (issueQuery.error) {
    return (
      <div role="alert" className="max-w-3xl rounded-md border border-danger-500/30 px-3 py-2 text-sm" data-testid="brief-view-error">
        <p className="font-medium text-text-primary">{isNotFound(issueQuery.error) ? "This brief doesn't exist." : "Couldn't load this brief."}</p>
        {!isNotFound(issueQuery.error) ? (
          <p className="mt-1 text-text-secondary">{issueQuery.error instanceof Error ? issueQuery.error.message : "The server did not say why."}</p>
        ) : null}
      </div>
    );
  }
  if (issueQuery.isLoading || !issue) {
    return (
      <p role="status" className="text-sm text-text-secondary" data-testid="brief-view-loading">
        Loading the brief…
      </p>
    );
  }
  if (issue.originKind !== AGENT_WORK_BRIEF_ORIGIN_KIND) {
    return (
      <p className="max-w-3xl text-sm text-text-secondary" data-testid="brief-view-not-brief">
        This issue wasn't created from a brief.{" "}
        <Link to={`/issues/${issue.identifier ?? issue.id}`} className="underline">
          Open it as an issue
        </Link>
        .
      </p>
    );
  }

  const agents = agentsQuery.data ?? [];
  const planner = issue.assigneeAgentId ? agents.find((agent) => agent.id === issue.assigneeAgentId) ?? null : null;
  const manager = managerQuery.data?.effective ?? null;
  const managerKnownMissing = Boolean(managerQuery.data && !managerQuery.data.effective);

  return (
    <div className="max-w-4xl space-y-8" data-testid="brief-view">
      <header className="space-y-1">
        <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-text-primary focus-visible:outline-none">
          {issue.title}
        </h1>
        <p className="text-sm text-text-secondary" data-testid="brief-state">
          {issue.identifier ? `${issue.identifier} · ` : ""}
          {unsent
            ? "Saved, not sent to the planner. Nobody has been asked to work on it."
            : issue.assigneeAgentId
              ? `With the planner${planner ? `, ${planner.name}` : ""}.`
              : "Sent; no longer in the backlog."}{" "}
          <Link to={`/issues/${issue.identifier ?? issue.id}`} className="underline">
            Open as an issue
          </Link>
        </p>
      </header>

      <p role="status" aria-live="polite" className={announcement ? "text-sm text-text-primary" : "sr-only"} data-testid="brief-view-status">
        {announcement}
      </p>

      {unsent ? (
        <section aria-labelledby={`${uid}-send`} className="space-y-3 rounded-md border border-border-soft px-4 py-3" data-testid="brief-send">
          <h2 id={`${uid}-send`} className="text-base font-semibold text-text-primary">
            Send to the planner
          </h2>
          <p className="text-sm text-text-secondary">{BRIEF_SAVE_NO_WAKE_TEXT}</p>
          <p className="text-sm text-text-secondary">{BRIEF_SUBMIT_TEXT}</p>
          {manager ? (
            <p className="text-sm text-text-primary" data-testid="brief-send-planner">
              It goes to {manager.name}, the performance manager.
            </p>
          ) : managerKnownMissing ? (
            <p className="text-sm text-text-primary" data-testid="brief-send-no-planner">
              {NO_PERFORMANCE_MANAGER_TEXT}{" "}
              <Link to="/company/settings" className="underline">
                Open Company settings
              </Link>
            </p>
          ) : null}
          <Button type="button" onClick={() => !submit.isPending && submit.mutate()} aria-disabled={submit.isPending} data-testid="brief-submit">
            {submit.isPending ? "Sending…" : "Send to the planner"}
          </Button>
          {submitProblem ? (
            <div role="alert" className="space-y-1 rounded-md border border-danger-500/30 px-3 py-2 text-sm" data-testid="brief-submit-error">
              <p className="text-text-primary">{submitProblem.text}</p>
              {submitProblem.noManager ? (
                <p>
                  <Link to="/company/settings" className="underline" data-testid="brief-settings-link">
                    Choose a performance manager in Company settings
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <BriefDocument
        issueId={issueId}
        document={briefQuery.data ?? null}
        isLoading={briefQuery.isLoading}
        error={briefQuery.error}
        revisions={revisionsQuery.data ?? []}
      />

      <section aria-labelledby={`${uid}-plan`} className="space-y-3" data-testid="brief-plan">
        <h2 id={`${uid}-plan`} className="text-base font-semibold text-text-primary">
          The plan
        </h2>
        <ScenarioManifestView
          document={manifestQuery.data ?? null}
          isLoading={manifestQuery.isLoading}
          error={manifestQuery.error}
          agents={agents}
          briefIssueId={issueId}
          briefRevisions={revisionsQuery.data ?? []}
          currentBriefRevisionId={briefQuery.data?.latestRevisionId ?? null}
        />
      </section>
    </div>
  );
}

/** The brief itself, with its revisions. Editing writes a new revision against the one loaded; a stale one overwrites nothing. */
function BriefDocument({
  issueId,
  document,
  isLoading,
  error,
  revisions,
}: {
  issueId: string;
  document: IssueDocument | null;
  isLoading: boolean;
  error: unknown;
  revisions: Array<{ id: string; revisionNumber: number; createdAt: Date | string; changeSummary: string | null }>;
}) {
  const uid = useId();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [baseRevisionId, setBaseRevisionId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<IssueDocument | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const save = useMutation({
    mutationFn: (base: string | null) =>
      agentBriefsApi.saveBrief(issueId, { body: text, baseRevisionId: base, title: document?.title ?? null, changeSummary: "Brief edited" }),
    onSuccess: (saved) => {
      setConflict(null);
      setProblem(null);
      setEditing(false);
      setStatus(`Brief revision ${saved.latestRevisionNumber} saved. Saving doesn't wake anyone.`);
      queryClient.setQueryData(agentBriefQueryKeys.brief(issueId), saved);
      void queryClient.invalidateQueries({ queryKey: agentBriefQueryKeys.briefRevisions(issueId) });
    },
    onError: async (failure) => {
      setStatus("");
      if (failure instanceof ApiError && failure.status === 409) {
        try {
          const latest = await agentBriefsApi.brief(issueId);
          setConflict(latest);
          setProblem(null);
          queryClient.setQueryData(agentBriefQueryKeys.brief(issueId), latest);
          void queryClient.invalidateQueries({ queryKey: agentBriefQueryKeys.briefRevisions(issueId) });
          return;
        } catch {
          // fall through to the plain refusal
        }
      }
      setProblem(`${refusalText("save the brief", failure)} Your text is still here; nothing was saved.`);
    },
  });

  const headingId = `${uid}-brief`;
  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid="brief-document">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold text-text-primary">
          The brief
        </h2>
        {document && !editing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setText(document.body);
              setBaseRevisionId(document.latestRevisionId);
              setConflict(null);
              setProblem(null);
              setStatus("");
              setEditing(true);
            }}
            data-testid="brief-edit"
          >
            Edit the brief
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className={status ? "text-sm text-text-primary" : "sr-only"} data-testid="brief-document-status">
        {status}
      </p>
      {isLoading ? (
        <p role="status" className="text-sm text-text-secondary">
          Loading the brief…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-danger-500" data-testid="brief-document-error">
          Couldn't load the brief: {error instanceof Error ? error.message : "the server did not say why."}
        </p>
      ) : !document ? (
        <p className="text-sm text-text-secondary">This brief has no text.</p>
      ) : editing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (save.isPending) return;
            if (!text.trim()) {
              setProblem("The brief can't be empty. Nothing was saved.");
              return;
            }
            save.mutate(baseRevisionId);
          }}
        >
          <Label htmlFor={`${uid}-edit`}>The brief (Markdown)</Label>
          <Textarea id={`${uid}-edit`} value={text} rows={18} className="font-mono text-xs" onChange={(event) => setText(event.target.value)} data-testid="brief-edit-text" />
          {conflict ? (
            <div role="alert" className="space-y-2 rounded-md border border-warn-500/40 px-3 py-2 text-sm" data-testid="brief-conflict">
              <p className="font-medium text-text-primary">The brief changed since you opened it.</p>
              <p className="text-text-secondary">
                It is now revision {conflict.latestRevisionNumber}, saved {formatDateTime(conflict.updatedAt)}. Nothing was overwritten
                and your text is still here.
              </p>
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center">See the saved revision {conflict.latestRevisionNumber}</summary>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-secondary">{conflict.body}</pre>
              </details>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => !save.isPending && save.mutate(conflict.latestRevisionId)} data-testid="brief-conflict-keep-mine">
                  Save mine as the next revision
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setText(conflict.body);
                    setBaseRevisionId(conflict.latestRevisionId);
                    setConflict(null);
                    setStatus(`Loaded revision ${conflict.latestRevisionNumber}. Your unsaved text was discarded.`);
                  }}
                  data-testid="brief-conflict-use-saved"
                >
                  Use the saved revision
                </Button>
              </div>
            </div>
          ) : null}
          {problem ? (
            <p role="alert" className="text-sm text-danger-500" data-testid="brief-edit-error">
              {problem}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" aria-disabled={save.isPending} data-testid="brief-edit-save">
              {save.isPending ? "Saving…" : "Save a new revision"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-xs text-text-secondary" data-testid="brief-revision">
            Revision {document.latestRevisionNumber}, saved {formatDateTime(document.updatedAt)}.
          </p>
          <div className="rounded-md border border-border-soft px-4 py-3">
            <MarkdownBody linkIssueReferences={false}>{document.body}</MarkdownBody>
          </div>
        </>
      )}
      {revisions.length > 0 ? (
        <details className="text-sm" data-testid="brief-revisions">
          <summary className="flex min-h-11 cursor-pointer select-none items-center font-medium text-text-primary">
            Revision history ({revisions.length})
          </summary>
          <ol className="space-y-1 text-text-secondary">
            {revisions.map((revision) => (
              <li key={revision.id}>
                Revision {revision.revisionNumber}, {formatDateTime(revision.createdAt)}
                {revision.changeSummary ? ` — ${revision.changeSummary}` : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
