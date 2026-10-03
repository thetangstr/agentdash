// AgentDash (GH #992): an agent run that prints the configured provider key
// must never persist or serve it.
//
// - the key is written into the managed Hermes template profile's `.env`,
//   matching how `hermes-provider-setup` stores the customer's provider key;
// - the run's stdout/stderr echoes it verbatim, in a Bearer header, inside a
//   JSON payload, base64-encoded, and split across a stream boundary;
// - the stored log file, the run row, the run events, the activity log and
//   every read path (readLog / getRun / list / listEvents) come back clean;
// - a second case seeds *raw* legacy rows/file (as if written before this
//   change) and proves the serve-time pass still scrubs them.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { heartbeatService } from "../services/heartbeat.ts";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.ts";
import { runLogBasePath } from "../services/run-log-store.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Deliberately NOT a recognized key shape (no sk-/ghp_/pcp_ prefix): only the
// verbatim known-secret match from the Hermes profile `.env` can catch it.
const CANARY = "provk-canary-7f3a9c2d4e5ab6c78d9e0f1a2b3c4d5e";
const CANARY_B64 = Buffer.from(CANARY, "utf8").toString("base64");

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat run-log secret redaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  let profilesDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of [
      "PAPERCLIP_HOME",
      "PAPERCLIP_INSTANCE_ID",
      "PAPERCLIP_SECRETS_MASTER_KEY",
      "HERMES_PROFILES_DIR",
    ]) saved[key] = process.env[key];
    home = await mkdtemp(join(tmpdir(), "heartbeat-redact-"));
    profilesDir = join(home, "hermes-profiles");
    await mkdir(join(profilesDir, "agentdash"), { recursive: true });
    await writeFile(
      join(profilesDir, "agentdash", ".env"),
      `OPENAI_API_KEY=${CANARY}\n`,
      "utf8",
    );
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "run-log-redaction-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "b".repeat(64);
    process.env.HERMES_PROFILES_DIR = profilesDir;
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-log-redaction-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetInstanceSecretsCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  async function seedCompanyAndAgent(script: string) {
    const company = await db
      .insert(companies)
      .values({ name: "Acme", issuePrefix: `R${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false })
      .returning()
      .then((rows) => rows[0]!);
    const agentId = randomUUID();
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
    return { company, agentId };
  }

  it("never persists or serves a provider key the agent prints", async () => {
    const script = [
      `const k = ${JSON.stringify(CANARY)};`,
      `const b64 = ${JSON.stringify(CANARY_B64)};`,
      "console.log('key: ' + k);",
      "console.error('Authorization: Bearer ' + k);",
      "console.log(JSON.stringify({token: k}));",
      "console.log('encoded: ' + b64);",
      // Split across the stream redactor's chunk boundary.
      "process.stdout.write(k.slice(0, 20));",
      "setTimeout(() => { process.stdout.write(k.slice(20) + '\\n'); process.exit(0); }, 150);",
    ].join(" ");
    const { company, agentId } = await seedCompanyAndAgent(script);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // The API never returns the key — not verbatim, not base64, not in halves.
    const log = await heartbeat.readLog(queued!.id);
    expect(log.content).not.toContain(CANARY);
    expect(log.content).not.toContain(CANARY_B64);
    expect(log.content).toContain("***REDACTED***");
    expect(JSON.stringify(await heartbeat.listEvents(queued!.id))).not.toContain(CANARY);
    expect(JSON.stringify(await heartbeat.getRunForResponse(queued!.id))).not.toContain(CANARY);
    expect(JSON.stringify(await heartbeat.list(company.id, agentId))).not.toContain(CANARY);

    // Persist-time proof: the raw artifacts on disk/in the DB are already clean.
    const [row] = await db.select().from(heartbeatRuns);
    expect(JSON.stringify(row)).not.toContain(CANARY);
    const rawLog = await readFile(join(runLogBasePath(), row.logRef!), "utf8");
    expect(rawLog).not.toContain(CANARY);
    expect(rawLog).not.toContain(CANARY_B64);
    expect(JSON.stringify(await db.select().from(heartbeatRunEvents))).not.toContain(CANARY);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toContain(CANARY);
  }, 30_000);

  it("serve-time pass scrubs rows and log files written before redaction", async () => {
    const { company, agentId } = await seedCompanyAndAgent("process.exit(0);");
    const heartbeat = heartbeatService(db);

    const runId = randomUUID();
    const logRef = `${company.id}/${agentId}/${runId}.ndjson`;
    const rawLine = JSON.stringify({
      ts: new Date().toISOString(),
      stream: "stdout",
      chunk: `provider said key was ${CANARY}`,
    });
    const logPath = join(runLogBasePath(), logRef);
    await mkdir(join(logPath, ".."), { recursive: true });
    await writeFile(logPath, `${rawLine}\n`, "utf8");

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      error: `adapter failed with ${CANARY}`,
      stdoutExcerpt: `echoed ${CANARY}`,
      resultJson: { message: `result mentions ${CANARY}` },
      logStore: "local_file",
      logRef,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId: company.id,
      runId,
      agentId,
      seq: 1,
      eventType: "log",
      message: `event echoes ${CANARY}`,
      payload: { detail: `payload ${CANARY}` },
    });

    const log = await heartbeat.readLog(runId);
    expect(log.content).not.toContain(CANARY);
    expect(log.content).toContain("***REDACTED***");

    // Internal reads stay raw by design — heartbeat execution consumes
    // `contextSnapshot` verbatim — while the serving boundary scrubs.
    const raw = await heartbeat.getRun(runId);
    expect(JSON.stringify(raw)).toContain(CANARY);
    const served = await heartbeat.getRunForResponse(runId);
    expect(JSON.stringify(served)).not.toContain(CANARY);
    expect(JSON.stringify(await heartbeat.listEvents(runId))).not.toContain(CANARY);
    const listed = await heartbeat.list(company.id, agentId);
    expect(listed.length).toBeGreaterThan(0);
    expect(JSON.stringify(listed)).not.toContain(CANARY);
  }, 30_000);

  // Regression (PR #998 review): serve-time redaction used to blank
  // identifier fields ending in "Key" (taskKey/sessionKey/…) inside
  // `contextSnapshot`, breaking task-session resumption. Identifiers must
  // survive both raw and served reads.
  it("preserves contextSnapshot.taskKey through the serving boundary", async () => {
    const { company, agentId } = await seedCompanyAndAgent("process.exit(0);");
    const heartbeat = heartbeatService(db);
    const taskKey = `issue:${randomUUID()}`;
    const sessionKey = "task-session-01JABCDEF";

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      error: `adapter failed with ${CANARY}`,
      contextSnapshot: { issueId: "x", taskKey, sessionKey },
      logStore: "local_file",
      logRef: null,
    });

    const raw = await heartbeat.getRun(runId);
    expect((raw?.contextSnapshot as Record<string, unknown>).taskKey).toBe(taskKey);
    expect((raw?.contextSnapshot as Record<string, unknown>).sessionKey).toBe(sessionKey);

    const served = await heartbeat.getRunForResponse(runId);
    const servedSnapshot = served?.contextSnapshot as Record<string, unknown>;
    expect(servedSnapshot.taskKey).toBe(taskKey);
    expect(servedSnapshot.sessionKey).toBe(sessionKey);
    expect(served?.error).not.toContain(CANARY);
    expect(served?.error).toContain("***REDACTED***");
  }, 30_000);
});
