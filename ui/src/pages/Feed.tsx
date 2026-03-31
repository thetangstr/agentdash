import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { AlertTriangle, CheckCircle2, Clock, Bot, FileText, ChevronRight } from "lucide-react";

const URGENCY_STYLES = {
  blocked: { border: "border-l-red-500", bg: "bg-red-50", icon: AlertTriangle, iconColor: "text-red-500", label: "Blocked" },
  needs_decision: { border: "border-l-amber-500", bg: "bg-amber-50", icon: Clock, iconColor: "text-amber-500", label: "Needs Decision" },
  active: { border: "border-l-blue-500", bg: "bg-blue-50", icon: FileText, iconColor: "text-blue-500", label: "Active" },
  informational: { border: "border-l-slate-300", bg: "bg-muted/30", icon: Bot, iconColor: "text-muted-foreground", label: "Update" },
};

const STATUS_COLORS: Record<string, string> = {
  backlog: "bg-slate-100 text-slate-600",
  todo: "bg-blue-100 text-blue-700",
  in_progress: "bg-indigo-100 text-indigo-700",
  in_review: "bg-amber-100 text-amber-700",
  blocked: "bg-red-100 text-red-700",
  done: "bg-emerald-100 text-emerald-700",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "text-red-600",
  high: "text-orange-600",
  medium: "text-slate-600",
  low: "text-slate-400",
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

export function Feed() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["feed", cid],
    queryFn: async () => {
      const r = await fetch(`/api/companies/${cid}/feed`);
      if (!r.ok) return { items: [], counts: { blocked: 0, needsDecision: 0, active: 0, informational: 0, total: 0 } };
      return r.json();
    },
    enabled: !!cid,
    refetchInterval: 30_000,
  });

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  const items = data?.items ?? [];
  const counts = data?.counts ?? { blocked: 0, needsDecision: 0, active: 0, informational: 0, total: 0 };

  const attention = items.filter((i: any) => i.urgencyTier === "blocked" || i.urgencyTier === "needs_decision");
  const active = items.filter((i: any) => i.urgencyTier === "active");
  const updates = items.filter((i: any) => i.urgencyTier === "informational");

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Your Feed</h1>
        <p className="text-sm text-muted-foreground mt-1">{today} — {selectedCompany?.name}</p>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">Loading your feed...</div>
      ) : counts.total === 0 ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <p className="font-semibold text-emerald-900">All clear</p>
            <p className="text-sm text-emerald-700">Nothing needs your attention right now.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Needs Attention */}
          {attention.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Needs Attention ({counts.blocked + counts.needsDecision})
              </h2>
              <div className="space-y-2">
                {attention.map((item: any) => (
                  <FeedCard key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}

          {/* Active Work */}
          {active.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Active Work ({counts.active})
              </h2>
              <div className="space-y-2">
                {active.map((item: any) => (
                  <FeedCard key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}

          {/* Agent Updates */}
          {updates.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Agent Updates ({counts.informational})
              </h2>
              <div className="space-y-1">
                {updates.map((item: any) => (
                  <FeedActivityRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FeedCard({ item }: { item: any }) {
  const style = URGENCY_STYLES[item.urgencyTier as keyof typeof URGENCY_STYLES] ?? URGENCY_STYLES.informational;
  const Icon = style.icon;

  if (item.kind === "approval_pending" && item.approval) {
    const a = item.approval;
    return (
      <Link to={`/approvals/${a.id}`} className="block">
        <div className={`rounded-xl border border-l-4 ${style.border} bg-card p-4 hover:bg-muted/30 transition-colors`}>
          <div className="flex items-start gap-3">
            <Icon className={`h-5 w-5 ${style.iconColor} shrink-0 mt-0.5`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                  {a.type === "action_proposal" ? "Action Proposal" : a.type === "hire_agent" ? "Hire Agent" : a.type}
                </span>
                <span className="text-xs text-muted-foreground">{formatRelative(item.timestamp)}</span>
              </div>
              <p className="text-sm font-medium mt-1">
                {a.type === "action_proposal"
                  ? `${a.payload?.actionType ?? "Action"}: ${a.payload?.summary ?? "Review required"}`
                  : `Approval: ${a.type}`}
              </p>
              {a.payload?.amountCents && (
                <p className="text-sm font-semibold text-emerald-600 mt-0.5">
                  ${(Number(a.payload.amountCents) / 100).toLocaleString()}
                </p>
              )}
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </div>
        </div>
      </Link>
    );
  }

  // Issue-based card
  const issue = item.issue;
  if (!issue) return null;

  const statusColor = STATUS_COLORS[issue.status] ?? "bg-muted text-muted-foreground";
  const prioColor = PRIORITY_COLORS[issue.priority] ?? "text-slate-600";

  return (
    <Link to={`/issues/${issue.identifier}`} className="block">
      <div className={`rounded-xl border border-l-4 ${style.border} bg-card p-4 hover:bg-muted/30 transition-colors`}>
        <div className="flex items-start gap-3">
          <Icon className={`h-5 w-5 ${style.iconColor} shrink-0 mt-0.5`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-muted-foreground">{issue.identifier}</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor}`}>{issue.status}</span>
              <span className={`text-xs font-medium ${prioColor}`}>{issue.priority}</span>
              {item.kind === "issue_created_by_me" && (
                <span className="text-xs text-muted-foreground">created by you</span>
              )}
            </div>
            <p className="text-sm font-medium mt-1">{issue.title}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">{formatRelative(item.timestamp)}</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </div>
    </Link>
  );
}

function FeedActivityRow({ item }: { item: any }) {
  if (item.kind === "agent_activity" && item.agentActivity) {
    const a = item.agentActivity;
    return (
      <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors">
        <Bot className="h-4 w-4 text-teal-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm">
            <span className="font-medium text-teal-700">{a.agentName}</span>
            {" "}{a.action.replace(".", " ").replace("_", " ")}
          </p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{formatRelative(item.timestamp)}</span>
      </div>
    );
  }

  // Updated issue row
  const issue = item.issue;
  if (!issue) return null;
  return (
    <Link to={`/issues/${issue.identifier}`} className="block">
      <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm">
            <span className="font-mono text-xs text-muted-foreground mr-1">{issue.identifier}</span>
            {issue.title}
          </p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{formatRelative(item.timestamp)}</span>
      </div>
    </Link>
  );
}
