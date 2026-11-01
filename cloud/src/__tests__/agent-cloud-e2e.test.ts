// Cloud MCP toolset, end to end (doc/plans/2026-10-31-cloud-mcp-toolset.md):
// an agent's stdio MCP session (the real @agentdash/mcp-server, toolset
// "cloud", calling this control plane over HTTP) takes a person from nothing
// to a connected workspace:
//
//   check_name → start → (the person clicks the email link) → the real
//   provisioner on the fake Railway → (the person claims the box) → connect →
//   (the person approves on the box) → connect → the same session lists, and
//   uses, the setup tools against the box.
//
// The person's steps are simulated where they really happen: the magic link
// from the captured email, the claim on the box's health, the approval on the
// fake box. The agent's transcript never contains the magic link, the claim
// link or code, or a password.
import http from "node:http";
import { randomBytes } from "node:crypto";
import sodium from "libsodium-wrappers";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAgentDashServer, NO_INSTANCE_API_URL } from "@agentdash/mcp-server";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { decryptField } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { boxes } from "../db/schema.js";
import type { MailMessage } from "../front-door/mailer.js";
import { frontDoor } from "../front-door/service.js";
import { inviteService } from "../invites.js";
import { sweepCleanup } from "../jobs/cleanup.js";
import { JobRunner } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { provisionHandler } from "../railway/provisioner.js";
import { settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FakeBoxAuth } from "./fake-box-auth.js";
import { FAKE_WORKSPACE } from "./fake-railway.js";
import { FakeRailwayBoxes } from "./fake-railway-boxes.js";

const caps = vi.hoisted(() => ({ claimTrackingReady: true }));
vi.mock("../capabilities.js", () => ({ capabilities: caps }));

http.globalAgent = new http.Agent({ keepAlive: false });
const TAG = "v2026.930.0";
const SLUG = `e2e${Date.now() % 100000}`;
const EMAIL = `founder@${SLUG}.test`;
const BOX = `https://${SLUG}.agentdash.cloud`;
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
let server: http.Server;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });
const mail: MailMessage[] = [];

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
  await sodium.ready;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await close?.();
  await pg?.stop();
});

describe("an agent takes a person from nothing to a connected workspace", () => {
  it("start → verify → provision (fake Railway) → claim → approve → connect → the session lists and uses the setup tools", async () => {
    const config = loadConfig({
      DATABASE_URL: pg.url,
      CLOUD_DATA_KEY: "66".repeat(32),
      CLOUD_ADMIN_TOKEN: randomBytes(32).toString("hex"),
      CLOUD_ADMIN_ALLOWED_IPS: "127.0.0.1,::1",
      CLOUD_PUBLIC_SITE_URL: "https://www.agentdash.test",
    });
    const s = settingsService(db);
    await s.set("provisioning_enabled", true, "test");
    await s.set("waitlist_mode", true, "test");
    await s.set("daily_cap", 1000, "test");
    await s.set("target_release", TAG, "test");

    // The fleet: fake Railway (with GHCR and box health), and the box's CLI-auth routes on top.
    const railway = new FakeRailwayBoxes({ ghcrTags: [TAG] });
    const box = new FakeBoxAuth({ fallback: railway.http });
    const fd = frontDoor({
      db,
      log,
      config,
      mailer: { send: async (m) => void mail.push(m) },
      resolveMx: async (domain) => [{ exchange: `mx.${domain}` }],
    });
    server = createApp({ db, config, log, frontDoor: fd, agent: { boxFetch: box.fetch } }).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const cloudUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // The box's own API, as the upgraded session will see it: health is public,
    // everything else needs a board key the person approved.
    const boxApiCalls: Array<{ path: string; auth: string | null }> = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin !== BOX) return await realFetch(input, init);
      const auth = new Headers(init?.headers).get("authorization");
      boxApiCalls.push({ path: url.pathname, auth });
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/health") return json(200, { status: "ok", deploymentMode: "authenticated", bootstrapStatus: "ready", claimed: true, adapterReady: false });
      if (!auth?.startsWith("Bearer ") || !box.boardKeys.has(auth.slice(7))) return json(401, { error: "Unauthorized" });
      if (url.pathname === "/api/companies") return json(200, []);
      return json(404, { error: "not found" });
    });

    // The agent's stdio session: the real MCP server, toolset "cloud", talking to this control plane over HTTP.
    const mcp = createAgentDashServer(
      { apiUrl: NO_INSTANCE_API_URL, apiKey: "", companyId: null, agentId: null, runId: null },
      { toolset: "cloud", cloud: { cloudUrl } },
    );
    const client = new Client({ name: "e2e-agent", version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    await client.connect(clientSide);
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void (listChanged += 1));
    const transcript: string[] = [];
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as Array<{ text: string }>)[0]!.text;
      transcript.push(text);
      return { ...(JSON.parse(text) as Record<string, unknown>), isError: Boolean(r.isError) };
    };

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["agentdash_cloud_check_name", "agentdash_cloud_start", "agentdash_cloud_status", "agentdash_cloud_connect"]);

    // 1. The agent checks the name and starts the signup, with the person's admission code.
    expect(await call("agentdash_cloud_check_name", { slug: SLUG })).toMatchObject({ available: true });
    const invitation = await inviteService(db, config.dataKeys).addHosted("e2e", "test", null);
    const started = await call("agentdash_cloud_start", { email: EMAIL, slug: SLUG, admissionCode: invitation.code, acceptTerms: true });
    expect(started).toMatchObject({ state: "email_pending", admission: "admission_code", isError: false });
    const handle = started.handle as string;
    expect(await call("agentdash_cloud_status", { handle })).toMatchObject({ state: "email_pending" });

    // 2. The person clicks the link in their email.
    const verifyMail = [...mail].reverse().find((m) => m.to === EMAIL && m.kind === "verify")!;
    const magic = /#token=([A-Za-z0-9_-]+)/.exec(verifyMail.text)![1]!;
    await request(server).post("/api/cloud/verify").send({ token: magic }).expect(200);
    expect(await call("agentdash_cloud_status", { handle })).toMatchObject({ state: "provisioning", step: { index: 0 } });
    expect(await call("agentdash_cloud_connect", { handle })).toMatchObject({ code: "not_claimed", isError: true });

    // 3. The real provisioner builds the box on the fake Railway.
    const runner = new JobRunner({
      db,
      log,
      handlers: [
        provisionHandler({
          client: railway.client({ log }),
          workspaceId: FAKE_WORKSPACE,
          dataKeys: config.dataKeys,
          escrowPublicKey: sodium.crypto_box_keypair().publicKey,
          edgeDomain: "agentdash.cloud",
          imageRepo: "ghcr.io/thetangstr/agentdash",
          sourceRepo: "thetangstr/agentdash",
          edgeLive: false,
          fetch: railway.http,
          pollMs: 5,
          autoDeployGraceMs: 0,
        }),
      ],
    });
    for (let ran = await runner.runOnce(); ran; ran = await runner.runOnce());
    const [row] = await db.select().from(boxes).where(eq(boxes.slug, SLUG));
    expect(row!.state).toBe("awaiting_claim");
    expect(await call("agentdash_cloud_status", { handle })).toMatchObject({ state: "awaiting_claim", url: BOX });

    // The claim link goes to the person's email only.
    expect(await fd.sendReadyEmails()).toBe(1);
    const claimCode = decryptField(config.dataKeys, row!.claimCodeEnc!, "boxes.claim_code_enc");
    expect(mail.find((m) => m.to === EMAIL && m.kind === "ready")!.text).toContain(`#code=${claimCode}`);

    // 4. The person claims the box (sets their password on /claim); the claim sweep sees it on the box's health.
    railway.opts.health = { status: "ok", deploymentMode: "authenticated", claimed: true };
    expect((await sweepCleanup(db, log, { fetch: railway.http })).claimed).toBe(1);
    expect(await call("agentdash_cloud_status", { handle })).toMatchObject({ state: "active", connected: false });

    // 5. The agent asks to be let in; the person approves on their box.
    const pending = await call("agentdash_cloud_connect", { handle });
    expect(pending).toMatchObject({ state: "approval_pending", boxUrl: BOX });
    const challengeId = new URL(pending.approvalUrl as string).pathname.split("/").pop()!;
    expect(new URL(pending.approvalUrl as string).origin).toBe(BOX);
    expect((await client.listTools()).tools).toHaveLength(4);
    box.approve(challengeId);

    // 6. Delivered once, and the session continues on the box with the setup tools.
    const connected = await call("agentdash_cloud_connect", { handle });
    expect(connected).toMatchObject({ state: "connected", sessionUpgraded: true, nextAction: "agentdash_setup_status", apiUrl: `${BOX}/api` });
    expect(box.boardKeys.has(connected.apiKey as string)).toBe(true);
    await vi.waitFor(() => expect(listChanged).toBe(1));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const setupTool of ["agentdash_setup_status", "agentdash_setup_adapter", "agentdash_start_interview", "agentdash_interview_turn", "agentdash_get_plan", "agentdash_confirm_plan", "agentdash_request_approval"]) {
      expect(names).toContain(setupTool);
    }
    const setup = await call("agentdash_setup_status", {});
    expect(setup).toMatchObject({ serverHealthy: true, apiKeyConfigured: true, phase: "setup_adapter" });
    expect(boxApiCalls.find((c) => c.path === "/api/companies")!.auth).toBe(`Bearer ${connected.apiKey as string}`);
    expect((await call("agentdash_cloud_connect", { handle })).delivered).toBe(true);

    // What the agent saw: never the magic link, the claim link or code, or a password.
    const seen = transcript.join("\n");
    expect(seen).not.toContain(magic);
    expect(seen).not.toContain(claimCode);
    expect(seen).not.toMatch(/\/claim|#code=|password=/i);
    expect(seen).not.toContain(invitation.code.slice(9));
    expect(logLines.join("\n")).not.toContain(handle);
    expect(logLines.join("\n")).not.toContain(connected.apiKey as string);
    expect((await db.execute(sql`select count(*)::int as n from agent_handles where connected_at is not null`))[0]).toMatchObject({ n: 1 });
    await client.close();
  });
});
