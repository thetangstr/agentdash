// AgentDash: mobile redesign — the bottom nav's live height as a layout signal.
//
// Layout writes `--mobile-bottom-nav-offset` on <html>: the nav's full height
// (including the home-indicator safe area) while it is shown on a phone, and
// 0px when it has slid away on scroll or on desktop. Anything docked to the
// bottom of the viewport (chat composers, sticky action bars) can sit at
// `bottom: var(--mobile-bottom-nav-offset, 0px)` and follow the nav exactly.
// `data-mobile-bottom-nav` on <html> carries the same state for CSS selectors:
// "visible" | "hidden" | "none" (no bottom nav at this width).

export const MOBILE_BOTTOM_NAV_OFFSET_VAR = "--mobile-bottom-nav-offset";
/** The h-16 nav row plus the bottom safe-area inset it pads itself with. */
export const MOBILE_BOTTOM_NAV_VISIBLE_OFFSET = "calc(4rem + env(safe-area-inset-bottom, 0px))";

export type MobileBottomNavState = "visible" | "hidden" | "none";

export function mobileBottomNavState(isMobile: boolean, visible: boolean): MobileBottomNavState {
  if (!isMobile) return "none";
  return visible ? "visible" : "hidden";
}

export function mobileBottomNavOffset(isMobile: boolean, visible: boolean): string {
  return mobileBottomNavState(isMobile, visible) === "visible" ? MOBILE_BOTTOM_NAV_VISIBLE_OFFSET : "0px";
}

/** Writes the signal onto `root` (normally <html>); returns a cleanup that removes it. */
export function applyMobileBottomNavSignal(
  root: HTMLElement,
  isMobile: boolean,
  visible: boolean,
): () => void {
  root.style.setProperty(MOBILE_BOTTOM_NAV_OFFSET_VAR, mobileBottomNavOffset(isMobile, visible));
  root.dataset.mobileBottomNav = mobileBottomNavState(isMobile, visible);
  return () => {
    root.style.removeProperty(MOBILE_BOTTOM_NAV_OFFSET_VAR);
    delete root.dataset.mobileBottomNav;
  };
}
