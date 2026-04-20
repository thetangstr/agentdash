import { Fragment, useMemo } from "react";
import { Link } from "@/lib/router";
import { Menu } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";

// AgentDash: luxury control-plane breadcrumb bar.
// Replaces the shadcn Breadcrumb primitive with a luxe-styled mono trail using
// `/` separators, taller chrome, and a hairline rule. The global-toolbar plugin
// outlet is preserved. Mobile still gets a hamburger on the left.

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

function GlobalToolbarPlugins({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({
    placementZones: ["globalToolbarButton"],
    companyId: context.companyId,
    enabled: !!context.companyId,
  });
  if (slots.length === 0 && launchers.length === 0) return null;
  return (
    <div className="flex items-center gap-1 ml-auto shrink-0 pl-2">
      <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
    </div>
  );
}

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { selectedCompanyId, selectedCompany } = useCompany();

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = <GlobalToolbarPlugins context={globalToolbarSlotContext} />;

  const menuButton = isMobile && (
    <Button
      variant="ghost"
      size="icon-sm"
      className="mr-2 shrink-0"
      onClick={toggleSidebar}
      aria-label="Open sidebar"
    >
      <Menu className="h-5 w-5" />
    </Button>
  );

  return (
    <div className="border-b border-border bg-background px-4 md:px-6 h-12 shrink-0 flex items-center">
      {menuButton}
      <div className="min-w-0 overflow-hidden flex-1">
        {breadcrumbs.length === 0 ? (
          <span className="lux-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">AgentDash</span>
        ) : (
          <div className="lux-crumbs">
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <Fragment key={i}>
                  {i > 0 && <span className="sep" aria-hidden>/</span>}
                  {isLast || !crumb.href ? (
                    <span className={isLast ? "here truncate" : "truncate"}>{crumb.label}</span>
                  ) : (
                    <Link to={crumb.href} className="truncate hover:text-foreground transition-colors">
                      {crumb.label}
                    </Link>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
      {globalToolbarSlots}
    </div>
  );
}
