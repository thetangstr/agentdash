import {
  CircleDot,
  LayoutDashboard,
  Search,
  SquarePen,
  ShieldQuestion,
  Settings,
  PackageCheck,
  MessageSquare,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarTeamItem } from "./SidebarTeamItem";
import { SidebarMoreGroup } from "./SidebarMoreGroup";
import { SidebarHelpMenu } from "./SidebarHelpMenu";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useDecisionsBadge } from "../hooks/useDecisionsBadge";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

export function Sidebar() {
  const { openNewIssue } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  // AgentDash: one UX (doc/plans/2026-09-30-one-ux.md) — one sidebar for every
  // company. The Decisions badge IS the page's main-list length (#817's
  // useDecisionsBadge), so the sidebar, Home and the page read one number.
  const decisionsBadge = useDecisionsBadge(selectedCompanyId);

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={openSearch}
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Issue button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            data-sidebar-nav-item=""
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium max-sm:min-h-11 max-sm:text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">New Issue</span>
          </button>
          {/* AgentDash: the six primary items (UX-6 #787), the same for every
              company. Team → /agents, with the per-agent list nested under it
              (collapsed by default) — still one primary item. */}
          <SidebarNavItem to="/dashboard" label="Home" icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem to="/cos" label="Ask" icon={MessageSquare} />
          <SidebarNavItem to="/issues" label="Work" icon={CircleDot} />
          <SidebarNavItem to="/decisions" label="Decisions" icon={ShieldQuestion} badge={decisionsBadge} />
          <SidebarNavItem to="/shipped" label="Shipped" icon={PackageCheck} />
          <SidebarTeamItem />
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        {/* AgentDash: sidebar IA — the one secondary group. Configuration
            lives in the Settings hub (footer gear), help pages behind the
            footer "?"; nothing else belongs in this sidebar. */}
        <SidebarMoreGroup />

        <div className="mt-auto flex items-center gap-1 border-t border-border pt-2">
          <div className="min-w-0 flex-1">
            <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
          </div>
          <SidebarHelpMenu />
        </div>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
