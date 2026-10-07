// AgentDash: live-run auto-follow for the run transcript, shared by every
// transcript view (Business, Readable, Raw). Moved out of AgentDetail's
// LogViewer, fixing why a live run's transcript did not follow:
//
//   1. The scroll container was resolved (and cached) on mount, while the
//      run page was still showing "Loading run logs..." / "No log events." —
//      before the transcript pane and its end anchor existed. The lookup fell
//      back to `window` and kept it, so the follow logic scrolled the page
//      while the transcript lived in its own max-height pane, and scroll
//      listeners never saw the pane. A live run that has produced nothing yet
//      (a Hermes run just starting) always hit this. The container is now
//      resolved from a callback ref, so it is found when the anchor mounts.
//   2. Follow only re-ran when the number of run events or log lines changed.
//      Views whose content changes without new lines (the Readable view
//      regrouping, a late adapter parser, the Business timeline arriving)
//      did not follow. A ResizeObserver on the content now drives it, with a
//      `contentKey` dependency as the fallback.
//   3. A live run opened with more history than fits started unfollowed, so
//      new lines appeared off-screen. A live run now starts at the latest line.
//
// Since then it is the one auto-follow rule for every window where a
// conversation or transcript grows live (the run page, the issue chat and its
// embedded run surfaces, Ask / the Chief of Staff chat): stick to the latest
// output while the viewer is at (or within LIVE_SCROLL_BOTTOM_TOLERANCE_PX of)
// the bottom; any scroll up lets go at once and the position stays put as
// content grows; "Jump to latest" (or sending your own message) follows again.
//   - `startAt: "latest"` (default) opens at the latest line and follows.
//   - `startAt: "current"` leaves the opening position alone (a page that
//     opens at its top, or on a deep-linked comment) and only starts following
//     once the viewer scrolls to the bottom of a scrollable view themselves.
// Follow steps are instant, never smooth, so they never fight a streaming
// transcript or a reduced-motion preference.

import { useCallback, useEffect, useRef, useState } from "react";

export const LIVE_SCROLL_BOTTOM_TOLERANCE_PX = 32;
export type ScrollContainer = Window | HTMLElement;
export type AutoFollowStart = "latest" | "current";

/** True when the viewer asked the OS for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** "smooth", unless the viewer prefers reduced motion. */
export function preferredScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

function isWindowContainer(container: ScrollContainer): container is Window {
  return typeof window !== "undefined" && container === window;
}

function isElementScrollContainer(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

export function findScrollContainer(anchor: HTMLElement | null): ScrollContainer {
  let parent = anchor?.parentElement ?? null;
  while (parent) {
    if (isElementScrollContainer(parent)) return parent;
    parent = parent.parentElement;
  }
  return window;
}

export interface ScrollMetrics {
  scrollHeight: number;
  distanceFromBottom: number;
  /** The visible height of the container (the window's innerHeight for the page). */
  viewportHeight: number;
}

export function readScrollMetrics(container: ScrollContainer): ScrollMetrics {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const viewportBottom = window.scrollY + window.innerHeight;
    return {
      scrollHeight: pageHeight,
      distanceFromBottom: Math.max(0, pageHeight - viewportBottom),
      viewportHeight: window.innerHeight,
    };
  }
  const viewportBottom = container.scrollTop + container.clientHeight;
  return {
    scrollHeight: container.scrollHeight,
    distanceFromBottom: Math.max(0, container.scrollHeight - viewportBottom),
    viewportHeight: container.clientHeight,
  };
}

export function scrollToContainerBottom(container: ScrollContainer, behavior: ScrollBehavior = "auto") {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    window.scrollTo({ top: pageHeight, behavior });
    return;
  }
  if (typeof container.scrollTo === "function") container.scrollTo({ top: container.scrollHeight, behavior });
  else container.scrollTop = container.scrollHeight;
}

const UNKNOWN_METRICS: ScrollMetrics = {
  scrollHeight: 0,
  distanceFromBottom: Number.POSITIVE_INFINITY,
  viewportHeight: 0,
};

/**
 * Did the viewer scroll away from the bottom between two readings? Distance
 * the layout explains (content added below, a shorter viewport after a
 * resize) is not the viewer leaving; anything beyond it is, even when it
 * lands in the same frame as new output.
 */
function viewerScrolledAway(previous: ScrollMetrics, current: ScrollMetrics): boolean {
  if (!Number.isFinite(previous.distanceFromBottom)) return false;
  const growth = Math.max(0, current.scrollHeight - previous.scrollHeight);
  const viewportShrink = Math.max(0, previous.viewportHeight - current.viewportHeight);
  const movedAwayBy = current.distanceFromBottom - (previous.distanceFromBottom + growth + viewportShrink);
  return movedAwayBy > LIVE_SCROLL_BOTTOM_TOLERANCE_PX;
}

export interface LiveAutoFollow {
  /** Put on an empty element at the end of the transcript pane. */
  anchorRef: (element: HTMLElement | null) => void;
  /** Put on the transcript content; its size changes drive the follow. */
  contentRef: (element: HTMLElement | null) => void;
  /**
   * Optional: put on the scrolling pane when the view owns it. Without it the
   * nearest scrolling ancestor of the anchor (or the page) is used.
   */
  scrollerRef: (element: HTMLElement | null) => void;
  isFollowing: boolean;
  /** "Jump to latest": scroll to the end and follow again. */
  jumpToLatest: () => void;
  /** The resolved scroll container, once the anchor has mounted. */
  getContainer: () => ScrollContainer | null;
}

export function useLiveAutoFollow({
  live,
  resetKey,
  contentKey,
  startAt = "latest",
}: {
  live: boolean;
  /** Changes when a different run / conversation is shown. */
  resetKey: string;
  /** Anything that changes when the rendered transcript changes. */
  contentKey?: unknown;
  /** Where a newly shown transcript opens (see the file comment). */
  startAt?: AutoFollowStart;
}): LiveAutoFollow {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  // Bumped when a responsive layout moves the scrolling from the page to an
  // element (or back), so the listeners rebind to the new container.
  const [containerVersion, setContainerVersion] = useState(0);
  const containerRef = useRef<ScrollContainer | null>(null);
  const isFollowingRef = useRef(false);
  const lastMetricsRef = useRef<ScrollMetrics>(UNKNOWN_METRICS);

  const anchorRef = useCallback((element: HTMLElement | null) => setAnchor(element), []);
  const contentRef = useCallback((element: HTMLElement | null) => setContent(element), []);
  const scrollerRef = useCallback((element: HTMLElement | null) => setScroller(element), []);

  const getContainer = useCallback((): ScrollContainer | null => {
    if (containerRef.current) return containerRef.current;
    if (scroller) {
      containerRef.current = scroller;
      return scroller;
    }
    // Never resolve (and cache) before the anchor exists: that is how the
    // page-level window got stuck as the container.
    if (!anchor) return null;
    containerRef.current = findScrollContainer(anchor);
    return containerRef.current;
  }, [anchor, scroller]);

  const setFollowing = useCallback((next: boolean) => {
    isFollowingRef.current = next;
    setIsFollowing((prev) => (prev === next ? prev : next));
  }, []);

  const pinToBottom = useCallback((container: ScrollContainer) => {
    scrollToContainerBottom(container, "auto");
    lastMetricsRef.current = readScrollMetrics(container);
  }, []);

  const jumpToLatest = useCallback(() => {
    const container = getContainer();
    if (!container) return;
    pinToBottom(container);
    setFollowing(true);
  }, [getContainer, pinToBottom, setFollowing]);

  // A new run, a new anchor or a live/finished switch: resolve the container
  // again and, for startAt "latest", start at the latest line.
  useEffect(() => {
    containerRef.current = null;
    lastMetricsRef.current = UNKNOWN_METRICS;
    if (!live) {
      setFollowing(false);
      return;
    }
    const container = getContainer();
    if (!container) return;
    if (startAt === "latest") {
      pinToBottom(container);
      setFollowing(true);
      return;
    }
    lastMetricsRef.current = readScrollMetrics(container);
    setFollowing(false);
  }, [live, resetKey, anchor, scroller, getContainer, pinToBottom, setFollowing, startAt]);

  const follow = useCallback(() => {
    if (!live || !isFollowingRef.current) return;
    const container = getContainer();
    if (!container) return;
    const current = readScrollMetrics(container);
    // The viewer scrolled up between updates: let go.
    if (viewerScrolledAway(lastMetricsRef.current, current)) {
      lastMetricsRef.current = current;
      setFollowing(false);
      return;
    }
    pinToBottom(container);
  }, [live, getContainer, pinToBottom, setFollowing]);

  // Track whether the viewer is at the bottom.
  useEffect(() => {
    if (!live) return;
    const container = getContainer();
    if (!container) return;
    const onScroll = () => {
      const metrics = readScrollMetrics(container);
      const nearBottom = metrics.distanceFromBottom <= LIVE_SCROLL_BOTTOM_TOLERANCE_PX;
      if (isFollowingRef.current) {
        if (!nearBottom) {
          // Growth alone (content added below while following) is not the
          // viewer leaving the bottom: keep the baseline so the follow step
          // catches up. Anything beyond that growth is the viewer scrolling
          // up, even when it lands in the same frame as new output: release.
          if (!viewerScrolledAway(lastMetricsRef.current, metrics)) return;
          lastMetricsRef.current = metrics;
          setFollowing(false);
          return;
        }
        lastMetricsRef.current = metrics;
        return;
      }
      lastMetricsRef.current = metrics;
      if (!nearBottom) return;
      // startAt "current": a view that does not scroll yet (a page still
      // loading, a short thread) is not the viewer choosing the bottom.
      const scrollable = metrics.scrollHeight > metrics.viewportHeight + LIVE_SCROLL_BOTTOM_TOLERANCE_PX;
      if (startAt === "latest" || scrollable) setFollowing(true);
    };
    const onResize = () => {
      if (anchor && !scroller) {
        const next = findScrollContainer(anchor);
        if (next !== container) {
          containerRef.current = next;
          if (isFollowingRef.current) pinToBottom(next);
          else lastMetricsRef.current = readScrollMetrics(next);
          setContainerVersion((value) => value + 1);
          return;
        }
      }
      if (isFollowingRef.current) follow();
      else onScroll();
    };
    const target: Window | HTMLElement = container;
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [live, resetKey, anchor, scroller, getContainer, setFollowing, startAt, pinToBottom, follow, containerVersion]);

  // Follow on every render-visible content change.
  useEffect(() => {
    follow();
  }, [follow, contentKey]);

  // ...and on every size change of the content or of the scrolling pane
  // itself (a desktop-to-phone resize reflows both).
  useEffect(() => {
    if (!live || typeof ResizeObserver === "undefined") return;
    const container = getContainer();
    const paneElement = container && !isWindowContainer(container) ? container : null;
    if (!content && !paneElement) return;
    const observer = new ResizeObserver(() => follow());
    if (content) observer.observe(content);
    if (paneElement) observer.observe(paneElement);
    return () => observer.disconnect();
  }, [live, content, follow, getContainer, containerVersion]);

  return { anchorRef, contentRef, scrollerRef, isFollowing, jumpToLatest, getContainer };
}
