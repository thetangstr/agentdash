import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, LogOut, Plus, Settings, UserPlus } from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/context/CompanyContext";
import { NEW_COMPANY_PATH } from "../lib/onboarding-route";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "../context/SidebarContext";

interface SidebarCompanyMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SidebarCompanyMenu({ open: controlledOpen, onOpenChange }: SidebarCompanyMenuProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { selectedCompany, companies } = useCompany();
  const navigate = useNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  // AgentDash: UX-6 review (#787) — CompanyRail hides itself for a
  // single-company user (every company, one UX), which would orphan the
  // rail's "Add company" button. The menu keeps the path reachable on
  // self-hosted instances; hosted agentdash.cloud boxes bind exactly one
  // workspace.
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    staleTime: 60_000,
  });
  const showNewCompany =
    companies.filter((company) => company.status !== "archived").length <= 1 &&
    health?.hostedBox !== true;

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      if (isMobile) setSidebarOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto flex-1 justify-start gap-1 px-2 py-1.5 text-left"
          aria-label={selectedCompany ? `Open ${selectedCompany.name} menu` : "Open company menu"}
          disabled={!selectedCompany}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selectedCompany?.brandColor ? (
              <span
                className="size-4 shrink-0 rounded-sm"
                style={{ backgroundColor: selectedCompany.brandColor }}
              />
            ) : null}
            {/* AgentDash (c3-a11y): a clipped workspace name keeps its full
                text on hover. */}
            <span
              className="truncate text-sm font-bold text-foreground"
              title={selectedCompany?.name ?? undefined}
            >
              {selectedCompany?.name ?? "Select company"}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="truncate">
          {selectedCompany?.name ?? "Company"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/company/settings/invites" onClick={closeNavigationChrome}>
            <UserPlus className="size-4" />
            <span className="truncate">
              {selectedCompany ? `Invite people to ${selectedCompany.name}` : "Invite people"}
            </span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/company/settings" onClick={closeNavigationChrome}>
            <Settings className="size-4" />
            <span>Company settings</span>
          </Link>
        </DropdownMenuItem>
        {showNewCompany ? (
          <DropdownMenuItem
            onClick={() => {
              closeNavigationChrome();
              navigate(NEW_COMPANY_PATH);
            }}
          >
            <Plus className="size-4" />
            <span>New company</span>
          </DropdownMenuItem>
        ) : null}
        {session?.session ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => signOutMutation.mutate()}
              disabled={signOutMutation.isPending}
            >
              <LogOut className="size-4" />
              <span>{signOutMutation.isPending ? "Signing out..." : "Sign out"}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
