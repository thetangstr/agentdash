import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronRight, Users } from "lucide-react";
import { useLocation } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  getSidebarTeamAgentsStorageKey,
  readSidebarTeamAgentsExpanded,
  writeSidebarTeamAgentsExpanded,
} from "../lib/sidebar-team-agents";
import { cn } from "../lib/utils";
import { SidebarAgentRows, useSidebarAgentRows } from "./SidebarAgents";
import { SidebarNavItem } from "./SidebarNavItem";

// AgentDash: UX-6 follow-up — the "Team" item with the per-agent list nested
// under it, grouped by reporting line and expanded by default so agents are
// visible in the left bar; a collapse is remembered. The Team link still
// navigates to /agents; only the chevron toggles the list. "My agent" is
// the first row under Team, so the list always has something to disclose.
export function SidebarTeamItem() {
  const { selectedCompanyId } = useCompany();
  const rows = useSidebarAgentRows();
  // Sidebar IA: /org is the Team page's "Org chart" tab, so Team stays lit there.
  const { pathname } = useLocation();
  const onOrgChart = pathname.split("/").filter(Boolean)[1] === "org";
  const activeClass = onOrgChart ? "bg-accent text-foreground" : undefined;
  const storageKey = useMemo(
    () =>
      selectedCompanyId
        ? getSidebarTeamAgentsStorageKey(selectedCompanyId, rows.currentUserId)
        : null,
    [selectedCompanyId, rows.currentUserId],
  );
  const [expanded, setExpanded] = useState(() => readSidebarTeamAgentsExpanded(storageKey));

  // The user id arrives with the session query, so the key can change after
  // mount; re-read so the remembered state follows the right user/company.
  useEffect(() => {
    setExpanded(readSidebarTeamAgentsExpanded(storageKey));
  }, [storageKey]);

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(next) => {
        setExpanded(next);
        writeSidebarTeamAgentsExpanded(storageKey, next);
      }}
    >
      <div className="relative">
        <SidebarNavItem to="/agents" label="Team" icon={Users} className={cn("pr-9 max-sm:pr-12", activeClass)} />
        <CollapsibleTrigger
          aria-label={expanded ? "Hide agents" : "Show agents"}
          className="absolute right-1 top-1/2 flex h-6 w-6 max-sm:h-11 max-sm:w-11 -translate-y-1/2 items-center justify-center text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="pl-4">
        <SidebarNavItem to="/my-agent" label="My agent" icon={Bot} className="mt-0.5 py-1.5" />
        {rows.orderedAgents.length > 0 ? <SidebarAgentRows {...rows} /> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
