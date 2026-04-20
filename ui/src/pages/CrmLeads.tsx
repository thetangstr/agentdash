// AgentDash: CrmLeads page — CUJ-A sales pipeline entry point
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Plus, ArrowRightCircle, Trash2 } from "lucide-react";
import { crmApi, type CrmLead, type NewLead } from "../api/crm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relativeTime } from "../lib/utils";

const LEAD_STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "qualified", label: "Qualified" },
  { value: "converted", label: "Converted" },
  { value: "disqualified", label: "Disqualified" },
];

function fullName(lead: CrmLead): string {
  const parts = [lead.firstName, lead.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "—";
}

function statusChipClass(status: string): string {
  switch (status) {
    case "qualified":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "converted":
      return "bg-green-500/10 text-green-600 dark:text-green-400";
    case "disqualified":
      return "bg-muted text-muted-foreground";
    case "new":
    default:
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
}

interface NewLeadFormState {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  phone: string;
  source: string;
}

const EMPTY_FORM: NewLeadFormState = {
  firstName: "",
  lastName: "",
  email: "",
  company: "",
  phone: "",
  source: "",
};

export function CrmLeads() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formState, setFormState] = useState<NewLeadFormState>(EMPTY_FORM);

  useEffect(() => {
    setBreadcrumbs([{ label: "Leads" }]);
  }, [setBreadcrumbs]);

  const queryKey = ["crm-leads", selectedCompanyId ?? "_none_"] as const;

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => crmApi.listLeads(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (body: NewLead) => crmApi.createLead(selectedCompanyId!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setDialogOpen(false);
      setFormState(EMPTY_FORM);
      pushToast({ tone: "success", title: "Lead created" });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Failed to create lead",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const convertMutation = useMutation({
    mutationFn: (id: string) => crmApi.convertLead(selectedCompanyId!, id),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey });
      pushToast({ tone: "success", title: "Lead converted" });
      const accountId = updated.convertedAccountId;
      if (accountId) {
        navigate(`/crm/accounts/${accountId}`);
      } else {
        navigate(`/crm/pipeline`);
      }
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Failed to convert lead",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  // No DELETE route exists for leads. Soft-delete via PATCH status=disqualified.
  const disqualifyMutation = useMutation({
    mutationFn: (id: string) =>
      crmApi.updateLead(selectedCompanyId!, id, { status: "disqualified" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      pushToast({ tone: "success", title: "Lead disqualified" });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Failed to update lead",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const needle = search.trim().toLowerCase();
    return rows.filter((lead) => {
      if (statusFilter !== "all" && lead.status !== statusFilter) return false;
      if (!needle) return true;
      const hay = [fullName(lead), lead.email ?? ""].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [data, search, statusFilter]);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-6">Select a company first.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Pre-qualification contacts awaiting triage or conversion into accounts.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Lead
        </Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          data-testid="leads-search"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email"
          className="h-8 w-full sm:max-w-xs px-2 text-sm border border-border bg-background rounded-md"
        />
        <select
          data-testid="leads-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 px-2 text-sm border border-border bg-background rounded-md"
        >
          {LEAD_STATUS_FILTERS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load leads"}
        </p>
      )}

      {isLoading && (
        <div className="grid gap-2" data-testid="leads-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && data && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <UserPlus className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {data.length === 0
              ? "No leads yet. Create one to get started."
              : "No leads match the current filter."}
          </p>
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="border border-border rounded-md overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Score</th>
                <th className="px-3 py-2 font-medium">Last Contact</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead) => {
                const busy =
                  convertMutation.isPending || disqualifyMutation.isPending;
                return (
                  <tr
                    key={lead.id}
                    data-testid={`lead-row-${lead.id}`}
                    className="border-t border-border"
                  >
                    <td className="px-3 py-2">{fullName(lead)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {lead.email ?? "—"}
                    </td>
                    <td className="px-3 py-2">{lead.company ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${statusChipClass(lead.status)}`}
                      >
                        {lead.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {lead.score ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {relativeTime(lead.updatedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || lead.status === "converted"}
                          onClick={() => convertMutation.mutate(lead.id)}
                        >
                          <ArrowRightCircle className="h-3.5 w-3.5 mr-1.5" />
                          Convert
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || lead.status === "disqualified"}
                          onClick={() => disqualifyMutation.mutate(lead.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Lead</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <LeadField
              label="First name"
              value={formState.firstName}
              onChange={(v) => setFormState((s) => ({ ...s, firstName: v }))}
            />
            <LeadField
              label="Last name"
              value={formState.lastName}
              onChange={(v) => setFormState((s) => ({ ...s, lastName: v }))}
            />
            <LeadField
              label="Email"
              type="email"
              value={formState.email}
              onChange={(v) => setFormState((s) => ({ ...s, email: v }))}
            />
            <LeadField
              label="Company"
              value={formState.company}
              onChange={(v) => setFormState((s) => ({ ...s, company: v }))}
            />
            <LeadField
              label="Phone"
              value={formState.phone}
              onChange={(v) => setFormState((s) => ({ ...s, phone: v }))}
            />
            <LeadField
              label="Source"
              value={formState.source}
              onChange={(v) => setFormState((s) => ({ ...s, source: v }))}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                setFormState(EMPTY_FORM);
              }}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                createMutation.mutate({
                  firstName: formState.firstName || null,
                  lastName: formState.lastName || null,
                  email: formState.email || null,
                  company: formState.company || null,
                  phone: formState.phone || null,
                  source: formState.source || null,
                })
              }
              disabled={createMutation.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LeadField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 px-2 border border-border bg-background rounded-md"
      />
    </label>
  );
}
