import { NavLink } from "@/lib/router";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import type { LucideIcon } from "lucide-react";

// AgentDash: luxe sidebar nav item.
// Active state uses accent-tinted surface + left-edge 2px rule (.lux-nav-item).
// Badges use mono pill tags for the editorial feel.

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  className?: string;
  badge?: number;
  badgeTone?: "default" | "danger";
  textBadge?: string;
  textBadgeTone?: "default" | "amber";
  alert?: boolean;
  liveCount?: number;
}

export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  end,
  className,
  badge,
  badgeTone = "default",
  textBadge,
  textBadgeTone = "default",
  alert = false,
  liveCount,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();

  return (
    <NavLink
      to={to}
      end={end}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          "lux-nav-item flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium rounded-sm transition-colors",
          isActive
            ? "is-active bg-accent text-accent-foreground"
            : "text-foreground/80 hover:bg-accent/40 hover:text-foreground",
          className,
        )
      }
    >
      <span className="relative shrink-0">
        <Icon className="h-3.5 w-3.5" />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-destructive shadow-[0_0_0_2px_var(--background)]" />
        )}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {textBadge && (
        <span
          className={cn(
            "ml-auto rounded-sm px-1.5 py-0.5 text-[9.5px] font-medium leading-none lux-mono tracking-[0.1em] uppercase",
            textBadgeTone === "amber"
              ? "bg-[color-mix(in_oklab,var(--chart-3)_25%,transparent)] text-[color-mix(in_oklab,var(--chart-3)_85%,var(--foreground))]"
              : "bg-muted text-muted-foreground",
          )}
        >
          {textBadge}
        </span>
      )}
      {liveCount != null && liveCount > 0 && (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          <span className="text-[10px] font-medium text-primary lux-mono tracking-[0.04em]">{liveCount} live</span>
        </span>
      )}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[10px] leading-none lux-mono lux-tnum",
            badgeTone === "danger"
              ? "bg-destructive text-destructive-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}
