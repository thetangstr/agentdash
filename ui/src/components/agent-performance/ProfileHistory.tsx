import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentProfileRevisionSummary } from "@paperclipai/shared";
import { agentProfileQueryKeys, agentProfilesApi } from "@/api/agent-profiles";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { EmptyNote, Section, ViewStatus } from "./shared";
import { ProfileDiffList, REVISION_STATE_TEXT } from "./profile-shared";
import { ManagerFiledBadge, isManagerFiledRevision } from "./manager-shared";

// AgentDash: Agent Performance Management gate 2 — revision history. Profiles
// are never reset: each change is a new revision, kept with its state. Each
// row can be compared with the active profile (or, before any is applied,
// with revision 0 derived from today's records) and exported as Markdown.
// Gate 4: a revision the company's performance manager proposed is marked
// "Proposed by the performance manager", from the revision's own
// `proposedByCapacity` (the server reads it from the approval's payload), so
// no approval is fetched per row.

function authorText(revision: AgentProfileRevisionSummary): string {
  if (revision.createdByUserId) return `a person (${revision.createdByUserId})`;
  if (revision.createdByAgentId) return `an agent (${revision.createdByAgentId.slice(0, 8)})`;
  return "unknown";
}

function RevisionDiff({ companyId, agentId, revision }: { companyId: string; agentId: string; revision: AgentProfileRevisionSummary }) {
  const query = useQuery({
    queryKey: agentProfileQueryKeys.diff(companyId, agentId, revision.id, "active"),
    queryFn: () => agentProfilesApi.diff(companyId, agentId, revision.id, "active"),
    retry: false,
  });
  if (!query.data) return <ViewStatus what="comparison" isLoading={query.isLoading} error={query.error} />;
  return (
    <ProfileDiffList
      diff={query.data.diff}
      beforeLabel="Active"
      afterLabel={`Revision ${revision.revisionNumber}`}
      emptyText="Same as the active profile."
      testId={`agent-profile-history-diff-${revision.revisionNumber}`}
    />
  );
}

export function ProfileHistory({
  companyId,
  agentId,
  activeRevisionId,
}: {
  companyId: string;
  agentId: string;
  activeRevisionId: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: agentProfileQueryKeys.revisions(companyId, agentId),
    queryFn: () => agentProfilesApi.revisions(companyId, agentId),
    retry: false,
  });
  return (
    <Section
      id="agent-profile-history"
      title="Revision history"
      description="Every revision is kept. Evidence stays attached to the revision it was observed under."
    >
      {!query.data ? (
        <ViewStatus what="revision history" isLoading={query.isLoading} error={query.error} />
      ) : query.data.length === 0 ? (
        <EmptyNote>No revisions yet.</EmptyNote>
      ) : (
        <ol className="space-y-2">
          {[...query.data]
            .sort((a, b) => b.revisionNumber - a.revisionNumber)
            .map((revision) => {
              const open = openId === revision.id;
              const isActive = revision.id === activeRevisionId;
              const regionId = `agent-profile-history-${revision.id}`;
              return (
                <li key={revision.id} className="rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-profile-history-row">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-text-primary">
                      <span className="font-medium">Revision {revision.revisionNumber}</span> · {REVISION_STATE_TEXT[revision.state]}
                      {isActive && revision.state !== "applied" ? " · active" : ""}
                      {isManagerFiledRevision(revision) ? (
                        <span className="ml-2 inline-block align-middle">
                          <ManagerFiledBadge testId="agent-profile-history-manager-filed" />
                        </span>
                      ) : null}
                      <span className="block text-xs text-text-secondary">
                        Created {formatDateTime(revision.createdAt)} by {authorText(revision)}; updated {formatDateTime(revision.updatedAt)}
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {!isActive ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-expanded={open}
                          aria-controls={regionId}
                          onClick={() => setOpenId(open ? null : revision.id)}
                        >
                          {open ? "Hide comparison" : "Compare with active"}
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" asChild>
                        <a
                          href={agentProfilesApi.exportMarkdownUrl(companyId, agentId, revision.id)}
                          download={`profile-revision-${revision.revisionNumber}.md`}
                        >
                          Export Markdown
                        </a>
                      </Button>
                    </div>
                  </div>
                  {open ? (
                    <div id={regionId} className="mt-2">
                      <RevisionDiff companyId={companyId} agentId={agentId} revision={revision} />
                    </div>
                  ) : null}
                </li>
              );
            })}
        </ol>
      )}
    </Section>
  );
}
