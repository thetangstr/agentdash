// AgentDash (GH #782): a real heartbeat run in a project with a connected
// GitHub repo.
//
// - the managed checkout is pointed at the agent-time credential helper, and
//   neither its git config nor its remote URL holds the token;
// - a token the agent prints (it can read it from its shell) is scrubbed from
//   the stored run log, the excerpts and the persisted result.
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { AGENT_CREDENTIAL_HELPER } from "../services/git-credential-helper.js";
import { githubConnectionService } from "../services/github-connection.js";
import { heartbeatService } from "../services/heartbeat.ts";

const execFile = promisify(execFileCallback);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const CANARY = "github_pat_11HEARTBEATCANARY000000_runLogCanaryThatMustNeverBeStored0";

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat with a connected GitHub repo", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY"]) saved[key] = process.env[key];
    home = await mkdtemp(join(tmpdir(), "heartbeat-github-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "github-credential-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "b".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-github-credential-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    // A dedicated database: dropped whole, no per-table cleanup racing the run's async writes.
    // Let the run's trailing bookkeeping settle before the database goes away.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  it("configures the checkout's credential helper and keeps the token out of every stored run output", async () => {
    const company = await db
      .insert(companies)
      .values({ name: "Acme", issuePrefix: `A${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false })
      .returning()
      .then((rows) => rows[0]!);

    const fakeGitHub = async (input: string | URL) =>
      String(input).includes("/pulls")
        ? new Response("[]", { status: 200 })
        : new Response(
            JSON.stringify({ name: "app", owner: { login: "acme" }, default_branch: "main", permissions: { push: true } }),
            { status: 200 },
          );
    const { connection } = await githubConnectionService(db, { fetch: fakeGitHub as never, env: {} }).connect(
      company.id,
      { repoUrl: "https://github.com/acme/app", token: CANARY },
      "owner-1",
    );

    // An existing managed checkout (cloned earlier, before the connection).
    const checkout = resolveManagedProjectWorkspaceDir({ companyId: company.id, projectId: connection.projectId, repoName: "app" });
    await mkdir(checkout, { recursive: true });
    await execFile("git", ["init", "-q", checkout]);
    await execFile("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/acme/app"]);

    const agentId = randomUUID();
    const script = [
      `const t = ${JSON.stringify(CANARY)};`,
      "console.log('pushing with ' + t);",
      "console.error('remote: https://x-access-token:' + t + '@github.com/acme/app');",
      "process.exit(0);",
    ].join(" ");
    await db.insert(agents).values({
      id: agentId,
      companyId: company.id,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", script] },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", { projectId: connection.projectId }, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // The checkout asks the control plane; its config and remote carry no token.
    const config = await readFile(join(checkout, ".git", "config"), "utf8");
    expect(config).not.toContain(CANARY);
    const helpers = (await execFile("git", ["-C", checkout, "config", "--local", "--get-all", "credential.https://github.com.helper"])).stdout;
    expect(helpers.split("\n")).toEqual(["", AGENT_CREDENTIAL_HELPER, ""]);
    expect((await execFile("git", ["-C", checkout, "remote", "get-url", "origin"])).stdout.trim()).toBe("https://github.com/acme/app");

    // Stored and streamed run output never carries the token.
    const log = await heartbeat.readLog(queued!.id);
    expect(log.content).toContain("pushing with [redacted-github-token]");
    expect(log.content).not.toContain(CANARY);
    const [row] = await db.select().from(heartbeatRuns);
    expect(JSON.stringify(row)).not.toContain(CANARY);
    const events = await db.select().from(heartbeatRunEvents);
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toContain(CANARY);
  });
});
