import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { Link } from "@/lib/router";
import { useSidebar } from "../context/SidebarContext";
import { SIDEBAR_HELP_ITEMS } from "../lib/sidebar-nav-items";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// AgentDash: sidebar IA — help pages live behind one "?" in the sidebar
// footer instead of taking rows in the navigation.

export function SidebarHelpMenu() {
  const [open, setOpen] = useState(false);
  const { isMobile, setSidebarOpen } = useSidebar();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Help"
          title="Help"
          className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <CircleHelp className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-44 p-1">
        <div role="menu" aria-label="Help" className="flex flex-col">
          {SIDEBAR_HELP_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                if (isMobile) setSidebarOpen(false);
              }}
              className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
