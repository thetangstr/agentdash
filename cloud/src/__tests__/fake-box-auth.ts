// The box's CLI-auth approval routes (server/src/routes/access.ts,
// server/src/services/board-auth.ts), faked for the cloud MCP toolset's
// connect step: create a challenge, read it with its secret, cancel it, and
// (as the PERSON, signed in on their box) approve it, which activates the
// pending board key. Same shapes and token formats as the real box.
import { randomBytes, randomUUID } from "node:crypto";

export interface FakeChallenge {
  id: string;
  host: string;
  secret: string;
  pendingKey: string;
  command: string;
  clientName: string | null;
  requestedAccess: string;
  status: "pending" | "approved" | "cancelled";
  approvedAt: Date | null;
  expiresAt: Date;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeBoxAuth {
  readonly challenges = new Map<string, FakeChallenge>();
  /** Board keys the box accepts (activated by approval). */
  readonly boardKeys = new Set<string>();
  readonly calls: string[] = [];
  /** Answer every call with this status instead (an unreachable or broken box). */
  down: number | null = null;

  constructor(private readonly opts: { domain?: string; fallback?: typeof fetch } = {}) {}

  /** The person, signed in on their box, clicks Approve. Like the box, a cancelled or expired request cannot be approved. */
  approve(id: string): boolean {
    const c = this.challenges.get(id);
    if (!c) throw new Error(`no challenge ${id}`);
    if (c.status !== "pending" || c.expiresAt <= new Date()) return false;
    c.status = "approved";
    c.approvedAt = new Date();
    this.boardKeys.add(c.pendingKey);
    return true;
  }

  /** The person clicks Cancel. */
  cancelByPerson(id: string): void {
    this.challenges.get(id)!.status = "cancelled";
  }

  expire(id: string): void {
    this.challenges.get(id)!.expiresAt = new Date(Date.now() - 1000);
  }

  latest(): FakeChallenge | undefined {
    return [...this.challenges.values()].at(-1);
  }

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const domain = this.opts.domain ?? "agentdash.cloud";
    if (!url.hostname.endsWith(`.${domain}`) || !url.pathname.startsWith("/api/cli-auth/")) {
      if (this.opts.fallback) return await this.opts.fallback(input, init);
      return json(599, { error: `fake box: unexpected ${method} ${url.href}` });
    }
    this.calls.push(`${method} ${url.hostname}${url.pathname}`);
    if (this.down) return new Response("<html>waking</html>", { status: this.down, headers: { "content-type": "text/html" } });
    // The real box's order (board-auth.ts challengeStatusForRow): cancelled,
    // then expired, then approved, so an approved request reads `expired`
    // after its 10 minutes, with approvedAt still set.
    const status = (c: FakeChallenge) => (c.status === "cancelled" ? "cancelled" : c.expiresAt <= new Date() ? "expired" : c.status);
    if (method === "POST" && url.pathname === "/api/cli-auth/challenges") {
      const b = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const c: FakeChallenge = {
        id: randomUUID(),
        host: url.hostname,
        secret: `pcp_cli_auth_${randomBytes(24).toString("hex")}`,
        pendingKey: `pcp_board_${randomBytes(24).toString("hex")}`,
        command: String(b.command),
        clientName: typeof b.clientName === "string" ? b.clientName : null,
        requestedAccess: String(b.requestedAccess ?? "board"),
        status: "pending",
        approvedAt: null,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      };
      this.challenges.set(c.id, c);
      const approvalPath = `/cli-auth/${c.id}?token=${encodeURIComponent(c.secret)}`;
      return json(201, {
        id: c.id,
        token: c.secret,
        boardApiToken: c.pendingKey,
        approvalPath,
        approvalUrl: `https://${url.hostname}${approvalPath}`,
        pollPath: `/cli-auth/challenges/${c.id}`,
        expiresAt: c.expiresAt.toISOString(),
        suggestedPollIntervalMs: 1000,
      });
    }
    const m = /^\/api\/cli-auth\/challenges\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    const c = m ? this.challenges.get(decodeURIComponent(m[1]!)) : undefined;
    if (m && method === "GET" && !m[2]) {
      if (!c || c.host !== url.hostname || url.searchParams.get("token") !== c.secret) return json(404, { error: "CLI auth challenge not found" });
      return json(200, { id: c.id, status: status(c), command: c.command, clientName: c.clientName, requestedAccess: c.requestedAccess, approvedAt: c.approvedAt?.toISOString() ?? null, expiresAt: c.expiresAt.toISOString(), requiresSignIn: true, canApprove: false });
    }
    if (m && method === "POST" && m[2]) {
      const token = (JSON.parse(String(init?.body ?? "{}")) as { token?: string }).token;
      if (!c || token !== c.secret) return json(404, { error: "CLI auth challenge not found" });
      const now = status(c);
      if (now !== "pending") return json(200, { status: now, cancelled: false });
      c.status = "cancelled";
      return json(200, { status: "cancelled", cancelled: true });
    }
    return json(404, { error: "not found" });
  }) as typeof fetch;
}
