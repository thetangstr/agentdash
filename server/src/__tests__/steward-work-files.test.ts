import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentCorrections,
  agents,
  assets,
  authUsers,
  bridgeEndpoints,
  bridgeStagedFiles,
  companies,
  companyMemberships,
  createDb,
  issueAttachments,
  issueComments,
  issues,
  projectAccess,
  projects,
  stewardInboxActionHandles,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import {
  markCurrentVersions,
  splitVersionedName,
  versionAuthorLabel,
  versionedFileName,
} from "../services/attachment-versions.js";
import { STAGED_SWEEP_GRACE_MS, sweepStagedFiles, validateBridgeFiles } from "../services/bridge-staged-files.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { issueService } from "../services/issues.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { truncateWithRetry } from "./helpers/truncate.js";

/**
 * AgentDash (co-worker slice 5): files over the bridge, with versions.
 *
 * Properties defended:
 *
 * - a file is named in the read-back by sha256 and size; an upload whose
 *   bytes the handle does not name is refused and stores nothing;
 * - over the company cap is refused, with the cap in the message, at propose
 *   and at upload;
 * - files travel only on issues in restricted projects (D2); elsewhere the
 *   read-back leaves them out and says why, and the bundle is text only;
 * - confirm refuses (and spends nothing) until every named file has arrived,
 *   then attaches each as the person, on the comment, versioned with their
 *   name, and the agent's wake and correction say so;
 * - versions count per base name per issue, a fetched versioned name sent
 *   back becomes the next version, and only the newest is current;
 * - a request carries files into a restricted project the same way;
 * - unconfirmed staged files are swept after the handle's expiry.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");

describe("file versions: names", () => {
  it("splits a name into its base, and takes a version suffix this module wrote back off", () => {
    expect(splitVersionedName("Q3 figures.csv")).toEqual({ stem: "Q3 figures", ext: ".csv", baseKey: "q3 figures.csv" });
    expect(splitVersionedName("Q3 figures v2 (Person A).csv")).toEqual({ stem: "Q3 figures", ext: ".csv", baseKey: "q3 figures.csv" });
    expect(splitVersionedName("../../etc/notes.md").baseKey).toBe("notes.md");
    expect(splitVersionedName("README").baseKey).toBe("readme");
    expect(splitVersionedName("").stem).toBe("file");
  });

  it("writes `<name> v<n> (<author>).<ext>` and keeps the author to one plain line", () => {
    expect(versionedFileName("Q3 figures", 3, "Agent A", ".csv")).toBe("Q3 figures v3 (Agent A).csv");
    expect(versionAuthorLabel("Agent (A)\nB/C")).toBe("Agent A BC");
    expect(versionAuthorLabel("")).toBe("unknown");
  });

  it("marks only the newest version of each name current; an unversioned file is its own current", () => {
    const rows = markCurrentVersions([
      { id: "a1", version: 1, versionBaseName: "q.csv" },
      { id: "a3", version: 3, versionBaseName: "q.csv" },
      { id: "a2", version: 2, versionBaseName: "q.csv" },
      { id: "b1", version: 1, versionBaseName: "r.md" },
      { id: "p", version: null, versionBaseName: null },
    ]);
    expect(rows.map((row) => [row.id, row.isCurrent, row.currentAttachmentId])).toEqual([
      ["a1", false, "a3"],
      ["a3", true, "a3"],
      ["a2", false, "a3"],
      ["b1", true, "b1"],
      ["p", true, "p"],
    ]);
  });

  it("checks a named file list: shape, duplicates, markup, the allowlist and the cap (with the cap in the message)", () => {
    const good = { name: "q3.csv", sha256: "a".repeat(64), size: 10 };
    expect(validateBridgeFiles([good], 100)).toEqual({
      ok: true,
      files: [{ name: "q3.csv", sha256: "a".repeat(64), size: 10, contentType: "text/csv" }],
    });
    expect(validateBridgeFiles([{ name: "q3.csv" }], 100)).toMatchObject({ ok: false, code: "invalid_files" });
    expect(validateBridgeFiles([good, good], 100)).toMatchObject({ ok: false, code: "duplicate_file" });
    expect(validateBridgeFiles([{ ...good, name: "page.html" }], 100)).toMatchObject({ ok: false, code: "file_refused" });
    expect(validateBridgeFiles([{ ...good, name: "tool.exe" }], 100)).toMatchObject({ ok: false, code: "file_refused" });
    const big = validateBridgeFiles([{ ...good, size: 5_000 }], 1_000);
    expect(big).toMatchObject({ ok: false, code: "file_too_large" });
    expect((big as { reason: string }).reason).toContain("the cap for this company is 1,000 bytes");
  });
});

describeEmbeddedPostgres("bridge work: files over the bridge, with versions", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let scratch = "";
  let storageDir = "";

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "bridge-files-"));
    storageDir = path.join(scratch, "storage");
    await mkdir(storageDir, { recursive: true });
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bridge-files-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  const storage = () => createStorageService(createLocalDiskStorageProvider(storageDir));
  const quietRuntime = { heartbeat: { enabled: false, wakeOnDemand: false } };

  async function person(companyId: string, role: string, name: string) {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    return userId;
  }

  async function stewardedAgent(companyId: string, name: string, stewardUserId: string, ownerUserId: string) {
    const agent = await db
      .insert(agents)
      .values({ companyId, name, role: "general", status: "idle", adapterType: "process", runtimeConfig: quietRuntime })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(companyId, { agentId: agent.id, userId: stewardUserId, assignedByUserId: ownerUserId });
    return agent;
  }

  async function seed(opts: { capBytes?: number } = {}) {
    const prefix = `FL${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z]/g, "X")}`;
    const company = await db
      .insert(companies)
      .values({
        name: `Files ${randomUUID()}`,
        issuePrefix: prefix,
        productProfile: "agentdash_mk",
        ...(opts.capBytes ? { attachmentMaxBytes: opts.capBytes } : {}),
      })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await person(company.id, "owner", "Owner O");
    const personA = await person(company.id, "operator", "Person A");
    const personB = await person(company.id, "operator", "Person B");
    const agentA = await stewardedAgent(company.id, "Agent A", personA, owner);
    const agentB = await stewardedAgent(company.id, "Agent B", personB, owner);
    await featureFlagsService(db).set(company.id, FEATURE_FLAG_KEYS.COWORKER_BRIDGE, true);
    return { company, prefix, owner, personA, personB, agentA, agentB };
  }

  async function restrictedProject(companyId: string, createdByUserId: string, members: Array<{ type: "user" | "agent"; id: string }>) {
    const project = await db
      .insert(projects)
      .values({ companyId, name: "Restricted work", visibility: "restricted", createdByUserId })
      .returning()
      .then((rows) => rows[0]!);
    for (const member of members) {
      await db.insert(projectAccess).values({
        companyId,
        projectId: project.id,
        principalType: member.type,
        principalId: member.id,
        grantedByUserId: createdByUserId,
      });
    }
    return project;
  }

  async function endpointFor(companyId: string, userId: string) {
    return db
      .insert(bridgeEndpoints)
      .values({
        companyId,
        userId,
        label: "person-a-laptop",
        tokenHash: `hash-${randomUUID()}`,
        capabilities: ["bridge:read", "bridge:inbox", "bridge:work"],
        enrolledAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  let issueCounter = 0;
  async function makeIssue(companyId: string, prefix: string, values: Partial<typeof issues.$inferInsert>) {
    issueCounter += 1;
    return db
      .insert(issues)
      .values({ companyId, title: "Draft the quarterly note", status: "blocked", identifier: `${prefix}-${issueCounter}`, ...values })
      .returning()
      .then((rows) => rows[0]!);
  }

  function app(endpoint: { id: string; companyId: string }) {
    const wakeup = vi.fn(async () => ({ id: randomUUID() }));
    const issueRuntime = {
      wakeup: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
      reportRunActivity: vi.fn(async () => undefined),
    };
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "bridge_endpoint", companyId: endpoint.companyId, bridgeEndpointId: endpoint.id };
      next();
    });
    server.use(
      "/api",
      bridgeRoutes(db, { autoDispatchQueuedRuns: false, heartbeat: { wakeup } as never, storage: storage(), issueRuntime: issueRuntime as never }),
    );
    server.use(errorHandler);
    return { server, wakeup, issueRuntime };
  }

  const upload = (server: express.Express, token: string, body: Buffer, filename: string) =>
    request(server).post("/api/bridge/work/upload").field("token", token).attach("file", body, { filename });

  /** Agent A's hand-off to Person A, in a restricted project both are on. */
  async function restrictedHandoff(opts: { capBytes?: number } = {}) {
    const seeded = await seed(opts);
    const project = await restrictedProject(seeded.company.id, seeded.owner, [
      { type: "agent", id: seeded.agentA.id },
      { type: "user", id: seeded.personA },
    ]);
    const issue = await makeIssue(seeded.company.id, seeded.prefix, { assigneeAgentId: seeded.agentA.id, projectId: project.id });
    const endpoint = await endpointFor(seeded.company.id, seeded.personA);
    return { ...seeded, project, issue, endpoint };
  }

  const figures = Buffer.from("site,share\nnorth,0.42\nsouth,0.58\n", "utf8");

  // -------------------------------------------------------------------------

  it("sends a file back on a restricted-project issue: read back, uploaded after the yes, attached on confirm as the person, versioned", async () => {
    const { issue, endpoint, personA, agentA, company } = await restrictedHandoff();
    const { server, wakeup } = app(endpoint);

    const proposed = await request(server)
      .post("/api/bridge/work/propose")
      .send({
        issueId: issue.identifier,
        comment: "Corrected figures attached.",
        files: [{ name: "q3 figures.csv", sha256: sha(figures), size: figures.length }],
      });
    expect(proposed.body.ok).toBe(true);
    const readback = (proposed.body.readback as string[]).join("\n");
    expect(readback).toContain('file "q3 figures.csv" (');
    expect(readback).toContain('text/csv) -> stored as "q3 figures v1 (Person A).csv"');
    expect(proposed.body.audience).toContain('restricted project "Restricted work"');
    expect(proposed.body.upload.files).toEqual([{ name: "q3 figures.csv", sha256: sha(figures), size: figures.length }]);
    expect(proposed.body.filesLeftOut).toBeUndefined();
    const token = proposed.body.handle as string;

    // Bytes the read-back did not name are refused and nothing is stored.
    const other = Buffer.from("site,share\nnorth,0.99\n", "utf8");
    const wrong = await upload(server, token, other, "q3 figures.csv");
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ ok: false, code: "file_not_in_handle" });
    expect(await db.select().from(bridgeStagedFiles)).toHaveLength(0);

    // Confirm before the bytes arrive: refused, nothing sent, handle not spent.
    const early = await request(server).post("/api/bridge/work/confirm").send({ token });
    expect(early.body).toMatchObject({ ok: false, code: "files_not_uploaded" });
    expect(early.body.reason).toContain('"q3 figures.csv"');
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);

    const staged = await upload(server, token, figures, "anything.csv");
    expect(staged.body).toMatchObject({ ok: true, name: "q3 figures.csv", sha256: sha(figures), alreadyStaged: false });
    const again = await upload(server, token, figures, "q3 figures.csv");
    expect(again.body).toMatchObject({ ok: true, alreadyStaged: true });
    const stagedRows = await db.select().from(bridgeStagedFiles);
    expect(stagedRows).toHaveLength(1);
    expect(stagedRows[0]!.objectKey).toContain(`/issues/${issue.id}/bridge-staged/`);
    // Not an attachment until the confirm.
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id))).toHaveLength(0);

    const confirmed = await request(server).post("/api/bridge/work/confirm").send({ token });
    expect(confirmed.body.ok).toBe(true);
    expect(confirmed.body.sent.files).toEqual([
      { attachmentId: expect.any(String), name: "q3 figures v1 (Person A).csv", version: 1 },
    ]);
    expect(confirmed.body.agentWoken).toBe(true);
    expect(wakeup).toHaveBeenCalledTimes(1);

    const attachments = await issueService(db).listAttachments(issue.id);
    expect(attachments).toHaveLength(1);
    const comment = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)).then((rows) => rows[0]!);
    expect(attachments[0]).toMatchObject({
      originalFilename: "q3 figures v1 (Person A).csv",
      version: 1,
      versionBaseName: "q3 figures.csv",
      isCurrent: true,
      createdByUserId: personA,
      createdByAgentId: null,
      issueCommentId: comment.id,
      sha256: sha(figures),
      contentType: "text/csv",
    });
    expect((await db.select().from(bridgeStagedFiles))[0]!.attachedAt).not.toBeNull();

    const added = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.attachment_added")));
    expect(added).toHaveLength(1);
    expect(added[0]!.actorId).toBe(personA);
    expect(added[0]!.details).toMatchObject({ channel: "bridge_work", bridgeEndpointId: endpoint.id, version: 1 });
    const group = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.bridge_reply_sent")));
    expect((group[0]!.details as Record<string, unknown>).parts).toEqual(["comment", "files"]);

    // The agent's "what changed" summary names the file.
    const correction = await db.select().from(agentCorrections).where(eq(agentCorrections.agentId, agentA.id));
    expect(correction).toHaveLength(1);
    expect(correction[0]!.summary).toContain('File: they sent "q3 figures v1 (Person A).csv"');

    // The bytes the person sent are the bytes the issue holds.
    const object = await storage().getObject(company.id, attachments[0]!.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(figures)).toBe(true);

    // The handle is spent: an upload against it now is refused.
    const late = await upload(server, token, figures, "q3 figures.csv");
    expect(late.body).toMatchObject({ ok: false, code: "handle_not_valid" });
  });

  it("counts versions per name: an agent's v1, the person's fetched copy sent back as v2, and only the newest is current", async () => {
    const { issue, endpoint, agentA, company } = await restrictedHandoff();
    const { server } = app(endpoint);
    const store = storage();

    // Agent A attaches its first pass (the agent upload path versions it).
    const draft = Buffer.from("site,share\nnorth,0.40\n", "utf8");
    const put = await store.putFile({ companyId: company.id, namespace: `issues/${issue.id}`, originalFilename: "q3 figures.csv", contentType: "text/csv", body: draft });
    const v1 = await issueService(db).createAttachment({
      issueId: issue.id,
      ...put,
      createdByAgentId: agentA.id,
      versionAuthor: "Agent A",
    });
    expect(v1).toMatchObject({ originalFilename: "q3 figures v1 (Agent A).csv", version: 1 });

    // The person fetched it as "q3 figures v1 (Agent A).csv", corrected it, and sends it back.
    const proposed = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, files: [{ name: "q3 figures v1 (Agent A).csv", sha256: sha(figures), size: figures.length }] });
    expect(proposed.body.ok).toBe(true);
    expect((proposed.body.readback as string[]).join("\n")).toContain('stored as "q3 figures v2 (Person A).csv"');
    await upload(server, proposed.body.handle, figures, "q3 figures v1 (Agent A).csv");
    const confirmed = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body.ok).toBe(true);

    // A person's own upload on the page stays unversioned and does not take the name.
    const pagePut = await store.putFile({ companyId: company.id, namespace: `issues/${issue.id}`, originalFilename: "q3 figures.csv", contentType: "text/csv", body: Buffer.from("x") });
    await issueService(db).createAttachment({ issueId: issue.id, ...pagePut, createdByUserId: "someone" });

    const listed = await issueService(db).listAttachments(issue.id);
    const byName = new Map(listed.map((row) => [row.originalFilename, row]));
    expect(byName.get("q3 figures v1 (Agent A).csv")).toMatchObject({ version: 1, isCurrent: false });
    const v2 = byName.get("q3 figures v2 (Person A).csv")!;
    expect(v2).toMatchObject({ version: 2, isCurrent: true });
    expect(byName.get("q3 figures v1 (Agent A).csv")!.currentAttachmentId).toBe(v2.id);
    expect(byName.get("q3 figures.csv")).toMatchObject({ version: null, isCurrent: true });

    // The agent's summary says the new file is the current version.
    const correction = await db.select().from(agentCorrections).where(eq(agentCorrections.agentId, agentA.id));
    expect(correction[0]!.summary).toContain("now the current version of that file");

    // work_read shows the marker too.
    const read = await request(server).post("/api/bridge/work/read").send({ issueId: issue.id });
    const items = read.body.attachments.items as Array<Record<string, unknown>>;
    const old = items.find((item) => item.attachmentId === v1.id)!;
    expect(old).toMatchObject({ version: 1, isCurrent: false, currentAttachmentId: v2.id });
    expect(items.find((item) => item.attachmentId === v2.id)).toMatchObject({ version: 2, isCurrent: true });

    // work_fetch_file gets the versioned name and the marker in headers.
    const fetched = await request(server).post("/api/bridge/work/file").send({ attachmentId: v1.id });
    expect(fetched.status).toBe(200);
    expect(decodeURIComponent(fetched.headers["content-disposition"])).toContain("q3 figures v1 (Agent A).csv");
    expect(fetched.headers["x-agentdash-version"]).toBe("1");
    expect(fetched.headers["x-agentdash-current"]).toBe("false");
    expect(fetched.headers["x-agentdash-current-attachment-id"]).toBe(v2.id);
    const fetchedCurrent = await request(server).post("/api/bridge/work/file").send({ attachmentId: v2.id });
    expect(fetchedCurrent.headers["x-agentdash-current"]).toBe("true");
    expect(fetchedCurrent.headers["x-agentdash-current-attachment-id"]).toBeUndefined();
  });

  it("leaves files out on an issue outside a restricted project and says why; the bundle goes as text", async () => {
    const { company, prefix, personA, agentA } = await seed();
    const issue = await makeIssue(company.id, prefix, { assigneeAgentId: agentA.id });
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);

    const proposed = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, comment: "See the note.", files: [{ name: "q3.csv", sha256: sha(figures), size: figures.length }] });
    expect(proposed.body.ok).toBe(true);
    expect(proposed.body.filesLeftOut).toContain("only on issues in projects with restricted access");
    expect(proposed.body.filesLeftOut).toContain('"q3.csv" was left out');
    expect(proposed.body.upload).toBeUndefined();
    expect((proposed.body.readback as string[]).join("\n")).not.toContain("file ");
    const handle = await db.select().from(stewardInboxActionHandles).then((rows) => rows[0]!);
    expect((handle.payload as Record<string, unknown>).files).toBeUndefined();

    // An upload against it is refused: the handle names no files.
    const refused = await upload(server, proposed.body.handle, figures, "q3.csv");
    expect(refused.body).toMatchObject({ ok: false, code: "file_not_in_handle" });

    const confirmed = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body.ok).toBe(true);
    expect(confirmed.body.sent.files).toBeUndefined();
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id))).toHaveLength(0);
  });

  it("refuses a file over the company cap, with the cap in the message, at propose and at upload", async () => {
    const { issue, endpoint, company } = await restrictedHandoff({ capBytes: 1_000 });
    const { server } = app(endpoint);
    const tooBig = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, comment: "x", files: [{ name: "big.csv", sha256: "b".repeat(64), size: 5_000 }] });
    expect(tooBig.body).toMatchObject({ ok: false, code: "file_too_large" });
    expect(tooBig.body.reason).toContain("the cap for this company is 1,000 bytes");
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);

    // Within the cap when proposed; the cap is lowered before the upload.
    const proposed = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, comment: "x", files: [{ name: "q3.csv", sha256: sha(figures), size: figures.length }] });
    expect(proposed.body.ok).toBe(true);
    await db.update(companies).set({ attachmentMaxBytes: 8 }).where(eq(companies.id, company.id));
    const over = await upload(server, proposed.body.handle, figures, "q3.csv");
    expect(over.body).toMatchObject({ ok: false, code: "file_too_large" });
    expect(over.body.reason).toContain("attachment cap of 8 bytes");
    expect(await db.select().from(bridgeStagedFiles)).toHaveLength(0);
  });

  it("refuses the whole bundle when the issue left its restricted project between the yes and the confirm", async () => {
    const { issue, endpoint } = await restrictedHandoff();
    const { server } = app(endpoint);
    const proposed = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, comment: "attached", files: [{ name: "q3.csv", sha256: sha(figures), size: figures.length }] });
    await upload(server, proposed.body.handle, figures, "q3.csv");
    await db.update(issues).set({ projectId: null }).where(eq(issues.id, issue.id));
    const confirmed = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: false, code: "files_not_allowed_now" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id))).toHaveLength(0);
  });

  it("carries files with a request into a restricted project both people can see, attached to the new issue as the requester", async () => {
    const { company, owner, personA, personB, agentB } = await seed();
    await restrictedProject(company.id, owner, [
      { type: "user", id: personA },
      { type: "user", id: personB },
      { type: "agent", id: agentB.id },
    ]);
    const endpoint = await endpointFor(company.id, personA);
    const { server, issueRuntime } = app(endpoint);
    const brief = {
      title: "Check the vendor figures",
      wanted: "Check the attached figures against the proposals.",
      doneMeans: "A note on the issue saying which figures hold.",
      person: "Person B",
      project: "Restricted work",
      files: [{ name: "vendor figures.csv", sha256: sha(figures), size: figures.length }],
    };
    const proposed = await request(server).post("/api/bridge/work/request").send(brief);
    expect(proposed.body.ok).toBe(true);
    expect((proposed.body.readback as string[]).join("\n")).toContain('stored as "vendor figures v1 (Person A).csv"');
    expect(proposed.body.upload.files).toHaveLength(1);

    const early = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(early.body).toMatchObject({ ok: false, code: "files_not_uploaded" });
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);

    const staged = await upload(server, proposed.body.handle, figures, "vendor figures.csv");
    expect(staged.body.ok).toBe(true);
    expect((await db.select().from(bridgeStagedFiles))[0]!.objectKey).toContain("/bridge-staged/requests/");

    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body.ok).toBe(true);
    expect(confirmed.body.files).toEqual([{ attachmentId: expect.any(String), name: "vendor figures v1 (Person A).csv" }]);
    const created = await db.select().from(issues).where(eq(issues.id, confirmed.body.issue.issueId)).then((rows) => rows[0]!);
    expect(created.assigneeAgentId).toBe(agentB.id);
    const attached = await issueService(db).listAttachments(created.id);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ originalFilename: "vendor figures v1 (Person A).csv", createdByUserId: personA, version: 1 });
    expect(issueRuntime.wakeup).toHaveBeenCalledTimes(1);
  });

  it("leaves a request's files out when it goes outside a restricted project, and says why", async () => {
    const { company, personA } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const proposed = await request(server).post("/api/bridge/work/request").send({
      title: "Check the vendor figures",
      wanted: "Check them.",
      doneMeans: "A note.",
      person: "Person B",
      files: [{ name: "vendor figures.csv", sha256: sha(figures), size: figures.length }],
    });
    expect(proposed.body.ok).toBe(true);
    expect(proposed.body.filesLeftOut).toContain("only on issues in projects with restricted access");
    expect(proposed.body.upload).toBeUndefined();
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body.ok).toBe(true);
    expect(confirmed.body.files).toBeUndefined();
    expect(await db.select().from(issueAttachments)).toHaveLength(0);
  });

  it("sweeps a staged file never confirmed after its handle expires, and never one that became an attachment", async () => {
    const { issue, endpoint, company } = await restrictedHandoff();
    const { server } = app(endpoint);
    const store = storage();

    const kept = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, comment: "kept", files: [{ name: "kept.csv", sha256: sha(figures), size: figures.length }] });
    await upload(server, kept.body.handle, figures, "kept.csv");
    await request(server).post("/api/bridge/work/confirm").send({ token: kept.body.handle });

    const other = Buffer.from("never,confirmed\n", "utf8");
    const dropped = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, comment: "dropped", files: [{ name: "dropped.csv", sha256: sha(other), size: other.length }] });
    await upload(server, dropped.body.handle, other, "dropped.csv");

    const rows = await db.select().from(bridgeStagedFiles);
    expect(rows).toHaveLength(2);
    const unconfirmed = rows.find((row) => row.attachedAt === null)!;
    const confirmedRow = rows.find((row) => row.attachedAt !== null)!;

    // Not yet: within its expiry (and the grace) nothing goes.
    expect(await sweepStagedFiles(db, store)).toEqual({ removed: 0 });

    const past = new Date(Date.now() - STAGED_SWEEP_GRACE_MS - 60_000);
    await db.update(bridgeStagedFiles).set({ expiresAt: past });
    expect(await sweepStagedFiles(db, store)).toEqual({ removed: 1 });
    expect((await store.headObject(company.id, unconfirmed.objectKey)).exists).toBe(false);
    expect((await store.headObject(company.id, confirmedRow.objectKey)).exists).toBe(true);
    const left = await db.select().from(bridgeStagedFiles);
    expect(left.map((row) => row.id)).toEqual([confirmedRow.id]);
    expect(await db.select().from(assets).where(eq(assets.objectKey, confirmedRow.objectKey))).toHaveLength(1);
  });

  it("keeps the gates: no upload without bridge:work, or while the company flag is off", async () => {
    const { company, personA } = await seed();
    const inboxOnly = await db
      .insert(bridgeEndpoints)
      .values({
        companyId: company.id,
        userId: personA,
        label: "person-a-desktop",
        tokenHash: `hash-${randomUUID()}`,
        capabilities: ["bridge:read", "bridge:inbox"],
        enrolledAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    const forbidden = await upload(app(inboxOnly).server, "x", figures, "q3.csv");
    expect(forbidden.status).toBe(403);

    const endpoint = await endpointFor(company.id, personA);
    await featureFlagsService(db).set(company.id, FEATURE_FLAG_KEYS.COWORKER_BRIDGE, false);
    const off = await upload(app(endpoint).server, "x", figures, "q3.csv");
    expect(off.body).toMatchObject({ ok: false, code: "coworker_bridge_disabled" });
    expect(await db.select().from(bridgeStagedFiles)).toHaveLength(0);
  });
});
