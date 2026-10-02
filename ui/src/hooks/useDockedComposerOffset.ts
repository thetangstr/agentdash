import { useEffect, type RefObject } from "react";

/**
 * AgentDash: mobile redesign. A composer docked above the bottom nav publishes
 * its height on <html> as `--mobile-docked-composer-height`, so other
 * bottom-anchored UI (the toast stack) can sit above both the nav and the
 * composer. It is 0px whenever no docked composer is mounted.
 */
export const MOBILE_DOCKED_COMPOSER_HEIGHT_VAR = "--mobile-docked-composer-height";

export function useDockedComposerOffset(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!enabled || !el) return;
    const publish = () => {
      root.style.setProperty(MOBILE_DOCKED_COMPOSER_HEIGHT_VAR, `${Math.round(el.getBoundingClientRect().height)}px`);
    };
    publish();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(MOBILE_DOCKED_COMPOSER_HEIGHT_VAR);
    };
  }, [ref, enabled]);
}
