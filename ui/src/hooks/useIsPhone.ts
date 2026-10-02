// AgentDash: mobile lists (lane B) — the phone breakpoint for list pages.
//
// Phones are anything narrower than Tailwind's `sm` breakpoint (640px), so a
// component that swaps layouts with this hook agrees with the `sm:` classes it
// sits next to. SidebarContext's `isMobile` (768px) is the Layout's concern and
// stays separate: a 700px tablet keeps the desktop list layouts.
import { useSyncExternalStore } from "react";

export const PHONE_MAX_WIDTH_PX = 639;
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;

function getMediaQueryList(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(PHONE_MEDIA_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const mql = getMediaQueryList();
  if (!mql) return () => {};
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return getMediaQueryList()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/** True when the viewport is phone-sized (narrower than 640px). */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
