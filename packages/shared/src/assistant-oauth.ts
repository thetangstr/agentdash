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

/** Access tokens live one hour; refresh tokens thirty days (design doc). */
export const ASSISTANT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const ASSISTANT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Consent requests and authorization codes both expire at ten minutes. */
export const ASSISTANT_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

/** The OAuth error code sent when a route's scope is not on the grant. */
export const ASSISTANT_INSUFFICIENT_SCOPE = "insufficient_scope";

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
 * Read entries mirror the M1 toolset's loopback calls one-for-one. Work and
 * decide entries exist so a consent that granted those scopes can already
 * reach the routes they will need; nothing mints work/decide-only behavior
 * without the person checking the box.
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

  // read: the M1 assistant toolset's loopback surface, one entry per call.
  { method: "GET", pattern: /^\/api\/companies\/[^/]+\/agents$/, scope: ASSISTANT_SCOPE_READ },
  // Member names — the toolset resolves human task-assignees through this.
  { method: "GET", pattern: /^\/api\/companies\/[^/]+\/people$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/companies\/[^/]+\/projects$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/companies\/[^/]+\/issues$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/companies\/[^/]+\/assistant\/digest$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/companies\/[^/]+\/assistant\/pending-decisions$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/projects\/[^/]+$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/issues\/[^/]+$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/issues\/[^/]+\/work-products$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/issues\/[^/]+\/comments$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/issues\/[^/]+\/runs$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/issues\/[^/]+\/approvals$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/cli-auth\/me$/, scope: ASSISTANT_SCOPE_READ },
  { method: "GET", pattern: /^\/api\/health$/, scope: ASSISTANT_SCOPE_READ },

  // work: creating and moving work, waking an agent (design doc §4.2).
  { method: "POST", pattern: /^\/api\/companies\/[^/]+\/projects$/, scope: ASSISTANT_SCOPE_WORK },
  { method: "POST", pattern: /^\/api\/companies\/[^/]+\/issues$/, scope: ASSISTANT_SCOPE_WORK },
  { method: "PATCH", pattern: /^\/api\/issues\/[^/]+$/, scope: ASSISTANT_SCOPE_WORK },
  { method: "POST", pattern: /^\/api\/issues\/[^/]+\/comments$/, scope: ASSISTANT_SCOPE_WORK },
  { method: "POST", pattern: /^\/api\/agents\/[^/]+\/wakeup$/, scope: ASSISTANT_SCOPE_WORK },

  // decide: reading an approval in full, resolving it, hiring an agent.
  // `agentdash:decide` is opt-in at consent and unchecked by default.
  { method: "GET", pattern: /^\/api\/approvals\/[^/]+$/, scope: ASSISTANT_SCOPE_DECIDE },
  { method: "POST", pattern: /^\/api\/approvals\/[^/]+\/approve$/, scope: ASSISTANT_SCOPE_DECIDE },
  { method: "POST", pattern: /^\/api\/approvals\/[^/]+\/reject$/, scope: ASSISTANT_SCOPE_DECIDE },
  { method: "POST", pattern: /^\/api\/approvals\/[^/]+\/request-revision$/, scope: ASSISTANT_SCOPE_DECIDE },
  { method: "POST", pattern: /^\/api\/companies\/[^/]+\/agents$/, scope: ASSISTANT_SCOPE_DECIDE },
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
