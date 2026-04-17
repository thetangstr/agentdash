// AgentDash: CrmDealDetail — CUJ-A deal detail page
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Briefcase,
  Building2,
  User,
  Calendar,
  Mail,
  Phone,
  MessageSquare,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import { crmApi, type CrmDeal, type CrmActivity } from "../api/crm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Canonical pipeline stages (kept in sync with CrmKanban)
// ---------------------------------------------------------------------------

const DEAL_STAGES = [
  "prospect",
  "qualified",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;

const STAGE_LABELS: Record<(typeof DEAL_STAGES)[number], string> = {
  prospect: "Prospect",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
};

// ---------------------------------------------------------------------------
// Amount helpers — backend stores `amountCents` as a stringified integer.
// ---------------------------------------------------------------------------

function dealAmountDollars(deal: CrmDeal): number | null {
  if (deal.amountCents != null && deal.amountCents !== "") {
    const cents = Number(deal.amountCents);
    if (Number.isFinite(cents)) return Math.round(cents) / 100;
  }
  if (typeof deal.amount === "number" && Number.isFinite(deal.amount)) {
    return deal.amount;
  }
  return null;
}

function formatDealAmount(deal: CrmDeal): string {
  const dollars = dealAmountDollars(deal);
  if (dollars == null) return "—";
  const currency = deal.currency ?? "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(dollars);
  } catch {
    return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
}

function dollarsToCents(dollars: number): string {
  return String(Math.round(dollars * 100));
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function activityIcon(type: string) {
  switch (type) {
    case "call":
      return Phone;
    case "email":
      return Mail;
    case "meeting":
      return Calendar;
    case "task":
      return CheckCircle2;
    default:
      return MessageSquare;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CrmDealDetail() {
  const { dealId } = useParams<{ dealId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const dealKey = useMemo(
    () => ["crm", selectedCompanyId ?? "_none_", "deals", dealId ?? "_none_"] as const,
    [selectedCompanyId, dealId],
  );

  const dealQuery = useQuery({
    queryKey: dealKey,
    queryFn: () => crmApi.getDeal(selectedCompanyId!, dealId!),
    enabled: !!selectedCompanyId && !!dealId,
  });
  const deal = dealQuery.data;

  const activitiesQuery = useQuery({
    queryKey: ["crm", selectedCompanyId ?? "_none_", "activities", "deal", dealId ?? "_none_"] as const,
    queryFn: () => crmApi.listActivities(selectedCompanyId!, { dealId: dealId! }),
    enabled: !!selectedCompanyId && !!dealId,
  });

  const accountQuery = useQuery({
    queryKey: ["crm", selectedCompanyId ?? "_none_", "accounts", deal?.accountId ?? "_none_"] as const,
    queryFn: () => crmApi.getAccount(selectedCompanyId!, deal!.accountId!),
    enabled: !!selectedCompanyId && !!deal?.accountId,
  });

  const contactQuery = useQuery({
    queryKey: ["crm", selectedCompanyId ?? "_none_", "contacts", deal?.contactId ?? "_none_"] as const,
    queryFn: () => crmApi.getContact(selectedCompanyId!, deal!.contactId!),
    enabled: !!selectedCompanyId && !!deal?.contactId,
  });

  useEffect(() => {
    if (deal) {
      setBreadcrumbs([{ label: "Pipeline", href: "/crm/pipeline" }, { label: deal.name }]);
    } else {
      setBreadcrumbs([{ label: "Pipeline", href: "/crm/pipeline" }, { label: "Deal" }]);
    }
  }, [deal, setBreadcrumbs]);

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<CrmDeal>) =>
      crmApi.updateDeal(selectedCompanyId!, dealId!, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dealKey });
      pushToast({ tone: "success", title: "Deal updated" });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Failed to update deal",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  // Inline edit state
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingAmount, setEditingAmount] = useState(false);
  const [amountDraft, setAmountDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState<string | null>(null);

  useEffect(() => {
    if (deal && notesDraft === null) {
      const existing =
        deal.metadata && typeof (deal.metadata as Record<string, unknown>).notes === "string"
          ? String((deal.metadata as Record<string, unknown>).notes)
          : "";
      setNotesDraft(existing);
    }
  }, [deal, notesDraft]);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-6">Select a company first.</p>;
  }

  if (!dealId) {
    return <p className="text-sm text-destructive p-6">Missing deal id.</p>;
  }

  if (dealQuery.isLoading) {
    return (
      <div className="space-y-4" data-testid="deal-loading">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (dealQuery.error) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">
          {dealQuery.error instanceof Error ? dealQuery.error.message : "Failed to load deal"}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => navigate("/crm/pipeline")}
        >
          Back to pipeline
        </Button>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Deal not found.</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => navigate("/crm/pipeline")}
        >
          Back to pipeline
        </Button>
      </div>
    );
  }

  const account = accountQuery.data;
  const contact = contactQuery.data;
  const activities = activitiesQuery.data ?? [];
  const busy = updateMutation.isPending;

  const commitName = () => {
    const next = nameDraft.trim();
    if (next && next !== deal.name) {
      updateMutation.mutate({ name: next });
    }
    setEditingName(false);
  };

  const commitAmount = () => {
    const trimmed = amountDraft.trim();
    if (trimmed === "") {
      setEditingAmount(false);
      return;
    }
    const parsed = Number(trimmed.replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(parsed)) {
      pushToast({ tone: "error", title: "Invalid amount" });
      setEditingAmount(false);
      return;
    }
    updateMutation.mutate({ amountCents: dollarsToCents(parsed) });
    setEditingAmount(false);
  };

  const commitNotes = () => {
    const nextNotes = (notesDraft ?? "").trim();
    const metadata = { ...(deal.metadata ?? {}), notes: nextNotes } as Record<
      string,
      unknown
    >;
    updateMutation.mutate({ metadata });
  };

  const contactName = contact
    ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
      contact.email ||
      "Contact"
    : null;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded bg-muted text-muted-foreground shrink-0">
          <Briefcase className="h-6 w-6" />
        </div>
        <div className="flex-1 min-w-0">
          {editingName ? (
            <input
              autoFocus
              data-testid="deal-name-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
                if (e.key === "Escape") setEditingName(false);
              }}
              className="h-9 w-full text-xl font-semibold px-2 border border-border bg-background rounded-md"
            />
          ) : (
            <button
              type="button"
              data-testid="deal-name"
              className="text-xl font-semibold truncate text-left hover:underline"
              onClick={() => {
                setNameDraft(deal.name);
                setEditingName(true);
              }}
              disabled={busy}
            >
              {deal.name}
            </button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {formatDate(deal.closeDate)}
            </span>
            {deal.ownerUserId && (
              <span className="flex items-center gap-1">
                <User className="h-3.5 w-3.5" />
                {deal.ownerUserId}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Key fields grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Amount */}
        <div className="border border-border rounded-md p-3">
          <p className="text-xs text-muted-foreground">Amount</p>
          {editingAmount ? (
            <input
              autoFocus
              data-testid="deal-amount-input"
              value={amountDraft}
              onChange={(e) => setAmountDraft(e.target.value)}
              onBlur={commitAmount}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAmount();
                if (e.key === "Escape") setEditingAmount(false);
              }}
              className="mt-0.5 h-8 w-full px-2 text-sm font-medium border border-border bg-background rounded-md"
              placeholder="e.g. 12500"
            />
          ) : (
            <button
              type="button"
              data-testid="deal-amount"
              className="text-sm font-medium mt-0.5 text-left hover:underline"
              onClick={() => {
                const dollars = dealAmountDollars(deal);
                setAmountDraft(dollars != null ? String(dollars) : "");
                setEditingAmount(true);
              }}
              disabled={busy}
            >
              {formatDealAmount(deal)}
            </button>
          )}
        </div>

        {/* Stage */}
        <div className="border border-border rounded-md p-3">
          <p className="text-xs text-muted-foreground">Stage</p>
          <select
            data-testid="deal-stage-select"
            value={deal.stage ?? ""}
            disabled={busy}
            onChange={(e) => {
              const nextStage = e.target.value;
              if (nextStage !== (deal.stage ?? "")) {
                updateMutation.mutate({ stage: nextStage });
              }
            }}
            className="mt-0.5 h-8 w-full px-2 text-sm font-medium border border-border bg-background rounded-md"
          >
            <option value="">—</option>
            {DEAL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        {/* Close date (read-only display; editing via form is future work) */}
        <div className="border border-border rounded-md p-3">
          <p className="text-xs text-muted-foreground">Close date</p>
          <p className="text-sm font-medium mt-0.5">{formatDate(deal.closeDate)}</p>
        </div>
      </div>

      {/* Linked account + contact */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Linked
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="border border-border rounded-md p-3">
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <Building2 className="h-3 w-3" /> Account
            </p>
            {account ? (
              <Link
                to={`/crm/accounts/${account.id}`}
                className="text-sm font-medium hover:underline"
              >
                {account.name}
              </Link>
            ) : deal.accountId ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <p className="text-sm text-muted-foreground">No account linked</p>
            )}
          </div>
          <div className="border border-border rounded-md p-3">
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <User className="h-3 w-3" /> Contact
            </p>
            {contact ? (
              <Link
                to={`/crm/contacts/${contact.id}`}
                className="text-sm font-medium hover:underline"
              >
                {contactName}
              </Link>
            ) : deal.contactId ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <p className="text-sm text-muted-foreground">No contact linked</p>
            )}
          </div>
        </div>
      </section>

      {/* HubSpot sync status */}
      {(deal.externalId || deal.externalSource || deal.lastSyncedAt) && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Sync status
          </h2>
          <div
            data-testid="deal-sync-status"
            className="border border-border rounded-md p-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm"
          >
            <div>
              <p className="text-xs text-muted-foreground">Source</p>
              <p className="font-medium capitalize flex items-center gap-1">
                {deal.externalSource ?? "—"}
                {deal.externalSource === "hubspot" && (
                  <ExternalLink className="h-3 w-3 text-muted-foreground" />
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">External ID</p>
              <p className="font-medium truncate">{deal.externalId ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last synced</p>
              <p className="font-medium">{formatDateTime(deal.lastSyncedAt)}</p>
            </div>
          </div>
        </section>
      )}

      {/* Activity timeline */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Activity ({activities.length})
        </h2>
        {activitiesQuery.isLoading && <Skeleton className="h-16 w-full" />}
        {!activitiesQuery.isLoading && activities.length === 0 && (
          <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        )}
        {activities.length > 0 && (
          <ol
            data-testid="deal-activity-timeline"
            className="relative border-l border-border ml-3 space-y-3"
          >
            {activities.map((a: CrmActivity) => {
              const Icon = activityIcon(a.activityType);
              return (
                <li key={a.id} className="pl-4 relative">
                  <span className="absolute -left-[9px] top-1 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background">
                    <Icon className="h-2.5 w-2.5 text-muted-foreground" />
                  </span>
                  <div className="border border-border rounded-md p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate">
                        {a.subject ?? a.activityType}
                      </p>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatDateTime(a.occurredAt)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground capitalize mt-0.5">
                      {a.activityType}
                    </p>
                    {a.body && (
                      <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap">
                        {a.body}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Notes */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Notes
        </h2>
        <textarea
          data-testid="deal-notes"
          value={notesDraft ?? ""}
          onChange={(e) => setNotesDraft(e.target.value)}
          placeholder="Add notes about this deal…"
          rows={4}
          className="w-full px-3 py-2 text-sm border border-border bg-background rounded-md"
        />
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={commitNotes} disabled={busy}>
            Save notes
          </Button>
        </div>
      </section>
    </div>
  );
}
