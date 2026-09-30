import {
  CircleDot,
  Target,
  Gauge,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Bot,
  BookOpen,
  ShieldAlert,
  ShieldQuestion,
  Boxes,
  Repeat,
  GitBranch,
  Settings,
  CreditCard,
  PackageCheck,
  MessageSquare,
  ChevronRight,
  Clock3,
  Puzzle,
  Cpu,
  FlaskConical,
  ScrollText,
  Activity,
  Monitor,
  Download,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarTeamItem } from "./SidebarTeamItem";
import { useDialogActions } from "../context/DialogContext";
import { accessApi } from "@/api/access";
import { useCompany } from "../context/CompanyContext";
import { useDecisionsBadge } from "../hooks/useDecisionsBadge";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useCapabilities } from "../hooks/useCapability";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { cn } from "../lib/utils";

export function Sidebar() {
  const { openNewIssue } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const { data: companyAccess } = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  // Override is administrator-only and exceptional; the server enforces both
  // (and its capability gate), so this only decides whether the entry point
  // is offered — by who the user is, never by the company's profile.
  const showOverrideLink = companyAccess?.access.canManageAgents === true;

  // AgentDash: one UX (doc/plans/2026-09-30-one-ux.md) — one sidebar for every
  // company. The Decisions badge IS the page's main-list length (#817's
  // useDecisionsBadge), so the sidebar, Home and the page read one number.
  const decisionsBadge = useDecisionsBadge(selectedCompanyId);

  // UX-6 (#787) review: the /instance/settings links are instance-admin only —
  // the same signal InstanceAccess uses, via the shared capabilities query.
  const { data: capabilities } = useCapabilities(selectedCompanyId);
  const isInstanceAdmin = capabilities?.isInstanceAdmin === true;

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
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Issue button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
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

        {/* Advanced: everything the six items don't cover, collapsed by
            default. No "Inbox" entry — /inbox redirects to /decisions. */}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors">
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform",
                advancedOpen && "rotate-90",
              )}
            />
            Advanced
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-0.5 mt-0.5">
            <SidebarNavItem to="/my-agent" label="My Agent" icon={Bot} />
            {showOverrideLink ? (
              <SidebarNavItem to="/inbox/override" label="Override" icon={ShieldAlert} />
            ) : null}
            <SidebarNavItem to="/guides" label="Guides" icon={BookOpen} />
            <SidebarNavItem to="/routines" label="Routines" icon={Repeat} />
            <SidebarNavItem to="/goals" label="Goals" icon={Target} />
            {showWorkspacesLink ? (
              <SidebarNavItem to="/workspaces" label="Workspaces" icon={GitBranch} />
            ) : null}
            <SidebarNavItem to="/org" label="Org" icon={Network} />
            <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
            <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
            <SidebarNavItem to="/evaluation" label="Evaluation" icon={Gauge} />
            <SidebarNavItem to="/billing" label="Billing" icon={CreditCard} />
            <SidebarNavItem to="/activity" label="Activity" icon={History} />
            <SidebarNavItem to="/company/import" label="Import" icon={Upload} />
            <SidebarNavItem to="/company/export" label="Export" icon={Download} />
            <SidebarNavItem
              to="/company/settings/environments"
              label="Environments"
              icon={Monitor}
            />
            <SidebarNavItem
              to="/company/settings/health"
              label="Health"
              icon={Activity}
            />
            {isInstanceAdmin ? (
              <>
                <SidebarNavItem
                  to="/instance/settings/heartbeats"
                  label="Heartbeats"
                  icon={Clock3}
                />
                <SidebarNavItem
                  to="/instance/settings/plugins"
                  label="Plugins"
                  icon={Puzzle}
                />
                <SidebarNavItem
                  to="/instance/settings/adapters"
                  label="Adapters"
                  icon={Cpu}
                />
                <SidebarNavItem
                  to="/instance/settings/experimental"
                  label="Experimental"
                  icon={FlaskConical}
                />
                <SidebarNavItem
                  to="/instance/settings/changelog"
                  label="Changelog"
                  icon={ScrollText}
                />
              </>
            ) : null}
            {/* The per-project list lives here too — one place for everything
                that is not one of the six. */}
            <div className="mt-2">
              <SidebarProjects />
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="mt-auto border-t border-border pt-2">
          <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
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
