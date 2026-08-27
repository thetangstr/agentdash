/**
 * The address this instance calls itself, when its operator has said one — which
 * is not the address any particular client happened to dial.
 *
 * Anything minted for a person to open must come from here, for the same reason
 * in two places:
 *
 * - The health route reports it so the UI can generate harness configuration
 *   against a stable host rather than `window.location.origin`. That origin is
 *   whatever URL was in the browser when someone pressed Copy, so a command
 *   copied from a LAN address bakes that address into `~/.codex/config.toml` on a
 *   colleague's laptop and silently stops working the moment they change network.
 *   A config that persists on someone else's machine is the worst place for that
 *   footgun.
 * - Approval links had the same shape of bug (#539): built from the caller's own
 *   transport address, they came out as `http://127.0.0.1:3102` — correct for the
 *   process that minted them and useless to the steward who had to read them.
 *
 * Not a secret. It is by definition the address people are told to use, and the
 * health endpoint already reports deployment mode and bootstrap state.
 */
export function configuredPublicBaseUrl(): string | undefined {
  const raw =
    process.env.PAPERCLIP_PUBLIC_URL?.trim()
    || process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

/**
 * Absolute URL for an approval's page, or `undefined` when this instance does not
 * advertise a public URL.
 *
 * Undefined rather than a loopback fallback, deliberately. A client that is told
 * "no answer" can say so; a client handed a plausible-looking wrong link passes it
 * to a human, who discovers the problem only when it fails to open.
 */
export function approvalUrl(approvalId: string): string | undefined {
  const base = configuredPublicBaseUrl();
  return base ? `${base}/approvals/${encodeURIComponent(approvalId)}` : undefined;
}
