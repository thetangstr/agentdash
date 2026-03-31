import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { UserPlus, Search, ArrowRightLeft, X } from "lucide-react";
import { useState, useMemo, useCallback } from "react";

const STATUS_COLORS: Record<string, string> = {
  new: "bg-blue-100 text-blue-700",
  contacted: "bg-indigo-100 text-indigo-700",
  qualified: "bg-violet-100 text-violet-700",
  converted: "bg-emerald-100 text-emerald-700",
  lost: "bg-red-100 text-red-700",
};

const STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;

export function CrmLeads() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [convertingLeadId, setConvertingLeadId] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const { data: leads = [], isLoading } = useQuery({
    queryKey: ["crm-leads", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/leads`); return r.json(); },
    enabled: !!cid,
  });

  const convertMutation = useMutation({
    mutationFn: async (leadId: string) => {
      const r = await fetch(`/api/companies/${cid}/crm/leads/${leadId}/convert`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: "Conversion failed" }));
        throw new Error(err.message ?? "Conversion failed");
      }
      return r.json();
    },
    onSuccess: (_data, leadId) => {
      queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
      queryClient.invalidateQueries({ queryKey: ["crm-accounts"] });
      setConvertingLeadId(null);
      const lead = (leads as any[]).find((l) => l.id === leadId);
      const name = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") : "Lead";
      setSuccessMessage(`${name} has been converted to an account.`);
      setTimeout(() => setSuccessMessage(null), 4000);
    },
    onError: () => {
      setConvertingLeadId(null);
    },
  });

  const handleConvert = useCallback((leadId: string) => {
    convertMutation.mutate(leadId);
  }, [convertMutation]);

  const filtered = useMemo(() => {
    let result = leads as any[];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) =>
        [l.firstName, l.lastName].filter(Boolean).join(" ").toLowerCase().includes(q) ||
        l.email?.toLowerCase().includes(q) ||
        l.company?.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== "all") {
      result = result.filter((l) => l.status === statusFilter);
    }
    return result;
  }, [leads, search, statusFilter]);

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm text-muted-foreground mt-1">{(leads as any[]).length} leads</p>
        </div>
      </div>

      {/* Success banner */}
      {successMessage && (
        <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span>{successMessage}</span>
          <button onClick={() => setSuccessMessage(null)} className="text-emerald-600 hover:text-emerald-800">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, email, or company..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border bg-background pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">Loading leads...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center space-y-3">
          <UserPlus className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <div>
            <p className="font-medium text-muted-foreground">
              {search || statusFilter !== "all" ? "No leads match your filters" : "No leads yet"}
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {search || statusFilter !== "all" ? "Try adjusting your search or filters." : "Create your first lead or sync from HubSpot."}
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Name</th>
                <th className="text-left p-3 font-medium">Company</th>
                <th className="text-left p-3 font-medium">Email</th>
                <th className="text-left p-3 font-medium">Source</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-right p-3 font-medium">Score</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((l: any) => {
                const fullName = [l.firstName, l.lastName].filter(Boolean).join(" ") || "Unknown";
                const statusColor = STATUS_COLORS[l.status] ?? "bg-muted text-muted-foreground";
                const isConverted = l.status === "converted";
                const isLost = l.status === "lost";
                return (
                  <tr key={l.id} className="hover:bg-muted/30">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <UserPlus className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="font-medium">{fullName}</span>
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground">{l.company ?? "--"}</td>
                    <td className="p-3 text-muted-foreground">{l.email ?? "--"}</td>
                    <td className="p-3 text-xs text-muted-foreground">{l.source ?? "--"}</td>
                    <td className="p-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor}`}>
                        {l.status ?? "--"}
                      </span>
                    </td>
                    <td className="p-3 text-right font-medium">{l.score != null ? l.score : "--"}</td>
                    <td className="p-3 text-right">
                      {!isConverted && !isLost && (
                        <button
                          onClick={() => setConvertingLeadId(l.id)}
                          className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-muted/50 transition-colors"
                        >
                          <ArrowRightLeft className="h-3.5 w-3.5" />
                          Convert
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Conversion confirmation modal */}
      {convertingLeadId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-xl border bg-card p-6 shadow-lg max-w-md w-full mx-4 space-y-4">
            <h2 className="text-lg font-semibold">Convert Lead to Account</h2>
            <p className="text-sm text-muted-foreground">
              Are you sure you want to convert{" "}
              <span className="font-medium text-foreground">
                {(() => {
                  const lead = (leads as any[]).find((l) => l.id === convertingLeadId);
                  return lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "this lead" : "this lead";
                })()}
              </span>{" "}
              to an account? This will create a new CRM account from this lead's information.
            </p>
            {convertMutation.isError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {convertMutation.error?.message ?? "Conversion failed. Please try again."}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConvertingLeadId(null)}
                disabled={convertMutation.isPending}
                className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleConvert(convertingLeadId)}
                disabled={convertMutation.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {convertMutation.isPending ? "Converting..." : "Convert to Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
