import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Settings } from "lucide-react";
import { sidebarBadgesApi } from "@/api/sidebarBadges";
import { pluginsApi } from "@/api/plugins";
import { ApiError } from "@/api/client";
import { Link, NavLink } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { settingsNavGroups } from "@/lib/settings-nav";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCapabilities } from "@/hooks/useCapability";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";

// AgentDash: sidebar IA — the one Settings navigation. It replaces the
// separate company-settings and instance-settings sidebars: Workspace, Agents,
// Data, Quality and Account for everyone, plus an Instance section shown only
// to instance admins (by who the user is, never by the company's profile).
// Layout shows it for every path isSettingsHubPath() accepts.
export function SettingsSidebar() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { data: capabilities } = useCapabilities(selectedCompanyId);
  const isInstanceAdmin = capabilities?.isInstanceAdmin === true;

  const { data: badges } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.sidebarBadges(selectedCompanyId)
      : ["sidebar-badges", "__disabled__"] as const,
    queryFn: async () => {
      try {
        return await sidebarBadgesApi.get(selectedCompanyId!);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      }
    },
    enabled: !!selectedCompanyId,
    retry: false,
    refetchInterval: 15_000,
  });

  // The plugin registry is instance-admin only; members never ask for it.
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    enabled: isInstanceAdmin,
    retry: false,
  });

  const groups = settingsNavGroups({ isInstanceAdmin });

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex flex-col gap-1 px-3 py-3 shrink-0">
        <Link
          to="/dashboard"
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          data-sidebar-nav-item=""
          className="flex items-center gap-1.5 rounded-md px-2 py-1 max-sm:min-h-11 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{selectedCompany?.name ?? "Company"}</span>
        </Link>
        <div className="flex items-center gap-2 px-2 py-1">
          <Settings className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-sm font-bold text-foreground">Settings</span>
        </div>
      </div>

      <nav
        aria-label="Settings"
        className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2"
      >
        {groups.map((group) => (
          <div key={group.id} data-testid={`settings-nav-${group.id}`}>
            <SidebarSection label={group.label}>
              {group.items.map((item) => (
                <SidebarNavItem
                  key={item.to}
                  to={item.to}
                  label={item.label}
                  icon={item.icon}
                  end={item.end}
                  badge={item.joinRequestsBadge ? badges?.joinRequests ?? 0 : undefined}
                />
              ))}
              {group.id === "instance" && (plugins ?? []).length > 0 ? (
                <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-3">
                  {(plugins ?? []).map((plugin) => (
                    <NavLink
                      key={plugin.id}
                      to={`/instance/settings/plugins/${plugin.id}`}
                      state={SIDEBAR_SCROLL_RESET_STATE}
                      className={({ isActive }) =>
                        [
                          "rounded-md px-2 py-1.5 text-xs transition-colors max-sm:flex max-sm:min-h-11 max-sm:items-center",
                          isActive
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        ].join(" ")
                      }
                    >
                      {plugin.manifestJson.displayName ?? plugin.packageName}
                    </NavLink>
                  ))}
                </div>
              ) : null}
            </SidebarSection>
          </div>
        ))}
      </nav>
    </aside>
  );
}
