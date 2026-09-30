import { Activity, BookOpen, DollarSign, History, Repeat, ScrollText, Target } from "lucide-react";

// AgentDash: sidebar IA — the sidebar's secondary destinations, shared by the
// sidebar and the command palette.

/** The collapsed "More" group: exactly four work destinations. */
export const SIDEBAR_MORE_ITEMS = [
  { to: "/goals", label: "Goals", icon: Target },
  { to: "/routines", label: "Routines", icon: Repeat },
  { to: "/costs", label: "Costs", icon: DollarSign },
  { to: "/activity", label: "Activity", icon: History },
] as const;

/** The footer Help ("?") menu. */
export const SIDEBAR_HELP_ITEMS = [
  { to: "/guides", label: "Guides", icon: BookOpen },
  { to: "/instance/settings/changelog", label: "Changelog", icon: ScrollText },
  { to: "/company/settings/health", label: "Health", icon: Activity },
] as const;
