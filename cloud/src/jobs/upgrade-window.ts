// AgentDash: the nightly upgrade window (spec §6.1: 02:00 to 05:00 Pacific),
// SC-12 GH #773. The window is the `upgrade_window` setting ("HH:MM-HH:MM",
// or null for always open) in the `upgrade_window_tz` time zone. A window
// whose end is before its start wraps midnight (e.g. "23:00-02:00").

export const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export interface UpgradeWindow {
  /** Minutes after local midnight. */
  start: number;
  end: number;
  tz: string;
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Null when the window is "always" (no setting). Throws on a malformed value. */
export function parseWindow(raw: string | null, tz: string): UpgradeWindow | null {
  if (raw === null) return null;
  const m = WINDOW_RE.exec(raw);
  if (!m) throw new Error(`upgrade_window must look like 02:00-05:00, got ${raw}`);
  if (!isTimeZone(tz)) throw new Error(`upgrade_window_tz is not a time zone: ${tz}`);
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) throw new Error("upgrade_window must not be empty (start equals end)");
  return { start, end, tz };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes after local midnight of `at` in `tz`. */
export function localMinutes(at: Date, tz: string): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const min = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (h % 24) * 60 + min;
}

export function inWindow(at: Date, w: UpgradeWindow | null): boolean {
  if (!w) return true;
  const m = localMinutes(at, w.tz);
  return w.start < w.end ? m >= w.start && m < w.end : m >= w.start || m < w.end;
}

/** The next moment (to the minute) the window is open: `at` itself when it is open now. */
export function nextWindowStart(at: Date, w: UpgradeWindow | null): Date {
  if (inWindow(at, w)) return at;
  const base = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  // At most two days of minutes; DST shifts move the local clock by an hour at most.
  for (let i = 1; i <= 2 * 24 * 60; i++) {
    const t = new Date(base.getTime() + i * 60_000);
    if (inWindow(t, w)) return t;
  }
  return at;
}
