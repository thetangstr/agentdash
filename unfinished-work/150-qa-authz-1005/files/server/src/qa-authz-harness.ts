/**
 * UltraQA QA-A (authz & isolation) harness — THROWAWAY, never committed.
 * Boots the real Express app + real better-auth + embedded Postgres + the real
 * live-events WS server on the lane port, then drives the QA-A matrix.
 * Run: cd server && npx tsx src/qa-authz-harness.ts
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const QA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "qa-authz-home-"));
process.env.PAPERCLIP_HOME = QA_HOME;
process.env.PAPERCLIP_STORAGE_LOCAL_DIR = path.join(QA_HOME, "storage");
process.env.BETTER_AUTH_SECRET = "qa-authz-harness-secret-0123456789abcdef";
process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
process.env.PAPERCLIP_BILLING_DISABLED = "true";
process.env.AGENTDASH_BILLING_DISABLED = "true";

const PORT = 3453;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const {
  createDb,
  companies,
  companyMemberships,
  agents,
  agentApiKeys,
  authUsers,
  projects,
  projectAccess,
  issues,
  goals,
  approvals,
  invites,
  routines,
  connections,
  plugins,
  pluginConfig,
  budgetPolicies,
  costEvents,
  activityLog,
  principalPermissionGrants,
  companySecrets,
  companySecretVersions,
} = await import("@paperclipai/db");
const { eq } = await import("drizzle-orm");
const { startEmbeddedPostgresTestDatabase } = await import("./__tests__/helpers/embedded-postgres.js");
const { createApp } = await import("./app.js");
const {
  createBetterAuthInstance,
  createBetterAuthHandler,
  resolveBetterAuthSession,
  resolveBetterAuthSessionFromHeaders,
} = await import("./auth/better-auth.js");
const { setupLiveEventsWebSocketServer } = await import("./realtime/live-events-ws.js");
const { loadConfig } = await import("./config.js");
const { createStorageServiceFromConfig } = await import("./storage/index.js");
const { publishLiveEvent } = await import("./services/live-events.js");
const { createPluginSecretsHandler } = await import("./services/plugin-secrets-handler.js");
const { WebSocket } = await import("ws");

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------
type Row = {
  id: string;
  intent: string;
  actor: string;
  req: string;
  expected: string;
  actual: string;
  verdict: "PASS" | "FAIL" | "INFO" | "SKIP";
  note?: string;
};
const rows: Row[] = [];
function rec(row: Row) {
  rows.push(row);
  console.log(`${row.verdict === "PASS" ? "PASS" : row.verdict === "FAIL" ? "FAIL" : row.verdict === "SKIP" ? "SKIP" : "INFO"} ${row.id} ${row.req} -> ${row.actual} ${row.note ?? ""}`);
}
function verdict(got: number, want: number[] | ((s: number) => boolean), info?: boolean) {
  const ok = Array.isArray(want) ? want.includes(got) : want(got);
  return ok ? "PASS" : info ? "INFO" : "FAIL";
}
const is4xx = (s: number) => s === 401 || s === 403 || s === 404;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
const tdb = await startEmbeddedPostgresTestDatabase("qa-authz-pg-");
const db = createDb(tdb.connectionString);
const config = loadConfig();
const auth = createBetterAuthInstance(
  db,
  {
    ...config,
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    deploymentMode: "authenticated",
  } as Parameters<typeof createBetterAuthInstance>[1],
  [ORIGIN],
);
const storageService = createStorageServiceFromConfig(config);
const app = await createApp(db, {
  uiMode: "none",
  serverPort: PORT,
  storageService,
  deploymentMode: "authenticated",
  deploymentExposure: "private",
  allowedHostnames: ["127.0.0.1", "localhost"],
  bindHost: "127.0.0.1",
  authReady: true,
  companyDeletionEnabled: true,
  betterAuthHandler: createBetterAuthHandler(auth),
  resolveSession: (req) => resolveBetterAuthSession(auth, req),
});
const server: Server = createServer(app);
setupLiveEventsWebSocketServer(server, db, {
  deploymentMode: "authenticated",
  resolveSessionFromHeaders: (headers) => resolveBetterAuthSessionFromHeaders(auth, headers),
});
await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
console.log(`QA harness listening on ${ORIGIN}`);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Credential = { kind: "cookie"; cookie: string } | { kind: "key"; token: string } | { kind: "none" };
async function call(cred: Credential, method: string, urlPath: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cred.kind === "cookie") {
    headers.cookie = cred.cookie;
    headers.origin = ORIGIN; // boardMutationGuard: session mutations need trusted origin
  } else if (cred.kind === "key") {
    headers.authorization = `Bearer ${cred.token}`;
  }
  const res = await fetch(`${ORIGIN}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 200);
  }
  return { status: res.status, json };
}

function sessionCookie(res: Response): string {
  // undici fetch exposes getSetCookie()
  const sc = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  return sc
    .map((c) => c.split(";")[0] ?? "")
    .filter((pair) => pair.includes("session_token"))
    .join("; ");
}

async function signUp(email: string) {
  const res = await fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, name: email.split("@")[0], password: "a-long-enough-password-1" }),
  });
  const json = (await res.json()) as { user?: { id?: string } };
  if (res.status !== 200 || !json.user?.id) throw new Error(`signup failed ${res.status} ${JSON.stringify(json)}`);
  return { userId: json.user.id, cookie: sessionCookie(res) };
}

function wsConnect(cookie: string, companyId: string) {
  return new Promise<{
    ws: InstanceType<typeof WebSocket>;
    events: unknown[];
    ok: boolean;
  }>((resolve) => {
    const events: unknown[] = [];
    const ws = new WebSocket(`${WS_URL}/api/companies/${companyId}/events/ws`, {
      headers: { cookie },
    });
    ws.on("message", (data) => {
      try {
        events.push(JSON.parse(String(data)));
      } catch {
        events.push(String(data));
      }
    });
    ws.on("open", () => resolve({ ws, events, ok: true }));
    ws.on("error", () => resolve({ ws, events, ok: false }));
    ws.on("unexpected-response", (_req, res) => resolve({ ws, events, ok: false }));
    setTimeout(() => resolve({ ws, events, ok: false }), 8000);
  });
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------
const now = new Date();
const companyA = await db.insert(companies).values({ name: "QA Alpha", issuePrefix: "QAA" }).returning().then((r) => r[0]!);
const companyB = await db.insert(companies).values({ name: "QA Beta", issuePrefix: "QAB" }).returning().then((r) => r[0]!);

const uAdminA = await signUp(`admin-a-${randomUUID()}@example.com`);
const uMemberA = await signUp(`member-a-${randomUUID()}@example.com`);
const uViewerA = await signUp(`viewer-a-${randomUUID()}@example.com`);
const uAdminB = await signUp(`admin-b-${randomUUID()}@example.com`);
const uMemberB = await signUp(`member-b-${randomUUID()}@example.com`);
const uGhost = await signUp(`ghost-${randomUUID()}@example.com`);

async function member(companyId: string, userId: string, role: string) {
  await db.insert(companyMemberships).values({
    companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role,
  });
}
await member(companyA.id, uAdminA.userId, "admin");
await member(companyA.id, uMemberA.userId, "member");
await member(companyA.id, uViewerA.userId, "viewer"); // legacy -> member
await member(companyB.id, uAdminB.userId, "admin");
await member(companyB.id, uMemberB.userId, "member");
// uGhost: signed up, no memberships

const adminA: Credential = { kind: "cookie", cookie: uAdminA.cookie };
const memberA: Credential = { kind: "cookie", cookie: uMemberA.cookie };
const viewerA: Credential = { kind: "cookie", cookie: uViewerA.cookie };
const adminB: Credential = { kind: "cookie", cookie: uAdminB.cookie };
const memberB: Credential = { kind: "cookie", cookie: uMemberB.cookie };
const ghost: Credential = { kind: "cookie", cookie: uGhost.cookie };
const anon: Credential = { kind: "none" };

async function mkAgent(companyId: string, name: string, role = "engineer", extra: Record<string, unknown> = {}) {
  return db.insert(agents).values({
    companyId, name, role, status: "idle", adapterType: "process", adapterConfig: {}, ...extra,
  }).returning().then((r) => r[0]!);
}
const agentA = await mkAgent(companyA.id, "QA Worker A");
const hiddenA = await mkAgent(companyA.id, "QA Hidden A", "engineer", { visibility: "owner", createdByUserId: uAdminA.userId });
const ceoA = await mkAgent(companyA.id, "QA Chief A", "ceo");
const agentB = await mkAgent(companyB.id, "QA Worker B");

async function mkKey(agent: { id: string; companyId: string }) {
  const token = `pcp_${randomBytes(24).toString("hex")}`;
  await db.insert(agentApiKeys).values({
    agentId: agent.id,
    companyId: agent.companyId,
    name: "qa",
    keyHash: createHash("sha256").update(token).digest("hex"),
    source: "manual",
  });
  return { kind: "key", token } as Credential;
}
const kAgentA = await mkKey(agentA);
const kCeoA = await mkKey(ceoA);
const kAgentB = await mkKey(agentB);

const projectOpen = await db.insert(projects).values({ companyId: companyA.id, name: "Open Project" }).returning().then((r) => r[0]!);
const projectSec = await db.insert(projects).values({ companyId: companyA.id, name: "Restricted Project", visibility: "restricted", createdByUserId: uAdminA.userId }).returning().then((r) => r[0]!);
await db.insert(projectAccess).values({ projectId: projectSec.id, principalType: "user", principalId: uAdminA.userId, grantedByUserId: uAdminA.userId });

const issueOpen = await db.insert(issues).values({ companyId: companyA.id, title: "Open issue", projectId: projectOpen.id, status: "todo" }).returning().then((r) => r[0]!);
const issueSec = await db.insert(issues).values({ companyId: companyA.id, title: "Restricted issue", projectId: projectSec.id, status: "todo" }).returning().then((r) => r[0]!);
const issueB = await db.insert(issues).values({ companyId: companyB.id, title: "Beta issue", status: "todo" }).returning().then((r) => r[0]!);

const goalA = await db.insert(goals).values({ companyId: companyA.id, title: "Alpha goal", level: "company" }).returning().then((r) => r[0]!);

const approvalHidden = await db.insert(approvals).values({
  companyId: companyA.id, type: "request_board_approval", status: "pending",
  requestedByAgentId: hiddenA.id, payload: { summary: "hidden agent asks" },
}).returning().then((r) => r[0]!);
const approvalOpen = await db.insert(approvals).values({
  companyId: companyA.id, type: "request_board_approval", status: "pending",
  requestedByAgentId: agentA.id, payload: { summary: "open agent asks" },
}).returning().then((r) => r[0]!);

const inviteA = await db.insert(invites).values({
  companyId: companyA.id, tokenHash: createHash("sha256").update("qa-invite-token").digest("hex"),
  expiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: uAdminA.userId,
}).returning().then((r) => r[0]!);

const routineA = await db.insert(routines).values({
  companyId: companyA.id, title: "QA routine", description: "ping",
}).returning().then((r) => r[0]!);

const connA = await db.insert(connections).values({
  companyId: companyA.id, ownerType: "user", ownerId: uAdminA.userId, provider: "slack",
}).returning().then((r) => r[0]!);

// secret via the real API (encryption handled by the local_encrypted provider)
const secretRes = await call(adminA, "POST", `/api/companies/${companyA.id}/secrets`, { name: "QA_SECRET_A", value: "s3cr3t-value-a" });
const secretA = (secretRes.json as { id?: string }) ?? {};
if (secretRes.status >= 300) console.log("WARN secret create:", secretRes.status, JSON.stringify(secretRes.json).slice(0, 200));

const secretB = await call(adminB, "POST", `/api/companies/${companyB.id}/secrets`, { name: "QA_SECRET_B", value: "s3cr3t-value-b" });
const secretBId = (secretB.json as { id?: string }).id;

// plugin + config referencing company B's secret id (for #811 service probe)
const pluginRow = await db.insert(plugins).values({
  pluginKey: "qa-test-plugin", packageName: "@qa/test", version: "0.0.1",
  manifestJson: {
    id: "qa-test-plugin", apiVersion: 1, version: "0.0.1", displayName: "QA Test",
    instanceConfigSchema: {
      type: "object",
      properties: { token: { type: "string", secret: true } },
    },
  } as never,
  status: "installed",
}).returning().then((r) => r[0]!);
if (secretBId) {
  await db.insert(pluginConfig).values({ pluginId: pluginRow.id, configJson: { token: secretBId } });
}

// budget policy on agentA via the real route
await call(adminA, "PATCH", `/api/agents/${agentA.id}/budgets`, { budgetMonthlyCents: 12345 }).catch(() => null);

// cost events: one in the restricted project, one in the open project
const ce = await db.insert(costEvents).values({
  companyId: companyA.id, agentId: agentA.id, issueId: issueSec.id, projectId: projectSec.id,
  provider: "qa", model: "qa", costCents: 777, inputTokens: 1, outputTokens: 1, occurredAt: new Date(),
}).returning().catch((e) => { console.log("WARN costEvent insert:", e?.message?.slice(0, 160)); return []; });
await db.insert(costEvents).values({
  companyId: companyA.id, agentId: agentA.id, issueId: issueOpen.id, projectId: projectOpen.id,
  provider: "qa", model: "qa", costCents: 555, inputTokens: 1, outputTokens: 1, occurredAt: new Date(),
}).catch((e) => { console.log("WARN costEvent2 insert:", e?.message?.slice(0, 160)); return []; });

console.log("seed done");

// ---------------------------------------------------------------------------
// XC: cross-company isolation — adminB / memberB / agentB attacking A's rows
// ---------------------------------------------------------------------------
const xcRows: Array<[string, string, string, unknown?]> = [
  ["XC-01", "PATCH", `/api/agents/${agentA.id}`, { name: "pwned" }],
  ["XC-02", "POST", `/api/agents/${agentA.id}/pause`],
  ["XC-03", "POST", `/api/agents/${agentA.id}/keys`, { name: "x" }],
  ["XC-04", "PATCH", `/api/agents/${agentA.id}/permissions`, { canCreateAgents: true, canAssignTasks: true }],
  ["XC-05", "PATCH", `/api/issues/${issueOpen.id}`, { title: "pwned" }],
  ["XC-06", "POST", `/api/issues/${issueOpen.id}/comments`, { body: "x" }],
  ["XC-07", "POST", `/api/issues/${issueOpen.id}/checkout`, { agentId: agentB.id, expectedStatuses: ["todo"] }],
  ["XC-08", "POST", `/api/approvals/${approvalOpen.id}/approve`, {}],
  ["XC-09", "POST", `/api/approvals/${approvalOpen.id}/reject`, {}],
  ["XC-10", "POST", `/api/approvals/${approvalOpen.id}/request-revision`, {}],
  ["XC-11", "PATCH", `/api/goals/${goalA.id}`, { title: "pwned" }],
  ["XC-12", "PATCH", `/api/projects/${projectOpen.id}`, { name: "pwned" }],
  ["XC-13", "PATCH", `/api/secrets/${secretA.id}`, { name: "pwned" }],
  ["XC-14", "DELETE", `/api/secrets/${secretA.id}`],
  ["XC-15", "POST", `/api/secrets/${secretA.id}/rotate`, { value: "x" }],
  ["XC-16", "PATCH", `/api/connections/${connA.id}`, { visibility: "workspace" }],
  ["XC-17", "POST", `/api/connections/${connA.id}/revoke`, {}],
  ["XC-18", "PATCH", `/api/routines/${routineA.id}`, { title: "pwned" }],
  ["XC-19", "DELETE", `/api/routines/${routineA.id}`], // route does not exist — 405 expected
  ["XC-20", "POST", `/api/routines/${routineA.id}/run`, {}],
  ["XC-21", "POST", `/api/invites/${inviteA.id}/revoke`, {}],
  ["XC-22", "PATCH", `/api/companies/${companyA.id}`, { name: "pwned" }],
  ["XC-23", "POST", `/api/companies/${companyA.id}/archive`, {}],
  ["XC-24", "POST", `/api/companies/${companyA.id}/export`, {}],
  ["XC-25", "PATCH", `/api/agents/${agentA.id}/budgets`, { budgetMonthlyCents: 1 }],
  ["XC-26", "PATCH", `/api/companies/${companyA.id}/budgets`, { budgetMonthlyCents: 1 }],
];
for (const [id, method, url, body] of xcRows) {
  const r = await call(adminB, method, url, body);
  rec({
    id, intent: "cross-company write as other-company admin", actor: "adminB",
    req: `${method} ${url}`, expected: "401/403/404/405",
    actual: `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`,
    verdict: verdict(r.status, (s) => is4xx(s) || s === 405),
  });
}
// body/query smuggling: B-scope in path, A id in body or vice versa
{
  const r = await call(adminB, "POST", `/api/companies/${companyB.id}/issues`, { title: "B issue w/ A project", projectId: projectSec.id });
  rec({ id: "XC-27", intent: "issue create in B naming A's restricted projectId in body", actor: "adminB", req: `POST /api/companies/{B}/issues {projectId: A}`, expected: "4xx (or created-but-unlinked)", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`, verdict: verdict(r.status, (s) => s >= 400 || !((r.json as { projectId?: string })?.projectId === projectSec.id)) });
}
{
  const r = await call(adminB, "POST", `/api/companies/${companyB.id}/issues`, { title: "B issue w/ A goal", goalId: goalA.id });
  rec({ id: "XC-28", intent: "issue create in B naming A's goalId in body", actor: "adminB", req: `POST /api/companies/{B}/issues {goalId: A}`, expected: "4xx or unlinked", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`, verdict: verdict(r.status, (s) => s >= 400 || !((r.json as { goalId?: string })?.goalId === goalA.id)) });
}
{
  const r = await call(adminB, "POST", `/api/companies/${companyB.id}/issues`, { title: "B issue w/ A assignee", assigneeAgentId: agentA.id });
  rec({ id: "XC-29", intent: "issue create in B assigning A's agent (body id)", actor: "adminB", req: `POST /api/companies/{B}/issues {assigneeAgentId: A}`, expected: "4xx or unlinked", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`, verdict: verdict(r.status, (s) => s >= 400 || !((r.json as { assigneeAgentId?: string })?.assigneeAgentId === agentA.id)) });
}
{
  const r = await call(adminB, "POST", `/api/companies/${companyB.id}/projects`, { name: "B proj w/ A goal", goalId: goalA.id });
  rec({ id: "XC-30", intent: "project create in B naming A's goalId", actor: "adminB", req: `POST /api/companies/{B}/projects {goalId: A}`, expected: "4xx or unlinked", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`, verdict: verdict(r.status, (s) => s >= 400 || !((r.json as { goalId?: string })?.goalId === goalA.id)) });
}
{
  const r = await call(adminB, "PATCH", `/api/issues/${issueB.id}`, { goalId: goalA.id });
  const stored = (r.json as { goalId?: string })?.goalId === goalA.id;
  rec({ id: "XC-45", intent: "issue PATCH in B setting A's goalId", actor: "adminB", req: `PATCH /api/issues/{B} {goalId: A}`, expected: "4xx or unchanged", actual: `${r.status} stored=${stored}`, verdict: verdict(0, () => r.status >= 400 || !stored) });
}
{
  const r = await call(adminB, "PATCH", `/api/issues/${issueB.id}`, { projectId: projectSec.id });
  const stored = (r.json as { projectId?: string })?.projectId === projectSec.id;
  rec({ id: "XC-46", intent: "issue PATCH in B setting A's projectId", actor: "adminB", req: `PATCH /api/issues/{B} {projectId: A}`, expected: "4xx or unchanged", actual: `${r.status} stored=${stored}`, verdict: verdict(0, () => r.status >= 400 || !stored) });
}
{
  const r = await call(adminB, "PATCH", `/api/issues/${issueB.id}`, { assigneeAgentId: agentA.id });
  const stored = (r.json as { assigneeAgentId?: string })?.assigneeAgentId === agentA.id;
  rec({ id: "XC-47", intent: "issue PATCH in B assigning A's agent", actor: "adminB", req: `PATCH /api/issues/{B} {assigneeAgentId: A}`, expected: "4xx or unchanged", actual: `${r.status} stored=${stored}`, verdict: verdict(0, () => r.status >= 400 || !stored) });
}
{
  // onboarding invites: companyId in BODY
  const r = await call(adminB, "POST", `/api/onboarding/invites`, { companyId: companyA.id, emails: ["victim@example.com"] });
  rec({ id: "XC-31", intent: "onboarding invite create with A's companyId in body", actor: "adminB", req: `POST /api/onboarding/invites {companyId: A}`, expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`, verdict: verdict(r.status, is4xx) });
}
{
  const r = await call(adminB, "POST", `/api/companies/${companyA.id}/invites`, { allowedJoinTypes: "human" });
  rec({ id: "XC-32", intent: "company-scoped invite create for A", actor: "adminB", req: `POST /api/companies/{A}/invites`, expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`, verdict: verdict(r.status, is4xx) });
}
// member-of-B (lower privilege) spot checks
for (const [id, method, url, body] of [
  ["XC-33", "PATCH", `/api/issues/${issueOpen.id}`, { title: "pwned" }],
  ["XC-34", "POST", `/api/approvals/${approvalOpen.id}/approve`, {}],
  ["XC-35", "GET", `/api/companies/${companyA.id}/agents`],
] as Array<[string, string, string, unknown?]>) {
  const r = await call(memberB, method, url, body);
  rec({ id, intent: "cross-company access as other-company member", actor: "memberB", req: `${method} ${url}`, expected: "401/403/404", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`, verdict: verdict(r.status, is4xx) });
}
// agent-of-B attacking A
for (const [id, method, url, body] of [
  ["XC-36", "PATCH", `/api/agents/${agentA.id}`, { name: "pwned" }],
  ["XC-37", "GET", `/api/companies/${companyA.id}/issues`],
  ["XC-38", "POST", `/api/issues/${issueOpen.id}/comments`, { body: "x" }],
  ["XC-39", "PATCH", `/api/agents/${agentA.id}/permissions`, { canCreateAgents: true, canAssignTasks: true }],
] as Array<[string, string, string, unknown?]>) {
  const r = await call(kAgentB, method, url, body);
  rec({ id, intent: "cross-company access as other-company agent key", actor: "agentB", req: `${method} ${url}`, expected: "401/403/404", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`, verdict: verdict(r.status, is4xx) });
}
// ghost (signed up, no membership)
for (const [id, method, url, body] of [
  ["XC-40", "GET", `/api/companies/${companyA.id}/issues`],
  ["XC-41", "PATCH", `/api/issues/${issueOpen.id}`, { title: "pwned" }],
  ["XC-42", "POST", `/api/approvals/${approvalOpen.id}/reject`, {}],
] as Array<[string, string, string, unknown?]>) {
  const r = await call(ghost, method, url, body);
  rec({ id, intent: "signed-up user with no membership", actor: "ghost", req: `${method} ${url}`, expected: "401/403/404", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`, verdict: verdict(r.status, is4xx) });
}
// anonymous
{
  const r = await call(anon, "GET", `/api/companies/${companyA.id}/issues`);
  rec({ id: "XC-43", intent: "anonymous read", actor: "anon", req: `GET /api/companies/{A}/issues`, expected: "401", actual: `${r.status}`, verdict: verdict(r.status, [401, 403]) });
}
// shortname lookup under wrong companyId
{
  const urlKey = (agentA as unknown as { urlKey?: string }).urlKey;
  if (urlKey) {
    const r = await call(adminB, "GET", `/api/agents/${urlKey}?companyId=${companyB.id}`);
    rec({ id: "XC-44", intent: "A's agent urlKey resolved under B's companyId query", actor: "adminB", req: `GET /api/agents/${urlKey}?companyId={B}`, expected: "403/404", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`, verdict: verdict(r.status, is4xx) });
  } else {
    rec({ id: "XC-44", intent: "urlKey lookup", actor: "adminB", req: "GET /api/agents/{urlKey}?companyId=B", expected: "403/404", actual: "no urlKey on seeded agent", verdict: "SKIP" });
  }
}

// ---------------------------------------------------------------------------
// RV: restricted-project visibility for memberA (not on access list)
// ---------------------------------------------------------------------------
{
  const r = await call(memberA, "GET", `/api/projects/${projectSec.id}`);
  rec({ id: "RV-01", intent: "restricted project detail hidden from off-list member", actor: "memberA", req: "GET /api/projects/{restricted}", expected: "404", actual: `${r.status}`, verdict: verdict(r.status, [404]) });
}
{
  const r = await call(memberA, "PATCH", `/api/projects/${projectSec.id}`, { name: "pwned" });
  rec({ id: "RV-02", intent: "restricted project PATCH must not reveal existence (issue #917: wants 404, not 403)", actor: "memberA", req: "PATCH /api/projects/{restricted}", expected: "404", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`, verdict: verdict(r.status, [404]) });
}
{
  const r = await call(memberA, "GET", `/api/companies/${companyA.id}/projects`);
  const list = Array.isArray(r.json) ? r.json : [];
  const leaked = list.some((p: { id?: string }) => p.id === projectSec.id);
  rec({ id: "RV-03", intent: "restricted project absent from member's list", actor: "memberA", req: "GET /api/companies/{A}/projects", expected: "200 without restricted id", actual: `${r.status} leaked=${leaked}`, verdict: verdict(200, () => r.status === 200 && !leaked) });
}
{
  const r = await call(memberA, "GET", `/api/issues/${issueSec.id}`);
  rec({ id: "RV-04", intent: "issue inside restricted project hidden", actor: "memberA", req: "GET /api/issues/{restricted-issue}", expected: "404", actual: `${r.status}`, verdict: verdict(r.status, [404, 403]) });
}
{
  const r = await call(memberA, "GET", `/api/companies/${companyA.id}/issues`);
  const list = Array.isArray(r.json) ? r.json : (r.json as { issues?: unknown[] })?.issues ?? [];
  const leaked = Array.isArray(list) && list.some((i: { id?: string }) => i.id === issueSec.id);
  rec({ id: "RV-05", intent: "restricted issue absent from member's issue list", actor: "memberA", req: "GET /api/companies/{A}/issues", expected: "200 without restricted issue", actual: `${r.status} leaked=${leaked}`, verdict: verdict(200, () => !leaked) });
}
{
  // WS: memberA socket must not get events naming the restricted project/issue
  const conn = await wsConnect(uMemberA.cookie, companyA.id);
  if (!conn.ok) {
    rec({ id: "RV-06", intent: "WS connect as memberA", actor: "memberA", req: "WS /api/companies/A/events/ws", expected: "open", actual: "failed to connect", verdict: "SKIP", note: "ws upgrade failed" });
  } else {
    publishLiveEvent({ companyId: companyA.id, type: "activity.logged", payload: { action: "issue.updated", entityType: "issue", entityId: issueSec.id, details: { issueId: issueSec.id, projectId: projectSec.id } } });
    publishLiveEvent({ companyId: companyA.id, type: "activity.logged", payload: { action: "issue.updated", entityType: "issue", entityId: issueOpen.id, details: { issueId: issueOpen.id, projectId: projectOpen.id } } });
    await new Promise((r) => setTimeout(r, 1500));
    const gotSec = conn.events.some((e) => JSON.stringify(e).includes(issueSec.id));
    const gotOpen = conn.events.some((e) => JSON.stringify(e).includes(issueOpen.id));
    rec({ id: "RV-06", intent: "restricted-issue event withheld, open-issue event delivered", actor: "memberA", req: "WS events/ws + activity.logged", expected: "open=yes restricted=no", actual: `open=${gotOpen} restricted=${gotSec}`, verdict: verdict(0, () => gotOpen && !gotSec) });
    conn.ws.close();
  }
}
{
  // company export as memberA: restricted project must not appear
  const r = await call(memberA, "POST", `/api/companies/${companyA.id}/exports/preview`, {});
  const body = JSON.stringify(r.json);
  const leaked = body.includes(projectSec.id) || body.includes("Restricted Project") || body.includes(issueSec.id);
  rec({ id: "RV-07", intent: "export preview must not carry restricted project/issue to off-list member", actor: "memberA", req: "POST /api/companies/{A}/exports/preview", expected: "no restricted ids in payload (or 403)", actual: `${r.status} leaked=${leaked}`, verdict: verdict(0, () => r.status === 403 || !leaked) });
}
{
  const r = await call(memberA, "GET", `/api/companies/${companyA.id}/activity`);
  const items = (r.json as { items?: unknown[] })?.items ?? (Array.isArray(r.json) ? r.json : []);
  const leaked = JSON.stringify(items).includes(issueSec.id) || JSON.stringify(items).includes(projectSec.id);
  rec({ id: "RV-08", intent: "activity feed must not name restricted project/issue", actor: "memberA", req: "GET /api/companies/{A}/activity", expected: "no restricted ids", actual: `${r.status} leaked=${leaked}`, verdict: verdict(0, () => !leaked) });
}
{
  // hidden agent (visibility=owner) invisible to memberA
  const r = await call(memberA, "GET", `/api/agents/${hiddenA.id}?companyId=${companyA.id}`);
  rec({ id: "RV-09", intent: "owner-visibility agent hidden from member", actor: "memberA", req: "GET /api/agents/{hidden}?companyId=A", expected: "404", actual: `${r.status}`, verdict: verdict(r.status, [404]) });
}
{
  const r = await call(memberA, "GET", `/api/companies/${companyA.id}/agents`);
  const list = Array.isArray(r.json) ? r.json : [];
  const leaked = list.some((a: { id?: string }) => a.id === hiddenA.id);
  rec({ id: "RV-10", intent: "hidden agent absent from member's list", actor: "memberA", req: "GET /api/companies/{A}/agents", expected: "no hidden id", actual: `${r.status} leaked=${leaked}`, verdict: verdict(0, () => !leaked) });
}

// ---------------------------------------------------------------------------
// PE: agent privilege escalation
// ---------------------------------------------------------------------------
{
  const r = await call(kAgentA, "PATCH", `/api/agents/${agentA.id}/permissions`, { canCreateAgents: true, canAssignTasks: true });
  rec({ id: "PE-01", intent: "non-CEO agent granting itself agents:create", actor: "agentA", req: "PATCH /api/agents/{self}/permissions", expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, is4xx) });
}
{
  const r = await call(kCeoA, "PATCH", `/api/agents/${agentA.id}/permissions`, { canCreateAgents: true, canAssignTasks: false });
  const row = await db.select({ p: agents.permissions }).from(agents).where(eq(agents.id, agentA.id)).then((x) => x[0]);
  const granted = (row?.p as { canCreateAgents?: boolean } | null)?.canCreateAgents === true;
  rec({ id: "PE-02", intent: "CEO agent granting another agent agents:create (issue #734)", actor: "ceoA", req: "PATCH /api/agents/{worker}/permissions {canCreateAgents}", expected: "403 (board-only per #727)", actual: `${r.status} db.canCreateAgents=${granted}`, verdict: verdict(0, () => is4xx(r.status) && !granted) });
}
{
  const r = await call(kCeoA, "PATCH", `/api/agents/${agentA.id}/permissions`, { canCreateAgents: false, canAssignTasks: true });
  const row = await db.select({ p: agents.permissions }).from(agents).where(eq(agents.id, agentA.id)).then((x) => x[0]);
  const granted = (row?.p as { canAssignTasks?: boolean } | null)?.canAssignTasks === true;
  rec({ id: "PE-03", intent: "CEO agent granting tasks:assign (issue #734)", actor: "ceoA", req: "PATCH /api/agents/{worker}/permissions {canAssignTasks}", expected: "403", actual: `${r.status} db.canAssignTasks=${granted}`, verdict: verdict(0, () => is4xx(r.status) && !granted) });
}
{
  const r = await call(kAgentA, "POST", `/api/companies/${companyA.id}/agents`, { name: "spawned", role: "engineer", adapterType: "process", adapterConfig: { command: "/usr/bin/true" } });
  rec({ id: "PE-04", intent: "agent without canCreateAgents hiring an agent", actor: "agentA", req: "POST /api/companies/{A}/agents", expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, is4xx) });
}
{
  const r = await call(kAgentA, "PATCH", `/api/agents/${agentA.id}`, { role: "ceo" });
  const roleNow = (r.json as { role?: string })?.role;
  rec({ id: "PE-05", intent: "agent self-promoting to role ceo", actor: "agentA", req: "PATCH /api/agents/{self} {role:ceo}", expected: "403/422", actual: `${r.status} role=${roleNow}`, verdict: verdict(0, () => r.status >= 400 && roleNow !== "ceo") });
}
{
  const r = await call(kAgentA, "PATCH", `/api/agents/${agentA.id}`, { permissions: { canCreateAgents: true } });
  rec({ id: "PE-06", intent: "agent setting permissions via generic PATCH", actor: "agentA", req: "PATCH /api/agents/{self} {permissions}", expected: "400/422", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, [400, 403, 422]) });
}
{
  const r = await call(kAgentA, "POST", `/api/companies/${companyA.id}/routines`, { title: "agent routine" });
  rec({ id: "PE-07", intent: "agent writing a routine (direction, #710)", actor: "agentA", req: "POST /api/companies/{A}/routines", expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, is4xx) });
}
{
  const r = await call(kAgentA, "PATCH", `/api/goals/${goalA.id}`, { title: "agent rewrites goal" });
  rec({ id: "PE-08", intent: "agent rewriting a company goal", actor: "agentA", req: "PATCH /api/goals/{A-goal}", expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, is4xx) });
}
{
  const r = await call(kAgentA, "POST", `/api/companies/${companyA.id}/secrets`, { name: "AGENT_SECRET", value: "x" });
  rec({ id: "PE-09", intent: "agent creating a company secret", actor: "agentA", req: "POST /api/companies/{A}/secrets", expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, is4xx) });
}
{
  const r = await call(kAgentA, "POST", `/api/companies/${companyA.id}/invites`, { allowedJoinTypes: "human" });
  rec({ id: "PE-10", intent: "agent minting a company invite", actor: "agentA", req: "POST /api/companies/{A}/invites", expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, is4xx) });
}
{
  const r = await call(kAgentA, "POST", `/api/companies/${companyA.id}/archive`, {});
  rec({ id: "PE-11", intent: "agent archiving its company", actor: "agentA", req: "POST /api/companies/{A}/archive", expected: "403", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, is4xx) });
}
{
  const r = await call(kAgentA, "POST", `/api/companies/${companyA.id}/exports`, {});
  rec({ id: "PE-12", intent: "agent triggering company export", actor: "agentA", req: "POST /api/companies/{A}/exports", expected: "403/4xx", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`, verdict: verdict(r.status, (s) => s >= 400) });
}
{
  // agent self-edit of allowed fields should work (control)
  const r = await call(kAgentA, "PATCH", `/api/agents/${agentA.id}`, { title: "QA Worker (renamed)" });
  rec({ id: "PE-13", intent: "control: agent edits own title (allowed)", actor: "agentA", req: "PATCH /api/agents/{self} {title}", expected: "200", actual: `${r.status}`, verdict: verdict(r.status, [200]) });
}

// ---------------------------------------------------------------------------
// RT: re-test of known issues
// ---------------------------------------------------------------------------
{
  // #916 — hidden agent's approval decided by member who cannot see it
  const r = await call(memberA, "POST", `/api/approvals/${approvalHidden.id}/approve`, {});
  const decided = r.status === 200;
  rec({ id: "RT-916", intent: "#916 member decides approval from invisible agent", actor: "memberA", req: `POST /api/approvals/{hidden-agent-approval}/approve`, expected: "404 (agent not visible)", actual: `${r.status} decided=${decided}`, verdict: decided ? "FAIL" : verdict(r.status, is4xx) });
}
{
  // #918 — dashboard spend to member without agents:create
  const costs = await call(memberA, "GET", `/api/companies/${companyA.id}/costs/summary`);
  const dash = await call(memberA, "GET", `/api/companies/${companyA.id}/dashboard`);
  const d = dash.json as Record<string, unknown>;
  const leaks = (r: unknown) => r && (typeof (r as {monthSpendCents?:unknown}).monthSpendCents !== "undefined" || typeof (r as {spendPerAcceptedIssueCents?:unknown}).spendPerAcceptedIssueCents !== "undefined");
  const leaked = leaks(d);
  const spendKeys = Object.keys(d).filter((k) => /spend|cost|token|budget/i.test(k));
  rec({ id: "RT-918", intent: "#918 member w/o agents:create reads spend via dashboard that /costs refuses", actor: "memberA", req: "GET /dashboard vs GET /costs/summary", expected: "consistent refusal (both 403 or fields omitted)", actual: `costs=${costs.status} dashboard=${dash.status} spendFields=${leaked} keys=[${spendKeys.join(",")}]`, verdict: verdict(0, () => costs.status === 200 || !leaked) });
}
{
  // #886 — config/skills/instructions routes admit member while detail redacts
  const conf = await call(memberA, "GET", `/api/agents/${agentA.id}/configuration?companyId=${companyA.id}`);
  const skills = await call(memberA, "GET", `/api/agents/${agentA.id}/skills?companyId=${companyA.id}`);
  const companyConfs = await call(memberA, "GET", `/api/companies/${companyA.id}/agent-configurations`);
  const detail = await call(memberA, "GET", `/api/agents/${agentA.id}?companyId=${companyA.id}`);
  const detailRedacted = JSON.stringify(detail.json).includes('"adapterConfig":{}');
  const leaked = conf.status === 200 || skills.status === 200 || companyConfs.status === 200;
  rec({ id: "RT-886", intent: "#886 member reads agent configuration routes the detail route redacts", actor: "memberA", req: "GET /agents/{id}/configuration|skills + /companies/{A}/agent-configurations", expected: "403 matching the redacted detail", actual: `conf=${conf.status} skills=${skills.status} companyConfs=${companyConfs.status} detailRedacted=${detailRedacted}`, verdict: leaked ? "FAIL" : "PASS" });
}
{
  // #828 — channel:"assistant" spoof by board caller
  const fresh = await db.insert(approvals).values({
    companyId: companyA.id, type: "request_board_approval", status: "pending",
    requestedByUserId: uMemberA.userId, payload: { summary: "channel spoof" },
  }).returning().then((r) => r[0]!);
  const r = await call(adminA, "POST", `/api/approvals/${fresh.id}/approve`, { channel: "assistant" });
  const row = await db.select({ ch: approvals.decisionChannel }).from(approvals).where(eq(approvals.id, fresh.id)).then((x) => x[0]);
  const spoofed = row?.ch === "assistant";
  rec({ id: "RT-828", intent: "#828 board caller stamps decisionChannel=assistant", actor: "adminA", req: "POST /api/approvals/{id}/approve {channel:assistant}", expected: "400/422 rejection", actual: `${r.status} stored=${row?.ch ?? "null"}`, verdict: spoofed ? "FAIL" : "PASS" });
}
{
  // #811 — plugin secrets resolver has no company / managed-secret check
  if (!secretBId) {
    rec({ id: "RT-811", intent: "#811 plugin secret resolve", actor: "plugin-worker", req: "service.resolve", expected: "refuse foreign/managed secret", actual: "SKIP — secretB seed failed", verdict: "SKIP" });
  } else {
    try {
      const handler = createPluginSecretsHandler({ db, pluginId: pluginRow.id });
      const value = await handler.resolve({ secretRef: secretBId });
      rec({ id: "RT-811", intent: "#811 plugin resolves another company's secret by bare id", actor: "plugin worker (any company)", req: `resolve(${secretBId.slice(0, 8)}…)`, expected: "refusal (not-found)", actual: `resolved '${String(value).slice(0, 12)}…'`, verdict: "FAIL" });
    } catch (err) {
      rec({ id: "RT-811", intent: "#811 plugin resolves another company's secret by bare id", actor: "plugin worker", req: `resolve(${secretBId.slice(0, 8)}…)`, expected: "refusal", actual: `refused: ${err instanceof Error ? err.name : err}`, verdict: "PASS" });
    }
  }
}
// RT-734 and RT-917 covered by PE-02/PE-03 and RV-02 rows above.

// ---------------------------------------------------------------------------
// AR: archived company behavior (policy undecided — record only)
// ---------------------------------------------------------------------------
{
  // archive company B first so we keep A alive for remaining probes
  const archive = await call(adminB, "POST", `/api/companies/${companyB.id}/archive`, {});
  rec({ id: "AR-00", intent: "admin archives own company", actor: "adminB", req: "POST /api/companies/{B}/archive", expected: "200/204", actual: `${archive.status}`, verdict: "INFO" });
  const reads = [
    ["AR-01", "GET", `/api/companies/${companyB.id}/issues`],
    ["AR-02", "GET", `/api/companies/${companyB.id}/agents`],
    ["AR-03", "GET", `/api/companies/${companyB.id}/dashboard`],
  ] as const;
  for (const [id, method, url] of reads) {
    const r = await call(adminB, method, url);
    rec({ id, intent: "archived-company read by its admin", actor: "adminB", req: `${method} ${url}`, expected: "record actual", actual: `${r.status}`, verdict: "INFO" });
  }
  const writes = [
    ["AR-04", "POST", `/api/companies/${companyB.id}/issues`, { title: "post-archive" }],
    ["AR-05", "PATCH", `/api/issues/${issueB.id}`, { title: "post-archive" }],
    ["AR-06", "POST", `/api/issues/${issueB.id}/comments`, { body: "post-archive" }],
  ] as const;
  for (const [id, method, url, body] of writes) {
    const r = await call(adminB, method, url, body);
    rec({ id, intent: "archived-company write by its admin", actor: "adminB", req: `${method} ${url}`, expected: "record actual", actual: `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`, verdict: "INFO" });
  }
  {
    const r = await call(kAgentB, "GET", `/api/companies/${companyB.id}/issues`);
    rec({ id: "AR-07", intent: "agent key still works in archived company", actor: "agentB", req: `GET /api/companies/{B}/issues`, expected: "record actual", actual: `${r.status}`, verdict: "INFO" });
    const w = await call(kAgentB, "POST", `/api/issues/${issueB.id}/comments`, { body: "agent post-archive" });
    rec({ id: "AR-08", intent: "agent writes in archived company", actor: "agentB", req: `POST /api/issues/{B}/comments`, expected: "record actual", actual: `${w.status}`, verdict: "INFO" });
  }
}

// ---------------------------------------------------------------------------
// extra: member-scope reads that should still work (regression sanity)
// ---------------------------------------------------------------------------
{
  const r = await call(memberA, "GET", `/api/companies/${companyA.id}/issues`);
  rec({ id: "SN-01", intent: "member reads own company's issues", actor: "memberA", req: "GET /api/companies/{A}/issues", expected: "200", actual: `${r.status}`, verdict: verdict(r.status, [200]) });
}
{
  const r = await call(memberA, "POST", `/api/issues/${issueOpen.id}/comments`, { body: "member comment" });
  rec({ id: "SN-02", intent: "member comments in own company", actor: "memberA", req: "POST /api/issues/{A}/comments", expected: "200/201", actual: `${r.status}`, verdict: verdict(r.status, [200, 201]) });
}
{
  const r = await call(memberA, "GET", `/api/companies/${companyB.id}/issues`);
  rec({ id: "SN-03", intent: "member-of-A reads B (must be denied)", actor: "memberA", req: "GET /api/companies/{B}/issues", expected: "403", actual: `${r.status}`, verdict: verdict(r.status, is4xx) });
}

fs.writeFileSync(
  "/Volumes/mac_studio_ssd/Projects/agentdash/.omc/briefs/devin-20261003/qa/b2-numbers-results.jsonl",
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
const pass = rows.filter((r) => r.verdict === "PASS").length;
const fail = rows.filter((r) => r.verdict === "FAIL").length;
const info = rows.filter((r) => r.verdict === "INFO").length;
const skip = rows.filter((r) => r.verdict === "SKIP").length;
console.log(`\nRESULTS: ${pass} pass, ${fail} fail, ${info} info, ${skip} skip`);

server.close();
await tdb.cleanup();
fs.rmSync(QA_HOME, { recursive: true, force: true });
process.exit(0);
