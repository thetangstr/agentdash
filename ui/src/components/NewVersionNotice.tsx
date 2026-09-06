import { useEffect, useState } from "react";
import { FRESHNESS_POLL_MS, isStale, looksLikeStaleAssetError } from "@/lib/build-freshness";

/**
 * Tells a person their tab is running an old build, and lets them decide.
 *
 * Deliberately a notice and not a reload. An unsaved mandate draft lives only
 * in this tab, so reloading to fix staleness could destroy the work this
 * product most wants people to do. It is also dismissible: someone mid-edit
 * should be able to make it go away, finish, and reload when they are ready.
 */
export function NewVersionNotice() {
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const next = await isStale();
      if (!cancelled && next) setStale(true);
    };

    /**
     * A chunk that will not load is the strongest possible evidence, and it
     * arrives before any poll would.
     *
     * Unlike the polls, this shows the notice WITHOUT confirming against
     * index.html first. The polls stay quiet on uncertainty because nagging
     * someone for no reason is worse than silence — but here something the
     * person can see has already failed to load, so offering a reload is the
     * right response even if the cause turned out to be a transient network
     * blip.
     */
    const onStaleAsset = () => {
      if (!cancelled) setStale(true);
    };

    // Vite's own hook, and it is cancelable: preventing the throw turns what
    // would have been a blank screen into this notice.
    const onPreloadError = (event: Event) => {
      event.preventDefault();
      onStaleAsset();
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (looksLikeStaleAssetError(event.reason)) onStaleAsset();
    };
    const onWindowError = (event: ErrorEvent) => {
      if (looksLikeStaleAssetError(event.error ?? event.message)) onStaleAsset();
    };

    window.addEventListener("vite:preloadError", onPreloadError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onWindowError);

    // Retained as the fallback they always were: a tab that never navigates
    // never triggers a chunk load, so it would otherwise never find out.
    const interval = window.setInterval(check, FRESHNESS_POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    void check();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("vite:preloadError", onPreloadError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onWindowError);
    };
  }, []);

  if (!stale || dismissed) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-[9998] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
    >
      <p className="font-medium">AgentDash has been updated.</p>
      <p className="mt-1 text-muted-foreground">
        This tab is running an older version, so parts of it may fail to load or behave oddly.
        Reload when you are ready — anything unsaved here will be lost.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded border border-foreground bg-foreground px-2 py-1 font-medium text-background"
        >
          Reload
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded border border-border px-2 py-1 hover:bg-muted"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
