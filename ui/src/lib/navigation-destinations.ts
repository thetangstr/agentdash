import {
  Bot,
  CircleDot,
  GitBranch,
  Hexagon,
  LayoutDashboard,
  MessageSquare,
  Network,
  PackageCheck,
  ShieldAlert,
  ShieldQuestion,
  Users,
  type LucideIcon,
} from "lucide-react";
import { SIDEBAR_HELP_ITEMS, SIDEBAR_MORE_ITEMS } from "./sidebar-nav-items";
import { settingsNavGroups } from "./settings-nav";

// AgentDash: sidebar IA — every navigation destination the command palette
// offers. The sidebar shows only the six primary items, More and the footer;
// everything else (settings pages, help pages, destinations that left the
// sidebar) stays reachable by search here.

export interface NavigationDestination {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Extra words cmdk matches on (old names, synonyms, the settings group). */
  keywords?: string;
  /** Muted hint shown after the label, e.g. the settings group. */
  hint?: string;
}

export interface NavigationDestinationGroup {
  heading: string;
  items: NavigationDestination[];
}

export function navigationDestinationGroups({
  isInstanceAdmin,
  isCompanyAdmin,
  workspacesEnabled,
}: {
  isInstanceAdmin: boolean;
  isCompanyAdmin: boolean;
  workspacesEnabled: boolean;
}): NavigationDestinationGroup[] {
  const pages: NavigationDestination[] = [
    { to: "/dashboard", label: "Home", icon: LayoutDashboard, keywords: "dashboard overview" },
    { to: "/cos", label: "Ask", icon: MessageSquare, keywords: "chief of staff chat cos" },
    { to: "/issues", label: "Work", icon: CircleDot, keywords: "issues tasks" },
    { to: "/decisions", label: "Decisions", icon: ShieldQuestion, keywords: "inbox approvals" },
    { to: "/shipped", label: "Shipped", icon: PackageCheck },
    { to: "/agents", label: "Team", icon: Users, keywords: "agents" },
    { to: "/org", label: "Org chart", icon: Network, keywords: "org team hierarchy" },
    { to: "/projects", label: "Projects", icon: Hexagon },
    { to: "/my-agent", label: "My agent", icon: Bot, keywords: "personal channels" },
  ];
  // AgentDash (security, GH #971 review): the override inbox is an
  // owner/admin view on the server — the destination hides for everyone
  // else, matching the gate the page itself enforces.
  if (isInstanceAdmin || isCompanyAdmin) {
    pages.push({ to: "/inbox/override", label: "Override", icon: ShieldAlert, keywords: "override inbox" });
  }
  if (workspacesEnabled) {
    pages.push({ to: "/workspaces", label: "Workspaces", icon: GitBranch });
  }

  return [
    { heading: "Pages", items: pages },
    { heading: "More", items: SIDEBAR_MORE_ITEMS.map((item) => ({ ...item })) },
    { heading: "Help", items: SIDEBAR_HELP_ITEMS.map((item) => ({ ...item })) },
    {
      heading: "Settings",
      items: settingsNavGroups({ isInstanceAdmin }).flatMap((group) =>
        group.items.map((item) => ({
          to: item.to,
          label: item.label,
          icon: item.icon,
          hint: group.label,
          keywords: `settings ${group.label}`,
        })),
      ),
    },
  ];
}
