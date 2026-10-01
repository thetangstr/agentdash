// SC-6 (GH #767), control-plane side: the claim link, the claim probe against
// old and new box releases, and close_signup after a claim is seen.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptField, parseKeyring } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, jobs } from "../db/schema.js";
import { CLAIM_EMAIL_IN_FRAGMENT_SINCE, claimLink, claimLinkForBox, claimReadsEmailFromFragment, compareReleases, probeClaim } from "../jobs/claim.js";
import { sweepCleanup } from "../jobs/cleanup.js";
import { closeSignupHandler } from "../jobs/close-signup.js";
import { JobRunner } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FAKE_WORKSPACE } from "./fake-railway.js";
import { FakeRailwayBoxes } from "./fake-railway-boxes.js";

const caps = vi.hoisted(() => ({ claimTrackingReady: false }));
vi.mock("../capabilities.js", () => ({ capabilities: caps }));

const KEYS = parseKeyring("66".repeat(32));
const CODE = "AGD-0123456789ABCDEF0123456789";
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const lines: string[] = [];
const log = createLogger({ write: (l) => lines.push(l), level: "debug" });

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
});

afterAll(async () => {
  await close?.();
  await pg?.stop();
});

const health = (body: Record<string, unknown>): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("claim link", () => {
  it("fragment form: the code and the email in the fragment, nothing in the query", () => {
    const url = claimLink({ slug: "acme", edgeDomain: "agentdash.cloud", email: "founder+x@example.com", code: CODE, emailInFragment: true });
    expect(url).toBe(`https://acme.agentdash.cloud/claim#code=${CODE}&email=founder%2Bx%40example.com`);
    const u = new URL(url);
    expect(u.search).toBe("");
    expect(new URLSearchParams(u.hash.slice(1)).get("code")).toBe(CODE);
    expect(new URLSearchParams(u.hash.slice(1)).get("email")).toBe("founder+x@example.com");
  });

  it("query form (older releases): email in ?email=, the code still only in the fragment", () => {
    const url = claimLink({ slug: "acme", edgeDomain: "agentdash.cloud", email: "founder+x@example.com", code: CODE, emailInFragment: false });
    expect(url).toBe(`https://acme.agentdash.cloud/claim?email=founder%2Bx%40example.com#code=${CODE}`);
    expect(new URL(url).search).not.toContain("AGD-");
  });

  it("picks the fragment form only for a known release at or after the first one that reads it (GH #836 re-review)", () => {
    expect(CLAIM_EMAIL_IN_FRAGMENT_SINCE).toBe("v2026.929.0"); // first stable whose /claim reads the fragment (#836)
    expect(compareReleases("v2026.1004.0", "v2026.927.3")).toBeGreaterThan(0);
    expect(compareReleases("v2026.927.1", "v2026.927.1")).toBe(0);
    expect(compareReleases("canary/v2026.927.0-canary.1", "v2026.927.0")).toBeNull();
    const since = "v2026.1002.0";
    expect(claimReadsEmailFromFragment("v2026.1002.0", since)).toBe(true);
    expect(claimReadsEmailFromFragment("v2026.1015.2", since)).toBe(true);
    expect(claimReadsEmailFromFragment("v2026.927.0", since)).toBe(false);
    expect(claimReadsEmailFromFragment(null, since)).toBe(false);
    expect(claimReadsEmailFromFragment("not-a-tag", since)).toBe(false);
    expect(claimReadsEmailFromFragment("v2026.1015.2", null)).toBe(false);
    const enc = encryptField(KEYS, CODE, "boxes.claim_code_enc");
    const opts = { dataKeys: KEYS, edgeDomain: "agentdash.cloud", email: "f@example.com", fragmentSince: since };
    expect(claimLinkForBox({ slug: "acme", claimCodeEnc: enc, releaseTag: "v2026.1003.0" }, opts)).toBe(`https://acme.agentdash.cloud/claim#code=${CODE}&email=f%40example.com`);
    expect(claimLinkForBox({ slug: "acme", claimCodeEnc: enc, releaseTag: "v2026.927.0" }, opts)).toBe(`https://acme.agentdash.cloud/claim?email=f%40example.com#code=${CODE}`);
    expect(claimLinkForBox({ slug: "acme", claimCodeEnc: enc, releaseTag: null }, opts)).toBe(`https://acme.agentdash.cloud/claim?email=f%40example.com#code=${CODE}`);
  });

  it("is built from the encrypted claim code, and gone once the code is erased", () => {
    const enc = encryptField(KEYS, CODE, "boxes.claim_code_enc");
    expect(claimLinkForBox({ slug: "acme", claimCodeEnc: enc }, { dataKeys: KEYS, edgeDomain: "agentdash.cloud", email: "f@example.com" })).toContain(`#code=${CODE}`);
    expect(claimLinkForBox({ slug: "acme", claimCodeEnc: null }, { dataKeys: KEYS, edgeDomain: "agentdash.cloud", email: "f@example.com" })).toBeNull();
  });
});

describe("claim probe across box releases", () => {
  it("reads claimed from a box with SC-6, and treats an older box as unknown", async () => {
    expect((await probeClaim("h", { fetch: health({ status: "ok", hostedBox: true, claimed: false }) })).state).toBe("unclaimed");
    expect((await probeClaim("h", { fetch: health({ status: "ok", hostedBox: true, claimed: true }) })).state).toBe("claimed");
    // v2026.925.0 and earlier: no `claimed`, and bootstrap_pending even after a sign-up.
    expect((await probeClaim("h", { fetch: health({ status: "ok", hostedBox: true, bootstrapStatus: "bootstrap_pending" }) })).state).toBe("unknown");
  });
});

describe("close_signup after a claim is seen", () => {
  async function claimedBox(fake: FakeRailwayBoxes) {
    const p = fake.addProject({ name: "agentdash-box-closeme", description: "x" });
    const env = fake.nextId("env");
    fake.envs.set(p.id, env);
    const web = { id: fake.nextId("svc"), projectId: p.id, name: "web", source: null, settings: {}, variables: { AGENTDASH_INVITE_CODES: CODE, AGENTDASH_CLAIM_EMAIL: "f@example.com" } as Record<string, string>, domains: ["web-closeme.up.railway.app"], deployments: [], triggers: [] };
    fake.services.set(web.id, web);
    const [acct] = await db.insert(accounts).values({ email: `closeme-${Date.now()}@example.test` }).returning();
    const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug: `closeme${Date.now() % 100000}` }).returning();
    for (const s of ["provisioning", "awaiting_claim"] as const) await db.update(boxes).set({ state: s }).where(eq(boxes.id, box!.id));
    await db
      .update(boxes)
      .set({
        projectId: p.id,
        environmentId: env,
        webServiceId: web.id,
        upstreamHost: web.domains[0],
        claimCodeEnc: encryptField(KEYS, CODE, "boxes.claim_code_enc"),
        claimCodeHash: "h",
      })
      .where(eq(boxes.id, box!.id));
    return { boxId: box!.id, web };
  }

  it("the sweep marks the box active and queues close_signup, which closes sign-up without a deploy and erases the code", async () => {
    const fake = new FakeRailwayBoxes();
    const { boxId, web } = await claimedBox(fake);
    const r = await sweepCleanup(db, log, { fetch: health({ status: "ok", hostedBox: true, claimed: true, bootstrapStatus: "bootstrap_pending" }) });
    expect(r.claimed).toBeGreaterThanOrEqual(1);
    const job = (await db.select().from(jobs).where(eq(jobs.boxId, boxId))).find((j) => j.kind === "close_signup");
    expect(job?.state).toBe("queued");

    const runner = new JobRunner({ db, log, handlers: [closeSignupHandler({ client: fake.client({ log }), workspaceId: FAKE_WORKSPACE })] });
    expect(await runner.runOnce()).toBe(job!.id);
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.state).toBe("succeeded");
    expect(web.variables.PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBe("true");
    expect(web.variables.AGENTDASH_CLAIM_EMAIL).toBe("");
    expect(web.variables.AGENTDASH_INVITE_CODES).toMatch(/^AGD-[0-9A-F]{26}$/);
    expect(web.variables.AGENTDASH_INVITE_CODES).not.toBe(CODE);
    expect(web.deployments).toHaveLength(0); // the fake refuses any upsert without skipDeploys
    const box = (await db.select().from(boxes).where(eq(boxes.id, boxId)))[0]!;
    expect(box).toMatchObject({ state: "active", claimCodeEnc: null, claimCodeHash: null });
    expect((await db.select().from(boxEvents).where(eq(boxEvents.boxId, boxId))).map((e) => e.kind)).toEqual(expect.arrayContaining(["claim_seen", "signup_closed"]));
    // The new code is never recorded or logged.
    const rows = JSON.stringify(await db.execute(sql`select * from boxes where id = ${boxId}`));
    expect(rows).not.toContain(web.variables.AGENTDASH_INVITE_CODES!);
    expect(lines.join("\n")).not.toContain(web.variables.AGENTDASH_INVITE_CODES!);
  });

  it("refuses to close a box with no recorded claim", async () => {
    const fake = new FakeRailwayBoxes();
    const { boxId } = await claimedBox(fake);
    const [job] = await db.insert(jobs).values({ boxId, kind: "close_signup" }).returning();
    await new JobRunner({ db, log, handlers: [closeSignupHandler({ client: fake.client({ log }), workspaceId: FAKE_WORKSPACE })] }).runOnce();
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.state).toBe("dead");
  });
});
