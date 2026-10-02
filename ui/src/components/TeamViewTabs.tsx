import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

// AgentDash: sidebar IA — the Team page's two views. "List" is /agents (the
// filterable agent list) and "Org chart" is /org; both URLs keep working, and
// the tabs are plain links so each view stays bookmarkable.
export type TeamView = "list" | "org";

const VIEWS: Array<{ value: TeamView; label: string; to: string }> = [
  { value: "list", label: "List", to: "/agents/all" },
  { value: "org", label: "Org chart", to: "/org" },
];

export function TeamViewTabs({ active, className }: { active: TeamView; className?: string }) {
  return (
    <nav aria-label="Team views" className={cn("flex items-center gap-1 border-b border-border", className)}>
      {VIEWS.map((view) => {
        const isActive = view.value === active;
        return (
          <Link
            key={view.value}
            to={view.to}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors max-sm:py-3",
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {view.label}
          </Link>
        );
      })}
    </nav>
  );
}
