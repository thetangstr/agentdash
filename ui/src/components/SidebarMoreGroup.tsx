import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { SIDEBAR_MORE_ITEMS } from "../lib/sidebar-nav-items";
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

  // The user id arrives with the session query, so the key can change after
  // mount; re-read so the remembered state follows the right user/company.
  useEffect(() => {
    setOpen(readSidebarMoreExpanded(storageKey));
  }, [storageKey]);

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        writeSidebarMoreExpanded(storageKey, next);
      }}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors">
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
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
