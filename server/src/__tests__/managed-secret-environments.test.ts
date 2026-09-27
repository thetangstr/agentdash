// AgentDash (GH #782 re-review): the GitHub token secret cannot be reached or
// deleted through environments, and secret mutations are company-scoped.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { companies, createDb, environments, githubRepoConnections, projects, projectWorkspaces } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const SANDBOX_SCHEMA = {
  type: "object",
  properties: { apiKey: { type: "string", format: "secret-ref" } },
};
vi.mock("../services/plugin-environment-driver.js", () => ({
  resolvePluginSandboxProviderDriverByKey: async () => ({ driver: { configSchema: SANDBOX_SCHEMA } }),
  validatePluginEnvironmentDriverConfig: async (input: { config: Record<string, unknown> }) => ({ normalizedConfig: input.config }),
  validatePluginSandboxProviderConfig: async (input: { config: Record<string, unknown> }) => ({
    normalizedConfig: input.config,
    driver: { configSchema: SANDBOX_SCHEMA },
  }),
}));

const { secretService } = await import("../services/secrets.js");
const { environmentRoutes } = await import("../routes/environments.js");
const { errorHandler } = await import("../middleware/index.js");
const { normalizeEnvironmentConfigForPersistence, resolveEnvironmentDriverConfigForRuntime } = await import(
  "../services/environment-config.js"
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TOKEN = "github_pat_11ENVCANARY00000000000000_environmentCanaryTokenValue0";

describeEmbeddedPostgres("managed secrets and environments", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const savedKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "c".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-managed-secret-env-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = savedKey;
    await tempDb?.cleanup();
  });

  async function companyWithToken() {
    const company = await db
      .insert(companies)
      .values({ name: `M ${randomUUID()}`, issuePrefix: `M${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const project = await db.insert(projects).values({ companyId: company.id, name: "app" }).returning().then((rows) => rows[0]!);
    const workspace = await db
      .insert(projectWorkspaces)
      .values({ companyId: company.id, projectId: project.id, name: "app", sourceType: "git_repo", repoUrl: "https://github.com/acme/app" })
      .returning()
      .then((rows) => rows[0]!);
    const svc = secretService(db);
    // Created the way the connection flow creates it (service-level, owning flow).
    const token = await svc.create(company.id, { name: `github-token-${workspace.id}`, provider: "local_encrypted", value: TOKEN });
    await db.insert(githubRepoConnections).values({
      companyId: company.id,
      projectId: project.id,
      projectWorkspaceId: workspace.id,
      repoFullName: "acme/app",
      repoOwner: "acme",
      repoName: "app",
      secretId: token.id,
    });
    const plain = await svc.create(company.id, { name: `ordinary-${randomUUID()}`, provider: "local_encrypted", value: "k" });
    return { company, tokenId: token.id, plainId: plain.id };
  }

  const ssh = (secretId: string) => ({
    host: "example.com",
    username: "u",
    remoteWorkspacePath: "/w",
    privateKeySecretRef: { type: "secret_ref", secretId },
  });

  it("refuses an SSH environment that points at the token, or at another company's secret", async () => {
    const a = await companyWithToken();
    const b = await companyWithToken();
    const base = { db, companyId: a.company.id, environmentName: "box", driver: "ssh" as const };
    await expect(normalizeEnvironmentConfigForPersistence({ ...base, config: ssh(a.tokenId) })).rejects.toThrow(/belongs to a connection/);
    await expect(normalizeEnvironmentConfigForPersistence({ ...base, config: ssh(b.plainId) })).rejects.toThrow(/does not exist in this company/);
    await expect(normalizeEnvironmentConfigForPersistence({ ...base, config: ssh(a.plainId) })).resolves.toMatchObject({
      privateKeySecretRef: { secretId: a.plainId },
    });
  });

  it("refuses a sandbox environment that points at the token, and never hydrates one stored earlier", async () => {
    const a = await companyWithToken();
    const base = {
      db,
      companyId: a.company.id,
      environmentName: "sb",
      driver: "sandbox" as const,
      pluginWorkerManager: {} as never,
    };
    await expect(
      normalizeEnvironmentConfigForPersistence({ ...base, config: { provider: "acme-sandbox", apiKey: a.tokenId } }),
    ).rejects.toThrow(/belongs to a connection/);
    const resolved = await resolveEnvironmentDriverConfigForRuntime(db, a.company.id, {
      driver: "sandbox",
      config: { provider: "acme-sandbox", apiKey: a.tokenId },
    } as never);
    expect(JSON.stringify(resolved)).not.toContain(TOKEN);
    await expect(
      resolveEnvironmentDriverConfigForRuntime(db, a.company.id, { driver: "ssh", config: ssh(a.tokenId) } as never),
    ).rejects.toThrow(/belongs to a connection/);
  });

  it("secret mutations are company-scoped and refuse managed secrets unless the owning flow asks", async () => {
    const a = await companyWithToken();
    const b = await companyWithToken();
    const svc = secretService(db);
    // Cross-company: not found, nothing deleted or changed.
    expect(await svc.remove(b.plainId, { companyId: a.company.id })).toBeNull();
    await expect(svc.rotate(b.plainId, { value: "x" }, undefined, { companyId: a.company.id })).rejects.toThrow(/not found/i);
    expect(await svc.resolveSecretValue(b.company.id, b.plainId, "latest")).toBe("k");
    // Managed: refused by default (environment deletion, key change, routines...).
    await expect(svc.remove(a.tokenId, { companyId: a.company.id })).rejects.toThrow(/belongs to a connection/);
    await expect(svc.rotate(a.tokenId, { value: "x" }, undefined, { companyId: a.company.id })).rejects.toThrow(/belongs to a connection/);
    await expect(svc.update(a.tokenId, { name: "renamed" }, { companyId: a.company.id })).rejects.toThrow(/belongs to a connection/);
    expect(await svc.resolveSecretValue(a.company.id, a.tokenId, "latest")).toBe(TOKEN);
    // The owning flow may.
    await svc.rotate(a.tokenId, { value: `${TOKEN}2` }, undefined, { companyId: a.company.id, allowManaged: true });
    expect(await svc.resolveSecretValue(a.company.id, a.tokenId, "latest")).toBe(`${TOKEN}2`);
  });

  it("deleting an environment never deletes the token or another company's secret it references", async () => {
    const a = await companyWithToken();
    const b = await companyWithToken();
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", environmentRoutes(db));
    app.use(errorHandler);
    for (const secretId of [a.tokenId, b.plainId]) {
      const env = await db
        .insert(environments)
        .values({ companyId: a.company.id, name: `ssh ${randomUUID()}`, driver: "ssh", config: ssh(secretId) })
        .returning()
        .then((rows) => rows[0]!);
      const res = await request(app).delete(`/api/environments/${env.id}`);
      expect(res.status).toBeLessThan(300);
    }
    expect(await secretService(db).resolveSecretValue(a.company.id, a.tokenId, "latest")).toBe(TOKEN);
    expect(await secretService(db).resolveSecretValue(b.company.id, b.plainId, "latest")).toBe("k");
  });
});
