// AgentDash (2026-10-02 incident): every e2e webServer boots a throwaway
// `paperclipai onboard --yes --run` instance whose embedded Postgres must
// NEVER land on 54329. That port belongs to the live travel instance on this
// machine; while it was restarting an e2e run bound 54329 first and the
// travel instance then attached to the e2e database. The server only shifts
// off a configured port when it is already busy, so the fix has to happen
// here: give every e2e config an explicit, derived DB port, and refuse to
// resolve to the reserved one.

const RESERVED_EMBEDDED_POSTGRES_PORT = 54329;
const E2E_DB_PORT_OFFSET = 20_000;

/**
 * The embedded Postgres port for an e2e webServer instance. `PAPERCLIP_E2E_DB_PORT`
 * wins when set; otherwise `serverPort + 20_000` so each Playwright config gets a
 * deterministic, non-overlapping port. Throws — never silently returns — when the
 * result is the reserved live-instance port or outside the valid range.
 */
export function resolveE2eEmbeddedPostgresPort(serverPort: number): number {
  const explicit = Number.parseInt(process.env.PAPERCLIP_E2E_DB_PORT ?? "", 10);
  const port =
    Number.isInteger(explicit) && explicit > 0 ? explicit : serverPort + E2E_DB_PORT_OFFSET;
  if (port === RESERVED_EMBEDDED_POSTGRES_PORT) {
    throw new Error(
      `Refusing to start e2e embedded PostgreSQL on reserved port ${RESERVED_EMBEDDED_POSTGRES_PORT} ` +
        `(PAPERCLIP_E2E_PORT=${process.env.PAPERCLIP_E2E_PORT ?? "unset"}, ` +
        `PAPERCLIP_E2E_DB_PORT=${process.env.PAPERCLIP_E2E_DB_PORT ?? "unset"}). ` +
        `Pick a different PAPERCLIP_E2E_PORT or set PAPERCLIP_E2E_DB_PORT explicitly.`,
    );
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `Invalid e2e embedded PostgreSQL port ${port} ` +
        `(serverPort=${serverPort}, PAPERCLIP_E2E_DB_PORT=${process.env.PAPERCLIP_E2E_DB_PORT ?? "unset"}).`,
    );
  }
  return port;
}
