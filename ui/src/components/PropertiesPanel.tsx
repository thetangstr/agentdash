import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import {
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  usePanel,
} from "../context/PanelContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const KEYBOARD_RESIZE_STEP = 24;

export function PropertiesPanel() {
  const { panelContent, panelVisible, panelWidth, setPanelVisible, setPanelWidth } = usePanel();
  const [isResizing, setIsResizing] = useState(false);

  const resizeTo = useCallback((width: number) => {
    setPanelWidth(clampPanelWidth(width));
  }, [setPanelWidth]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = panelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      resizeTo(startWidth + startX - moveEvent.clientX);
    };

    const handlePointerUp = () => {
      setIsResizing(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }, [panelWidth, resizeTo]);

  if (!panelContent) return null;

  return (
    <aside
      className={cn(
        "relative hidden h-full shrink-0 flex-col overflow-hidden border-l border-border bg-card md:flex",
        isResizing
          ? "transition-opacity duration-200 ease-in-out"
          : "transition-[width,opacity] duration-200 ease-in-out",
      )}
      style={{ width: panelVisible ? panelWidth : 0, opacity: panelVisible ? 1 : 0 }}
    >
      {panelVisible ? (
        <div
          role="separator"
          aria-label="Resize properties panel"
          aria-orientation="vertical"
          aria-valuemin={PANEL_WIDTH_MIN}
          aria-valuemax={PANEL_WIDTH_MAX}
          aria-valuenow={panelWidth}
          tabIndex={0}
          className="group absolute inset-y-0 left-0 z-20 flex w-4 cursor-col-resize items-center justify-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerDown={handleResizePointerDown}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              resizeTo(panelWidth + KEYBOARD_RESIZE_STEP);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              resizeTo(panelWidth - KEYBOARD_RESIZE_STEP);
            } else if (event.key === "Home") {
              event.preventDefault();
              resizeTo(PANEL_WIDTH_MIN);
            } else if (event.key === "End") {
              event.preventDefault();
              resizeTo(PANEL_WIDTH_MAX);
            }
          }}
        >
          <span
            className={
              isResizing
                ? "h-12 w-0.5 rounded-full bg-primary"
                : "h-10 w-px rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary"
            }
          />
        </div>
      ) : null}
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <span className="text-sm font-medium">Properties</span>
          <Button variant="ghost" size="icon-xs" onClick={() => setPanelVisible(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-4">{panelContent}</div>
        </ScrollArea>
      </div>
    </aside>
  );
}
