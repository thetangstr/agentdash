import { useEffect } from "react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Target } from "lucide-react";

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

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
