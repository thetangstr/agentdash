// AgentDash (OBS-2): when a daily token-ceiling pause lifts, said correctly.
//
// The ceiling's window is a UTC calendar day, and the server's `liftsAt` is
// the midnight UTC at the END of that day (e.g. 2026-10-14T00:00:00.000Z for
// the Oct 13 window). Rendering it with a local-time date formatter and then
// appending "UTC" printed "Oct 13, 2026 UTC" for any viewer west of
// Greenwich: a day early, and labelled with the wrong zone. This renders the
// actual instant in UTC, plus the viewer's own wall-clock time.

/**
 * "00:00 UTC on Oct 14, 2026 (5:00 PM Oct 13 your time)".
 *
 * The parenthetical is left out when the viewer's zone shows the same wall
 * time as UTC. `timeZone` defaults to the viewer's own; tests pass one.
 */
export function formatTokenCeilingLift(liftsAt: string | Date, timeZone?: string): string {
  const at = new Date(liftsAt);
  if (Number.isNaN(at.getTime())) return "midnight UTC";

  const utcTime = at.toLocaleTimeString("en-US", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const utcDate = at.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const utc = `${utcTime} UTC on ${utcDate}`;

  const localTime = at.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const localDate = at.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" });
  const sameAsUtc =
    localDate === at.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }) &&
    localTime === at.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
  if (sameAsUtc) return utc;
  return `${utc} (${localTime} ${localDate} your time)`;
}
