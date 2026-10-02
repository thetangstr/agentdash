import { CircleHelp } from "lucide-react";
import { Link } from "@/lib/router";
import { useSidebar } from "../context/SidebarContext";
import { SIDEBAR_HELP_ITEMS } from "../lib/sidebar-nav-items";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// AgentDash: sidebar IA — help pages live behind one "?" in the sidebar
// footer instead of taking rows in the navigation. A real menu (the shared
// DropdownMenu primitive): menu semantics, arrow-key navigation, Escape.

export function SidebarHelpMenu() {
  const { isMobile, setSidebarOpen } = useSidebar();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Help"
          title="Help"
          className="flex h-8 w-8 max-sm:h-11 max-sm:w-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <CircleHelp className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-44" aria-label="Help">
        {SIDEBAR_HELP_ITEMS.map((item) => (
          <DropdownMenuItem
            key={item.to}
            asChild
            onSelect={() => {
              if (isMobile) setSidebarOpen(false);
            }}
          >
            <Link to={item.to} className="text-[13px]">
              <item.icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
