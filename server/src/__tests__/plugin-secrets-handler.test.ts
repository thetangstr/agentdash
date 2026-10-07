// AgentDash (GH #811): the plugin secrets resolver resolves secret ids with no
// company or managed-secret check. A ref that lands in plugin config must pin a
// single company — a config mixing companies has no defensible scope and
// resolves nothing — and connection-managed secrets are never plugin-resolvable.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecrets,
  createDb,
  githubRepoConnections,
  pluginConfig,
  plugins,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const { createPluginSecretsHandler } = await import("../services/plugin-secrets-handler.js");
const { secretService } = await import("../services/secrets.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("plugin secrets handler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const savedKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "c".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-secrets-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = savedKey;
    await tempDb?.cleanup();
  });

  async function newCompany() {
    return db
      .insert(companies)
      .values({ name: `P ${randomUUID()}`, issuePrefix: `P${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function newSecret(companyId: string, value: string) {
    return secretService(db).create(companyId, {
      name: `plugin-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
  }

  async function newPluginWithConfig(configJson: Record<string, unknown>) {
    const plugin = await db
      .insert(plugins)
      .values({
        pluginKey: `acme.test-${randomUUID().slice(0, 8)}`,
        packageName: "@acme/test-plugin",
        version: "1.0.0",
        manifestJson: {
          apiVersion: 1,
          displayName: "Test plugin",
          instanceConfigSchema: {
            type: "object",
            properties: {
              apiKey: { type: "string", format: "secret-ref" },
              backupKey: { type: "string", format: "secret-ref" },
            },
          },
        } as never,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(pluginConfig).values({ pluginId: plugin.id, configJson });
    return plugin;
  }

  it("resolves a ref that belongs to the single company the config pins", async () => {
    const company = await newCompany();
    const secret = await newSecret(company.id, "secret-value-a");
    const plugin = await newPluginWithConfig({ apiKey: secret.id });

    const handler = createPluginSecretsHandler({ db, pluginId: plugin.id });
    await expect(handler.resolve({ secretRef: secret.id })).resolves.toBe("secret-value-a");
  });

  it("resolves every ref in a config whose refs all belong to one company", async () => {
    const company = await newCompany();
    const first = await newSecret(company.id, "first-value");
    const second = await newSecret(company.id, "second-value");
    const plugin = await newPluginWithConfig({ apiKey: first.id, backupKey: second.id });

    const handler = createPluginSecretsHandler({ db, pluginId: plugin.id });
    await expect(handler.resolve({ secretRef: first.id })).resolves.toBe("first-value");
    await expect(handler.resolve({ secretRef: second.id })).resolves.toBe("second-value");
  });

  it("refuses to resolve anything when the config refs secrets in more than one company", async () => {
    const companyA = await newCompany();
    const companyB = await newCompany();
    const secretA = await newSecret(companyA.id, "company-a-value");
    const secretB = await newSecret(companyB.id, "company-b-value");
    const plugin = await newPluginWithConfig({ apiKey: secretA.id, backupKey: secretB.id });

    const handler = createPluginSecretsHandler({ db, pluginId: plugin.id });
    await expect(handler.resolve({ secretRef: secretA.id })).rejects.toThrowError(/not found/i);
    await expect(handler.resolve({ secretRef: secretB.id })).rejects.toThrowError(/not found/i);
  });

  it("refuses a managed (connection-owned) secret even when the config references it", async () => {
    const company = await newCompany();
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "app" })
      .returning()
      .then((rows) => rows[0]!);
    const workspace = await db
      .insert(projectWorkspaces)
      .values({
        companyId: company.id,
        projectId: project.id,
        name: "app",
        sourceType: "git_repo",
        repoUrl: "https://github.com/acme/app",
      })
      .returning()
      .then((rows) => rows[0]!);
    const managed = await secretService(db).create(company.id, {
      name: `github-token-${workspace.id}`,
      provider: "local_encrypted",
      value: "github_pat_managed",
    });
    await db.insert(githubRepoConnections).values({
      companyId: company.id,
      projectId: project.id,
      projectWorkspaceId: workspace.id,
      repoFullName: "acme/app",
      repoOwner: "acme",
      repoName: "app",
      secretId: managed.id,
    });
    const plugin = await newPluginWithConfig({ apiKey: managed.id });

    const handler = createPluginSecretsHandler({ db, pluginId: plugin.id });
    await expect(handler.resolve({ secretRef: managed.id })).rejects.toThrowError(/not found|connection|managed/i);
    // The secret itself is untouched — the owning flow still resolves it.
    await expect(
      secretService(db).resolveSecretValue(company.id, managed.id, "latest"),
    ).resolves.toBe("github_pat_managed");
  });

  it("still refuses refs that are not declared in the plugin config", async () => {
    const company = await newCompany();
    const declared = await newSecret(company.id, "declared");
    const undeclared = await newSecret(company.id, "undeclared");
    const plugin = await newPluginWithConfig({ apiKey: declared.id });

    const handler = createPluginSecretsHandler({ db, pluginId: plugin.id });
    await expect(handler.resolve({ secretRef: undeclared.id })).rejects.toThrowError(/not found/i);
    await expect(handler.resolve({ secretRef: randomUUID() })).rejects.toThrowError(/not found/i);
  });
});
