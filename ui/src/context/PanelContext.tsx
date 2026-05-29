import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const VISIBILITY_STORAGE_KEY = "paperclip:panel-visible";
const WIDTH_STORAGE_KEY = "paperclip:panel-width";

export const PANEL_WIDTH_DEFAULT = 320;
export const PANEL_WIDTH_MIN = 280;
export const PANEL_WIDTH_MAX = 560;

export function clampPanelWidth(width: number) {
  if (!Number.isFinite(width)) return PANEL_WIDTH_DEFAULT;
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(width)));
}

interface PanelContextValue {
  panelContent: ReactNode | null;
  panelVisible: boolean;
  panelWidth: number;
  openPanel: (content: ReactNode) => void;
  closePanel: () => void;
  setPanelVisible: (visible: boolean) => void;
  setPanelWidth: (width: number) => void;
  togglePanelVisible: () => void;
}

const PanelContext = createContext<PanelContextValue | null>(null);

function readPreference(): boolean {
  try {
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function readWidthPreference(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    return raw === null ? PANEL_WIDTH_DEFAULT : clampPanelWidth(Number(raw));
  } catch {
    return PANEL_WIDTH_DEFAULT;
  }
}

function writePreference(visible: boolean) {
  try {
    localStorage.setItem(VISIBILITY_STORAGE_KEY, String(visible));
  } catch {
    // Ignore storage failures.
  }
}

function writeWidthPreference(width: number) {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore storage failures.
  }
}

export function PanelProvider({ children }: { children: ReactNode }) {
  const [panelContent, setPanelContent] = useState<ReactNode | null>(null);
  const [panelVisible, setPanelVisibleState] = useState(readPreference);
  const [panelWidth, setPanelWidthState] = useState(readWidthPreference);

  const openPanel = useCallback((content: ReactNode) => {
    setPanelContent(content);
  }, []);

  const closePanel = useCallback(() => {
    setPanelContent(null);
  }, []);

  const setPanelVisible = useCallback((visible: boolean) => {
    setPanelVisibleState(visible);
    writePreference(visible);
  }, []);

  const setPanelWidth = useCallback((width: number) => {
    const next = clampPanelWidth(width);
    setPanelWidthState(next);
    writeWidthPreference(next);
  }, []);

  const togglePanelVisible = useCallback(() => {
    setPanelVisibleState((prev) => {
      const next = !prev;
      writePreference(next);
      return next;
    });
  }, []);

  return (
    <PanelContext.Provider
      value={{
        panelContent,
        panelVisible,
        panelWidth,
        openPanel,
        closePanel,
        setPanelVisible,
        setPanelWidth,
        togglePanelVisible,
      }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanel() {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within PanelProvider");
  }
  return ctx;
}
