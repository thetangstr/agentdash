/**
 * AgentDash assistant MCP (GH #677): the OAuth 2.1 vocabulary shared by the
 * authorization server, the actor middleware's route allowlist, and the UI.
 *
 * Scope semantics come from the assistant-MCP design doc §4.2:
 *  - `agentdash:read`   — the whole M1 read surface
 *  - `agentdash:work`   — creating/moving work and waking agents
 *  - `agentdash:decide` — resolving approvals and hiring; opt-in at consent,
 *                         never granted by default
 */
export const ASSISTANT_SCOPE_READ = "agentdash:read";
export const ASSISTANT_SCOPE_WORK = "agentdash:work";
export const ASSISTANT_SCOPE_DECIDE = "agentdash:decide";

export const ASSISTANT_SCOPES = [
  ASSISTANT_SCOPE_READ,
  ASSISTANT_SCOPE_WORK,
  ASSISTANT_SCOPE_DECIDE,
] as const;

export type AssistantScope = (typeof ASSISTANT_SCOPES)[number];

export function isAssistantScope(value: string): value is AssistantScope {
  return (ASSISTANT_SCOPES as readonly string[]).includes(value);
}

/**
 * Every credential this surface mints is prefixed so it can be routed without
 * a lookup — the actor middleware dispatches on `pcpa_` before touching the
 * agent-key or board-key tables.
 */
export const ASSISTANT_ACCESS_TOKEN_PREFIX = "pcpa_";
export const ASSISTANT_REFRESH_TOKEN_PREFIX = "pcpr_";
export const ASSISTANT_CLIENT_ID_PREFIX = "dcr_";
/**
 * Ephemeral internal credentials the assistant MCP endpoint mints for its own
 * loopback tool calls (GH #677 security round). Never issued to a client,
 * never persisted — the token lives only inside one MCP request and the
 * actor middleware resolves it straight from an in-process registry.
 */
export const ASSISTANT_LOOPBACK_TOKEN_PREFIX = "pcin_";

/** Access tokens live one hour; refresh tokens thirty days (design doc). */
export const ASSISTANT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const ASSISTANT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Consent requests and authorization codes both expire at ten minutes. */
export const ASSISTANT_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

/** The OAuth error code sent when a route's scope is not on the grant. */
export const ASSISTANT_INSUFFICIENT_SCOPE = "insufficient_scope";

/** The error code the loopback write gate returns when a per-grant hourly budget is spent. */
export const ASSISTANT_WRITE_RATE_LIMITED = "assistant_write_rate_limited";

/**
 * GH #678 (spec §7.1): the per-grant write budget the work tools live under —
 * at most this many writes (and newly created tasks) per rolling hour, since
 * every write can queue a paid agent run.
 */
export const ASSISTANT_WRITE_LIMIT_PER_HOUR = 30;
export const ASSISTANT_TASK_CREATE_LIMIT_PER_HOUR = 10;

/**
 * The ONLY routes an `assistant_grant` credential may reach, and the scope
 * each requires.
 *
 * Same discipline as BRIDGE_ENDPOINT_ROUTES and EVALUATOR_WRITE_ROUTE_PATTERNS:
 * the allowlist lives beside where the actor is minted because a check far
 * from the credential it governs is one that gets forgotten when a route is
 * added. A grant is per-company, scoped, and revocable — none of which helps
 * if the token doubles as a general board key, so anything not listed here is
 * refused with 403 even when the token is otherwise valid.
 *
 * Security review (GH #688): the allowlist is deliberately ONE route. A
 * `pcpa_` token on a raw REST route skips the toolset's §5 redaction —
 * `GET /companies/:id/agents` leaks adapterConfig, `/issues/:id/runs` leaks
 * raw contextSnapshot, `/people` leaks member emails — and the work/decide
 * entries handed a bearer token raw write powers (agent create, issue PATCH)
 * that bypass the tool contract. Tool calls therefore loop back on an
 * ephemeral `pcin_` internal credential (see assistant-loopback.ts), not on
 * the client's token; the scopes on the grant gate what the MCP surface
 * itself will do.
 */
export const ASSISTANT_ROUTE_SCOPES: ReadonlyArray<{
  method: string;
  pattern: RegExp;
  scope: AssistantScope;
}> = [
  // The MCP endpoint itself — a grant's bearer reaches exactly this POST.
  // GET/DELETE are allowlisted too so the stateless route answers its own 405
  // rather than the allowlist's blunter 403.
  { method: "POST", pattern: /^\/api\/mcp\/assistant$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/mcp\/assistant$/, scope: ASSISTANT_SCOPE_READ },
  { method: "DELETE", pattern: /^\/api\/mcp\/assistant$/, scope: ASSISTANT_SCOPE_READ },
];

/**
 * The scope a (method, path) requires, or null when the pair is outside the
 * assistant surface entirely. `path` must be query-free and slash-normalized
 * (the middleware's `normalizedPath` already provides that).
 */
export function assistantRouteScope(method: string, path: string): AssistantScope | null {
  const m = method.toUpperCase();
  const clean = path.split("?")[0]!.replace(/\/+$/, "");
  for (const route of ASSISTANT_ROUTE_SCOPES) {
    if (route.method === m && route.pattern.test(clean)) return route.scope;
  }
  return null;
}

/**
 * GH #678 (M3): the `origin_kind` stamped on issues an assistant write
 * creates. It doubles as the idempotency domain: `origin_id` carries the
 * caller's request key and a partial unique index
 * (`issues_assistant_work_request_uq`) makes the create replay-safe, the way
 * `routine_execution` rows dedupe routine dispatches.
 */
export const ASSISTANT_WORK_ORIGIN_KIND = "assistant_work";

/**
 * The deterministic requestId of a start_project kickoff task. Both halves
 * of the idempotent retry need the same key — the tool sends it on the
 * issue create, the project route reads it back to report kickoffPending.
 */
export function assistantKickoffRequestId(projectId: string): string {
  return `start_project:${projectId}`;
}

/**
 * GH #678 (M3): the ONLY writes the assistant MCP endpoint's `pcin_` loopback
 * credential may make — one entry per route the work toolset wraps (spec
 * §4.2, tools 10–14). Everything a work tool can do flows through this list:
 * a route missing from it is refused before the request reaches a handler,
 * whatever bug or prompt-injection produced the call.
 *
 * The list lives beside ASSISTANT_ROUTE_SCOPES for the same reason that table
 * does: the allowlist must sit where the credential is resolved, or the next
 * route added to a tool quietly acquires write power nobody reviewed. Every
 * entry requires `agentdash:work`; the loopback gate also enforces the
 * per-grant write and task-create limits (spec §7.1) before the route runs.
 *
 * `bodyFields` (review, GH #745): the EXACT top-level body keys the work
 * tools send. The wrapped routes accept much wider payloads —
 * `assigneeAdapterOverrides`, `executionWorkspaceSettings`, `env`,
 * `definitionOfDone`, reopen/resume flags — none of which an assistant write
 * was ever meant to set. A `pcin_` body carrying anything outside the list is
 * refused in middleware, so a new field on a wrapped route cannot be reached
 * through the assistant surface without deliberately widening this list.
 */
export const ASSISTANT_LOOPBACK_WRITE_ROUTES: ReadonlyArray<{
  method: string;
  pattern: RegExp;
  /** Counts against the tighter per-grant "new tasks per hour" limit too. */
  taskCreate?: boolean;
  /** The only top-level request-body keys the toolset sends. */
  bodyFields: readonly string[];
}> = [
  // start_project — POST /companies/:id/projects
  {
    method: "POST",
    pattern: /^\/api\/companies\/[^/]+\/projects$/,
    bodyFields: ["name", "description", "targetDate", "leadAgentId"],
  },
  // create_work_item, start_project's kickoff — POST /companies/:id/issues
  {
    method: "POST",
    pattern: /^\/api\/companies\/[^/]+\/issues$/,
    taskCreate: true,
    bodyFields: ["projectId", "title", "description", "assigneeAgentId", "status", "priority", "requestId"],
  },
  // assign_work, update_work_item — PATCH /issues/:id
  {
    method: "PATCH",
    pattern: /^\/api\/issues\/[^/]+$/,
    bodyFields: ["assigneeAgentId", "assigneeUserId", "status", "priority", "title", "projectId"],
  },
  // assign_work's nudge — POST /agents/:id/wakeup
  {
    method: "POST",
    pattern: /^\/api\/agents\/[^/]+\/wakeup$/,
    bodyFields: ["source", "triggerDetail", "reason", "payload", "idempotencyKey"],
  },
  // comment_on_work — POST /issues/:id/comments
  { method: "POST", pattern: /^\/api\/issues\/[^/]+\/comments$/, bodyFields: ["body"] },
];

/**
 * The write route a `pcin_` (method, path) is allowed to reach, or null.
 * Same normalization contract as `assistantRouteScope`.
 */
export function assistantLoopbackWriteRoute(
  method: string,
  path: string,
): (typeof ASSISTANT_LOOPBACK_WRITE_ROUTES)[number] | null {
  const m = method.toUpperCase();
  const clean = path.split("?")[0]!.replace(/\/+$/, "");
  for (const route of ASSISTANT_LOOPBACK_WRITE_ROUTES) {
    if (route.method === m && route.pattern.test(clean)) return route;
  }
  return null;
}
