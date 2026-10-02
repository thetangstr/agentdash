import { useMemo } from "react";
import { NavLink, useLocation } from "@/lib/router";
import {
  House,
  CircleDot,
  SquarePen,
  Users,
  ShieldQuestion,
  MessageSquare,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useDecisionsBadge } from "../hooks/useDecisionsBadge";

interface MobileBottomNavProps {
  visible: boolean;
}

interface MobileNavLinkItem {
  type: "link";
  to: string;
  label: string;
  icon: typeof House;
  badge?: number;
}

interface MobileNavActionItem {
  type: "action";
  label: string;
  icon: typeof SquarePen;
  onClick: () => void;
}

type MobileNavItem = MobileNavLinkItem | MobileNavActionItem;

export function MobileBottomNav({ visible }: MobileBottomNavProps) {
  const location = useLocation();
  const { selectedCompanyId } = useCompany();
  // AgentDash: UX-6/UX-7 (#787/#788) + one UX (doc/plans/2026-09-30-one-ux.md)
  // — the same five slots for every company: Home/Work/Ask/Decisions/Team.
  // The Decisions badge is #817's useDecisionsBadge, one number everywhere.
  const decisionsBadge = useDecisionsBadge(selectedCompanyId);

  const items = useMemo<MobileNavItem[]>(
    () => [
      { type: "link", to: "/dashboard", label: "Home", icon: House },
      { type: "link", to: "/issues", label: "Work", icon: CircleDot },
      { type: "link", to: "/cos", label: "Ask", icon: MessageSquare },
      {
        type: "link",
        to: "/decisions",
        label: "Decisions",
        icon: ShieldQuestion,
        badge: decisionsBadge,
      },
      { type: "link", to: "/agents", label: "Team", icon: Users },
    ],
    [decisionsBadge],
  );

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 transition-transform duration-200 ease-out md:hidden pb-[env(safe-area-inset-bottom)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      <div className="grid h-16 grid-cols-5 pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))]">
        {items.map((item) => {
          if (item.type === "action") {
            const Icon = item.icon;
            const active = /\/issues\/new(?:\/|$)/.test(location.pathname);
            return (
              <button
                key={item.label}
                type="button"
                onClick={item.onClick}
                className={cn(
                  "relative flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          }

          const Icon = item.icon;
          return (
            <NavLink
              key={item.label}
              to={item.to}
              state={SIDEBAR_SCROLL_RESET_STATE}
              className={({ isActive }) =>
                cn(
                  "relative flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon className={cn("h-[18px] w-[18px]", isActive && "stroke-[2.3]")} />
                    {item.badge != null && item.badge > 0 && (
                      <span className="absolute -right-2 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-xs leading-none text-text-inverse">
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </span>
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
