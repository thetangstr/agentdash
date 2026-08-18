/**
 * The public base URL is where BROWSERS reach this server. That is not the
 * same thing as where the process listens: on the MKThink Mini, Caddy
 * terminates TLS on :3112 and proxies to the app on :3102.
 *
 * Startup used to rewrite the configured public URL's port to the actual
 * listen port unconditionally, for any URL carrying an explicit port. The
 * intent was the local case — you configure http://localhost:3000, the port
 * is taken, `detectPort` moves you to 3001, and the configured URL should
 * follow. Applied to a proxy-fronted URL it does the opposite of what it
 * means: `https://host:3112` became `https://host:3102`, every Better Auth
 * trusted origin was built for :3102, and every browser arriving through
 * Caddy on :3112 was refused with `INVALID_ORIGIN`.
 *
 * That is not a cosmetic mismatch. It refuses sign-in and sign-up for every
 * human on the public URL, including anyone opening an invite link — the one
 * journey where the person cannot ask an admin to let them in, because they
 * are not in yet. Observed on the live instance 2026-08-17 and 2026-08-18.
 *
 * So the rewrite now fires only when the URL actually points at the port this
 * process asked for. If it names a different port, something else is serving
 * that port to the outside world and the URL is already correct.
 */
export function rewritePublicBaseUrlPort(
  rawUrl: string | undefined,
  ports: { requestedPort: number; listenPort: number },
): string | undefined {
  if (!rawUrl) return undefined;
  if (ports.requestedPort === ports.listenPort) return rawUrl;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  // The URL API normalizes default ports like :80/:443 to "", so treat them as
  // stable URLs: a public URL with no explicit port is not pointing at a port
  // this process could have been moved off.
  if (!parsed.port) return rawUrl;
  if (parsed.port !== String(ports.requestedPort)) return rawUrl;
  parsed.port = String(ports.listenPort);
  return parsed.toString();
}
