import {
  Boxes,
  Clock3,
  Cpu,
  CreditCard,
  Download,
  FlaskConical,
  Gauge,
  GraduationCap,
  HeartPulse,
  Info,
  KeyRound,
  Link2,
  MailPlus,
  MonitorCog,
  Puzzle,
  ScrollText,
  Shield,
  SlidersHorizontal,
  Upload,
  UserRoundPen,
  type LucideIcon,
} from "lucide-react";

// AgentDash: sidebar IA — the one Settings navigation. SettingsSidebar
// renders these groups and CommandPalette indexes them, so a destination
// added here is reachable from both. Every item keeps its existing URL.

export interface SettingsNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Exact-match highlighting (for items whose URL prefixes another item's). */
  end?: boolean;
  /** Shows the pending join-request count. */
  joinRequestsBadge?: boolean;
}

export interface SettingsNavGroup {
  id: "workspace" | "agents" | "data" | "quality" | "account" | "instance";
  label: string;
  items: SettingsNavItem[];
}

export function settingsNavGroups({ isInstanceAdmin }: { isInstanceAdmin: boolean }): SettingsNavGroup[] {
  const groups: SettingsNavGroup[] = [
    {
      id: "workspace",
      label: "Workspace",
      items: [
        { to: "/company/settings", label: "General", icon: SlidersHorizontal, end: true },
        {
          to: "/company/settings/access",
          label: "Members & access",
          icon: Shield,
          end: true,
          joinRequestsBadge: true,
        },
        { to: "/company/settings/invites", label: "Invites", icon: MailPlus, end: true },
        { to: "/billing", label: "Billing", icon: CreditCard },
        { to: "/company/settings/model-key", label: "Model key", icon: KeyRound, end: true },
        { to: "/company/settings/connections", label: "Connections", icon: Link2, end: true },
      ],
    },
    {
      id: "agents",
      label: "Agents",
      items: [
        // AgentDash (#859 workforce): role templates, approved company
        // knowledge and first-job readiness. Lives under Settings › Agents
        // (with Team › Agents linking here), not as a top-level item.
        { to: "/workforce", label: "Workforce roles", icon: GraduationCap },
        { to: "/skills", label: "Skills", icon: Boxes },
        { to: "/company/settings/environments", label: "Environments", icon: MonitorCog, end: true },
        // Read-only for members; installing/removing adapters is instance-admin
        // only on the server.
        { to: "/instance/settings/adapters", label: "Adapters", icon: Cpu },
        // The scheduler view spans every company on the instance and the API
        // is instance-admin only, so members are not offered a page that 403s.
        ...(isInstanceAdmin
          ? [{ to: "/instance/settings/heartbeats", label: "Schedules", icon: Clock3, end: true }]
          : []),
      ],
    },
    {
      id: "data",
      label: "Data",
      items: [
        { to: "/company/import", label: "Import", icon: Upload },
        { to: "/company/export", label: "Export", icon: Download },
      ],
    },
    {
      id: "quality",
      label: "Quality",
      items: [
        { to: "/evaluation", label: "Evaluation", icon: Gauge },
        // Health's URL is under /company/settings, so it renders in this
        // layout; list it so the nav highlights it. Also in the Help menu.
        { to: "/company/settings/health", label: "Health", icon: HeartPulse, end: true },
      ],
    },
    {
      // Per-user pages that every member can open (the account menu links
      // them), so they are not behind the instance-admin check.
      id: "account",
      label: "Account",
      items: [
        { to: "/instance/settings/profile", label: "Profile", icon: UserRoundPen, end: true },
        { to: "/instance/settings/about", label: "About", icon: Info, end: true },
        { to: "/instance/settings/changelog", label: "Changelog", icon: ScrollText, end: true },
      ],
    },
  ];

  if (isInstanceAdmin) {
    groups.push({
      id: "instance",
      label: "Instance",
      items: [
        { to: "/instance/settings/general", label: "General", icon: SlidersHorizontal, end: true },
        { to: "/instance/settings/access", label: "Access", icon: Shield, end: true },
        { to: "/instance/settings/plugins", label: "Plugins", icon: Puzzle },
        { to: "/instance/settings/experimental", label: "Experimental", icon: FlaskConical },
      ],
    });
  }

  return groups;
}
