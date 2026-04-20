// AgentDash: Skill version management page (CUJ-10)
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { companySkillsApi } from "../api/companySkills";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Blocks, ShieldCheck, ShieldAlert, Shield } from "lucide-react";
import type { CompanySkillListItem } from "@agentdash/shared";

function trustIcon(trust: string) {
  if (trust === "markdown_only") return <ShieldCheck className="h-4 w-4 text-green-500" />;
  if (trust === "assets") return <Shield className="h-4 w-4 text-blue-500" />;
  return <ShieldAlert className="h-4 w-4 text-amber-500" />;
}

export function SkillVersions() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Skill Versions" }]);
  }, [setBreadcrumbs]);

  const { data: skills, isLoading, error } = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId!),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Blocks} message="Select a company to manage skills." />;
  }

  if (isLoading) return <PageSkeleton variant="list" />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;

  if (!skills || skills.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Skill Versions</h2>
        <EmptyState icon={Blocks} message="No skills installed yet." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Skill Versions</h2>
        <span className="text-xs text-muted-foreground">
          {skills.length} skill{skills.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="border border-border">
        {skills.map((skill: CompanySkillListItem) => (
          <EntityRow
            key={skill.id}
            title={skill.name}
            subtitle={[skill.sourceType, skill.sourceRef].filter(Boolean).join(" @ ") || undefined}
            to={`/skills/${skill.id}`}
            leading={trustIcon(skill.trustLevel ?? "unvetted")}
            trailing={
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{skill.sourceType}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                  skill.trustLevel === "markdown_only"
                    ? "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400"
                    : skill.trustLevel === "assets"
                      ? "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                      : "bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400"
                }`}>
                  {skill.trustLevel}
                </span>
              </div>
            }
          />
        ))}
      </div>
    </div>
  );
}
