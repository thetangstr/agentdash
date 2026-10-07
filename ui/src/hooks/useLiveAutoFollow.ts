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
import { useCallback, useEffect, useRef, useState } from "react";

export const LIVE_SCROLL_BOTTOM_TOLERANCE_PX = 32;
export type ScrollContainer = Window | HTMLElement;

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

export function readScrollMetrics(container: ScrollContainer): { scrollHeight: number; distanceFromBottom: number } {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const viewportBottom = window.scrollY + window.innerHeight;
    return { scrollHeight: pageHeight, distanceFromBottom: Math.max(0, pageHeight - viewportBottom) };
  }
  const viewportBottom = container.scrollTop + container.clientHeight;
  return {
    scrollHeight: container.scrollHeight,
    distanceFromBottom: Math.max(0, container.scrollHeight - viewportBottom),
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

export interface LiveAutoFollow {
  /** Put on an empty element at the end of the transcript pane. */
  anchorRef: (element: HTMLElement | null) => void;
  /** Put on the transcript content; its size changes drive the follow. */
  contentRef: (element: HTMLElement | null) => void;
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
}: {
  live: boolean;
  /** Changes when a different run is shown. */
  resetKey: string;
  /** Anything that changes when the rendered transcript changes. */
  contentKey?: unknown;
}): LiveAutoFollow {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const containerRef = useRef<ScrollContainer | null>(null);
  const isFollowingRef = useRef(false);
  const lastMetricsRef = useRef({ scrollHeight: 0, distanceFromBottom: Number.POSITIVE_INFINITY });

  const anchorRef = useCallback((element: HTMLElement | null) => setAnchor(element), []);
  const contentRef = useCallback((element: HTMLElement | null) => setContent(element), []);

  const getContainer = useCallback((): ScrollContainer | null => {
    if (containerRef.current) return containerRef.current;
    // Never resolve (and cache) before the anchor exists: that is how the
    // page-level window got stuck as the container.
    if (!anchor) return null;
    containerRef.current = findScrollContainer(anchor);
    return containerRef.current;
  }, [anchor]);

  const setFollowing = useCallback((next: boolean) => {
    isFollowingRef.current = next;
    setIsFollowing((prev) => (prev === next ? prev : next));
  }, []);

  const jumpToLatest = useCallback(() => {
    const container = getContainer();
    if (!container) return;
    scrollToContainerBottom(container, "auto");
    lastMetricsRef.current = readScrollMetrics(container);
    setFollowing(true);
  }, [getContainer, setFollowing]);

  // A new run, a new anchor or a live/finished switch: resolve the container
  // again and, for a live run, start at the latest line.
  useEffect(() => {
    containerRef.current = null;
    lastMetricsRef.current = { scrollHeight: 0, distanceFromBottom: Number.POSITIVE_INFINITY };
    if (!live) {
      setFollowing(false);
      return;
    }
    const container = getContainer();
    if (!container) return;
    scrollToContainerBottom(container, "auto");
    lastMetricsRef.current = readScrollMetrics(container);
    setFollowing(true);
  }, [live, resetKey, anchor, getContainer, setFollowing]);

  // Track whether the viewer is at the bottom.
  useEffect(() => {
    if (!live) return;
    const container = getContainer();
    if (!container) return;
    const onScroll = () => {
      const metrics = readScrollMetrics(container);
      const previous = lastMetricsRef.current;
      const nearBottom = metrics.distanceFromBottom <= LIVE_SCROLL_BOTTOM_TOLERANCE_PX;
      if (!nearBottom && isFollowingRef.current) {
        // Growth alone (content added below while following) is not the
        // viewer leaving the bottom: keep the baseline so the follow step
        // catches up. Anything beyond that growth is the viewer scrolling
        // up, even when it lands in the same frame as new output: release.
        const growth = Math.max(0, metrics.scrollHeight - previous.scrollHeight);
        const movedAwayBy = metrics.distanceFromBottom - (previous.distanceFromBottom + growth);
        if (!(Number.isFinite(previous.distanceFromBottom) && movedAwayBy > LIVE_SCROLL_BOTTOM_TOLERANCE_PX)) return;
      }
      lastMetricsRef.current = metrics;
      setFollowing(nearBottom);
    };
    const target: Window | HTMLElement = container;
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [live, resetKey, getContainer, setFollowing]);

  const follow = useCallback(() => {
    if (!live || !isFollowingRef.current) return;
    const container = getContainer();
    if (!container) return;
    const previous = lastMetricsRef.current;
    const current = readScrollMetrics(container);
    const growth = Math.max(0, current.scrollHeight - previous.scrollHeight);
    const movedAwayBy = current.distanceFromBottom - (previous.distanceFromBottom + growth);
    // The viewer scrolled up between updates: let go.
    if (Number.isFinite(previous.distanceFromBottom) && movedAwayBy > LIVE_SCROLL_BOTTOM_TOLERANCE_PX) {
      lastMetricsRef.current = current;
      setFollowing(false);
      return;
    }
    scrollToContainerBottom(container, "auto");
    lastMetricsRef.current = readScrollMetrics(container);
  }, [live, getContainer, setFollowing]);

  // Follow on every render-visible content change.
  useEffect(() => {
    follow();
  }, [follow, contentKey]);

  useEffect(() => {
    if (!live || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => follow());
    observer.observe(content);
    return () => observer.disconnect();
  }, [live, content, follow]);

  return { anchorRef, contentRef, isFollowing, jumpToLatest, getContainer };
}
