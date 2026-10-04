import { Link } from "@/lib/router";
import { ChevronLeft, Menu } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, useMemo } from "react";
import { cn } from "@/lib/utils";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

function GlobalToolbarPlugins({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], companyId: context.companyId, enabled: !!context.companyId });
  if (slots.length === 0 && launchers.length === 0) return null;
  return (
    <div className="flex items-center gap-1 ml-auto shrink-0 pl-2">
      <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
    </div>
  );
}

export function BreadcrumbBar() {
  const { breadcrumbs, mobileToolbar } = useBreadcrumbs();
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

  if (isMobile && mobileToolbar) {
    return (
      <div className="border-b border-border px-2 h-12 shrink-0 flex items-center">
        {mobileToolbar}
      </div>
    );
  }

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

  if (breadcrumbs.length === 0) {
    // AgentDash: a page that registers no breadcrumb (Billing, Workforce)
    // still gets the sidebar menu and the workspace name on phones —
    // otherwise the top bar is empty and the nav is unreachable.
    return (
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center justify-end">
        {menuButton}
        {isMobile && selectedCompany ? (
          <div className="min-w-0 flex-1 overflow-hidden">
            <h1 className="text-sm font-semibold uppercase tracking-wider truncate">{selectedCompany.name}</h1>
          </div>
        ) : null}
        {globalToolbarSlots}
      </div>
    );
  }

  // Single breadcrumb = page title (uppercase)
  if (breadcrumbs.length === 1) {
    return (
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          <h1 className="text-sm font-semibold uppercase tracking-wider truncate">
            {breadcrumbs[0].label}
          </h1>
        </div>
        {globalToolbarSlots}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail. On phones the bar shows ONE
  // back chevron — the closest linked parent — plus the page name; earlier
  // crumbs, every separator and the chevron's text twin are desktop-only.
  // The chevron announces "Up to <parent>" (not "Back to …") so it can never
  // collide with a page's own "Back to Home"/"Back to runs" link.
  const phoneParentIndex = breadcrumbs.reduce(
    (found, crumb, i) => (!crumb.href || i === breadcrumbs.length - 1 ? found : i),
    -1,
  );

  return (
    <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
      {menuButton}
      <div className="min-w-0 overflow-hidden flex-1">
        <Breadcrumb className="min-w-0 overflow-hidden">
          <BreadcrumbList className="flex-nowrap">
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              const isPhoneParent = i === phoneParentIndex;
              return (
                <Fragment key={i}>
                  {i > 0 && <BreadcrumbSeparator className="max-sm:hidden" />}
                  <BreadcrumbItem
                    className={cn(
                      // AgentDash (c3 follow-up): the last crumb may shrink on
                      // phones too — the parent is a chevron there, so a very
                      // long page title truncates with an ellipsis instead of
                      // overflowing the bar.
                      isLast ? "min-w-0" : "shrink-0",
                      !isLast && !isPhoneParent && "max-sm:hidden",
                    )}
                  >
                    {isLast || !crumb.href ? (
                      <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                    ) : isPhoneParent ? (
                      <>
                        {/* AgentDash (c3-a11y): the phone parent is a back
                            chevron — a truncated "W"/"Worl" reads as noise and
                            still eats page-name space. Separate links keep the
                            desktop crumb's real name (a shared aria-label
                            renames it at every width and collided with pages'
                            own back links — first-run e2e). */}
                        <BreadcrumbLink asChild className="sm:hidden">
                          <Link
                            to={crumb.href}
                            aria-label={`Up to ${crumb.label}`}
                            className="inline-flex min-h-11 min-w-11 items-center"
                          >
                            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                          </Link>
                        </BreadcrumbLink>
                        <BreadcrumbLink asChild className="max-sm:hidden">
                          <Link to={crumb.href} className="min-w-0 truncate">
                            {crumb.label}
                          </Link>
                        </BreadcrumbLink>
                      </>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link to={crumb.href} className="min-w-0 truncate">
                          {crumb.label}
                        </Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {globalToolbarSlots}
    </div>
  );
}
