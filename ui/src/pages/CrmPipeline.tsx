// @ts-nocheck — AgentDash CRM WIP, stub API
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  CircleDollarSign,
  Handshake,
  Loader2,
  Plus,
  RefreshCw,
  Users,
  Workflow,
} from "lucide-react";
import { crmApi } from "../api/crm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const STAGE_META: Record<string, { label: string; color: string }> = {
  new: { label: "New", color: "bg-blue-100 text-blue-700" },
  contacted: { label: "Contacted", color: "bg-indigo-100 text-indigo-700" },
  qualified: { label: "Qualified", color: "bg-violet-100 text-violet-700" },
  proposal: { label: "Proposal", color: "bg-amber-100 text-amber-700" },
  negotiation: { label: "Negotiation", color: "bg-orange-100 text-orange-700" },
  closed_won: { label: "Won", color: "bg-emerald-100 text-emerald-700" },
  closed_lost: { label: "Lost", color: "bg-red-100 text-red-700" },
  customer: { label: "Customer", color: "bg-emerald-100 text-emerald-700" },
  active: { label: "Active", color: "bg-emerald-100 text-emerald-700" },
};

const DEAL_STAGES = ["new", "contacted", "qualified", "proposal", "negotiation", "closed_won", "closed_lost"];
const LEAD_STATUSES = ["new", "working", "qualified", "converted", "disqualified"];
const PARTNER_TYPES = ["referral", "reseller", "agency", "technology"];
const PARTNER_STATUSES = ["active", "inactive", "prospect"];

type CrmDialogKind = "account" | "deal" | "lead" | "partner" | "hubspot";

interface AccountDraft {
  name: string;
  domain: string;
  industry: string;
  size: string;
  stage: string;
}

interface DealDraft {
  name: string;
  accountId: string;
  stage: string;
  amount: string;
  currency: string;
  closeDate: string;
  probability: string;
}

interface LeadDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  title: string;
  source: string;
  status: string;
  score: string;
}

interface PartnerDraft {
  name: string;
  type: string;
  contactName: string;
  contactEmail: string;
  website: string;
  status: string;
  tier: string;
}

interface HubSpotDraft {
  portalId: string;
  accessToken: string;
  syncEnabled: boolean;
}

const EMPTY_ACCOUNT_DRAFT: AccountDraft = {
  name: "",
  domain: "",
  industry: "",
  size: "",
  stage: "new",
};

const EMPTY_DEAL_DRAFT: DealDraft = {
  name: "",
  accountId: "",
  stage: "new",
  amount: "",
  currency: "USD",
  closeDate: "",
  probability: "",
};

const EMPTY_LEAD_DRAFT: LeadDraft = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  company: "",
  title: "",
  source: "",
  status: "new",
  score: "",
};

const EMPTY_PARTNER_DRAFT: PartnerDraft = {
  name: "",
  type: "referral",
  contactName: "",
  contactEmail: "",
  website: "",
  status: "active",
  tier: "",
};

const EMPTY_HUBSPOT_DRAFT: HubSpotDraft = {
  portalId: "",
  accessToken: "",
  syncEnabled: true,
};

function trimToNull(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function sanitizeCurrencyToCents(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[$,\s]/g, "");
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return null;
  return String(Math.round(numeric * 100));
}

function dateInputToIso(value: string) {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;
}

export function buildCrmMutationPayloads(input: {
  account: AccountDraft;
  deal: DealDraft;
  lead: LeadDraft;
  partner: PartnerDraft;
}) {
  return {
    account: {
      name: input.account.name.trim(),
      domain: trimToNull(input.account.domain),
      industry: trimToNull(input.account.industry),
      size: trimToNull(input.account.size),
      stage: trimToNull(input.account.stage),
    },
    deal: {
      name: input.deal.name.trim(),
      accountId: trimToNull(input.deal.accountId),
      stage: trimToNull(input.deal.stage),
      amountCents: sanitizeCurrencyToCents(input.deal.amount),
      currency: trimToNull(input.deal.currency) ?? "USD",
      closeDate: dateInputToIso(input.deal.closeDate),
      probability: trimToNull(input.deal.probability),
    },
    lead: {
      firstName: trimToNull(input.lead.firstName),
      lastName: trimToNull(input.lead.lastName),
      email: trimToNull(input.lead.email),
      phone: trimToNull(input.lead.phone),
      company: trimToNull(input.lead.company),
      title: trimToNull(input.lead.title),
      source: trimToNull(input.lead.source),
      status: input.lead.status,
      score: trimToNull(input.lead.score),
    },
    partner: {
      name: input.partner.name.trim(),
      type: input.partner.type,
      contactName: trimToNull(input.partner.contactName),
      contactEmail: trimToNull(input.partner.contactEmail),
      website: trimToNull(input.partner.website),
      status: input.partner.status,
      tier: trimToNull(input.partner.tier),
    },
  };
}

export function crmQueryKeysForCompany(companyId: string) {
  return [
    queryKeys.crm.pipeline(companyId),
    queryKeys.crm.accounts(companyId),
    queryKeys.crm.deals(companyId),
    queryKeys.crm.leads(companyId),
    queryKeys.crm.partners(companyId),
    queryKeys.crm.hubspot(companyId),
  ];
}

export function summarizeCrmCujCoverage(input: {
  hasCreateAccount: boolean;
  hasCreateDeal: boolean;
  hasCreateLead: boolean;
  hasCreatePartner: boolean;
  hasHubspotConnect: boolean;
  hasHubspotSync: boolean;
}) {
  const supported: string[] = [];
  const missing: string[] = [];

  if (input.hasCreateAccount || input.hasCreateLead) supported.push("T10");
  else missing.push("T10");

  if (input.hasCreateAccount || input.hasCreateLead || input.hasCreatePartner) supported.push("CUJ-3");
  else missing.push("CUJ-3");

  if (input.hasCreateDeal) supported.push("CUJ-8");
  else missing.push("CUJ-8");

  if (input.hasHubspotConnect && input.hasHubspotSync) supported.push("CUJ-10");
  else missing.push("CUJ-10");

  return { supported, missing };
}

function formatMoneyFromCents(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `$${(numeric / 100).toLocaleString()}`;
}

function SectionHeader({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <Button size="sm" variant="outline" onClick={onAction}>
          <Plus className="mr-1.5 h-4 w-4" />
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export function CrmPipeline() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [activeDialog, setActiveDialog] = useState<CrmDialogKind | null>(null);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(EMPTY_ACCOUNT_DRAFT);
  const [dealDraft, setDealDraft] = useState<DealDraft>(EMPTY_DEAL_DRAFT);
  const [leadDraft, setLeadDraft] = useState<LeadDraft>(EMPTY_LEAD_DRAFT);
  const [partnerDraft, setPartnerDraft] = useState<PartnerDraft>(EMPTY_PARTNER_DRAFT);
  const [hubspotDraft, setHubspotDraft] = useState<HubSpotDraft>(EMPTY_HUBSPOT_DRAFT);
  const cid = selectedCompanyId;

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipeline" }]);
  }, [setBreadcrumbs]);

  const { data: pipeline, isLoading: pipelineLoading, error: pipelineError } = useQuery({
    queryKey: cid ? queryKeys.crm.pipeline(cid) : ["crm", "pipeline", "no-company"],
    queryFn: () => crmApi.pipeline(cid!),
    enabled: !!cid,
  });
  const { data: accounts = [], isLoading: accountsLoading, error: accountsError } = useQuery({
    queryKey: cid ? queryKeys.crm.accounts(cid) : ["crm", "accounts", "no-company"],
    queryFn: () => crmApi.accounts(cid!),
    enabled: !!cid,
  });
  const { data: deals = [], isLoading: dealsLoading, error: dealsError } = useQuery({
    queryKey: cid ? queryKeys.crm.deals(cid) : ["crm", "deals", "no-company"],
    queryFn: () => crmApi.deals(cid!),
    enabled: !!cid,
  });
  const { data: leads = [], isLoading: leadsLoading, error: leadsError } = useQuery({
    queryKey: cid ? queryKeys.crm.leads(cid) : ["crm", "leads", "no-company"],
    queryFn: () => crmApi.leads(cid!),
    enabled: !!cid,
  });
  const { data: partners = [], isLoading: partnersLoading, error: partnersError } = useQuery({
    queryKey: cid ? queryKeys.crm.partners(cid) : ["crm", "partners", "no-company"],
    queryFn: () => crmApi.partners(cid!),
    enabled: !!cid,
  });
  const { data: hubspotConfig, isLoading: hubspotLoading, error: hubspotError } = useQuery({
    queryKey: cid ? queryKeys.crm.hubspot(cid) : ["crm", "hubspot", "no-company"],
    queryFn: () => crmApi.hubspotConfig(cid!),
    enabled: !!cid,
  });

  useEffect(() => {
    if (!hubspotConfig) return;
    setHubspotDraft((current) => ({
      portalId: hubspotConfig.portalId ?? current.portalId,
      accessToken: "",
      syncEnabled: hubspotConfig.syncEnabled ?? current.syncEnabled,
    }));
  }, [hubspotConfig]);

  const anyLoading =
    pipelineLoading || accountsLoading || dealsLoading || leadsLoading || partnersLoading || hubspotLoading;
  const errorMessage =
    (pipelineError as Error | null)?.message ||
    (accountsError as Error | null)?.message ||
    (dealsError as Error | null)?.message ||
    (leadsError as Error | null)?.message ||
    (partnersError as Error | null)?.message ||
    (hubspotError as Error | null)?.message ||
    null;

  const counts = useMemo(
    () => ({
      totalPipeline: formatMoneyFromCents(pipeline?.totalPipelineValueCents ?? 0),
      accounts: accounts.length,
      leads: leads.length,
      deals: deals.length,
      partners: partners.length,
      newLeads: leads.filter((lead) => lead.status === "new").length,
    }),
    [accounts.length, deals.length, leads, partners.length, pipeline?.totalPipelineValueCents],
  );

  const accountOptions = useMemo(
    () => accounts.map((account) => ({ id: account.id, name: account.name })),
    [accounts],
  );

  const invalidateCrmQueries = async () => {
    if (!cid) return;
    await Promise.all(
      crmQueryKeysForCompany(cid).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  };

  const closeDialog = () => {
    setActiveDialog(null);
  };

  const createAccount = useMutation({
    mutationFn: () => crmApi.createAccount(cid!, buildCrmMutationPayloads({
      account: accountDraft,
      deal: dealDraft,
      lead: leadDraft,
      partner: partnerDraft,
    }).account),
    onSuccess: async () => {
      await invalidateCrmQueries();
      setAccountDraft(EMPTY_ACCOUNT_DRAFT);
      closeDialog();
      pushToast({
        title: "Account created",
        body: "Business context is now available to the CRM workspace.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create account",
        body: error instanceof Error ? error.message : "AgentDash could not create the account.",
        tone: "error",
      });
    },
  });

  const createDeal = useMutation({
    mutationFn: () => crmApi.createDeal(cid!, buildCrmMutationPayloads({
      account: accountDraft,
      deal: dealDraft,
      lead: leadDraft,
      partner: partnerDraft,
    }).deal),
    onSuccess: async () => {
      await invalidateCrmQueries();
      setDealDraft(EMPTY_DEAL_DRAFT);
      closeDialog();
      pushToast({
        title: "Deal created",
        body: "The pipeline has been updated.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create deal",
        body: error instanceof Error ? error.message : "AgentDash could not create the deal.",
        tone: "error",
      });
    },
  });

  const createLead = useMutation({
    mutationFn: () => crmApi.createLead(cid!, buildCrmMutationPayloads({
      account: accountDraft,
      deal: dealDraft,
      lead: leadDraft,
      partner: partnerDraft,
    }).lead),
    onSuccess: async () => {
      await invalidateCrmQueries();
      setLeadDraft(EMPTY_LEAD_DRAFT);
      closeDialog();
      pushToast({
        title: "Lead created",
        body: "The lead is ready for qualification and follow-up.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create lead",
        body: error instanceof Error ? error.message : "AgentDash could not create the lead.",
        tone: "error",
      });
    },
  });

  const createPartner = useMutation({
    mutationFn: () => crmApi.createPartner(cid!, buildCrmMutationPayloads({
      account: accountDraft,
      deal: dealDraft,
      lead: leadDraft,
      partner: partnerDraft,
    }).partner),
    onSuccess: async () => {
      await invalidateCrmQueries();
      setPartnerDraft(EMPTY_PARTNER_DRAFT);
      closeDialog();
      pushToast({
        title: "Partner added",
        body: "The partner relationship is now tracked in AgentDash.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to add partner",
        body: error instanceof Error ? error.message : "AgentDash could not save the partner.",
        tone: "error",
      });
    },
  });

  const saveHubspotConfig = useMutation({
    mutationFn: () =>
      crmApi.saveHubspotConfig(cid!, {
        portalId: trimToNull(hubspotDraft.portalId),
        accessToken: trimToNull(hubspotDraft.accessToken),
        syncEnabled: hubspotDraft.syncEnabled,
      }),
    onSuccess: async () => {
      await invalidateCrmQueries();
      setHubspotDraft((current) => ({ ...current, accessToken: "" }));
      closeDialog();
      pushToast({
        title: "HubSpot configuration saved",
        body: "You can sync the latest CRM records immediately.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save HubSpot config",
        body: error instanceof Error ? error.message : "AgentDash could not save the integration.",
        tone: "error",
      });
    },
  });

  const syncHubspot = useMutation({
    mutationFn: () => crmApi.syncHubspot(cid!),
    onSuccess: async (result) => {
      await invalidateCrmQueries();
      pushToast({
        title: "HubSpot sync complete",
        body: `Imported ${result.companies} accounts, ${result.contacts} contacts, and ${result.deals} deals.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "HubSpot sync failed",
        body: error instanceof Error ? error.message : "AgentDash could not sync HubSpot.",
        tone: "error",
      });
    },
  });

  if (!cid) {
    return <div className="p-6 text-muted-foreground">Select a company to use CRM.</div>;
  }

  const cujCoverage = summarizeCrmCujCoverage({
    hasCreateAccount: true,
    hasCreateDeal: true,
    hasCreateLead: true,
    hasCreatePartner: true,
    hasHubspotConnect: true,
    hasHubspotSync: Boolean(hubspotConfig?.configured),
  });

  return (
    <div className="space-y-8 p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
            <Workflow className="h-3.5 w-3.5" />
            CRM operator workspace
          </div>
          <div>
            <h1 className="text-2xl font-bold">Pipeline</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage customer context, demand, revenue workflow, and partner channels for {selectedCompany?.name ?? "this company"}.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setActiveDialog("hubspot")}>
            <Building2 className="mr-2 h-4 w-4" />
            {hubspotConfig?.configured ? "HubSpot settings" : "Connect HubSpot"}
          </Button>
          <Button
            variant="outline"
            onClick={() => syncHubspot.mutate()}
            disabled={!hubspotConfig?.configured || syncHubspot.isPending}
          >
            {syncHubspot.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Sync now
          </Button>
          <Button onClick={() => setActiveDialog("deal")}>
            <Plus className="mr-2 h-4 w-4" />
            New deal
          </Button>
        </div>
      </div>

      {errorMessage ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          CRM failed to load completely: {errorMessage}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Pipeline value</p>
            <p className="mt-1 text-3xl font-bold">{counts.totalPipeline}</p>
            <p className="mt-1 text-xs text-muted-foreground">{pipeline?.totalDeals ?? 0} deals tracked</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Accounts</p>
            <p className="mt-1 text-3xl font-bold">{counts.accounts}</p>
            <p className="mt-1 text-xs text-muted-foreground">Company context in system</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Leads</p>
            <p className="mt-1 text-3xl font-bold">{counts.leads}</p>
            <p className="mt-1 text-xs text-muted-foreground">{counts.newLeads} need triage</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Deals</p>
            <p className="mt-1 text-3xl font-bold">{counts.deals}</p>
            <p className="mt-1 text-xs text-muted-foreground">Revenue opportunities</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Partners</p>
            <p className="mt-1 text-3xl font-bold">{counts.partners}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {hubspotConfig?.configured ? "HubSpot connected" : "Manual mode"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.9fr]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <SectionHeader
              title="Pipeline by stage"
              description="Operator view of live revenue movement across the funnel."
            />
            {pipeline?.stages?.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {pipeline.stages.map((stage) => {
                  const key = stage.stage ?? "unknown";
                  const meta = STAGE_META[key] ?? { label: key, color: "bg-muted text-muted-foreground" };
                  return (
                    <div key={key} className="rounded-xl border bg-background p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", meta.color)}>
                          {meta.label}
                        </span>
                        <span className="text-sm font-semibold">{stage.count}</span>
                      </div>
                      <p className="mt-2 text-xl font-bold">{formatMoneyFromCents(stage.totalAmountCents)}</p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyPanel message={anyLoading ? "Loading pipeline..." : "No deal pipeline yet. Create a deal or sync from HubSpot."} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-5">
            <SectionHeader
              title="CRM CUJ coverage"
              description="Quick product check against the canonical customer journeys."
            />
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-medium text-foreground">Supported now</p>
                <p className="mt-1 text-muted-foreground">{cujCoverage.supported.join(", ") || "None"}</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Still missing</p>
                <p className="mt-1 text-muted-foreground">{cujCoverage.missing.join(", ") || "No immediate gaps in this surface"}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3 text-muted-foreground">
                This page now supports action loops, not just reporting. The remaining gap is deeper CRM workflow, especially contact detail, lead conversion, and downstream task creation.
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <SectionHeader
          title="Accounts"
          description="Company context the agents should understand before doing customer-facing work."
          actionLabel="New account"
          onAction={() => setActiveDialog("account")}
        />
        {accounts.length === 0 ? (
          <EmptyPanel message="No accounts yet. Add one manually or sync from HubSpot." />
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-3 text-left font-medium">Account</th>
                  <th className="p-3 text-left font-medium">Domain</th>
                  <th className="p-3 text-left font-medium">Industry</th>
                  <th className="p-3 text-left font-medium">Stage</th>
                  <th className="p-3 text-left font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {accounts.slice(0, 10).map((account) => (
                  <tr key={account.id} className="hover:bg-muted/20">
                    <td className="p-3 font-medium">{account.name}</td>
                    <td className="p-3 text-muted-foreground">{account.domain ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{account.industry ?? "—"}</td>
                    <td className="p-3">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs", STAGE_META[account.stage ?? ""]?.color ?? "bg-muted text-muted-foreground")}>
                        {STAGE_META[account.stage ?? ""]?.label ?? account.stage ?? "—"}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{account.externalSource ?? "manual"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <SectionHeader
          title="Deals"
          description="Revenue opportunities the board should be able to review and act on."
          actionLabel="New deal"
          onAction={() => setActiveDialog("deal")}
        />
        {deals.length === 0 ? (
          <EmptyPanel message="No deals yet. Create your first deal or sync from HubSpot." />
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-3 text-left font-medium">Deal</th>
                  <th className="p-3 text-left font-medium">Account</th>
                  <th className="p-3 text-left font-medium">Stage</th>
                  <th className="p-3 text-left font-medium">Amount</th>
                  <th className="p-3 text-left font-medium">Close date</th>
                  <th className="p-3 text-left font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deals.slice(0, 10).map((deal) => {
                  const meta = STAGE_META[deal.stage ?? ""] ?? { label: deal.stage ?? "—", color: "bg-muted text-muted-foreground" };
                  const account = accounts.find((candidate) => candidate.id === deal.accountId);
                  return (
                    <tr key={deal.id} className="hover:bg-muted/20">
                      <td className="p-3 font-medium">{deal.name}</td>
                      <td className="p-3 text-muted-foreground">{account?.name ?? "—"}</td>
                      <td className="p-3">
                        <span className={cn("rounded-full px-2 py-0.5 text-xs", meta.color)}>{meta.label}</span>
                      </td>
                      <td className="p-3">{formatMoneyFromCents(deal.amountCents)}</td>
                      <td className="p-3 text-muted-foreground">
                        {deal.closeDate ? new Date(deal.closeDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">{deal.externalSource ?? "manual"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-3">
          <SectionHeader
            title="Leads"
            description="New demand coming into the system before qualification."
            actionLabel="New lead"
            onAction={() => setActiveDialog("lead")}
          />
          {leads.length === 0 ? (
            <EmptyPanel message="No leads yet." />
          ) : (
            <div className="overflow-hidden rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-3 text-left font-medium">Name</th>
                    <th className="p-3 text-left font-medium">Company</th>
                    <th className="p-3 text-left font-medium">Email</th>
                    <th className="p-3 text-left font-medium">Source</th>
                    <th className="p-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {leads.slice(0, 10).map((lead) => (
                    <tr key={lead.id} className="hover:bg-muted/20">
                      <td className="p-3 font-medium">{[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—"}</td>
                      <td className="p-3 text-muted-foreground">{lead.company ?? "—"}</td>
                      <td className="p-3 text-muted-foreground">{lead.email ?? "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{lead.source ?? "—"}</td>
                      <td className="p-3">
                        <span className={cn("rounded-full px-2 py-0.5 text-xs", lead.status === "converted" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700")}>
                          {lead.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <SectionHeader
            title="Partners"
            description="Referral and channel relationships that expand distribution."
            actionLabel="Add partner"
            onAction={() => setActiveDialog("partner")}
          />
          {partners.length === 0 ? (
            <EmptyPanel message="No partners yet." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {partners.map((partner) => (
                <div key={partner.id} className="rounded-xl border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{partner.name}</h3>
                      {partner.contactEmail ? <p className="mt-1 text-sm text-muted-foreground">{partner.contactEmail}</p> : null}
                    </div>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{partner.type}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {partner.status ? <span>Status: {partner.status}</span> : null}
                    {partner.tier ? <span>Tier: {partner.tier}</span> : null}
                    {partner.referralCount ? <span>{partner.referralCount} referrals</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={activeDialog === "account"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New account</DialogTitle>
            <DialogDescription>Add customer context that agents can reference when planning and executing work.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="crm-account-name">Name</Label>
              <Input
                id="crm-account-name"
                value={accountDraft.name}
                onChange={(event) => setAccountDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Acme Inc."
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="crm-account-domain">Domain</Label>
                <Input
                  id="crm-account-domain"
                  value={accountDraft.domain}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, domain: event.target.value }))}
                  placeholder="acme.com"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-account-stage">Stage</Label>
                <Input
                  id="crm-account-stage"
                  value={accountDraft.stage}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, stage: event.target.value }))}
                  placeholder="customer"
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="crm-account-industry">Industry</Label>
                <Input
                  id="crm-account-industry"
                  value={accountDraft.industry}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, industry: event.target.value }))}
                  placeholder="Healthcare"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-account-size">Segment</Label>
                <Input
                  id="crm-account-size"
                  value={accountDraft.size}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, size: event.target.value }))}
                  placeholder="Mid-market"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={createAccount.isPending}>Cancel</Button>
            <Button onClick={() => createAccount.mutate()} disabled={createAccount.isPending || !accountDraft.name.trim()}>
              {createAccount.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Building2 className="mr-2 h-4 w-4" />}
              Create account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={activeDialog === "deal"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>Create a revenue opportunity the board can monitor and assign around.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="crm-deal-name">Name</Label>
              <Input
                id="crm-deal-name"
                value={dealDraft.name}
                onChange={(event) => setDealDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Acme expansion"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Account</Label>
                <Select value={dealDraft.accountId || "__none__"} onValueChange={(value) => setDealDraft((current) => ({ ...current, accountId: value === "__none__" ? "" : value }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No linked account" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No linked account</SelectItem>
                    {accountOptions.map((account) => (
                      <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Stage</Label>
                <Select value={dealDraft.stage} onValueChange={(value) => setDealDraft((current) => ({ ...current, stage: value }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEAL_STAGES.map((stage) => (
                      <SelectItem key={stage} value={stage}>{STAGE_META[stage]?.label ?? stage}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="crm-deal-amount">Amount</Label>
                <Input
                  id="crm-deal-amount"
                  value={dealDraft.amount}
                  onChange={(event) => setDealDraft((current) => ({ ...current, amount: event.target.value }))}
                  placeholder="12500"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-deal-currency">Currency</Label>
                <Input
                  id="crm-deal-currency"
                  value={dealDraft.currency}
                  onChange={(event) => setDealDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() }))}
                  placeholder="USD"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-deal-probability">Probability %</Label>
                <Input
                  id="crm-deal-probability"
                  value={dealDraft.probability}
                  onChange={(event) => setDealDraft((current) => ({ ...current, probability: event.target.value }))}
                  placeholder="80"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="crm-deal-close-date">Close date</Label>
              <Input
                id="crm-deal-close-date"
                type="date"
                value={dealDraft.closeDate}
                onChange={(event) => setDealDraft((current) => ({ ...current, closeDate: event.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={createDeal.isPending}>Cancel</Button>
            <Button onClick={() => createDeal.mutate()} disabled={createDeal.isPending || !dealDraft.name.trim()}>
              {createDeal.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CircleDollarSign className="mr-2 h-4 w-4" />}
              Create deal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={activeDialog === "lead"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New lead</DialogTitle>
            <DialogDescription>Capture incoming demand so it can be qualified and routed into execution.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="crm-lead-first-name">First name</Label>
                <Input
                  id="crm-lead-first-name"
                  value={leadDraft.firstName}
                  onChange={(event) => setLeadDraft((current) => ({ ...current, firstName: event.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-lead-last-name">Last name</Label>
                <Input
                  id="crm-lead-last-name"
                  value={leadDraft.lastName}
                  onChange={(event) => setLeadDraft((current) => ({ ...current, lastName: event.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="crm-lead-email">Email</Label>
                <Input
                  id="crm-lead-email"
                  type="email"
                  value={leadDraft.email}
                  onChange={(event) => setLeadDraft((current) => ({ ...current, email: event.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-lead-phone">Phone</Label>
                <Input
                  id="crm-lead-phone"
                  value={leadDraft.phone}
                  onChange={(event) => setLeadDraft((current) => ({ ...current, phone: event.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="crm-lead-company">Company</Label>
                <Input
                  id="crm-lead-company"
                  value={leadDraft.company}
                  onChange={(event) => setLeadDraft((current) => ({ ...current, company: event.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-lead-title">Title</Label>
                <Input
                  id="crm-lead-title"
                  value={leadDraft.title}
                  onChange={(event) => setLeadDraft((current) => ({ ...current, title: event.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="crm-lead-source">Source</Label>
                <Input
                  id="crm-lead-source"
                  value={leadDraft.source}
                  onChange={(event) => setLeadDraft((current) => ({ ...current, source: event.target.value }))}
                  placeholder="Outbound"
                />
              </div>
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select value={leadDraft.status} onValueChange={(value) => setLeadDraft((current) => ({ ...current, status: value }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAD_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>{status}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-lead-score">Score</Label>
                <Input
                  id="crm-lead-score"
                  value={leadDraft.score}
                  onChange={(event) => setLeadDraft((current) => ({ ...current, score: event.target.value }))}
                  placeholder="72"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={createLead.isPending}>Cancel</Button>
            <Button
              onClick={() => createLead.mutate()}
              disabled={createLead.isPending || (!leadDraft.email.trim() && !leadDraft.company.trim() && !leadDraft.firstName.trim() && !leadDraft.lastName.trim())}
            >
              {createLead.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Users className="mr-2 h-4 w-4" />}
              Create lead
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={activeDialog === "partner"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add partner</DialogTitle>
            <DialogDescription>Track channel and referral relationships that influence growth.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="crm-partner-name">Name</Label>
              <Input
                id="crm-partner-name"
                value={partnerDraft.name}
                onChange={(event) => setPartnerDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={partnerDraft.type} onValueChange={(value) => setPartnerDraft((current) => ({ ...current, type: value }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARTNER_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select value={partnerDraft.status} onValueChange={(value) => setPartnerDraft((current) => ({ ...current, status: value }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARTNER_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>{status}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="crm-partner-contact-name">Contact name</Label>
                <Input
                  id="crm-partner-contact-name"
                  value={partnerDraft.contactName}
                  onChange={(event) => setPartnerDraft((current) => ({ ...current, contactName: event.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-partner-contact-email">Contact email</Label>
                <Input
                  id="crm-partner-contact-email"
                  type="email"
                  value={partnerDraft.contactEmail}
                  onChange={(event) => setPartnerDraft((current) => ({ ...current, contactEmail: event.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="crm-partner-website">Website</Label>
                <Input
                  id="crm-partner-website"
                  value={partnerDraft.website}
                  onChange={(event) => setPartnerDraft((current) => ({ ...current, website: event.target.value }))}
                  placeholder="https://partner.com"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="crm-partner-tier">Tier</Label>
                <Input
                  id="crm-partner-tier"
                  value={partnerDraft.tier}
                  onChange={(event) => setPartnerDraft((current) => ({ ...current, tier: event.target.value }))}
                  placeholder="Gold"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={createPartner.isPending}>Cancel</Button>
            <Button onClick={() => createPartner.mutate()} disabled={createPartner.isPending || !partnerDraft.name.trim()}>
              {createPartner.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Handshake className="mr-2 h-4 w-4" />}
              Save partner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={activeDialog === "hubspot"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>HubSpot integration</DialogTitle>
            <DialogDescription>Connect HubSpot so demand and account context flow into AgentDash.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              {hubspotConfig?.configured
                ? `Connected${hubspotConfig.portalId ? ` to portal ${hubspotConfig.portalId}` : ""}. Save a new token here if you need to rotate credentials.`
                : "No HubSpot configuration found yet."}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="hubspot-portal-id">Portal ID</Label>
              <Input
                id="hubspot-portal-id"
                value={hubspotDraft.portalId}
                onChange={(event) => setHubspotDraft((current) => ({ ...current, portalId: event.target.value }))}
                placeholder="12345678"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="hubspot-access-token">Access token</Label>
              <Textarea
                id="hubspot-access-token"
                value={hubspotDraft.accessToken}
                onChange={(event) => setHubspotDraft((current) => ({ ...current, accessToken: event.target.value }))}
                placeholder={hubspotConfig?.configured ? "Paste a replacement token to rotate credentials" : "Paste the HubSpot private app token"}
                className="min-h-24"
              />
            </div>
            <label className="flex items-center gap-3 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={hubspotDraft.syncEnabled}
                onCheckedChange={(checked) => setHubspotDraft((current) => ({ ...current, syncEnabled: checked === true }))}
              />
              <span>Enable background HubSpot sync for this company</span>
            </label>
          </div>
          <DialogFooter className="sm:justify-between">
            <Button
              variant="outline"
              onClick={() => syncHubspot.mutate()}
              disabled={!hubspotConfig?.configured || syncHubspot.isPending}
            >
              {syncHubspot.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Sync now
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={closeDialog} disabled={saveHubspotConfig.isPending}>Cancel</Button>
              <Button onClick={() => saveHubspotConfig.mutate()} disabled={saveHubspotConfig.isPending || (!hubspotDraft.portalId.trim() && !hubspotDraft.accessToken.trim())}>
                {saveHubspotConfig.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Building2 className="mr-2 h-4 w-4" />}
                Save integration
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
