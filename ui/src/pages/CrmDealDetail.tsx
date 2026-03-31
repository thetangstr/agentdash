import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import {
  Briefcase, ArrowLeft, DollarSign, Calendar, User, Building2, MessageSquare,
  Clock, Bot, Link2, FileText, CheckCircle, GitBranch,
} from "lucide-react";

const STAGE_META: Record<string, { label: string; color: string }> = {
  new: { label: "New", color: "bg-blue-100 text-blue-700" },
  contacted: { label: "Contacted", color: "bg-indigo-100 text-indigo-700" },
  qualified: { label: "Qualified", color: "bg-violet-100 text-violet-700" },
  proposal: { label: "Proposal", color: "bg-amber-100 text-amber-700" },
  negotiation: { label: "Negotiation", color: "bg-orange-100 text-orange-700" },
  closed_won: { label: "Won", color: "bg-emerald-100 text-emerald-700" },
  closed_lost: { label: "Lost", color: "bg-red-100 text-red-700" },
};

function formatRelative(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function ActivityIcon({ type }: { type: string }) {
  if (type === "agentdash_auto_approved") return <CheckCircle className="h-4 w-4 text-emerald-500" />;
  if (type === "agentdash_pipeline") return <GitBranch className="h-4 w-4 text-violet-500" />;
  if (type === "agentdash_action_proposal" || type === "agentdash_issue_completion") return <Bot className="h-4 w-4 text-teal-600" />;
  if (type === "hubspot_sync") return <Link2 className="h-4 w-4 text-orange-500" />;
  if (type === "agentdash_manual") return <User className="h-4 w-4 text-slate-500" />;
  if (type.includes("pipeline") || type.includes("agent")) return <Bot className="h-4 w-4 text-teal-600" />;
  if (type.includes("hubspot") || type.includes("sync")) return <Link2 className="h-4 w-4 text-orange-500" />;
  if (type.includes("note")) return <FileText className="h-4 w-4 text-blue-500" />;
  return <MessageSquare className="h-4 w-4 text-muted-foreground" />;
}

function SourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  if (source === "agentdash_auto_approved") {
    return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-[10px] font-medium"><CheckCircle className="h-3 w-3" />Auto-approved</span>;
  }
  if (source === "agentdash_pipeline") {
    return <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 text-violet-700 px-2 py-0.5 text-[10px] font-medium"><GitBranch className="h-3 w-3" />Pipeline</span>;
  }
  if (source === "agentdash_action_proposal" || source === "agentdash_issue_completion" || source.includes("agent")) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 text-teal-700 px-2 py-0.5 text-[10px] font-medium"><Bot className="h-3 w-3" />Agent</span>;
  }
  if (source === "hubspot_sync" || source.includes("hubspot")) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 text-orange-700 px-2 py-0.5 text-[10px] font-medium"><Link2 className="h-3 w-3" />HubSpot</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-[10px] font-medium"><User className="h-3 w-3" />Manual</span>;
}

export function CrmDealDetail() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const { dealId } = useParams<{ dealId: string }>();

  const { data: deal, isLoading } = useQuery({
    queryKey: ["crm-deal", dealId],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/deals/${dealId}`); return r.json(); },
    enabled: !!cid && !!dealId,
  });

  const { data: account } = useQuery({
    queryKey: ["crm-account", deal?.accountId],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/accounts/${deal.accountId}`); return r.json(); },
    enabled: !!cid && !!deal?.accountId,
  });

  const { data: activities = [] } = useQuery({
    queryKey: ["crm-deal-activities", cid, dealId],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/activities?dealId=${dealId}`); return r.json(); },
    enabled: !!cid && !!dealId,
  });

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;
  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (!deal) return <div className="p-6 text-muted-foreground">Deal not found</div>;

  const stageMeta = STAGE_META[deal.stage] ?? { label: deal.stage ?? "Unknown", color: "bg-muted text-muted-foreground" };

  return (
    <div className="p-6 space-y-6">
      {/* Back link */}
      <Link
        to="/crm"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Pipeline
      </Link>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="rounded-xl border bg-card p-3">
          <Briefcase className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{deal.name}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${stageMeta.color}`}>
              {stageMeta.label}
            </span>
            {deal.amountCents && (
              <span className="text-lg font-semibold">
                ${(Number(deal.amountCents) / 100).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Deal Info */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold">Deal Information</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex items-start gap-3">
            <DollarSign className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Amount</p>
              <p className="text-sm font-medium">
                {deal.amountCents ? `$${(Number(deal.amountCents) / 100).toLocaleString()}` : "Not set"}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Briefcase className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Stage</p>
              <p className="text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stageMeta.color}`}>
                  {stageMeta.label}
                </span>
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Close Date</p>
              <p className="text-sm font-medium">
                {deal.closeDate ? new Date(deal.closeDate).toLocaleDateString() : "Not set"}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <DollarSign className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Probability</p>
              <p className="text-sm font-medium">
                {deal.probability != null ? `${deal.probability}%` : "Not set"}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <User className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Owner</p>
              <p className="text-sm font-medium">{deal.ownerName ?? deal.ownerId ?? "Unassigned"}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Account</p>
              {deal.accountId && account ? (
                <Link
                  to={`/crm/accounts/${deal.accountId}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {account.name}
                </Link>
              ) : (
                <p className="text-sm font-medium text-muted-foreground">No account linked</p>
              )}
            </div>
          </div>
        </div>
        {deal.description && (
          <div className="pt-3 border-t">
            <p className="text-xs text-muted-foreground mb-1">Description</p>
            <p className="text-sm whitespace-pre-wrap">{deal.description}</p>
          </div>
        )}
      </div>

      {/* Activity Timeline */}
      <div>
        <h2 className="text-sm font-semibold mb-3">Activity Timeline</h2>
        {activities.length === 0 ? (
          <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
            No activities recorded for this deal.
          </div>
        ) : (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-[19px] top-0 bottom-0 w-px bg-border" />

            <div className="space-y-0">
              {activities.map((a: any) => {
                const source = (a.metadata as any)?.source ?? a.externalSource ?? "manual";
                return (
                  <div key={a.id} className="relative flex items-start gap-4 py-3">
                    {/* Timeline dot */}
                    <div className="relative z-10 rounded-full border-2 border-background bg-card p-1.5 shrink-0">
                      <ActivityIcon type={a.activityType ?? source ?? ""} />
                    </div>

                    <div className="flex-1 min-w-0 pt-0.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{a.subject ?? a.activityType}</p>
                          {a.body && (
                            <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                              {a.body}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <SourceBadge source={source} />
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatRelative(a.occurredAt ?? a.createdAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
