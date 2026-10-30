import { useEffect, useMemo } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { listUIAdapters } from "../adapters";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { AgentBriefView } from "../components/agent-performance/AgentBriefView";
import { StartFromBrief } from "../components/agent-performance/StartFromBrief";
import { UnboundDraftView } from "../components/agent-performance/UnboundDraftView";

// AgentDash: Agent Performance Management gate 5 (P5.2) — start from a brief.
//   /agents/new/brief          paste or upload a brief and save it (wakes no one)
//   /agents/briefs/:issueId    the brief, "Send to the planner", and the planner's plan
//   /agents/drafts/:profileId  a draft profile for a new role: four steps, then Request hire
// One UX for every company: no product-profile branches here.

function NoCompany() {
  return <p className="text-sm text-text-secondary">Choose a company first.</p>;
}

export function NewAgentFromBrief() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  useEffect(() => {
    setBreadcrumbs([{ label: "Team", href: "/agents" }, { label: "New Agent", href: "/agents/new" }, { label: "Start from a brief" }]);
  }, [setBreadcrumbs]);
  if (!selectedCompanyId) return <NoCompany />;
  return (
    <StartFromBrief
      companyId={selectedCompanyId}
      onSaved={(result) => navigate(`/agents/briefs/${result.issueId}`, { state: { briefSaved: true } })}
    />
  );
}

export function AgentBriefPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { issueId } = useParams<{ issueId: string }>();
  const location = useLocation();
  const justSaved = Boolean((location.state as { briefSaved?: boolean } | null)?.briefSaved);
  useEffect(() => {
    setBreadcrumbs([{ label: "Team", href: "/agents" }, { label: "Start from a brief", href: "/agents/new/brief" }, { label: "Brief" }]);
  }, [setBreadcrumbs]);
  if (!selectedCompanyId) return <NoCompany />;
  if (!issueId) return null;
  return <AgentBriefView key={issueId} companyId={selectedCompanyId} issueId={issueId} justSaved={justSaved} />;
}

export function AgentDraftProfilePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { profileId } = useParams<{ profileId: string }>();
  const [searchParams] = useSearchParams();
  const briefIssueId = searchParams.get("brief");
  const disabledAdapters = useDisabledAdaptersSync();
  const adapterOptions = useMemo(
    () =>
      listUIAdapters()
        .filter((adapter) => !disabledAdapters.has(adapter.type))
        .map((adapter) => ({ value: adapter.type, label: adapter.label })),
    [disabledAdapters],
  );
  useEffect(() => {
    setBreadcrumbs([
      { label: "Team", href: "/agents" },
      ...(briefIssueId ? [{ label: "Brief", href: `/agents/briefs/${briefIssueId}` }] : []),
      { label: "Draft profile" },
    ]);
  }, [setBreadcrumbs, briefIssueId]);
  if (!selectedCompanyId) return <NoCompany />;
  if (!profileId) return null;
  return (
    <UnboundDraftView
      key={profileId}
      companyId={selectedCompanyId}
      profileId={profileId}
      adapterOptions={adapterOptions}
      briefIssueId={briefIssueId}
    />
  );
}
