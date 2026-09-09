const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

/**
 * How long until a deadline, or null once it has passed.
 *
 * `timeAgo` only counts backwards, so an approval's `expiresAt` had nowhere to
 * be rendered and was shown nowhere at all — a decision could lapse with the
 * steward never having seen a clock. Null rather than a negative duration keeps
 * the two cases distinct at the call site: "expires in 4h" and "expired" are
 * different sentences, not the same one with a sign flip.
 */
export function timeUntil(date: Date | string): string | null {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return null;
  if (seconds < MINUTE) return "under a minute";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
  return `${Math.floor(seconds / DAY)}d`;
}

/**
 * How long something has been waiting, as a bare duration.
 *
 * The counterpart to `timeUntil`, and the reason it exists: composing a label
 * from `timeAgo` produced "waiting 2d ago", because `timeAgo` already ends in
 * "ago". Its output is a complete phrase and does not compose. This returns
 * just the duration, so a caller can put its own words around it.
 */
export function timeSince(date: Date | string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < MINUTE) return "under a minute";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
  return `${Math.floor(seconds / DAY)}d`;
}

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return `${m}m ago`;
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return `${h}h ago`;
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return `${d}d ago`;
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return `${w}w ago`;
  }
  const mo = Math.floor(seconds / MONTH);
  return `${mo}mo ago`;
}
