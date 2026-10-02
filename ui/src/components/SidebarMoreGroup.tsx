import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { SIDEBAR_MORE_ITEMS } from "../lib/sidebar-nav-items";
import { useLocation } from "@/lib/router";
import { toCompanyRelativePath } from "../lib/company-routes";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import {
  getSidebarMoreStorageKey,
  readSidebarMoreExpanded,
  writeSidebarMoreExpanded,
} from "../lib/sidebar-more";
import { cn } from "../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarNavItem } from "./SidebarNavItem";

// AgentDash: sidebar IA — the only secondary group in the sidebar. Exactly
// four work destinations that are not one of the six primary items; all
// configuration lives in the Settings hub, help pages in the Help menu.
// Collapsed by default; the expanded state is remembered per user per company.
// On one of its own pages the group is shown open regardless, so the active
// item is visible and highlighted; that does not overwrite the remembered state.

/** Whether a (company-prefixed or bare) pathname is one of the More items or below it. */
export function isSidebarMoreRoute(pathname: string): boolean {
  const path = toCompanyRelativePath(pathname).split(/[?#]/)[0]!;
  return SIDEBAR_MORE_ITEMS.some((item) => path === item.to || path.startsWith(`${item.to}/`));
}

export function SidebarMoreGroup() {
  const { selectedCompanyId } = useCompany();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const storageKey = useMemo(
    () => (selectedCompanyId ? getSidebarMoreStorageKey(selectedCompanyId, currentUserId) : null),
    [selectedCompanyId, currentUserId],
  );
  const [open, setOpen] = useState(() => readSidebarMoreExpanded(storageKey));
  const { pathname } = useLocation();
  const onMoreRoute = isSidebarMoreRoute(pathname);
  // Collapsing by hand while on a More page is respected until the route changes.
  const [collapsedOnRoute, setCollapsedOnRoute] = useState<string | null>(null);
  const shownOpen = open || (onMoreRoute && collapsedOnRoute !== pathname);

  // The user id arrives with the session query, so the key can change after
  // mount; re-read so the remembered state follows the right user/company.
  useEffect(() => {
    setOpen(readSidebarMoreExpanded(storageKey));
  }, [storageKey]);

  return (
    <Collapsible
      open={shownOpen}
      onOpenChange={(next) => {
        setOpen(next);
        setCollapsedOnRoute(next ? null : pathname);
        writeSidebarMoreExpanded(storageKey, next);
      }}
    >
      <CollapsibleTrigger data-sidebar-nav-item="" className="flex w-full items-center gap-1.5 px-3 py-1.5 max-sm:min-h-11 text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors">
        <ChevronRight className={cn("h-3 w-3 transition-transform", shownOpen && "rotate-90")} />
        More
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5 mt-0.5">
        {SIDEBAR_MORE_ITEMS.map((item) => (
          <SidebarNavItem key={item.to} to={item.to} label={item.label} icon={item.icon} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
