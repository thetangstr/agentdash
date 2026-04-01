import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import {
  Scale,
  CheckCircle2,
  XCircle,
  ChevronDown,
  DollarSign,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
  Gift,
  CreditCard,
  ArrowUpRight,
  Percent,
  UserCog,
  MessageSquare,
  Wrench,
} from "lucide-react";

// AgentDash: Action Proposals approval queue (AGE-11)

type StatusFilter = "pending" | "approved" | "rejected" | "all";

const STATUS_BADGES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
};

const ACTION_TYPE_ICONS: Record<string, typeof Scale> = {
  refund: RotateCcw,
  replacement: Gift,
  credit: CreditCard,
  escalation: ArrowUpRight,
  discount: Percent,
  account_action: UserCog,
  communication: MessageSquare,
  custom: Wrench,
};

interface Proposal {
  id: string;
  type: string;
  status: string;
  payload: {
    actionType?: string;
    summary?: string;
    amountCents?: number;
    currency?: string;
    confidenceScore?: number;
    evidence?: Record<string, unknown>;
    crmAccountId?: string;
    crmContactId?: string;
    [key: string]: unknown;
  };
  requestedByAgentId?: string | null;
  decisionNote?: string | null;
  createdAt: string;
}

export function ActionProposals() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(new Set());

  const { data: proposals = [], isLoading } = useQuery<Proposal[]>({
    queryKey: ["action-proposals", cid, statusFilter],
    queryFn: async () => {
      const params = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const res = await fetch(`/api/companies/${cid}/action-proposals${params}`);
      return res.json();
    },
    enabled: !!cid,
  });

  const approveMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/approvals/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Failed to approve proposal");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["action-proposals"] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/approvals/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Failed to reject proposal");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["action-proposals"] });
    },
  });

  function toggleEvidence(id: string) {
    setExpandedEvidence((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  const tabs: { value: StatusFilter; label: string }[] = [
    { value: "pending", label: "Pending" },
    { value: "approved", label: "Approved" },
    { value: "rejected", label: "Rejected" },
    { value: "all", label: "All" },
  ];

  const pendingCount = statusFilter === "all"
    ? proposals.filter((p) => p.status === "pending").length
    : statusFilter === "pending"
      ? proposals.length
      : 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Action Proposals</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Agent-proposed operational actions requiring human approval
          </p>
        </div>
        {pendingCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-700 px-3 py-1 text-sm font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            {pendingCount} pending
          </span>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 rounded-lg bg-muted/50 p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusFilter(tab.value)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === tab.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
          Loading proposals...
        </div>
      ) : proposals.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center space-y-3">
          <ShieldCheck className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <div>
            <p className="font-medium text-muted-foreground">
              {statusFilter === "pending"
                ? "No proposals pending"
                : statusFilter === "approved"
                  ? "No approved proposals"
                  : statusFilter === "rejected"
                    ? "No rejected proposals"
                    : "No action proposals yet"}
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {statusFilter === "pending"
                ? "Agents are working within policy limits"
                : "Proposals will appear here when agents request operational actions."}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          {proposals.map((proposal) => {
            const payload = proposal.payload ?? {};
            const actionType = payload.actionType ?? "unknown";
            const IconComponent = ACTION_TYPE_ICONS[actionType] ?? Scale;
            const statusColor = STATUS_BADGES[proposal.status] ?? "bg-muted text-muted-foreground";
            const evidence = payload.evidence ?? {};
            const evidenceEntries = Object.entries(evidence);
            const isEvidenceExpanded = expandedEvidence.has(proposal.id);
            const isPending = proposal.status === "pending";
            const confidenceScore = payload.confidenceScore;
            const amountCents = payload.amountCents;

            return (
              <div
                key={proposal.id}
                className="rounded-xl border bg-card p-5 space-y-4"
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="rounded-lg bg-muted/50 p-2 shrink-0">
                      <IconComponent className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold capitalize">
                          {actionType.replace(/_/g, " ")}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor}`}>
                          {proposal.status}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {payload.summary ?? "No summary provided"}
                      </p>
                    </div>
                  </div>

                  {/* Amount */}
                  {amountCents != null && amountCents > 0 && (
                    <div className="flex items-center gap-1.5 shrink-0 text-right">
                      <DollarSign className="h-4 w-4 text-muted-foreground" />
                      <span className="text-lg font-bold">
                        ${(amountCents / 100).toLocaleString()}
                      </span>
                      {payload.currency && payload.currency !== "USD" && (
                        <span className="text-xs text-muted-foreground">{payload.currency}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Confidence bar */}
                {confidenceScore != null && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Confidence</span>
                      <span className="font-medium">{Math.round(confidenceScore * 100)}%</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full transition-all ${
                          confidenceScore >= 0.8
                            ? "bg-emerald-500"
                            : confidenceScore >= 0.5
                              ? "bg-amber-500"
                              : "bg-red-500"
                        }`}
                        style={{ width: `${Math.round(confidenceScore * 100)}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* CRM links */}
                {(payload.crmAccountId || payload.crmContactId) && (
                  <div className="flex gap-3 text-xs">
                    {payload.crmAccountId && (
                      <Link
                        to={`/crm/accounts/${payload.crmAccountId}`}
                        className="text-primary hover:underline"
                      >
                        View CRM Account
                      </Link>
                    )}
                    {payload.crmContactId && (
                      <span className="text-muted-foreground">
                        Contact: {payload.crmContactId.slice(0, 8)}...
                      </span>
                    )}
                  </div>
                )}

                {/* Evidence packet (collapsible) */}
                {evidenceEntries.length > 0 && (
                  <div>
                    <button
                      onClick={() => toggleEvidence(proposal.id)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${isEvidenceExpanded ? "rotate-0" : "-rotate-90"}`}
                      />
                      Evidence ({evidenceEntries.length} fields)
                    </button>
                    {isEvidenceExpanded && (
                      <div className="mt-2 rounded-lg bg-muted/30 border p-3 space-y-1.5">
                        {evidenceEntries.map(([key, value]) => (
                          <div key={key} className="flex gap-2 text-xs">
                            <span className="font-medium text-muted-foreground min-w-[100px] shrink-0">
                              {key}
                            </span>
                            <span className="text-foreground break-all">
                              {typeof value === "object" ? JSON.stringify(value) : String(value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Metadata row */}
                <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
                  <div className="flex items-center gap-3">
                    {proposal.requestedByAgentId && (
                      <span>Agent: {proposal.requestedByAgentId.slice(0, 8)}...</span>
                    )}
                    <span>{new Date(proposal.createdAt).toLocaleString()}</span>
                  </div>

                  {/* Approve / Reject buttons */}
                  {isPending && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => rejectMutation.mutate(proposal.id)}
                        disabled={rejectMutation.isPending || approveMutation.isPending}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Reject
                      </button>
                      <button
                        onClick={() => approveMutation.mutate(proposal.id)}
                        disabled={approveMutation.isPending || rejectMutation.isPending}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Approve
                      </button>
                    </div>
                  )}

                  {/* Decision note for resolved proposals */}
                  {!isPending && proposal.decisionNote && (
                    <span className="italic">"{proposal.decisionNote}"</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
