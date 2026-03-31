import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useState } from "react";
import {
  Building2, User, DollarSign, Clock, Bot, ArrowLeft,
  Activity, FileText, Users, Briefcase, ChevronRight,
  GitBranch, Link2, CheckCircle,
} from "lucide-react";

const STAGE_COLORS: Record<string, string> = {
  prospect: "bg-slate-100 text-slate-700",
  onboarding: "bg-blue-100 text-blue-700",
  active: "bg-emerald-100 text-emerald-700",
  at_risk: "bg-red-100 text-red-700",
  renewal: "bg-amber-100 text-amber-700",
  expansion: "bg-violet-100 text-violet-700",
  champion: "bg-teal-100 text-teal-700",
  churned: "bg-gray-100 text-gray-500",
};

const DEAL_STAGE_COLORS: Record<string, string> = {
  qualification: "bg-blue-100 text-blue-700",
  discovery: "bg-indigo-100 text-indigo-700",
  proposal: "bg-amber-100 text-amber-700",
  negotiation: "bg-orange-100 text-orange-700",
  contract_sent: "bg-violet-100 text-violet-700",
  closed_won: "bg-emerald-100 text-emerald-700",
  closed_lost: "bg-red-100 text-red-700",
};

type TabType = "overview" | "contacts" | "deals" | "timeline";

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
  // Fallback: match by substring for activity types
  if (type.includes("pipeline") || type.includes("agent")) return <Bot className="h-4 w-4 text-teal-600" />;
  if (type.includes("hubspot") || type.includes("sync")) return <Link2 className="h-4 w-4 text-orange-500" />;
  if (type.includes("note")) return <FileText className="h-4 w-4 text-blue-500" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
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

export function CrmAccountDetail() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const { accountId } = useParams<{ accountId: string }>();
  const [activeTab, setActiveTab] = useState<TabType>("overview");

  const { data: account, isLoading } = useQuery({
    queryKey: ["crm-account", accountId],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/accounts/${accountId}`); return r.json(); },
    enabled: !!cid && !!accountId,
  });

  const { data: contacts = [] } = useQuery({
    queryKey: ["crm-account-contacts", cid, accountId],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/contacts?accountId=${accountId}`); return r.json(); },
    enabled: !!cid && !!accountId,
  });

  const { data: deals = [] } = useQuery({
    queryKey: ["crm-account-deals", cid, accountId],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/deals?accountId=${accountId}`); return r.json(); },
    enabled: !!cid && !!accountId,
  });

  const { data: activities = [] } = useQuery({
    queryKey: ["crm-account-activities", cid, accountId],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/activities?accountId=${accountId}&limit=50`); return r.json(); },
    enabled: !!cid && !!accountId,
  });

  const { data: context } = useQuery({
    queryKey: ["crm-account-context", cid, accountId],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/accounts/${accountId}/context`); if (!r.ok) return null; return r.json(); },
    enabled: !!cid && !!accountId,
  });

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;
  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (!account) return <div className="p-6 text-muted-foreground">Account not found</div>;

  const stageColor = STAGE_COLORS[account.stage] ?? "bg-muted text-muted-foreground";
  const totalValueCents = deals.reduce((sum: number, d: any) => sum + (Number(d.amountCents) || 0), 0);
  const openDeals = deals.filter((d: any) => d.stage !== "closed_won" && d.stage !== "closed_lost");

  const tabs: { value: TabType; label: string; count?: number }[] = [
    { value: "overview", label: "Overview" },
    { value: "contacts", label: "Contacts", count: contacts.length },
    { value: "deals", label: "Deals", count: deals.length },
    { value: "timeline", label: "Timeline", count: activities.length },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Back link */}
      <Link to="/crm/accounts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-3.5 w-3.5" /> Accounts
      </Link>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="rounded-xl border bg-card p-3">
          <Building2 className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{account.name}</h1>
          <div className="flex items-center gap-3 mt-1">
            {account.stage && <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${stageColor}`}>{account.stage}</span>}
            {account.industry && <span className="text-sm text-muted-foreground">{account.industry}</span>}
            {account.domain && <span className="text-sm text-muted-foreground">{account.domain}</span>}
            {account.externalSource && <span className="text-xs text-muted-foreground">via {account.externalSource}</span>}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.value
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{tab.count}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* Key Metrics */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm text-muted-foreground">Lifetime Value</p>
              <p className="text-2xl font-bold mt-1">${(totalValueCents / 100).toLocaleString()}</p>
            </div>
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm text-muted-foreground">Open Deals</p>
              <p className="text-2xl font-bold mt-1">{openDeals.length}</p>
              {openDeals.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  ${(openDeals.reduce((s: number, d: any) => s + (Number(d.amountCents) || 0), 0) / 100).toLocaleString()}
                </p>
              )}
            </div>
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm text-muted-foreground">Contacts</p>
              <p className="text-2xl font-bold mt-1">{contacts.length}</p>
            </div>
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm text-muted-foreground">Activities</p>
              <p className="text-2xl font-bold mt-1">{activities.length}</p>
              {activities.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">Last: {formatRelative(activities[0]?.occurredAt ?? activities[0]?.createdAt)}</p>
              )}
            </div>
          </div>

          {/* Agent Metrics from context */}
          {context?.customerMetrics && (
            <div className="rounded-xl border bg-card p-5">
              <h3 className="text-sm font-semibold mb-3">Agent Context</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Avg Deal Size</p>
                  <p className="text-lg font-semibold">${(context.customerMetrics.avgDealSizeCents / 100).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Deal Count</p>
                  <p className="text-lg font-semibold">{context.customerMetrics.dealCount}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Last Activity</p>
                  <p className="text-lg font-semibold">{context.customerMetrics.lastActivityAt ? formatRelative(context.customerMetrics.lastActivityAt) : "None"}</p>
                </div>
              </div>
            </div>
          )}

          {/* Recent Timeline Preview */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Recent Activity</h3>
              <button onClick={() => setActiveTab("timeline")} className="text-xs text-primary hover:underline">View all</button>
            </div>
            <div className="space-y-0">
              {activities.slice(0, 5).map((a: any) => (
                <div key={a.id} className="flex items-start gap-3 py-2.5 border-b last:border-0">
                  <ActivityIcon type={a.activityType ?? ""} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">{a.subject ?? a.activityType}</p>
                    {a.body && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{a.body}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <SourceBadge source={(a.metadata as any)?.source ?? a.externalSource} />
                    <span className="text-xs text-muted-foreground">{formatRelative(a.occurredAt ?? a.createdAt)}</span>
                  </div>
                </div>
              ))}
              {activities.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No activities yet</p>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "contacts" && (
        <div>
          {contacts.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No contacts for this account.</div>
          ) : (
            <div className="space-y-2">
              {contacts.map((c: any) => (
                <div key={c.id} className="rounded-xl border bg-card p-4 flex items-center gap-4 hover:bg-muted/30 transition-colors">
                  <div className="rounded-full bg-muted p-2.5">
                    <User className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown"}</p>
                    <div className="flex gap-3 text-xs text-muted-foreground mt-0.5">
                      {c.email && <span>{c.email}</span>}
                      {c.phone && <span>{c.phone}</span>}
                      {c.title && <span>{c.title}</span>}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "deals" && (
        <div>
          {deals.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No deals for this account.</div>
          ) : (
            <div className="space-y-2">
              {deals.map((d: any) => {
                const sc = DEAL_STAGE_COLORS[d.stage] ?? "bg-muted text-muted-foreground";
                return (
                  <div key={d.id} className="rounded-xl border bg-card p-4 flex items-center gap-4 hover:bg-muted/30 transition-colors">
                    <div className="rounded-full bg-muted p-2.5">
                      <DollarSign className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="font-medium">{d.name}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${sc}`}>{d.stage ?? "—"}</span>
                        {d.amountCents && <span className="text-sm font-semibold">${(Number(d.amountCents) / 100).toLocaleString()}</span>}
                        {d.closeDate && <span className="text-xs text-muted-foreground">Close: {new Date(d.closeDate).toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === "timeline" && (
        <div>
          {activities.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No activities recorded yet.</div>
          ) : (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-[19px] top-0 bottom-0 w-px bg-border" />

              <div className="space-y-0">
                {activities.map((a: any, i: number) => {
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
                            {a.body && <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{a.body}</p>}

                            {/* Agent evidence (if present) */}
                            {(a.metadata as any)?.evidence && (
                              <div className="mt-2 rounded-lg border bg-muted/30 p-3 text-xs space-y-1">
                                <p className="font-medium text-muted-foreground">Evidence</p>
                                {Object.entries((a.metadata as any).evidence).map(([k, v]) => (
                                  <p key={k}><span className="font-medium">{k}:</span> {typeof v === "object" ? JSON.stringify(v) : String(v)}</p>
                                ))}
                              </div>
                            )}

                            {/* Amount if present */}
                            {(a.metadata as any)?.amountCents && (
                              <p className="text-sm font-semibold text-emerald-600 mt-1">
                                ${(Number((a.metadata as any).amountCents) / 100).toLocaleString()}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <SourceBadge source={source} />
                            <span className="text-xs text-muted-foreground whitespace-nowrap">{formatRelative(a.occurredAt ?? a.createdAt)}</span>
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
      )}
    </div>
  );
}
