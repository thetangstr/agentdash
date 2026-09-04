import { useEffect, useState } from "react";
import { FRESHNESS_POLL_MS, isStale } from "@/lib/build-freshness";

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

    const interval = window.setInterval(check, FRESHNESS_POLL_MS);
    // Also on focus: coming back to a tab left open overnight is exactly when
    // this matters, and waiting out the interval wastes the visit.
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    void check();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
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
        This tab is running an older version, so some screens may be missing or behave oddly.
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
