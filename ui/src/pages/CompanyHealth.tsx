import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { dashboardApi } from "@/api/dashboard";
import { ApiError } from "@/api/client";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { HarnessHealthPanel } from "@/components/HarnessHealthPanel";
import { TaskOutcomeQualityPanel } from "@/components/TaskOutcomeQualityPanel";

export function CompanyHealth() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Health" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to view health metrics.</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Health</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Operational health for this company's agents — harness run reliability and task outcome quality.
        </p>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading health metrics…</div>
      ) : error ? (
        <div className="text-sm text-destructive">
          {error instanceof ApiError && error.status === 403
            ? "You do not have permission to view company health metrics."
            : error instanceof Error
              ? error.message
              : "Failed to load health metrics."}
        </div>
      ) : data ? (
        <div className="space-y-4">
          <HarnessHealthPanel health={data.harness} />
          <TaskOutcomeQualityPanel quality={data.taskQuality} />
        </div>
      ) : null}
    </div>
  );
}
