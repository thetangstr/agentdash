// AgentDash: CRM Accounts list page
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { crmApi } from "../api/crm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Building2 } from "lucide-react";

export function CrmAccounts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "CRM" },
      { label: "Accounts" },
    ]);
  }, [setBreadcrumbs]);

  const { data: accounts, isLoading, error } = useQuery({
    queryKey: queryKeys.crm.accounts(selectedCompanyId!),
    queryFn: () => crmApi.listAccounts(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Building2} message="Select a company to view accounts." />;
  }

  if (isLoading) return <PageSkeleton variant="list" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  if (!accounts || accounts.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Accounts</h2>
        <EmptyState icon={Building2} message="No accounts yet." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Accounts</h2>
        <span className="text-xs text-muted-foreground">
          {accounts.length} account{accounts.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="border border-border">
        {accounts.map((account) => (
          <EntityRow
            key={account.id}
            title={account.name}
            subtitle={[account.industry, account.size].filter(Boolean).join(" · ") || undefined}
            to={`/crm/accounts/${account.id}`}
            leading={
              <div className="flex h-8 w-8 items-center justify-center rounded bg-muted text-muted-foreground">
                <Building2 className="h-4 w-4" />
              </div>
            }
            trailing={
              <div className="flex items-center gap-3">
                {account.domain && (
                  <span className="hidden sm:inline text-xs text-muted-foreground">{account.domain}</span>
                )}
                {account.stage && <StatusBadge status={account.stage} />}
              </div>
            }
          />
        ))}
      </div>
    </div>
  );
}
