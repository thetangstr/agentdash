import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Target, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { goalsApi } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";

export function Goals() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const goalsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.goals.list(selectedCompanyId) : ["goals", "none"],
    queryFn: () => (selectedCompanyId ? goalsApi.list(selectedCompanyId) : Promise.resolve([])),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  const goals = goalsQuery.data ?? [];
  const prefix = selectedCompany?.issuePrefix;

  if (goals.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Target}
          message="Start a new goal to drive focused work across your agents and teams."
          action="New Goal"
          onAction={() => openNewGoal({ hideParentSelector: true })}
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Goals</h1>
        <Button onClick={() => openNewGoal({ hideParentSelector: true })} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          New Goal
        </Button>
      </div>
      <div className="rounded-md border border-border divide-y divide-border">
        {goals.map((goal) => (
          <Link
            key={goal.id}
            to={prefix ? `/${prefix}/goals/${goal.id}` : `/goals/${goal.id}`}
            className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{goal.title}</div>
              {goal.description ? (
                <div className="text-sm text-muted-foreground truncate">{goal.description}</div>
              ) : null}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-muted-foreground uppercase">{goal.level}</span>
              <StatusBadge status={goal.status} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
