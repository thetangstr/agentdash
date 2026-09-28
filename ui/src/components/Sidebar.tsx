import {
  Inbox,
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
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialogActions } from "../context/DialogContext";
import { accessApi } from "@/api/access";
import { useCompany } from "../context/CompanyContext";
import { useDecisionsBadge } from "../hooks/useDecisionsBadge";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

export function Sidebar() {
  const { openNewIssue } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
  // AgentDash-MK: presentation only. The server 404s these routes off-profile,
  // so hiding the link is convenience, never the access control.
  const showMyAgentLink = selectedCompany?.productProfile === "agentdash_mk";
  // UX-7 (GH #788): the legacy inbox badge only matters where the Inbox still
  // exists — gating the hook skips its six queries on the default profile.
  const inboxBadge = useInboxBadge(selectedCompanyId, showMyAgentLink);
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
    enabled: !!selectedCompanyId && showMyAgentLink,
  });
  // Override is administrator-only and exceptional; the server enforces both,
  // so this only decides whether the entry point is offered.
  const showOverrideLink = showMyAgentLink && companyAccess?.access.canManageAgents === true;

  // AgentDash: UX-7 (GH #788) — the default profile's "Inbox" is the Decisions
  // page, and its badge IS the page's main-list length: pending approvals plus
  // issues assigned to you with a manual origin. Same query key as Home, so
  // the sidebar and both pages read one answer.
  const decisionsBadge = useDecisionsBadge(selectedCompanyId, !showMyAgentLink);

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
          {/* AgentDash: UX-3 (#784) — the dashboard is Home on the default profile. */}
          <SidebarNavItem
            to="/dashboard"
            label={showMyAgentLink ? "Dashboard" : "Home"}
            icon={LayoutDashboard}
            liveCount={liveRunCount}
          />
          {showMyAgentLink ? (
            <SidebarNavItem to="/my-agent" label="My Agent" icon={Bot} />
          ) : null}
          <SidebarNavItem to="/guides" label="Guides" icon={BookOpen} />
          {showOverrideLink ? (
            <SidebarNavItem to="/inbox/override" label="Override" icon={ShieldAlert} />
          ) : null}
          {/* AgentDash: UX-7 (GH #788) — Decisions on the default profile;
              the tabbed Inbox stays exactly as it was on agentdash_mk. */}
          {showMyAgentLink ? (
            <SidebarNavItem
              to="/inbox"
              label="Inbox"
              icon={Inbox}
              badge={inboxBadge.inbox}
              badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
              alert={inboxBadge.failedRuns > 0}
            />
          ) : (
            <SidebarNavItem
              to="/decisions"
              label="Decisions"
              icon={ShieldQuestion}
              badge={decisionsBadge}
            />
          )}
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        <SidebarSection label="Work">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          {/* AgentDash: UX-2 (#783) — default profile only; MK keeps its sidebar. */}
          {showMyAgentLink ? null : (
            <SidebarNavItem to="/shipped" label="Shipped" icon={PackageCheck} />
          )}
          <SidebarNavItem to="/routines" label="Routines" icon={Repeat} />
          <SidebarNavItem to="/goals" label="Goals" icon={Target} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label="Workspaces" icon={GitBranch} />
          ) : null}
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label="Company">
          <SidebarNavItem to="/org" label="Org" icon={Network} />
          <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
          <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
          <SidebarNavItem to="/evaluation" label="Evaluation" icon={Gauge} />
          <SidebarNavItem to="/billing" label="Billing" icon={CreditCard} />
          <SidebarNavItem to="/activity" label="Activity" icon={History} />
          <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
        </SidebarSection>

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
