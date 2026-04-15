// AgentDash: CRM Account detail page
import { useEffect } from "react";
import { useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { crmApi } from "../api/crm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Building2, Users, Mail, Globe, Briefcase } from "lucide-react";

export function CrmAccountDetail() {
  const { accountId } = useParams<{ accountId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: account, isLoading, error } = useQuery({
    queryKey: queryKeys.crm.accountDetail(selectedCompanyId!, accountId!),
    queryFn: () => crmApi.getAccount(selectedCompanyId!, accountId!),
    enabled: !!selectedCompanyId && !!accountId,
  });

  const { data: contacts } = useQuery({
    queryKey: [...queryKeys.crm.contacts(selectedCompanyId!), "account", accountId],
    queryFn: () => crmApi.listContacts(selectedCompanyId!, { accountId: accountId! }),
    enabled: !!selectedCompanyId && !!accountId,
  });

  const { data: deals } = useQuery({
    queryKey: [...queryKeys.crm.deals(selectedCompanyId!), "account", accountId],
    queryFn: () => crmApi.listDeals(selectedCompanyId!, { accountId: accountId! }),
    enabled: !!selectedCompanyId && !!accountId,
  });

  useEffect(() => {
    if (account) {
      setBreadcrumbs([
        { label: "CRM" },
        { label: "Accounts" },
        { label: account.name },
      ]);
    }
  }, [account, setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Building2} message="Select a company." />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!account) return <EmptyState icon={Building2} message="Account not found." />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded bg-muted text-muted-foreground shrink-0">
          <Building2 className="h-6 w-6" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold truncate">{account.name}</h1>
          <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
            {account.domain && (
              <span className="flex items-center gap-1">
                <Globe className="h-3.5 w-3.5" />
                {account.domain}
              </span>
            )}
            {account.industry && <span>{account.industry}</span>}
            {account.size && <span>{account.size}</span>}
          </div>
        </div>
        {account.stage && <StatusBadge status={account.stage} />}
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <DetailCard label="Industry" value={account.industry} />
        <DetailCard label="Company Size" value={account.size} />
        <DetailCard label="Stage" value={account.stage} />
        <DetailCard label="External Source" value={account.externalSource} />
        <DetailCard label="External ID" value={account.externalId} />
        <DetailCard label="Last Synced" value={account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleDateString() : null} />
      </div>

      {/* Contacts section */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Contacts ({contacts?.length ?? 0})
        </h2>
        {contacts && contacts.length > 0 ? (
          <div className="border border-border">
            {contacts.map((c) => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unnamed";
              return (
                <EntityRow
                  key={c.id}
                  title={name}
                  subtitle={c.title || undefined}
                  to={`/crm/contacts/${c.id}`}
                  leading={
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                    </div>
                  }
                  trailing={
                    c.email ? (
                      <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                        <Mail className="h-3 w-3" />
                        {c.email}
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No contacts linked to this account.</p>
        )}
      </section>

      {/* Deals section */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Deals ({deals?.length ?? 0})
        </h2>
        {deals && deals.length > 0 ? (
          <div className="border border-border">
            {deals.map((d) => (
              <EntityRow
                key={d.id}
                title={d.name}
                subtitle={d.amount != null ? `${d.currency ?? "$"}${d.amount.toLocaleString()}` : undefined}
                leading={
                  <div className="flex h-7 w-7 items-center justify-center rounded bg-muted text-muted-foreground">
                    <Briefcase className="h-3.5 w-3.5" />
                  </div>
                }
                trailing={d.stage ? <StatusBadge status={d.stage} /> : undefined}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No deals for this account.</p>
        )}
      </section>
    </div>
  );
}

function DetailCard({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium mt-0.5">{value}</p>
    </div>
  );
}
