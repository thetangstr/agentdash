import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { Boxes, Tag, History, Pin, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";

export function SkillVersions() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;

  const { data: skills = [], isLoading } = useQuery({
    queryKey: ["skills", cid],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${cid}/skills`);
      return res.json();
    },
    enabled: !!cid,
  });

  const [expandedSkills, setExpandedSkills] = useState<Record<string, boolean>>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;
  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  const statusColors: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700",
    deprecated: "bg-amber-100 text-amber-700",
    draft: "bg-slate-100 text-slate-600",
  };

  const toggleExpanded = (skillId: string) => {
    setExpandedSkills((prev) => ({ ...prev, [skillId]: !prev[skillId] }));
  };

  const handlePin = async (skillId: string) => {
    setActionLoading(`pin-${skillId}`);
    try {
      await fetch(`/api/companies/${cid}/skills/${skillId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRollback = async (skillId: string) => {
    setActionLoading(`rollback-${skillId}`);
    try {
      await fetch(`/api/companies/${cid}/skills/${skillId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Boxes className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold">Skill Versions</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage skill versions, pin releases, and rollback when needed
            </p>
          </div>
        </div>
      </div>

      {skills.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center space-y-3">
          <Boxes className="h-10 w-10 mx-auto text-muted-foreground" />
          <h3 className="font-semibold text-lg">No skills registered</h3>
          <p className="text-muted-foreground text-sm max-w-md mx-auto">
            Skills will appear here once they are registered for this company.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill: any) => {
            const version = skill.version ?? skill.metadata?.version ?? "1.0.0";
            const status = skill.status ?? "active";
            const usageCount = skill.installCount ?? skill.usageCount ?? skill.metadata?.usageCount;
            const isExpanded = expandedSkills[skill.id] ?? false;
            const versions = skill.versions ?? skill.metadata?.versions ?? [];

            return (
              <div
                key={skill.id}
                className="rounded-xl border bg-card p-5 space-y-3 hover:border-foreground/20 transition-colors"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold truncate">{skill.name}</h3>
                    {skill.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                        {skill.description}
                      </p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[status] ?? "bg-muted text-muted-foreground"}`}
                  >
                    {status}
                  </span>
                </div>

                {/* Version + Usage */}
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5" />
                    v{version}
                  </span>
                  {usageCount != null && (
                    <span className="flex items-center gap-1.5">
                      <Boxes className="h-3.5 w-3.5" />
                      {usageCount} {usageCount === 1 ? "use" : "uses"}
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-2 border-t">
                  <button
                    onClick={() => handlePin(skill.id)}
                    disabled={actionLoading === `pin-${skill.id}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50"
                  >
                    <Pin className="h-3.5 w-3.5" />
                    {actionLoading === `pin-${skill.id}` ? "Pinning..." : "Pin Version"}
                  </button>
                  <button
                    onClick={() => handleRollback(skill.id)}
                    disabled={actionLoading === `rollback-${skill.id}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {actionLoading === `rollback-${skill.id}` ? "Rolling back..." : "Rollback"}
                  </button>
                </div>

                {/* Version History (collapsible) */}
                {versions.length > 0 && (
                  <div className="pt-2 border-t">
                    <button
                      onClick={() => toggleExpanded(skill.id)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                      <History className="h-3.5 w-3.5" />
                      Version History ({versions.length})
                    </button>
                    {isExpanded && (
                      <div className="mt-2 space-y-1.5 pl-5">
                        {versions.map((v: any, idx: number) => (
                          <div
                            key={v.version ?? idx}
                            className="flex items-center justify-between text-xs"
                          >
                            <span className="font-medium">
                              v{v.version ?? v.tag ?? `${idx + 1}`}
                            </span>
                            <span className="text-muted-foreground">
                              {v.releasedAt
                                ? new Date(v.releasedAt).toLocaleDateString()
                                : v.createdAt
                                  ? new Date(v.createdAt).toLocaleDateString()
                                  : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
