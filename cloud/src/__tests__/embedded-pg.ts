// AgentDash: an embedded Postgres per suite for the control plane's tests,
// with each phase time-boxed so a wedged start cannot hang CI.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";

type Instance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type Ctor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (m: unknown) => void;
  onError?: (m: unknown) => void;
}) => Instance;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") return reject(new Error("no port"));
      s.close(() => resolve(a.port));
    });
  });
}

async function within<T>(label: string, ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface TestDatabase {
  url: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const EmbeddedPostgres = ((await import("embedded-postgres")) as unknown as { default: Ctor }).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-control-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "cloud",
    password: "cloud",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  const stop = async () => {
    await within("embedded Postgres stop", 30_000, () => pg.stop()).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    await within("embedded Postgres initialise", 90_000, () => pg.initialise());
    await within("embedded Postgres start", 60_000, () => pg.start());
    const admin = postgres(`postgres://cloud:cloud@127.0.0.1:${port}/postgres`, { max: 1, onnotice: () => {} });
    await admin.unsafe("create database cloud_control");
    await admin.end();
  } catch (err) {
    await stop();
    throw err;
  }
  return { url: `postgres://cloud:cloud@127.0.0.1:${port}/cloud_control`, stop };
}
