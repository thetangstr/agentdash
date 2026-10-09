// AgentDash (per-steward document access, slice 8): a person uploads their own
// file from their own machine to their own OneDrive, and shares it, through
// the bridge, as themselves.
//
// Real database, the real actor middleware with real endpoint tokens, and a
// local HTTP server standing in for Microsoft Graph and for the pre-
// authenticated upload session URL. Nothing here calls Microsoft.
//
// People are Person A (uploader), Person B, Person C, and two members both
// named "Person D". Person B stewards Agent B.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentStewardships,
  agentWakeupRequests,
  heartbeatRuns,
  agents,
  authUsers,
  bridgeEndpoints,
  bridgeUploads,
  companies,
  companyMemberships,
  connections,
  createDb,
  featureFlags,
  issueComments,
  issues,
  stewardInboxActionHandles,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { bridgeService } from "../services/bridge.js";
import { accessService } from "../services/access.js";
import {
  BRIDGE_UPLOAD_RETENTION_DAYS,
  MAX_TASK_INSTRUCTIONS_CHARS,
  UPLOAD_FRAGMENT_UNIT,
  pruneBridgeUploads,
} from "../services/bridge-upload.js";
import { connectorService } from "../services/connectors.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { __resetMicrosoftGraphAuthState } from "../services/microsoft-graph-auth.js";
import {
  FRAGMENT_FORWARD_BUDGET_MS,
  __setFragmentForwardBudget,
  __setGraphWriteRetryDelay,
} from "../services/microsoft-documents-write.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const ENV_KEYS = [
  "MICROSOFT_GRAPH_BASE_URL",
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "AGENTDASH_PERSON_UPLOAD_MAX_BYTES",
] as const;

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SHA = "a".repeat(64);
/** Two fragments: one 320 KiB unit, then a short last one. */
const FILE_BYTES = UPLOAD_FRAGMENT_UNIT + 1000;
const DRIVE = "drive-person-a";
const ITEM_WEB_URL = "https://onedrive.example.test/personal/person_a/deck.pptx";
const ORG_LINK_URL = "https://onedrive.example.test/org-link/abc";
const EMAIL_DOMAIN = "@tenant.example.test";

// ---------------------------------------------------------------------------
// Source scans: the write surface is one file, imported by one service.
// ---------------------------------------------------------------------------

describe("slice 8 source rules", () => {
  const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
  const write = read("server/src/services/microsoft-documents-write.ts");
  const upload = read("server/src/services/bridge-upload.ts");

  it("asks for no tenant-wide write scope and no anonymous or users-scope link", () => {
    for (const source of [write, upload]) {
      expect(source).not.toMatch(/Files\.ReadWrite\.All/);
      expect(source).not.toMatch(/Sites\.ReadWrite\.All/);
    }
    expect(write).toMatch(/scope: "organization"/);
    expect(write).not.toMatch(/scope: "anonymous"/);
    expect(write).not.toMatch(/scope: "users"/);
    expect(write).toMatch(/requireSignIn: true/);
    expect(write).toMatch(/sendInvitation: true/);
    expect(write).toMatch(/"@microsoft\.graph\.conflictBehavior": "rename"/);
  });

  it("keeps every Graph write verb in microsoft-documents-write.ts", () => {
    // bridge-upload.ts reads Graph with GET only; every PUT/POST/DELETE is in the write module.
    expect(upload).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(write).toMatch(/method: "PUT"/);
  });

  it("is imported only by the person-upload service (and the slice 5 executor when it exists)", () => {
    const allowed = new Set(["bridge-upload.ts", "connector-send-execution.ts"]);
    const importers: string[] = [];
    for (const dir of ["server/src/services", "server/src/routes"]) {
      for (const file of readdirSync(path.join(repoRoot, dir))) {
        if (!file.endsWith(".ts")) continue;
        if (read(`${dir}/${file}`).includes("microsoft-documents-write.js")) importers.push(file);
      }
    }
    expect(importers.filter((f) => !allowed.has(f))).toEqual([]);
    expect(importers).toContain("bridge-upload.ts");
  });

  it("gives the client's per-fragment timeout room above the server's whole forwarding budget", () => {
    // The client gives up on a fragment request after FRAGMENT_TIMEOUT_MS and
    // then asks for status. If the server could still be forwarding by then,
    // the client would resend a range Microsoft may be committing.
    const client = read("packages/connect/src/inbox-mcp.mjs");
    const match = /const FRAGMENT_TIMEOUT_MS = ([\d_]+);/.exec(client);
    expect(match).not.toBeNull();
    const clientTimeoutMs = Number(match![1]!.replace(/_/g, ""));
    expect(clientTimeoutMs).toBeGreaterThanOrEqual(FRAGMENT_FORWARD_BUDGET_MS + 30_000);
  });

  it("recognises a guest by its principal name only: basic profile reads never return userType", () => {
    expect(upload).not.toMatch(/userType/);
  });

  it("is reachable: the upload routes are on the endpoint allowlist and retention is started", () => {
    const auth = read("server/src/middleware/auth.ts");
    for (const p of ["destinations", "propose", "confirm", "fragment", "status", "cancel"]) {
      expect(auth).toContain(`"/api/bridge/upload/${p}"`);
    }
    expect(read("server/src/index.ts")).toContain("startBridgeUploadRetention(");
  });
});

describeEmbeddedPostgres("person upload over the bridge (slice 8)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const savedEnv: Record<string, string | undefined> = {};

  let msServer: Server | null = null;
  let msBase = "";

  type Call = { method: string; path: string; auth: string | null; contentRange: string | null; body: unknown; bytes: number };
  let graphCalls: Call[] = [];
  let uploadCalls: Call[] = [];
  /** Every upload URL the mock handed out; none may ever reach a response. */
  let sessionUrls: string[] = [];
  let tenantUsers: Map<string, { id: string; userType?: string; userPrincipalName?: string }>;
  let inviteStatus: (email: string) => { status: number; body: unknown };
  let fragmentFailures = 0;
  /** Held open until released, to observe an upload while sharing still runs. */
  let inviteGate: Promise<void> | null = null;
  /** Commit the last fragment, then drop the connection before answering. */
  let dropFinalResponse = false;
  /** Never answer a fragment PUT at all. */
  let hangFragments = false;
  /** The name Microsoft gives the committed file (it renames on a clash). */
  let landedName = "deck.pptx";
  /** Session paths Microsoft has finished with: every later call is a 404. */
  let goneSessions = new Set<string>();
  /** Files Microsoft has stored in the person's folders, beyond the fixtures. */
  let landed: Array<Record<string, unknown>> = [];

  let FLAGGED = "";
  let UNFLAGGED = "";
  const PERSON_A = `person-a-${randomUUID()}`;
  const PERSON_B = `person-b-${randomUUID()}`;
  const PERSON_C = `person-c-${randomUUID()}`;
  const PERSON_D1 = `person-d1-${randomUUID()}`;
  const PERSON_D2 = `person-d2-${randomUUID()}`;
  let AGENT_B = "";
  let ACCESS = "";

  const FOLDERS = [
    { id: "folder-top", name: "Client projects", folder: { childCount: 2 }, parentReference: { driveId: DRIVE, path: "/drive/root:" }, webUrl: "https://onedrive.example.test/cp" },
    { id: "folder-kickoff", name: "Kickoff", folder: { childCount: 0 }, parentReference: { driveId: DRIVE, path: "/drive/root:/Client%20projects" }, webUrl: "https://onedrive.example.test/cp/kickoff" },
    { id: "folder-archive", name: "Archive", folder: { childCount: 0 }, parentReference: { driveId: DRIVE, path: "/drive/root:/Client%20projects" }, webUrl: "https://onedrive.example.test/cp/archive" },
  ];
  const FILE_ITEM = { id: "file-notes", name: "notes.docx", file: { mimeType: "x" }, parentReference: { driveId: DRIVE, path: "/drive/root:" } };

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    home = await mkdtemp(path.join(tmpdir(), "bridge-upload-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "bridge-upload-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "e".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bridge-upload-");
    db = createDb(tempDb.connectionString);
    __setGraphWriteRetryDelay(() => 0);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    __resetMicrosoftGraphAuthState();
    graphCalls = [];
    uploadCalls = [];
    sessionUrls = [];
    fragmentFailures = 0;
    inviteGate = null;
    dropFinalResponse = false;
    hangFragments = false;
    landedName = "deck.pptx";
    goneSessions = new Set();
    // An older file of the same name and size already in the folder: never mistaken for this upload.
    landed = [
      {
        id: "item-old-deck",
        name: "deck.pptx",
        size: FILE_BYTES,
        file: { mimeType: PPTX },
        createdDateTime: "2020-01-01T00:00:00Z",
        webUrl: "https://onedrive.example.test/old-deck",
        parentReference: { driveId: DRIVE, id: "folder-kickoff" },
      },
    ];
    tenantUsers = new Map([
      [`person.b${EMAIL_DOMAIN}`, { id: "aad-b", userType: "Member" }],
      [`person.c${EMAIL_DOMAIN}`, { id: "aad-c", userType: "Member" }],
    ]);
    inviteStatus = () => ({ status: 200, body: { value: [{ id: "perm-1", roles: ["write"] }] } });

    // -- the Microsoft double -------------------------------------------------
    const app = express();
    app.use("/up.1drv.example", express.raw({ type: () => true, limit: "20mb" }));
    app.use("/graph", express.json());
    app.all(/^\/up\.1drv\.example\/.*/, async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      uploadCalls.push({
        method: req.method,
        path: req.path,
        auth: req.headers.authorization ?? null,
        contentRange: (req.headers["content-range"] as string | undefined) ?? null,
        body: null,
        bytes: body.length,
      });
      if (goneSessions.has(req.path)) return void res.status(404).json({ error: { code: "itemNotFound" } });
      if (req.method === "DELETE") return void res.status(204).end();
      if (req.method === "GET") return void res.json({ nextExpectedRanges: [`${UPLOAD_FRAGMENT_UNIT}-`], expirationDateTime: "2099-01-01T00:00:00Z" });
      if (hangFragments) return;
      if (fragmentFailures > 0) {
        fragmentFailures -= 1;
        return void res.status(503).json({ error: { code: "serviceNotAvailable" } });
      }
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers["content-range"]));
      if (!m) return void res.status(400).json({});
      const end = Number(m[2]);
      const total = Number(m[3]);
      if (end === total - 1) {
        const item = {
          id: "item-deck",
          name: landedName,
          size: total,
          file: { mimeType: PPTX },
          createdDateTime: new Date().toISOString(),
          webUrl: ITEM_WEB_URL,
          parentReference: { driveId: DRIVE, id: "folder-kickoff" },
        };
        if (dropFinalResponse) {
          // Microsoft committed the file; the answer never arrives.
          goneSessions.add(req.path);
          landed.push(item);
          req.socket.destroy();
          return;
        }
        goneSessions.add(req.path);
        return void res.status(201).json(item);
      }
      res.status(202).json({ nextExpectedRanges: [`${end + 1}-`], expirationDateTime: "2099-01-01T00:00:00Z" });
    });
    app.all(/^\/graph\/.*/, async (req, res) => {
      const raw = req.originalUrl.slice("/graph".length);
      const decoded = decodeURIComponent(raw);
      graphCalls.push({
        method: req.method,
        path: decoded,
        auth: req.headers.authorization ?? null,
        contentRange: null,
        body: req.body,
        bytes: 0,
      });
      if (req.headers.authorization !== `Bearer ${ACCESS}`) return void res.status(401).json({});
      if (req.method === "GET") {
        if (decoded.startsWith("/me/drive/root/children")) return void res.json({ value: [FOLDERS[0], FILE_ITEM] });
        const search = /^\/me\/drive\/root\/search\(q='(.*)'\)/.exec(decoded);
        if (search) {
          const q = search[1]!.toLowerCase();
          return void res.json({ value: [...FOLDERS, FILE_ITEM].filter((f) => f.name.toLowerCase().includes(q)) });
        }
        const byPath = /^\/me\/drive\/root:\/([^?]*)/.exec(decoded);
        if (byPath) {
          const wanted = byPath[1]!;
          const hit = FOLDERS.find((f) => {
            const parent = decodeURIComponent(f.parentReference.path.replace("/drive/root:", "")).replace(/^\//, "");
            return (parent ? `${parent}/${f.name}` : f.name) === wanted;
          });
          return void (hit ? res.json(hit) : res.status(404).json({ error: { code: "itemNotFound" } }));
        }
        const childByName = /^\/me\/drive\/items\/([^/:?]+):\/([^?:]+)(?:\?|$)/.exec(decoded);
        if (childByName) {
          const hit = landed.find(
            (f) => (f.parentReference as { id: string }).id === childByName[1] && f.name === childByName[2],
          );
          return void (hit ? res.json(hit) : res.status(404).json({ error: { code: "itemNotFound" } }));
        }
        const children = /^\/me\/drive\/items\/([^/:?]+)\/children/.exec(decoded);
        if (children) {
          return void res.json({ value: landed.filter((f) => (f.parentReference as { id: string }).id === children[1]) });
        }
        const byId = /^\/me\/drive\/items\/([^?]*)/.exec(decoded);
        if (byId) {
          const hit = [...FOLDERS, FILE_ITEM].find((f) => f.id === byId[1]);
          return void (hit ? res.json(hit) : res.status(404).json({ error: { code: "itemNotFound" } }));
        }
        // Like Graph: only the $select-ed properties come back.
        const selected = (value: Record<string, unknown>) => {
          const select = new URLSearchParams(decoded.split("?")[1] ?? "").get("$select");
          if (!select) return value;
          const keep = new Set(select.split(","));
          return Object.fromEntries(Object.entries(value).filter(([k]) => keep.has(k)));
        };
        const user = /^\/users\/([^?]*)/.exec(decoded);
        if (user) {
          // Graph answers 400 for some valid addresses in the key segment (an apostrophe, for one).
          if (user[1]!.includes("'")) return void res.status(400).json({ error: { code: "Request_BadRequest" } });
          const hit = tenantUsers.get(user[1]!);
          return void (hit
            ? res.json(selected({ ...hit, mail: user[1] }))
            : res.status(404).json({ error: { code: "Request_ResourceNotFound" } }));
        }
        if (decoded.startsWith("/users?")) {
          const filter = /mail eq '((?:[^']|'')*)'/.exec(decoded);
          const mail = filter ? filter[1]!.replace(/''/g, "'") : "";
          const hit = tenantUsers.get(mail);
          return void res.json({ value: hit ? [selected({ ...hit, mail })] : [] });
        }
      }
      if (req.method === "POST") {
        if (decoded.includes(":/createUploadSession")) {
          const url = `${msBase}/up.1drv.example/session-${sessionUrls.length + 1}-${randomUUID()}`;
          sessionUrls.push(url);
          return void res.json({ uploadUrl: url, expirationDateTime: "2099-01-01T00:00:00Z" });
        }
        if (decoded.endsWith("/invite")) {
          if (inviteGate) await inviteGate;
          const email = (req.body as { recipients: Array<{ email: string }> }).recipients[0]!.email;
          const { status, body } = inviteStatus(email);
          return void res.status(status).json(body);
        }
        if (decoded.endsWith("/createLink")) {
          const body = req.body as { type: string; scope: string };
          return void res.json({ link: { webUrl: ORG_LINK_URL, type: body.type, scope: body.scope } });
        }
      }
      res.status(404).json({ error: { code: "unexpected", path: decoded } });
    });
    msServer = createServer(app);
    await new Promise<void>((resolve) => msServer!.listen(0, "127.0.0.1", resolve));
    const address = msServer.address();
    if (!address || typeof address === "string") throw new Error("no port");
    msBase = `http://127.0.0.1:${address.port}`;
    process.env.MICROSOFT_GRAPH_BASE_URL = `${msBase}/graph`;
    delete process.env.AGENTDASH_PERSON_UPLOAD_MAX_BYTES;

    // -- fixtures --------------------------------------------------------------
    const [flagged, unflagged] = await db
      .insert(companies)
      .values([
        { name: `Flagged ${randomUUID()}`, issuePrefix: `BU${randomUUID().slice(0, 4).toUpperCase()}` },
        { name: `Plain ${randomUUID()}`, issuePrefix: `BP${randomUUID().slice(0, 4).toUpperCase()}` },
      ])
      .returning();
    FLAGGED = flagged!.id;
    UNFLAGGED = unflagged!.id;
    const now = new Date();
    const people: Array<[string, string, string]> = [
      [PERSON_A, "Person A", `person.a${EMAIL_DOMAIN}`],
      [PERSON_B, "Person B", `person.b${EMAIL_DOMAIN}`],
      [PERSON_C, "Person C", `person.outside@elsewhere.example.test`],
      [PERSON_D1, "Person D", `person.d1${EMAIL_DOMAIN}`],
      [PERSON_D2, "Person D", `person.d2${EMAIL_DOMAIN}`],
    ];
    await db.insert(authUsers).values(
      people.map(([id, name, email]) => ({ id, name, email, emailVerified: true, createdAt: now, updatedAt: now })),
    );
    for (const companyId of [FLAGGED, UNFLAGGED]) {
      await db.insert(companyMemberships).values(
        people.map(([id]) => ({
          companyId,
          principalType: "user",
          principalId: id,
          status: "active",
          membershipRole: id === PERSON_A ? "owner" : "member",
        })),
      );
    }
    await featureFlagsService(db).set(FLAGGED, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS, true);
    AGENT_B = await db
      .insert(agents)
      .values({
        companyId: FLAGGED,
        name: "Agent B",
        role: "general",
        status: "idle",
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      })
      .returning()
      .then((rows) => rows[0]!.id);
    await db.insert(agentStewardships).values({ companyId: FLAGGED, agentId: AGENT_B, userId: PERSON_B });
    ACCESS = `graph-access-${randomUUID()}`;
  });

  afterEach(async () => {
    // Every response this test saw: never an email, a token, or a session URL.
    const all = seen.join("\n");
    seen.length = 0;
    expect(all).not.toContain(EMAIL_DOMAIN);
    expect(all).not.toMatch(/uploadUrl/);
    expect(all).not.toMatch(/up\.1drv/);
    expect(all).not.toMatch(/accessToken|graph-access-|refresh_token/);
    for (const url of sessionUrls) expect(all).not.toContain(url);
    __setFragmentForwardBudget(null);
    if (msServer?.listening) {
      msServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => msServer!.close((e) => (e ? reject(e) : resolve())));
    }
    msServer = null;
    delete process.env.MICROSOFT_GRAPH_BASE_URL;
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(activityLog);
    await db.delete(bridgeUploads);
    await db.delete(stewardInboxActionHandles);
    await db.delete(bridgeEndpoints);
    await db.delete(connections);
    await db.delete(issues);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(featureFlags);
    await db.delete(companies);
  });

  // -- helpers -----------------------------------------------------------------

  /** The production stack: the real actor middleware in front of the bridge routes. */
  function app() {
    const a = express();
    a.use(express.json());
    a.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    a.use("/api", bridgeRoutes(db));
    a.use(errorHandler);
    return a;
  }

  async function endpointFor(
    userId: string,
    capabilities = ["bridge:read", "bridge:inbox", "bridge:upload"],
    companyId = FLAGGED,
  ) {
    const bridge = bridgeService(db);
    const { enrollmentId } = await bridge.requestEnrollment(companyId, {
      userId,
      label: `laptop-${randomUUID().slice(0, 6)}`,
      capabilities,
    });
    return bridge.approveEnrollment(companyId, enrollmentId, userId);
  }

  async function connectMicrosoft(userId: string, scopes: string[], companyId = FLAGGED) {
    const svc = connectorService(db);
    const pending = await svc.storeOAuthState(companyId, "user", userId, "microsoft", { stateToken: "unused" });
    await svc.completeOAuthConnection(pending.id, {
      scopes,
      accountLabel: `${userId}${EMAIL_DOMAIN}`,
      sendIdentity: "delegated",
      token: {
        accessToken: ACCESS,
        refreshToken: `refresh-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        tokenType: "Bearer",
        scope: scopes.join(" "),
      },
    });
  }

  const WRITE_TIER = ["User.Read", "Files.Read.All", "Sites.Read.All", "Files.ReadWrite", "User.ReadBasic.All"];

  /** Every response body this test saw, to assert on as one string. */
  const seen: string[] = [];
  const post = (token: string, route: string, body: unknown = {}) =>
    request(app())
      .post(`/api/bridge/upload/${route}`)
      .set("authorization", `Bearer ${token}`)
      .send(body as object)
      .then((res) => {
        seen.push(res.text);
        return res;
      });

  const deck = (overrides: Record<string, unknown> = {}) => ({
    name: "deck.pptx",
    byteSize: FILE_BYTES,
    contentType: PPTX,
    sha256: SHA,
    ...overrides,
  });

  async function ready() {
    const { token, endpointId } = await endpointFor(PERSON_A);
    await connectMicrosoft(PERSON_A, WRITE_TIER);
    return { token, endpointId };
  }

  function sendFragment(token: string, uploadId: string, start: number, bytes: Buffer, total = FILE_BYTES) {
    return request(app())
      .post("/api/bridge/upload/fragment")
      .set("authorization", `Bearer ${token}`)
      .set("x-agentdash-upload-id", uploadId)
      .set("content-type", "application/octet-stream")
      .set("content-range", `bytes ${start}-${start + bytes.length - 1}/${total}`)
      .send(bytes)
      .then((res) => {
        seen.push(res.text);
        return res;
      });
  }

  /** Propose, confirm, and send both fragments. Returns the final response. */
  async function uploadAll(token: string, proposal: Record<string, unknown>) {
    const proposed = await post(token, "propose", proposal);
    expect(proposed.body.ok, JSON.stringify(proposed.body)).toBe(true);
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    expect(confirmed.body.ok, JSON.stringify(confirmed.body)).toBe(true);
    const first = await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT, 1));
    expect(first.status, first.text).toBe(200);
    const last = await sendFragment(token, confirmed.body.uploadId, UPLOAD_FRAGMENT_UNIT, Buffer.alloc(1000, 2));
    return { proposed, confirmed, first, last };
  }

  const activities = (prefix = "document.person_upload_") =>
    db.select().from(activityLog).where(like(activityLog.action, `${prefix}%`));

  // -- gates -------------------------------------------------------------------

  it("answers 404 on every upload route while the company's flag is off", async () => {
    const { token } = await endpointFor(PERSON_A, undefined, UNFLAGGED);
    await connectMicrosoft(PERSON_A, WRITE_TIER, UNFLAGGED);
    const statuses = [];
    for (const route of ["destinations", "propose", "confirm", "status", "cancel"]) {
      statuses.push((await post(token, route, { handle: "x", uploadId: randomUUID(), file: deck() })).status);
    }
    statuses.push((await sendFragment(token, randomUUID(), 0, Buffer.alloc(10), 10)).status);
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
    expect(graphCalls).toHaveLength(0);
  });

  it("refuses an endpoint paired without bridge:upload (403)", async () => {
    const { token } = await endpointFor(PERSON_A, ["bridge:read", "bridge:inbox"]);
    await connectMicrosoft(PERSON_A, WRITE_TIER);
    const res = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/bridge:upload/);
    const dest = await post(token, "destinations", {});
    expect(dest.status).toBe(403);
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("refuses an agent credential on every upload route (403)", async () => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = { type: "agent", agentId: AGENT_B, companyId: FLAGGED, source: "agent_key" };
      next();
    });
    a.use("/api", bridgeRoutes(db));
    a.use(errorHandler);
    for (const route of ["destinations", "propose", "confirm", "fragment", "status", "cancel"]) {
      const res = await request(a).post(`/api/bridge/upload/${route}`).send({});
      expect(res.status, route).toBe(403);
    }
  });

  it("mints bridge:upload on connect-code redeem: it is in the capability vocabulary", async () => {
    // The enrolment itself is the check: an unknown capability is refused.
    const { endpointId } = await endpointFor(PERSON_A);
    const [row] = await db.select().from(bridgeEndpoints).where(eq(bridgeEndpoints.id, endpointId));
    expect(row!.capabilities).toContain("bridge:upload");
    const source = readFileSync(path.join(repoRoot, "server/src/routes/connect-codes.ts"), "utf8");
    expect(source).toMatch(/BRIDGE_UPLOAD_CAPABILITY\]/);
  });

  it("refuses a read-only Microsoft connection with write_scope_missing and mints nothing", async () => {
    const { token } = await endpointFor(PERSON_A);
    await connectMicrosoft(PERSON_A, ["User.Read", "Files.Read.All", "Sites.Read.All"]);
    const res = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, reason: "write_scope_missing" });
    expect(res.body.handle).toBeUndefined();
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("says to connect Microsoft first when the person has no connection", async () => {
    const { token } = await endpointFor(PERSON_A);
    const res = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    expect(res.body).toMatchObject({ ok: false, reason: "microsoft_not_connected" });
  });

  // -- propose -------------------------------------------------------------------

  it("refuses an oversize file and a .zip at propose, before any folder lookup", async () => {
    const { token } = await ready();
    process.env.AGENTDASH_PERSON_UPLOAD_MAX_BYTES = String(FILE_BYTES - 1);
    const big = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    expect(big.body).toMatchObject({ ok: false, reason: "file_too_large" });
    delete process.env.AGENTDASH_PERSON_UPLOAD_MAX_BYTES;
    const zip = await post(token, "propose", {
      file: deck({ name: "deck.zip", contentType: "application/zip" }),
      destination: { folderId: "folder-kickoff" },
    });
    expect(zip.body).toMatchObject({ ok: false, reason: "file_type_not_allowed" });
    // A docx named .pptx is a mismatch too.
    const mismatch = await post(token, "propose", {
      file: deck({ name: "deck.docx" }),
      destination: { folderId: "folder-kickoff" },
    });
    expect(mismatch.body).toMatchObject({ ok: false, reason: "file_type_not_allowed" });
    expect(graphCalls.filter((c) => c.path.startsWith("/me/drive/items"))).toHaveLength(0);
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("D10: with no destination it mints no handle and lists folders to pick from", async () => {
    const { token } = await ready();
    const res = await post(token, "propose", { file: deck() });
    expect(res.body).toMatchObject({ ok: false, reason: "destination_required" });
    expect(res.body.candidates).toEqual([
      expect.objectContaining({ folderId: "folder-top", name: "Client projects", path: "Client projects" }),
    ]);
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("lists destinations: own-drive folders only, filtered by a query", async () => {
    const { token } = await ready();
    const all = await post(token, "destinations", {});
    expect(all.body.ok).toBe(true);
    expect(all.body.folders.map((f: { folderId: string }) => f.folderId)).toEqual(["folder-top"]);
    const searched = await post(token, "destinations", { query: "kick" });
    expect(searched.body.folders).toEqual([
      { folderId: "folder-kickoff", name: "Kickoff", path: "Client projects/Kickoff", webUrl: "https://onedrive.example.test/cp/kickoff" },
    ]);
    expect(graphCalls.every((c) => c.method === "GET")).toBe(true);
  });

  it("resolves an exact path; an unknown path or a file mints no handle and offers candidates", async () => {
    const { token } = await ready();
    const missing = await post(token, "propose", { file: deck(), destination: { path: "Client projects/Kick" } });
    expect(missing.body).toMatchObject({ ok: false, reason: "destination_not_found" });
    expect(missing.body.candidates.map((c: { folderId: string }) => c.folderId)).toContain("folder-kickoff");
    const file = await post(token, "propose", { file: deck(), destination: { folderId: "file-notes" } });
    expect(file.body).toMatchObject({ ok: false, reason: "destination_not_folder" });
    const escape = await post(token, "propose", { file: deck(), destination: { path: "../other" } });
    expect(escape.body).toMatchObject({ ok: false, reason: "destination_invalid" });
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
    const found = await post(token, "propose", { file: deck(), destination: { path: "/Client projects/Kickoff/" } });
    expect(found.body.ok).toBe(true);
    expect(found.body.readback[0]).toContain("Client projects/Kickoff");
  });

  it("an ambiguous recipient mints no handle and comes back with names and roles, never an email", async () => {
    const { token } = await ready();
    const res = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person D", role: "write" }],
    });
    expect(res.body).toMatchObject({ ok: false, reason: "person_unresolved" });
    expect(res.body.ambiguities[0].didYouMean).toHaveLength(2);
    expect(res.body.ambiguities[0].didYouMean[0]).toEqual({ userId: expect.any(String), name: "Person D", role: "member" });
    expect(res.text).not.toContain(EMAIL_DOMAIN);
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
    // Picking one by id resolves it.
    const picked = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ userId: PERSON_D1, role: "read" }],
    });
    tenantUsers.set(`person.d1${EMAIL_DOMAIN}`, { id: "aad-d1", userType: "Member" });
    const again = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ userId: PERSON_D1, role: "read" }],
    });
    expect(picked.body.reason).toBe("recipient_outside_organization");
    expect(again.body.ok).toBe(true);
  });

  it("asks for view or edit instead of assuming", async () => {
    const { token } = await ready();
    const res = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person B" }],
    });
    expect(res.body).toMatchObject({ ok: false, reason: "role_required", people: ["Person B"] });
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("refuses a recipient outside the Microsoft organization at propose, and never invites", async () => {
    const { token } = await ready();
    const res = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person C", role: "read" }],
    });
    expect(res.body).toMatchObject({ ok: false, reason: "recipient_outside_organization", person: "Person C" });
    expect(res.text).not.toContain("elsewhere.example.test");
    expect(graphCalls.some((c) => c.path.endsWith("/invite"))).toBe(false);
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("refuses a guest already in the directory, by its #EXT# principal name", async () => {
    const { token } = await ready();
    const propose = () =>
      post(token, "propose", {
        file: deck(),
        destination: { folderId: "folder-kickoff" },
        recipients: [{ name: "Person B", role: "read" }],
      });
    tenantUsers.set(`person.b${EMAIL_DOMAIN}`, {
      id: "aad-b",
      userType: "Member",
      userPrincipalName: "person.b_partner.example.test#EXT#@tenant.example.test",
    });
    expect((await propose()).body.reason).toBe("recipient_outside_organization");
    // Only basic profile fields are asked for, which is all User.ReadBasic.All returns.
    const lookups = graphCalls.filter((c) => c.path.startsWith("/users"));
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((c) => c.path.includes("$select=id,mail,userPrincipalName") && !c.path.includes("userType"))).toBe(true);
  });

  it("falls back to the mail filter when Graph answers 400 to the direct lookup", async () => {
    const { token } = await ready();
    const odd = `o'neil.d1${EMAIL_DOMAIN}`;
    await db.update(authUsers).set({ email: odd }).where(eq(authUsers.id, PERSON_D1));
    tenantUsers.set(odd, { id: "aad-d1" });
    const res = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ userId: PERSON_D1, role: "read" }],
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(graphCalls.some((c) => c.path.startsWith("/users?$filter=mail eq 'o''neil.d1"))).toBe(true);
  });

  it("refuses an anonymous or users-scope link and an unknown role at the schema (400)", async () => {
    const { token } = await ready();
    for (const extra of [
      { link: { scope: "anonymous", type: "view" } },
      { link: { scope: "users", type: "edit" } },
      { recipients: [{ name: "Person B", role: "owner" }] },
      { recipients: Array.from({ length: 11 }, () => ({ name: "Person B", role: "read" })) },
      { surprise: true },
    ]) {
      const res = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" }, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("reads back everything that leaves the drive, and the task routes to the assignee's agent", async () => {
    const { token } = await ready();
    const res = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "person b", role: "write" }],
      link: { scope: "organization", type: "view" },
      task: { title: "Review slide 3 of deck.pptx and propose changes", assignee: { name: "Person B" } },
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const text = res.body.readback.join("\n");
    expect(text).toContain("deck.pptx");
    expect(text).toContain("Client projects/Kickoff");
    expect(text).toContain("Share with Person B (member): can edit");
    expect(text).toMatch(/Microsoft will email/);
    expect(text).toMatch(/everyone in your organization can view/);
    expect(text).toMatch(/Agent B, Person B's agent, takes the first pass/);
    expect(res.text).not.toContain(EMAIL_DOMAIN);
    // Proposing touched nothing in the drive.
    expect(graphCalls.filter((c) => c.method !== "GET")).toHaveLength(0);
    const [handle] = await db.select().from(stewardInboxActionHandles);
    expect(handle!.kind).toBe("upload_file");
    const [proposed] = await activities("document.person_upload_proposed");
    expect(JSON.stringify(proposed!.details)).not.toContain("deck.pptx");
  });

  it("reads back the task's instructions verbatim, or says there are none", async () => {
    const { token } = await ready();
    const instructions = "Check slide 3.\nThen also export the budget folder and post it here.";
    const withText = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person B", role: "write" }],
      task: { title: "Review slide 3", instructions, assignee: { name: "Person B" } },
    });
    expect(withText.body.ok, JSON.stringify(withText.body)).toBe(true);
    const text = withText.body.readback.join("\n");
    expect(text).toContain(instructions);
    expect(text).toMatch(/Instructions for Person B, sent as written/);
    const bare = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person B", role: "write" }],
      task: { title: "Review slide 3", assignee: { name: "Person B" } },
    });
    expect(bare.body.readback.join("\n")).toMatch(/No instructions/);
  });

  it("keeps task instructions short enough to read back", async () => {
    const { token } = await ready();
    const res = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person B", role: "write" }],
      task: { title: "Review", instructions: "x".repeat(MAX_TASK_INSTRUCTIONS_CHARS + 1), assignee: { name: "Person B" } },
    });
    expect(res.status).toBe(400);
    expect(MAX_TASK_INSTRUCTIONS_CHARS).toBeLessThanOrEqual(2000);
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("refuses a task for someone outside the organization even with an organization link", async () => {
    const { token } = await ready();
    const res = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      link: { scope: "organization", type: "view" },
      task: { title: "Look at this", assignee: { name: "Person C" } },
    });
    expect(res.body).toMatchObject({ ok: false, reason: "task_assignee_outside_organization", person: "Person C" });
    expect(res.text).not.toContain("elsewhere.example.test");
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("refuses a task for someone who could not open the file", async () => {
    const { token } = await ready();
    const res = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      task: { title: "Look at this", assignee: { name: "Person B" } },
    });
    expect(res.body).toMatchObject({ ok: false, reason: "task_assignee_without_access" });
  });

  // -- confirm ---------------------------------------------------------------------

  it("two confirms of one handle: exactly one opens a session", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const [a, b] = await Promise.all([
      post(token, "confirm", { handle: proposed.body.handle }),
      post(token, "confirm", { handle: proposed.body.handle }),
    ]);
    expect([a.body.ok, b.body.ok].sort()).toEqual([false, true]);
    expect([a.body.reason, b.body.reason]).toContain("handle_invalid");
    expect(graphCalls.filter((c) => c.path.includes("createUploadSession"))).toHaveLength(1);
    expect(await db.select().from(bridgeUploads)).toHaveLength(1);
  });

  it("an upload handle cannot be spent through inbox confirm, and an inbox handle not here", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const inbox = await request(app())
      .post("/api/bridge/inbox/confirm")
      .set("authorization", `Bearer ${token}`)
      .send({ token: proposed.body.handle });
    expect(inbox.body.ok).toBe(false);
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    expect(confirmed.body.ok).toBe(true);
  });

  it("confirm returns an upload id and fragment size, never the session URL, and stores the URL encrypted", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: true, fragmentBytes: 10 * 1024 * 1024, byteSize: FILE_BYTES });
    const session = graphCalls.find((c) => c.path.includes("createUploadSession"))!;
    expect(session.path).toBe("/me/drive/items/folder-kickoff:/deck.pptx:/createUploadSession");
    expect(session.body).toEqual({ item: { "@microsoft.graph.conflictBehavior": "rename", name: "deck.pptx" } });
    const [row] = await db.select().from(bridgeUploads);
    expect(JSON.stringify(row)).not.toContain(sessionUrls[0]!);
    expect(JSON.stringify(row)).not.toContain("up.1drv");
  });

  // -- fragments --------------------------------------------------------------------

  it("forwards each fragment unchanged, with the same Content-Range and no Authorization", async () => {
    const { token } = await ready();
    const { first, last } = await uploadAll(token, { file: deck(), destination: { folderId: "folder-kickoff" } });
    expect(first.body).toMatchObject({ ok: true, nextExpectedRanges: [`${UPLOAD_FRAGMENT_UNIT}-`] });
    expect(last.body).toMatchObject({
      ok: true,
      completed: true,
      item: { driveId: DRIVE, itemId: "item-deck", name: "deck.pptx", webUrl: ITEM_WEB_URL },
      sharing: [],
    });
    expect(uploadCalls.map((c) => [c.method, c.contentRange, c.auth, c.bytes])).toEqual([
      ["PUT", `bytes 0-${UPLOAD_FRAGMENT_UNIT - 1}/${FILE_BYTES}`, null, UPLOAD_FRAGMENT_UNIT],
      ["PUT", `bytes ${UPLOAD_FRAGMENT_UNIT}-${FILE_BYTES - 1}/${FILE_BYTES}`, null, 1000],
    ]);
    const [row] = await db.select().from(bridgeUploads);
    expect(row).toMatchObject({ status: "completed", driveId: DRIVE, itemId: "item-deck", uploadUrlEncrypted: null });
  });

  it("refuses a body longer than its Content-Range with 413 and forwards nothing", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    const res = await request(app())
      .post("/api/bridge/upload/fragment")
      .set("authorization", `Bearer ${token}`)
      .set("x-agentdash-upload-id", confirmed.body.uploadId)
      .set("content-type", "application/octet-stream")
      .set("content-range", `bytes 0-${UPLOAD_FRAGMENT_UNIT - 1}/${FILE_BYTES}`)
      .send(Buffer.alloc(UPLOAD_FRAGMENT_UNIT + 1));
    expect(res.status).toBe(413);
    expect(uploadCalls).toHaveLength(0);
  });

  it("refuses a fragment that is not a 320 KiB multiple, a wrong total, or another endpoint's upload", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    const odd = await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(1000));
    expect(odd.status).toBe(400);
    const wrongTotal = await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT), FILE_BYTES + 1);
    expect(wrongTotal.status).toBe(400);
    const other = await endpointFor(PERSON_A);
    const foreign = await sendFragment(other.token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    expect(foreign.status).toBe(404);
    expect(uploadCalls).toHaveLength(0);
  });

  it("retries a Microsoft 5xx on a fragment, then reports it for the client to resume", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    fragmentFailures = 2;
    const ok = await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    expect(ok.status).toBe(200);
    expect(uploadCalls).toHaveLength(3);
    fragmentFailures = 10;
    const down = await sendFragment(token, confirmed.body.uploadId, UPLOAD_FRAGMENT_UNIT, Buffer.alloc(1000));
    expect(down.status).toBe(502);
    expect(down.body.reason).toBe("microsoft_unreachable");
    const status = await post(token, "status", { uploadId: confirmed.body.uploadId });
    expect(status.body).toMatchObject({ ok: true, status: "open", nextExpectedRanges: [`${UPLOAD_FRAGMENT_UNIT}-`] });
  });

  it("the last fragment shares, links, creates the routed task with one metadata-only comment, and audits ids only", async () => {
    const { token } = await ready();
    const { last } = await uploadAll(token, {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person B", role: "write" }],
      link: { scope: "organization", type: "view" },
      task: { title: "Review slide 3 and propose changes", instructions: "Focus on the numbers.", assignee: { name: "Person B" } },
      message: "For the kickoff",
    });
    expect(last.body).toMatchObject({
      ok: true,
      completed: true,
      sharing: [{ userId: PERSON_B, name: "Person B", role: "write", ok: true }],
      link: { scope: "organization", type: "view", ok: true, webUrl: ORG_LINK_URL },
      issue: { ok: true, created: true, assignedTo: { agentName: "Agent B" } },
    });

    const invite = graphCalls.find((c) => c.path.endsWith("/invite"))!;
    expect(invite.path).toBe(`/drives/${DRIVE}/items/item-deck/invite`);
    expect(invite.body).toEqual({
      recipients: [{ email: `person.b${EMAIL_DOMAIN}` }],
      roles: ["write"],
      requireSignIn: true,
      sendInvitation: true,
      message: "For the kickoff",
    });
    const link = graphCalls.find((c) => c.path.endsWith("/createLink"))!;
    expect(link.body).toEqual({ type: "view", scope: "organization" });
    for (const call of graphCalls.filter((c) => c.method === "POST")) {
      expect(JSON.stringify(call.body)).not.toMatch(/anonymous/);
    }

    const [issue] = await db.select().from(issues).where(eq(issues.id, last.body.issue.issueId));
    expect(issue).toMatchObject({ title: "Review slide 3 and propose changes", assigneeAgentId: AGENT_B, createdByUserId: PERSON_A });
    expect(issue!.description).toContain("Focus on the numbers.");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue!.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorUserId).toBe(PERSON_A);
    expect(comments[0]!.body).toContain(ITEM_WEB_URL);
    expect(comments[0]!.body).toContain(`${DRIVE}/item-deck`);
    expect(comments[0]!.body).toContain("Person B (can edit)");
    expect(comments[0]!.body).not.toContain(EMAIL_DOMAIN);
    const created = await db.select().from(activityLog).where(eq(activityLog.action, "issue.created"));
    expect(created[0]!.details).toMatchObject({ routedToStewardedAgent: { fromUserId: PERSON_B, toAgentId: AGENT_B } });
    // The routed agent is woken for it, knowing the work came via its steward.
    let wakes: Array<typeof agentWakeupRequests.$inferSelect> = [];
    for (let i = 0; i < 200 && wakes.length === 0; i += 1) {
      wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, AGENT_B));
      if (wakes.length === 0) await new Promise((r) => setTimeout(r, 10));
    }
    // Recorded as skipped here (the fixture agent does not run), with the wake intact.
    expect(wakes[0]).toMatchObject({ source: "assignment" });
    expect(wakes[0]!.payload).toMatchObject({ issueId: issue!.id, routedFromStewardUserId: PERSON_B });

    const rows = await activities();
    expect(rows.map((r) => r.action).sort()).toEqual([
      "document.person_upload_completed",
      "document.person_upload_confirmed",
      "document.person_upload_proposed",
      "document.person_upload_shared",
    ]);
    for (const row of rows) {
      const details = JSON.stringify(row.details);
      expect(details).not.toContain("deck.pptx");
      expect(details).not.toContain(EMAIL_DOMAIN);
      expect(details).not.toContain("Person B");
      expect(row.actorId).toBe(PERSON_A);
    }
    const shared = rows.find((r) => r.action === "document.person_upload_shared")!;
    expect(shared.details).toMatchObject({ recipients: [{ userId: PERSON_B, role: "write", ok: true }], itemId: "item-deck" });
  });

  it("posts the link on an existing task instead, by identifier", async () => {
    const { token } = await ready();
    const existing = await db
      .insert(issues)
      .values({ companyId: FLAGGED, title: "Kickoff prep", identifier: "KICK-12", status: "todo", createdByUserId: PERSON_A })
      .returning()
      .then((rows) => rows[0]!);
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" }, issueId: "kick-12" });
    expect(proposed.body.readback.join("\n")).toContain("Post the link on KICK-12: Kickoff prep");
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    const last = await sendFragment(token, confirmed.body.uploadId, UPLOAD_FRAGMENT_UNIT, Buffer.alloc(1000));
    expect(last.body.issue).toMatchObject({ ok: true, issueId: existing.id, created: false });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, existing.id));
    expect(comments).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(1);
  });

  it("an invite answered 207 is that person's ok:false, never a thrown error", async () => {
    const { token } = await ready();
    tenantUsers.set(`person.d1${EMAIL_DOMAIN}`, { id: "aad-d1", userType: "Member" });
    inviteStatus = (email) =>
      email.startsWith("person.d1")
        ? { status: 207, body: { value: [{ error: { code: "accessDenied", message: "x" } }] } }
        : { status: 200, body: { value: [{ id: "perm" }] } };
    const { last } = await uploadAll(token, {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [
        { name: "Person B", role: "read" },
        { userId: PERSON_D1, role: "write" },
      ],
    });
    expect(last.status).toBe(200);
    expect(last.body.sharing).toEqual([
      { userId: PERSON_B, name: "Person B", role: "read", ok: true },
      { userId: PERSON_D1, name: "Person D", role: "write", ok: false, reason: "accessDenied" },
    ]);
  });

  it("re-checks the organization before inviting, and skips the invite if it changed", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person B", role: "read" }],
    });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    tenantUsers.delete(`person.b${EMAIL_DOMAIN}`);
    await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    const last = await sendFragment(token, confirmed.body.uploadId, UPLOAD_FRAGMENT_UNIT, Buffer.alloc(1000));
    expect(last.body.sharing).toEqual([
      { userId: PERSON_B, name: "Person B", role: "read", ok: false, reason: "recipient_outside_organization" },
    ]);
    expect(graphCalls.some((c) => c.path.endsWith("/invite"))).toBe(false);
  });

  // -- status, cancel, retention -------------------------------------------------------

  it("cancel sends DELETE to the session and marks the upload cancelled", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    const res = await post(token, "cancel", { uploadId: confirmed.body.uploadId });
    expect(res.body).toMatchObject({ ok: true, status: "cancelled" });
    expect(uploadCalls.map((c) => [c.method, c.auth])).toEqual([["DELETE", null]]);
    const [row] = await db.select().from(bridgeUploads);
    expect(row).toMatchObject({ status: "cancelled", uploadUrlEncrypted: null });
    const after = await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    expect(after.status).toBe(409);
    expect((await activities("document.person_upload_cancelled")).length).toBe(1);
  });

  // -- membership ------------------------------------------------------------------------

  it("refuses every upload route once the person is no longer an active member", async () => {
    const { token } = await ready();
    const existing = await db
      .insert(issues)
      .values({ companyId: FLAGGED, title: "Kickoff prep", identifier: "KICK-12", status: "todo", createdByUserId: PERSON_A })
      .returning()
      .then((rows) => rows[0]!);
    const first = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" }, issueId: "KICK-12" });
    const second = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" }, issueId: "KICK-12" });
    const confirmed = await post(token, "confirm", { handle: first.body.handle });
    expect(confirmed.body.ok).toBe(true);
    graphCalls = [];

    await db
      .update(companyMemberships)
      .set({ status: "archived" })
      .where(and(eq(companyMemberships.companyId, FLAGGED), eq(companyMemberships.principalId, PERSON_A)));

    const statuses: Record<string, number> = {};
    statuses.destinations = (await post(token, "destinations", {})).status;
    statuses.propose = (await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } })).status;
    statuses.confirm = (await post(token, "confirm", { handle: second.body.handle })).status;
    statuses.fragment = (await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT))).status;
    statuses.status = (await post(token, "status", { uploadId: confirmed.body.uploadId })).status;
    statuses.cancel = (await post(token, "cancel", { uploadId: confirmed.body.uploadId })).status;
    expect(statuses).toEqual({ destinations: 403, propose: 403, confirm: 403, fragment: 403, status: 403, cancel: 403 });
    expect(uploadCalls).toHaveLength(0);
    expect(graphCalls).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, existing.id))).toHaveLength(0);
  });

  it("archiving a member revokes their paired machines", async () => {
    const { token, endpointId } = await endpointFor(PERSON_B);
    await connectMicrosoft(PERSON_B, WRITE_TIER);
    const [membership] = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, FLAGGED), eq(companyMemberships.principalId, PERSON_B)));
    await accessService(db).archiveMember(FLAGGED, membership!.id, { actorUserId: PERSON_A });
    const [endpoint] = await db.select().from(bridgeEndpoints).where(eq(bridgeEndpoints.id, endpointId));
    expect(endpoint!.revokedAt).not.toBeNull();
    expect(endpoint!.revokedByUserId).toBe(PERSON_A);
    const res = await post(token, "destinations", {});
    expect(res.status).toBe(403);
    expect(graphCalls).toHaveLength(0);
  });

  // -- recovery: Microsoft committed the file but the answer was lost ---------------------

  it("finds the file when the final fragment's answer was lost, and still shares it", async () => {
    const { token } = await ready();
    dropFinalResponse = true;
    landedName = "deck 1.pptx";
    const { last } = await uploadAll(token, {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person B", role: "read" }],
    });
    expect(last.status, last.text).toBe(200);
    expect(last.body).toMatchObject({
      ok: true,
      completed: true,
      item: { itemId: "item-deck", name: "deck 1.pptx", webUrl: ITEM_WEB_URL },
      sharing: [{ userId: PERSON_B, name: "Person B", role: "read", ok: true }],
    });
    const [row] = await db.select().from(bridgeUploads);
    expect(row).toMatchObject({ status: "completed", itemId: "item-deck" });
    // The older file of the same name was never taken for this one.
    expect(graphCalls.filter((c) => c.path.endsWith("/invite")).map((c) => c.path)).toEqual([
      `/drives/${DRIVE}/items/item-deck/invite`,
    ]);
  });

  it("status finds a landed file after the session is gone; with none, it says to check the folder", async () => {
    const { token } = await ready();
    const begin = async () => {
      const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
      const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
      return confirmed.body.uploadId as string;
    };
    const uploadId = await begin();
    await sendFragment(token, uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    // Microsoft finished with the session and stored the file; nobody heard back.
    goneSessions.add(new URL(sessionUrls[0]!).pathname);
    landed.push({
      id: "item-deck",
      name: "deck.pptx",
      size: FILE_BYTES,
      file: { mimeType: PPTX },
      createdDateTime: new Date().toISOString(),
      webUrl: ITEM_WEB_URL,
      parentReference: { driveId: DRIVE, id: "folder-kickoff" },
    });
    const found = await post(token, "status", { uploadId });
    expect(found.body).toMatchObject({ ok: true, status: "completed", item: { itemId: "item-deck" }, sharing: [] });

    landed = [];
    const other = await begin();
    goneSessions.add(new URL(sessionUrls[1]!).pathname);
    const missing = await post(token, "status", { uploadId: other });
    expect(missing.body).toMatchObject({ ok: false, reason: "session_expired" });
    expect(missing.body.message).toContain("Client projects/Kickoff");
    expect(missing.body.message).not.toMatch(/propose it again\.?$/);
  });

  it("a lost final answer with no file to be found says the file may have landed, not that nothing happened", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    goneSessions.add(new URL(sessionUrls[0]!).pathname);
    const last = await sendFragment(token, confirmed.body.uploadId, UPLOAD_FRAGMENT_UNIT, Buffer.alloc(1000));
    expect(last.status).toBe(410);
    expect(last.body).toMatchObject({ ok: false, reason: "session_expired" });
    expect(last.body.message).toMatch(/may/);
    expect(last.body.message).toContain("Client projects/Kickoff");
  });

  // -- finishing: the file is up, sharing is still running ---------------------------------

  it("while sharing still runs, status and a re-sent last fragment say finishing, never 'shared with nobody'", async () => {
    const { token } = await ready();
    let release!: () => void;
    inviteGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proposed = await post(token, "propose", {
      file: deck(),
      destination: { folderId: "folder-kickoff" },
      recipients: [{ name: "Person B", role: "read" }],
    });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    const uploadId = confirmed.body.uploadId as string;
    await sendFragment(token, uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    const finalRequest = sendFragment(token, uploadId, UPLOAD_FRAGMENT_UNIT, Buffer.alloc(1000));
    for (let i = 0; i < 300; i += 1) {
      if (graphCalls.some((c) => c.path.endsWith("/invite"))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const during = await post(token, "status", { uploadId });
    expect(during.body).toMatchObject({ ok: true, status: "completed", finishing: true, item: { itemId: "item-deck" } });
    expect(during.body.sharing).toBeUndefined();
    const resent = await sendFragment(token, uploadId, UPLOAD_FRAGMENT_UNIT, Buffer.alloc(1000));
    expect(resent.status).toBe(409);
    expect(resent.body).toMatchObject({ reason: "already_completed", finishing: true });
    expect(resent.body.sharing).toBeUndefined();

    release();
    const last = await finalRequest;
    expect(last.body.sharing).toEqual([{ userId: PERSON_B, name: "Person B", role: "read", ok: true }]);
    const after = await post(token, "status", { uploadId });
    expect(after.body).toMatchObject({ ok: true, status: "completed", sharing: [{ userId: PERSON_B, ok: true }] });
    expect(after.body.finishing).toBeUndefined();
  });

  it("gives up forwarding a fragment Microsoft never answers within the forwarding budget", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    const confirmed = await post(token, "confirm", { handle: proposed.body.handle });
    __setFragmentForwardBudget(300);
    hangFragments = true;
    const started = Date.now();
    const res = await sendFragment(token, confirmed.body.uploadId, 0, Buffer.alloc(UPLOAD_FRAGMENT_UNIT));
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("microsoft_unreachable");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("purges upload rows older than the retention window and keeps newer ones", async () => {
    const { token } = await ready();
    const proposed = await post(token, "propose", { file: deck(), destination: { folderId: "folder-kickoff" } });
    await post(token, "confirm", { handle: proposed.body.handle });
    const [row] = await db.select().from(bridgeUploads);
    const later = new Date(row!.createdAt.getTime() + (BRIDGE_UPLOAD_RETENTION_DAYS - 1) * 86_400_000);
    expect(await pruneBridgeUploads(db, later)).toBe(0);
    const expired = new Date(row!.createdAt.getTime() + (BRIDGE_UPLOAD_RETENTION_DAYS + 1) * 86_400_000);
    expect(await pruneBridgeUploads(db, expired)).toBe(1);
    expect(await db.select().from(bridgeUploads)).toHaveLength(0);
  });

});
