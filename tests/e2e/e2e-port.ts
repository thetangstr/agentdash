// AgentDash (2026-10-05): 3199 is the live ExecOS instance on this machine and
// 3100/3120/3300 are other live local installs (see COMMON.md). A Playwright
// config that resolves to one of them either attaches to the wrong server
// (reuseExistingServer) or boots a throwaway instance that collides with it —
// and the no-webServer configs would drive a live product instance through
// test mutations. Refuse these ports no matter how they arrive: explicit
// PAPERCLIP_E2E_PORT, or a config's own hardcoded default.

export const RESERVED_E2E_SERVER_PORTS: readonly number[] = [3100, 3120, 3199, 3300];

/**
 * Resolve the HTTP port an e2e Playwright config or spec should use.
 * `defaultPort` is the caller's own free-port fallback when PAPERCLIP_E2E_PORT
 * is unset; an explicit env value always wins. Reserved live-instance ports are
 * refused on either path — the same shape as e2e-db-port.ts's 54329 guard.
 */
export function resolveE2eServerPort(defaultPort: number): number {
  const explicit = Number.parseInt(process.env.PAPERCLIP_E2E_PORT ?? "", 10);
  const port = Number.isInteger(explicit) && explicit > 0 ? explicit : defaultPort;
  if (RESERVED_E2E_SERVER_PORTS.includes(port)) {
    throw new Error(
      `Refusing to run Playwright e2e on port ${port} — that port belongs to a live local instance ` +
        `(PAPERCLIP_E2E_PORT=${process.env.PAPERCLIP_E2E_PORT ?? "unset"}). ` +
        `Ports ${RESERVED_E2E_SERVER_PORTS.join(", ")} are reserved. ` +
        `Set PAPERCLIP_E2E_PORT to a free port (e.g. a lane port in the 3451-3457 range).`,
    );
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `Invalid e2e server port ${port} ` +
        `(default=${defaultPort}, PAPERCLIP_E2E_PORT=${process.env.PAPERCLIP_E2E_PORT ?? "unset"}). ` +
        `Set PAPERCLIP_E2E_PORT to an integer between 1024 and 65535 that is not a live-instance port.`,
    );
  }
  return port;
}
